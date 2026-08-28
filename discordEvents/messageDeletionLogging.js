const Discord = require('discord.js')

const RECONCILIATION_DELAY_MS = 1_500
const AUDIT_ENTRY_MAX_AGE_MS = 30_000
const AUDIT_BUFFER_TTL_MS = 60_000
const AUDIT_BUFFER_MAX_ENTRIES = 160
const AUDIT_USAGE_MAX_ENTRIES = 320
const DISCORD_EPOCH = 1_420_070_400_000n

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function auditEntries(logs) {
    const entries = logs?.entries
    if (!entries) return []
    if (typeof entries.values === 'function') return Array.from(entries.values())
    if (typeof entries.first === 'function') {
        const first = entries.first()
        return first ? [first] : []
    }
    return Array.isArray(entries) ? entries : []
}

function auditChannelId(entry) {
    return entry?.extra?.channel?.id
        ?? entry?.extra?.channelId
        ?? entry?.extra?.channel_id
        ?? null
}

function bulkAuditChannelId(entry) {
    return entry?.target?.id ?? auditChannelId(entry)
}

function auditCount(entry) {
    const count = Number(entry?.extra?.count)
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

function entryTimestamp(entry) {
    return Number(entry?.createdTimestamp ?? entry?.createdAt?.getTime?.() ?? 0)
}

function auditEntryKey(entry, type) {
    const channelId = type === 73 ? bulkAuditChannelId(entry) : auditChannelId(entry)
    return `${type}:${String(entry?.id ?? `${entry?.executor?.id ?? ''}:${entryTimestamp(entry)}:${entry?.target?.id ?? ''}:${channelId ?? ''}`)}`
}

function messageTimestamp(message) {
    if (Number.isFinite(message?.createdTimestamp)) return Number(message.createdTimestamp)
    const createdAt = message?.createdAt?.getTime?.()
    if (Number.isFinite(createdAt)) return createdAt
    try {
        return Number((BigInt(message?.id) >> 22n) + DISCORD_EPOCH)
    } catch {
        return Number.MAX_SAFE_INTEGER
    }
}

function messageCreatedAt(message) {
    const timestamp = messageTimestamp(message)
    return timestamp === Number.MAX_SAFE_INTEGER ? '' : new Date(timestamp).toISOString()
}

function attachmentUrls(message) {
    const attachments = message?.attachments
    const values = attachments?.values
        ? Array.from(attachments.values())
        : Array.isArray(attachments) ? attachments : []
    return values.map((attachment) => attachment?.url ?? attachment?.proxyURL ?? String(attachment ?? ''))
        .filter(Boolean)
        .join('\n')
}

function csvEscape(value) {
    const raw = String(value ?? '')
    const safe = /^[\s]*[=+\-@]/u.test(raw) ? `'${raw}` : raw
    return `"${safe.replace(/"/gu, '""')}"`
}

function sortMessages(messages) {
    return [...messages].sort((left, right) => messageTimestamp(left) - messageTimestamp(right)
        || String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
}

function buildBulkCsv(messages) {
    const rows = sortMessages(messages)
        .map((message) => {
            const author = message?.author
            const authorName = message?.member?.displayName
                ?? author?.globalName
                ?? author?.username
                ?? author?.tag
                ?? ''
            const recovered = Boolean(author?.id) && !message?.partial
            return [
                message?.id ?? '', author?.id ?? '', authorName, messageCreatedAt(message),
                message?.content ?? '', attachmentUrls(message),
                recovered ? 'recovered' : 'record unavailable',
            ].map(csvEscape).join(',')
        })
    return `${[
        'message_id,author_id,author_name,message_created_at,content,attachment_urls,record_status',
        ...rows,
    ].join('\n')}\n`
}

function buildMessageAuthorHeader(message) {
    const author = message?.author
    const member = message?.member ?? message?.guild?.members?.cache?.get?.(author?.id)
    const name = member?.displayName ?? author?.globalName ?? author?.username ?? author?.tag ?? 'Unknown message author'
    const iconURL = typeof member?.displayAvatarURL === 'function'
        ? member.displayAvatarURL({ dynamic: true })
        : typeof author?.displayAvatarURL === 'function'
            ? author.displayAvatarURL({ dynamic: true })
            : undefined
    return iconURL ? { name, iconURL } : { name }
}

function makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message, deletedBy }) {
    const authorId = message?.author?.id
    const actor = deletedBy?.id
        ? `<@${deletedBy.id}>`
        : deletedBy === 'self'
            ? 'self-delete (or record unavailable)'
            : 'record unavailable'
    return buildCopyableMessageEmbeds({
        title: 'Message Deleted 🗑️',
        searchableText: `Deleted by: ${actor}\nMessage Author: ${authorId ? `<@${authorId}>` : 'record unavailable'}`,
        contentLabel: 'Message', content: message?.content != null ? message.content : 'Cache Empty',
        author: buildMessageAuthorHeader(message),
    })
}

