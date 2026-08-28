const Discord = require('discord.js')

const RECONCILIATION_DELAY_MS = 1_500
const AUDIT_RECONCILIATION_DELAYS_MS = [1_000, 2_000, 3_000, 3_000]
const AUDIT_ENTRY_MAX_AGE_MS = 30_000
const AUDIT_BUFFER_TTL_MS = 60_000
const AUDIT_BUFFER_MAX_ENTRIES = 320

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function collectionValues(collection) {
    if (!collection) return []
    if (typeof collection.values === 'function') return Array.from(collection.values())
    if (typeof collection.first === 'function') {
        const first = collection.first()
        return first ? [first] : []
    }
    return Array.isArray(collection) ? collection : []
}

const auditChannelId = (entry) => entry?.extra?.channel?.id ?? entry?.extra?.channelId ?? null
const auditTargetId = (entry) => entry?.target?.id ?? entry?.targetId ?? null
const auditExecutorId = (entry) => entry?.executor?.id ?? entry?.executorId ?? null
const bulkAuditChannelId = (entry) => entry?.target?.id ?? auditChannelId(entry)

function auditCount(entry) {
    const count = Number(entry?.extra?.count)
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

function entryTimestamp(entry) {
    return Number(entry?.createdTimestamp ?? entry?.createdAt?.getTime?.() ?? 0)
}

function auditEntryKey(entry, type) {
    const channelId = type === 73 ? bulkAuditChannelId(entry) : auditChannelId(entry)
    return `${type}:${String(entry?.id ?? `${auditExecutorId(entry) ?? ''}:${entryTimestamp(entry)}:${auditTargetId(entry) ?? ''}:${channelId ?? ''}`)}`
}

function messageTimestamp(message) {
    const cached = Number(message?.createdTimestamp)
    if (Number.isSafeInteger(cached) && cached > 0) return cached
    const createdAt = Number(message?.createdAt?.getTime?.())
    if (Number.isSafeInteger(createdAt) && createdAt > 0) return createdAt
    if (typeof message?.id !== 'string' || !/^[1-9]\d{16,18}$/u.test(message.id)) return null
    const timestamp = discordTimestamp(message.id)
    return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null
}

function discordTimestamp(id) {
    try {
        return Number(Discord.SnowflakeUtil.timestampFrom(id))
    } catch {
        return null
    }
}

function messageCreatedAt(message) {
    const timestamp = messageTimestamp(message)
    return timestamp == null ? '' : new Date(timestamp).toISOString()
}

function attachmentUrls(message) {
    const attachments = message?.attachments
    const values = attachments?.values ? Array.from(attachments.values()) : Array.isArray(attachments) ? attachments : []
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
    return [...messages].sort((left, right) => (messageTimestamp(left) ?? Number.MAX_SAFE_INTEGER) - (messageTimestamp(right) ?? Number.MAX_SAFE_INTEGER)
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

function makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message, deletedBy }) {
    const author = message?.author
    const member = message?.member ?? message?.guild?.members?.cache?.get?.(author?.id)
    const name = member?.displayName ?? author?.globalName ?? author?.username ?? author?.tag ?? 'Unknown message author'
    const avatarSource = typeof member?.displayAvatarURL === 'function' ? member : author
    const iconURL = typeof avatarSource?.displayAvatarURL === 'function' ? avatarSource.displayAvatarURL({ dynamic: true }) : undefined
    const timestamp = messageTimestamp(message)
    const channelId = messageChannelId(message)
    const contentFooter = [
        timestamp == null ? null : `Created at: <t:${Math.floor(timestamp / 1000)}:F>`,
        `Channel: ${channelId ? `<#${channelId}>` : 'record unavailable'}`,
    ].filter(Boolean).join('\n')
    return buildCopyableMessageEmbeds({
        title: 'Message Deleted 🗑️',
        searchableText: `Deleted by: ${deletedBy?.id ? `<@${deletedBy.id}>` : 'record unavailable'}\nMessage Author: ${author?.id ? `<@${author.id}>` : 'record unavailable'}`,
        contentLabel: 'Message', content: message?.content != null ? message.content : 'Cache Empty',
        contentFooter,
        author: iconURL ? { name, iconURL } : { name },
    })
}

function sameId(left, right) {
    return left != null && right != null && String(left) === String(right)
}

function messageChannelId(message) {
    return message?.channelId ?? message?.channel?.id
}

function isRecent(entry, currentTime) {
    const timestamp = entryTimestamp(entry)
    return timestamp > 0 && Math.abs(currentTime - timestamp) <= AUDIT_ENTRY_MAX_AGE_MS
}

function createMessageDeletionLogger({
    botLog,
    buildCopyableMessageEmbeds,
    discord = Discord,
    wait = sleep,
    batchDelay = RECONCILIATION_DELAY_MS,
    reconciliationDelays = AUDIT_RECONCILIATION_DELAYS_MS,
    now = Date.now,
    setCleanupTimer = setTimeout,
} = {}) {
    if (typeof botLog !== 'function') throw new Error('A botLog function is required.')
    if (typeof buildCopyableMessageEmbeds !== 'function') throw new Error('A message embed builder is required.')

    const guildStates = new Map()
    let cleanupTimer = null

    function sweepExpiredState() {
        const currentTime = now()
        for (const [guildId, state] of guildStates) {
            pruneRecords(state, currentTime)
            if (!state.records.size && !state.queue && !state.worker) {
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
        const state = existing ?? { records: new Map(), queue: null, worker: null }
        guildStates.set(guildId, state)
        if (!existing) scheduleCleanup()
        pruneRecords(state, now())
        return state
    }

    function pruneRecords(state, currentTime) {
        for (const [key, record] of state.records) if (record.expiresAt <= currentTime) state.records.delete(key)
        const recent = [...state.records.entries()].sort(([, left], [, right]) => (
            right.expiresAt - left.expiresAt || entryTimestamp(right.entry) - entryTimestamp(left.entry)
        ))
        for (const [key] of recent.slice(AUDIT_BUFFER_MAX_ENTRIES)) state.records.delete(key)
    }

    function mergeEntries(state, type, entries, preferCurrent = false) {
        const currentTime = now()
        for (const entry of entries) {
            if (!(type === 73 ? entry?.executor?.id : auditExecutorId(entry))) continue
            const key = auditEntryKey(entry, type)
            const existing = state.records.get(key)
            const record = existing ?? {
                key, type, consumedSingles: 0, closedForSingles: false, bulkConsumed: false,
            }
            record.entry = preferCurrent || !existing || entryTimestamp(entry) >= entryTimestamp(existing.entry)
                ? entry : existing.entry
            record.count = Math.max(record.count ?? 0, auditCount(entry))
            record.expiresAt = currentTime + AUDIT_BUFFER_TTL_MS
            state.records.set(key, record)
        }
        pruneRecords(state, currentTime)
        scheduleCleanup()
    }

    function bufferedEntries(state, type) {
        return [...state.records.values()]
            .filter((record) => record.type === type && isRecent(record.entry, now()))
    }

    async function fetchEntries(guild, state, type) {
        const logs = await guild.fetchAuditLogs({ type, limit: 20 })
        mergeEntries(state, type, collectionValues(logs?.entries), true)
    }

    function singleGroups(records) {
        const groups = new Map()
        for (const record of records) {
            const authorId = record.message?.author?.id
            const channelId = messageChannelId(record.message)
            const key = `${authorId ?? ''}\0${channelId ?? ''}`
            const group = groups.get(key) ?? { authorId, channelId, records: [], observed: new Map() }
            group.records.push(record)
            groups.set(key, group)
        }
        return [...groups.values()]
    }

    function openSingleMatches(state, group) {
        if (!group.authorId || !group.channelId) return []
        return bufferedEntries(state, 72).filter((record) => (
            !record.closedForSingles
            && sameId(auditTargetId(record.entry), group.authorId)
            && sameId(auditChannelId(record.entry), group.channelId)
        ))
    }

    function resolveSingleGroups(state, groups, matched) {
        const unresolved = []
        for (const group of groups) {
            const matches = openSingleMatches(state, group)
            for (const record of matches) group.observed.set(record.key, record)
            const executors = new Set(matches.map((record) => auditExecutorId(record.entry)))
            const eligible = matches.filter((record) => record.consumedSingles < record.count)
            const available = eligible.reduce((total, record) => total + record.count - record.consumedSingles, 0)
            if (executors.size !== 1 || available < group.records.length) {
                unresolved.push(group)
                continue
            }
            for (const pending of group.records) {
                const candidate = eligible.find((entry) => entry.consumedSingles < entry.count)
                candidate.consumedSingles += 1
                candidate.expiresAt = now() + AUDIT_BUFFER_TTL_MS
                matched.set(pending, candidate.entry.executor ?? { id: auditExecutorId(candidate.entry) })
            }
        }
        pruneRecords(state, now())
        if (matched.size) scheduleCleanup()
        return unresolved
    }

    function closeUnresolvedGroups(state, groups) {
        for (const group of groups) for (const record of group.observed.values()) {
            record.consumedSingles = Math.max(record.consumedSingles, record.count)
            record.closedForSingles = true
            record.expiresAt = now() + AUDIT_BUFFER_TTL_MS
        }
        pruneRecords(state, now())
        scheduleCleanup()
    }

    async function attemptSingleDelivery(errors, record, deletedBy) {
        try {
            for (const embed of makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message: record.message, deletedBy })) {
                await botLog(record.message.guild, embed, 1, 'messages')
            }
        } catch (error) {
            errors.push(error)
        }
    }

    async function reconcileSingleQueue(state, queue) {
        const groups = singleGroups(queue.records)
        const matched = new Map()
        let unresolved = resolveSingleGroups(state, groups, matched)
        const fetchErrors = []
        let fetchedAuditRecords = false
        for (const delay of reconciliationDelays) {
            if (!unresolved.length) break
            await wait(delay)
            unresolved = resolveSingleGroups(state, unresolved, matched)
            if (!unresolved.length) break
            try {
                await fetchEntries(queue.guild, state, 72)
                fetchedAuditRecords = true
                unresolved = resolveSingleGroups(state, unresolved, matched)
            } catch (error) {
                fetchErrors.push(error)
            }
        }
        if (fetchErrors.length && !fetchedAuditRecords) {
            console.error('Message deletion audit reconciliation failed after bounded retries:', fetchErrors.at(-1))
        }
        try {
            const deliveryErrors = []
            closeUnresolvedGroups(state, unresolved)
            for (const record of queue.records) {
                await attemptSingleDelivery(deliveryErrors, record, matched.get(record) ?? 'unavailable')
            }
            if (deliveryErrors.length) throw new AggregateError(deliveryErrors, 'Message deletion BotLog delivery failed.')
        } finally {
            for (const record of queue.records) record.resolve()
        }
    }

    function recordSingleDeletion(message) {
        const guild = message?.guild
        if (!guild?.id) return Promise.resolve()
        const state = stateForGuild(guild.id)
        let queue = state.queue
        if (!queue) {
            queue = { guild, records: [], readyAt: now() + batchDelay }
            state.queue = queue
            startSingleWorker(guild.id, state)
        }
        return new Promise((resolve) => queue.records.push({ message, resolve }))
    }

    function startSingleWorker(guildId, state) {
        if (state.worker) return
        const queue = state.queue
        if (!queue) return
        let collectionFinished = false
        const worker = (async () => {
            await wait(Math.max(0, queue.readyAt - now()))
            collectionFinished = true
            if (state.queue === queue) state.queue = null
            await reconcileSingleQueue(state, queue)
        })()
        worker.catch((error) => console.error('Message deletion logging failed:', error)).finally(() => {
            state.worker = null
            if (collectionFinished && state.queue) startSingleWorker(guildId, state)
        })
        state.worker = worker
    }

    function resolveBulk(state, channelId, count) {
        const candidates = channelId ? bufferedEntries(state, 73).filter((record) => (
            record.entry?.executor?.id
            && sameId(bulkAuditChannelId(record.entry), channelId)
            && record.count === count
            && !record.bulkConsumed
        )) : []
        if (new Set(candidates.map((record) => record.entry.executor.id)).size !== 1) return null
        const candidate = candidates.sort((left, right) => entryTimestamp(right.entry) - entryTimestamp(left.entry))[0]
        candidate.bulkConsumed = true
        candidate.expiresAt = now() + AUDIT_BUFFER_TTL_MS
        pruneRecords(state, now())
        scheduleCleanup()
        return candidate.entry.executor
    }

    async function recordBulkDeletion(messages, channel) {
        const records = collectionValues(messages)
        if (!records.length) return
        const guild = channel?.guild ?? records[0]?.guild
        if (!guild?.id) return
        const channelId = channel?.id ?? messageChannelId(records[0])
        const state = stateForGuild(guild.id)
        await wait(batchDelay)
        let executor = resolveBulk(state, channelId, records.length)
        if (!executor) {
            try {
                await fetchEntries(guild, state, 73)
                executor = resolveBulk(state, channelId, records.length)
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
        mergeEntries(stateForGuild(guild.id), type, [entry])
    }

    return { recordAuditEntry, recordSingleDeletion, recordBulkDeletion, sweepExpiredState }
}

module.exports = { createMessageDeletionLogger, buildBulkCsv, csvEscape }