function collectionValues(messages) {
    if (!messages) return []
    if (typeof messages.values === 'function') return Array.from(messages.values())
    return Array.isArray(messages) ? messages : []
}

function sameId(left, right) {
    return left != null && right != null && String(left) === String(right)
}

function isRecent(entry, currentTime) {
    const timestamp = entryTimestamp(entry)
    return timestamp > 0 && Math.abs(currentTime - timestamp) <= AUDIT_ENTRY_MAX_AGE_MS
}

function pruneUsage(usage, currentTime) {
    for (const [key, record] of usage) if (record.expiresAt <= currentTime) usage.delete(key)
    const newest = [...usage.entries()].sort(([, left], [, right]) => right.expiresAt - left.expiresAt)
    for (const [key] of newest.slice(AUDIT_USAGE_MAX_ENTRIES)) usage.delete(key)
}

function createMessageDeletionLogger({
    botLog,
    buildCopyableMessageEmbeds,
    discord = Discord,
    wait = sleep,
    batchDelay = RECONCILIATION_DELAY_MS,
    now = Date.now,
    setCleanupTimer = setTimeout,
} = {}) {
    if (typeof botLog !== 'function') throw new Error('A botLog function is required.')
    if (typeof buildCopyableMessageEmbeds !== 'function') throw new Error('A message embed builder is required.')

    const guildStates = new Map()
    const pendingSingles = new Map()
    let cleanupTimer = null

    function sweepExpiredState() {
        const currentTime = now()
        for (const [guildId, state] of guildStates) {
            for (const [key, record] of state.entries) if (record.expiresAt <= currentTime) state.entries.delete(key)
            pruneUsage(state.singleUsage, currentTime)
            pruneUsage(state.bulkUsage, currentTime)
            if (!state.entries.size && !state.singleUsage.size && !state.bulkUsage.size && !pendingSingles.has(guildId)) {
                guildStates.delete(guildId)
            }
        }
        return guildStates.size
    }

    function scheduleCleanup() {
        if (cleanupTimer || !guildStates.size) return
        cleanupTimer = setCleanupTimer(() => {
            cleanupTimer = null
            sweepExpiredState()
            scheduleCleanup()
        }, AUDIT_BUFFER_TTL_MS)
        cleanupTimer?.unref?.()
    }

    function stateForGuild(guildId) {
        const existing = guildStates.get(guildId)
        const state = existing ?? {
            entries: new Map(), singleUsage: new Map(), bulkUsage: new Map(),
        }
        guildStates.set(guildId, state)
        if (!existing) scheduleCleanup()
        const currentTime = now()
        for (const [key, record] of state.entries) if (record.expiresAt <= currentTime) state.entries.delete(key)
        for (const usage of [state.singleUsage, state.bulkUsage]) pruneUsage(usage, currentTime)
        return state
    }

    function mergeEntries(guildId, type, entries, preferCurrent = false) {
        const state = stateForGuild(guildId)
        const currentTime = now()
        for (const entry of entries) {
            if (!entry?.executor?.id) continue
            const key = auditEntryKey(entry, type)
            const existing = state.entries.get(key)
            state.entries.set(key, {
                entry: preferCurrent || !existing ? entry : existing.entry,
                count: Math.max(existing?.count ?? 0, auditCount(entry)),
                type,
                expiresAt: currentTime + AUDIT_BUFFER_TTL_MS,
            })
        }
        const relevant = [...state.entries.entries()]
            .sort(([, left], [, right]) => entryTimestamp(right.entry) - entryTimestamp(left.entry))
        for (const [key] of relevant.slice(AUDIT_BUFFER_MAX_ENTRIES)) state.entries.delete(key)
        scheduleCleanup()
    }

    function bufferedEntries(guildId, type) {
        return [...stateForGuild(guildId).entries.values()]
            .filter((record) => record.type === type && isRecent(record.entry, now()))
    }

    async function fetchEntries(guild, type) {
        const logs = await guild.fetchAuditLogs({ type, limit: 20 })
        mergeEntries(guild.id, type, auditEntries(logs), true)
        return bufferedEntries(guild.id, type)
    }

    function candidatesForMessage(records, message) {
        const authorId = message?.author?.id
        const channelId = message?.channelId ?? message?.channel?.id
        if (!authorId || !channelId) return []
        return records.filter((record) => (
            record.entry?.executor?.id
            && sameId(record.entry?.target?.id, authorId)
            && sameId(auditChannelId(record.entry), channelId)
        ))
    }

    function resolveSingles(guildId, pending) {
        const state = stateForGuild(guildId)
        const candidates = new Map()
        const uncertainChannel = new Set()
        const ambiguous = new Set()
        const matched = new Map()
        const groups = new Map()
        const records = bufferedEntries(guildId, 72)

        for (const pendingRecord of pending) {
            const matches = candidatesForMessage(records, pendingRecord.message)
            candidates.set(pendingRecord, matches)
            const channelId = pendingRecord.message?.channelId ?? pendingRecord.message?.channel?.id
            if (channelId) {
                const authorId = pendingRecord.message?.author?.id
                if (records.some((record) => sameId(record.entry?.target?.id, authorId) && !auditChannelId(record.entry))) {
                    uncertainChannel.add(pendingRecord)
                }
            }
            if (new Set(matches.map((record) => record.entry.executor.id)).size > 1) ambiguous.add(pendingRecord)
        }
        for (const pendingRecord of pending) {
            if (ambiguous.has(pendingRecord)) continue
            const matches = candidates.get(pendingRecord)
            if (!matches.length) continue
            const message = pendingRecord.message
            const key = `${message.author.id}\0${message.channelId ?? message.channel?.id}\0${matches[0].entry.executor.id}`
            const group = groups.get(key) ?? []
            group.push(pendingRecord)
            groups.set(key, group)
        }
        for (const group of groups.values()) {
            const common = candidates.get(group[0]).filter((candidate) => group.every((record) => (
                candidates.get(record).some((other) => auditEntryKey(other.entry, 72) === auditEntryKey(candidate.entry, 72))
            )))
            const available = common.reduce((total, candidate) => {
                const used = state.singleUsage.get(auditEntryKey(candidate.entry, 72))?.used ?? 0
                return total + Math.max(0, candidate.count - used)
            }, 0)
            if (available < group.length) {
                continue
            }
            const allocated = new Map()
            for (const record of group) {
                const candidate = common.find((entry) => {
                    const key = auditEntryKey(entry.entry, 72)
                    return (state.singleUsage.get(key)?.used ?? 0) + (allocated.get(key) ?? 0) < entry.count
                })
                if (!candidate) break
                const key = auditEntryKey(candidate.entry, 72)
                allocated.set(key, (allocated.get(key) ?? 0) + 1)
                matched.set(record, candidate.entry.executor)
            }
            for (const [key, used] of allocated) {
                const existing = state.singleUsage.get(key)
                state.singleUsage.set(key, {
                    used: (existing?.used ?? 0) + used,
                    expiresAt: now() + AUDIT_BUFFER_TTL_MS,
                })
            }
            pruneUsage(state.singleUsage, now())
            scheduleCleanup()
        }
        return { matched, candidates, uncertainChannel }
    }

    function quarantineUnresolvedSingles(guildId, observedCandidates, unresolved) {
        const state = stateForGuild(guildId)
        for (const record of unresolved) {
            const candidates = observedCandidates.get(record) ?? []
            for (const candidate of candidates) {
                const key = auditEntryKey(candidate.entry, 72)
                const existing = state.singleUsage.get(key)
                state.singleUsage.set(key, {
                    used: Math.max(existing?.used ?? 0, candidate.count),
                    expiresAt: now() + AUDIT_BUFFER_TTL_MS,
                })
            }
        }
        pruneUsage(state.singleUsage, now())
        scheduleCleanup()
    }

    function mergeObservedCandidates(observed, candidates) {
        for (const [record, records] of candidates) {
            const current = observed.get(record) ?? []
            const known = new Set(current.map((candidate) => auditEntryKey(candidate.entry, 72)))
            observed.set(record, current.concat(records.filter((candidate) => !known.has(auditEntryKey(candidate.entry, 72)))))
        }
    }

    async function logSingle(message, deletedBy) {
        for (const embed of makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message, deletedBy })) {
            await botLog(message.guild, embed, 1, 'messages')
        }
    }

    async function flushSingles(guildId) {
        const batch = pendingSingles.get(guildId)
        if (!batch) return
        pendingSingles.delete(guildId)
        const pending = [...batch.records]
        let resolution = resolveSingles(guildId, pending)
        const observedCandidates = new Map(resolution.candidates)
        const matched = new Map(resolution.matched)
        let unresolved = pending.filter((record) => !resolution.matched.has(record))
        let fetched = false
        let fetchError
        if (unresolved.length) {
            try {
                await fetchEntries(batch.guild, 72)
                fetched = true
                resolution = resolveSingles(guildId, unresolved)
                mergeObservedCandidates(observedCandidates, resolution.candidates)
                for (const [record, executor] of resolution.matched) matched.set(record, executor)
                unresolved = unresolved.filter((record) => !resolution.matched.has(record))
            } catch (error) {
                fetchError = error
            }
        }
        if (fetchError) console.error('Message deletion audit reconciliation failed:', fetchError)
        try {
            const deliveryErrors = []
            for (const [record, executor] of matched) {
                try {
                    await logSingle(record.message, executor)
                } catch (error) {
                    deliveryErrors.push(error)
                }
            }
            quarantineUnresolvedSingles(guildId, observedCandidates, unresolved)
            for (const record of unresolved) {
                const selfDelete = fetched
                    && !(resolution.candidates.get(record)?.length)
                    && !resolution.uncertainChannel.has(record)
                    && (record.message?.channelId ?? record.message?.channel?.id)
                    && record.message?.author?.id
                try {
                    await logSingle(record.message, selfDelete ? 'self' : 'unavailable')
                } catch (error) {
                    deliveryErrors.push(error)
                }
            }
            if (deliveryErrors.length) throw new AggregateError(deliveryErrors, 'Message deletion BotLog delivery failed.')
        } finally {
            for (const record of pending) record.resolve()
        }
    }

    function recordSingleDeletion(message) {
        const guild = message?.guild
        if (!guild?.id) return Promise.resolve()
        let batch = pendingSingles.get(guild.id)
        if (!batch) {
            batch = { guild, records: [] }
            pendingSingles.set(guild.id, batch)
            Promise.resolve().then(() => wait(batchDelay)).then(() => flushSingles(guild.id))
                .catch((error) => console.error('Message deletion logging failed:', error))
        }
        return new Promise((resolve) => batch.records.push({ message, resolve }))
    }

    function bulkCandidates(guildId, channelId, count) {
        if (!channelId) return []
        const state = stateForGuild(guildId)
        return bufferedEntries(guildId, 73).filter((record) => (
            record.entry?.executor?.id
            && sameId(bulkAuditChannelId(record.entry), channelId)
            && record.count === count
            && !state.bulkUsage.has(auditEntryKey(record.entry, 73))
        ))
    }

    function resolveBulk(guildId, channelId, count) {
        const candidates = bulkCandidates(guildId, channelId, count)
        if (new Set(candidates.map((record) => record.entry.executor.id)).size !== 1) return null
        const candidate = candidates.sort((left, right) => entryTimestamp(right.entry) - entryTimestamp(left.entry))[0]
        stateForGuild(guildId).bulkUsage.set(auditEntryKey(candidate.entry, 73), {
            expiresAt: now() + AUDIT_BUFFER_TTL_MS,
        })
        pruneUsage(stateForGuild(guildId).bulkUsage, now())
        scheduleCleanup()
        return candidate.entry.executor
    }

    async function recordBulkDeletion(messages, channel) {
        const records = collectionValues(messages)
        if (!records.length) return
        const guild = channel?.guild ?? records[0]?.guild
        if (!guild?.id) return
        const channelId = channel?.id ?? records[0]?.channelId ?? records[0]?.channel?.id
        await wait(batchDelay)
        let executor = resolveBulk(guild.id, channelId, records.length)
        if (!executor) {
            try {
                await fetchEntries(guild, 73)
                executor = resolveBulk(guild.id, channelId, records.length)
            } catch (error) {
                console.error('Bulk message deletion audit reconciliation failed:', error)
            }
        }
        const recovered = records.filter((message) => Boolean(message?.author?.id) && !message?.partial)
        const authors = new Map()
        for (const message of sortMessages(recovered)) authors.set(message.author.id, (authors.get(message.author.id) ?? 0) + 1)
        const authorText = authors.size
            ? [...authors.entries()].map(([id, count]) => `<@${id}> (${count})`).join(', ')
            : 'record unavailable'
        const description = [
            `Deleted by: ${executor?.id ? `<@${executor.id}>` : 'record unavailable'}`,
            `Messages deleted: ${records.length}`,
            `Message records recovered: ${recovered.length}`,
            `Records unavailable: ${records.length - recovered.length}`,
            '', `Message Authors: ${authorText}`, '',
            `Channel: ${channelId ? `<#${channelId}>` : 'record unavailable'}`,
        ].join('\n')
        await botLog(guild, new discord.EmbedBuilder()
            .setTitle('Messages Bulk Deleted 🗑️')
            .setDescription(description), 1, 'messages', {
            files: [{ attachment: Buffer.from(buildBulkCsv(records), 'utf8'), name: 'bulk-deleted-messages.csv' }],
        })
    }

    function recordAuditEntry(entry, guild) {
        const type = Number(entry?.action ?? entry?.actionType)
        if ((type !== 72 && type !== 73) || !guild?.id) return
        mergeEntries(guild.id, type, [entry])
    }

    return { recordAuditEntry, recordSingleDeletion, recordBulkDeletion, sweepExpiredState }
}

module.exports = { createMessageDeletionLogger, buildBulkCsv, csvEscape }
