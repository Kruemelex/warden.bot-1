const Discord = require('discord.js')

const RECONCILIATION_DELAY_MS = 1_500
const AUDIT_RECONCILIATION_DELAYS_MS = [1_000, 2_000, 3_000, 3_000]
const AUDIT_ENTRY_MAX_AGE_MS = 30_000
const AUDIT_BUFFER_TTL_MS = 60_000
const AUDIT_BUFFER_MAX_ENTRIES = 320
const DISCORD_EPOCH = 1_420_070_400_000n
const MAX_DISCORD_SNOWFLAKE = (1n << 64n) - 1n
const MAX_MESSAGE_TIMESTAMP = Number((MAX_DISCORD_SNOWFLAKE >> 22n) + DISCORD_EPOCH)
const INVALID_MESSAGE_TIMESTAMP = Number.MAX_SAFE_INTEGER

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

function auditEntries(logs) { return collectionValues(logs?.entries) }

function auditChannelId(entry) {
    return entry?.extra?.channel?.id
        ?? entry?.extra?.channelId
        ?? entry?.extra?.channel_id
        ?? null
}

function auditTargetId(entry) {
    return entry?.target?.id ?? entry?.targetId ?? entry?.target_id ?? null
}

function auditExecutorId(entry) {
    return entry?.executor?.id ?? entry?.executorId ?? entry?.executor_id ?? null
}

function auditExecutor(entry) {
    const id = auditExecutorId(entry)
    return id == null ? null : entry?.executor?.id ? entry.executor : { id }
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
    return `${type}:${String(entry?.id ?? `${auditExecutorId(entry) ?? ''}:${entryTimestamp(entry)}:${auditTargetId(entry) ?? ''}:${channelId ?? ''}`)}`
}

function isValidMessageTimestamp(timestamp) {
    return Number.isSafeInteger(timestamp)
        && timestamp >= Number(DISCORD_EPOCH)
        && timestamp <= MAX_MESSAGE_TIMESTAMP
}

function snowflakeTimestamp(id) {
    if (typeof id !== 'string' && typeof id !== 'bigint') return null
    const text = String(id)
    if (!/^[1-9]\d*$/u.test(text)) return null
    try {
        const snowflake = BigInt(text)
        if (snowflake > MAX_DISCORD_SNOWFLAKE) return null
        const timestamp = Number((snowflake >> 22n) + DISCORD_EPOCH)
        return isValidMessageTimestamp(timestamp) ? timestamp : null
    } catch {
        return null
    }
}

function messageTimestamp(message) {
    if (isValidMessageTimestamp(message?.createdTimestamp)) return Number(message.createdTimestamp)
    const createdAt = message?.createdAt?.getTime?.()
    if (isValidMessageTimestamp(createdAt)) return createdAt
    return snowflakeTimestamp(message?.id) ?? INVALID_MESSAGE_TIMESTAMP
}

function messageCreatedAt(message) {
    const timestamp = messageTimestamp(message)
    return timestamp === INVALID_MESSAGE_TIMESTAMP ? '' : new Date(timestamp).toISOString()
}

function messageCreatedTimestamp(message) {
    const timestamp = messageTimestamp(message)
    return timestamp === INVALID_MESSAGE_TIMESTAMP
        ? ''
        : `<t:${Math.floor(timestamp / 1000)}:F>`
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

function makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message, deletedBy }) {
    const author = message?.author
    const member = message?.member ?? message?.guild?.members?.cache?.get?.(author?.id)
    const name = member?.displayName ?? author?.globalName ?? author?.username ?? author?.tag ?? 'Unknown message author'
    const avatarSource = typeof member?.displayAvatarURL === 'function' ? member
        : typeof author?.displayAvatarURL === 'function' ? author : null
    const iconURL = avatarSource?.displayAvatarURL({ dynamic: true })
    const actor = deletedBy?.id
        ? `<@${deletedBy.id}>`
        : 'record unavailable'
    const createdTimestamp = messageCreatedTimestamp(message)
    return buildCopyableMessageEmbeds({
        title: 'Message Deleted 🗑️',
        searchableText: `Deleted by: ${actor}\nMessage Author: ${author?.id ? `<@${author.id}>` : 'record unavailable'}`,
        contentLabel: 'Message', content: message?.content != null ? message.content : 'Cache Empty',
        contentFooter: createdTimestamp ? `Created at: ${createdTimestamp}` : undefined,
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
    const singleQueues = new Map()
    const singleWorkers = new Map()
    let cleanupTimer = null

    function sweepExpiredState() {
        const currentTime = now()
        for (const [guildId, state] of guildStates) {
            pruneRecords(state, currentTime)
            if (!state.records.size && !singleQueues.has(guildId)) {
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
        const state = existing ?? { records: new Map() }
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

    function mergeEntries(guildId, type, entries, preferCurrent = false) {
        const state = stateForGuild(guildId)
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

    function bufferedEntries(guildId, type) {
        return [...stateForGuild(guildId).records.values()]
            .filter((record) => record.type === type && isRecent(record.entry, now()))
    }

    async function fetchEntries(guild, type) {
        const logs = await guild.fetchAuditLogs({ type, limit: 20 })
        mergeEntries(guild.id, type, auditEntries(logs), true)
        return bufferedEntries(guild.id, type)
    }

    function candidatesForMessage(records, message) {
        const authorId = message?.author?.id
        const channelId = messageChannelId(message)
        if (!authorId || !channelId) return []
        return records.filter((record) => (
            auditExecutorId(record.entry)
            && sameId(auditTargetId(record.entry), authorId)
            && sameId(auditChannelId(record.entry), channelId)
        ))
    }

    function resolveSingleBatch(guildId, pending) {
        const state = stateForGuild(guildId)
        const candidates = new Map()
        const matched = new Map()
        const groups = new Map()
        const records = bufferedEntries(guildId, 72)

        for (const pendingRecord of pending) {
            const matches = candidatesForMessage(records, pendingRecord.message)
            candidates.set(pendingRecord, matches)
            const openMatches = matches.filter((record) => !record.closedForSingles)
            const channelId = messageChannelId(pendingRecord.message)
            if (!openMatches.length || new Set(openMatches.map((record) => auditExecutorId(record.entry))).size > 1) continue
            const key = `${pendingRecord.message.author.id}\0${channelId}\0${auditExecutorId(openMatches[0].entry)}`
            const group = groups.get(key) ?? []
            group.push(pendingRecord)
            groups.set(key, group)
        }
        for (const group of groups.values()) {
            const common = candidates.get(group[0]).filter((candidate) => group.every((record) => (
                candidates.get(record).some((other) => other.key === candidate.key)
            )))
            const eligible = common.filter((candidate) => !candidate.closedForSingles
                && candidate.consumedSingles < candidate.count)
            const available = eligible.reduce((total, candidate) => total + candidate.count - candidate.consumedSingles, 0)
            if (available < group.length) continue
            for (const record of group) {
                const candidate = eligible.find((entry) => entry.consumedSingles < entry.count)
                candidate.consumedSingles += 1
                candidate.expiresAt = now() + AUDIT_BUFFER_TTL_MS
                matched.set(record, auditExecutor(candidate.entry))
            }
        }
        pruneRecords(state, now())
        if (matched.size) scheduleCleanup()
        return { matched, candidates }
    }

    function closeUnresolvedSingles(guildId, observedCandidates, unresolved) {
        const state = stateForGuild(guildId)
        for (const record of unresolved) {
            const candidates = observedCandidates.get(record) ?? []
            for (const candidate of candidates) {
                candidate.consumedSingles = Math.max(candidate.consumedSingles, candidate.count)
                candidate.closedForSingles = true
                candidate.expiresAt = now() + AUDIT_BUFFER_TTL_MS
            }
        }
        pruneRecords(state, now())
        scheduleCleanup()
    }

    function mergeObservedCandidates(observed, candidates) {
        for (const [record, records] of candidates) {
            const current = observed.get(record) ?? []
            const known = new Set(current.map((candidate) => candidate.key))
            observed.set(record, current.concat(records.filter((candidate) => !known.has(candidate.key))))
        }
    }

    function applySingleResolution(guildId, pending, observedCandidates, matched) {
        const resolution = resolveSingleBatch(guildId, pending)
        mergeObservedCandidates(observedCandidates, resolution.candidates)
        for (const [record, executor] of resolution.matched) matched.set(record, executor)
        return pending.filter((record) => !matched.has(record))
    }

    async function attemptSingleDelivery(errors, message, deletedBy) {
        try {
            for (const embed of makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message, deletedBy })) {
                await botLog(message.guild, embed, 1, 'messages')
            }
        } catch (error) {
            errors.push(error)
        }
    }

    async function reconcileSingleQueue(guildId) {
        const queue = singleQueues.get(guildId)
        if (!queue?.readyForReconciliation) return
        singleQueues.delete(guildId)
        const pending = [...queue.records]
        const observedCandidates = new Map()
        const matched = new Map()
        let unresolved = applySingleResolution(guildId, pending, observedCandidates, matched)
        const fetchErrors = []
        let fetchedAuditRecords = false
        for (const delay of reconciliationDelays) {
            if (!unresolved.length) break
            await wait(delay)
            unresolved = applySingleResolution(guildId, unresolved, observedCandidates, matched)
            if (!unresolved.length) break
            try {
                await fetchEntries(queue.guild, 72)
                fetchedAuditRecords = true
                unresolved = applySingleResolution(guildId, unresolved, observedCandidates, matched)
            } catch (error) {
                fetchErrors.push(error)
            }
        }
        if (fetchErrors.length && !fetchedAuditRecords) {
            console.error('Message deletion audit reconciliation failed after bounded retries:', fetchErrors.at(-1))
        }
        try {
            const deliveryErrors = []
            for (const [record, executor] of matched) {
                await attemptSingleDelivery(deliveryErrors, record.message, executor)
            }
            closeUnresolvedSingles(guildId, observedCandidates, unresolved)
            for (const record of unresolved) {
                await attemptSingleDelivery(deliveryErrors, record.message, 'unavailable')
            }
            if (deliveryErrors.length) throw new AggregateError(deliveryErrors, 'Message deletion BotLog delivery failed.')
        } finally {
            for (const record of pending) record.resolve()
        }
    }

    function recordSingleDeletion(message) {
        const guild = message?.guild
        if (!guild?.id) return Promise.resolve()
        let queue = singleQueues.get(guild.id)
        if (!queue) {
            queue = { guild, records: [], readyForReconciliation: false }
            singleQueues.set(guild.id, queue)
            Promise.resolve().then(() => wait(batchDelay)).then(() => {
                queue.readyForReconciliation = true
                startSingleQueueWorker(guild.id)
            })
                .catch((error) => console.error('Message deletion logging failed:', error))
        }
        return new Promise((resolve) => queue.records.push({ message, resolve }))
    }

    function startSingleQueueWorker(guildId) {
        if (singleWorkers.has(guildId)) return
        const worker = (async () => {
            while (singleQueues.get(guildId)?.readyForReconciliation) await reconcileSingleQueue(guildId)
        })()
        singleWorkers.set(guildId, worker)
        worker.catch((error) => console.error('Message deletion logging failed:', error)).finally(() => {
            singleWorkers.delete(guildId)
            if (singleQueues.get(guildId)?.readyForReconciliation) startSingleQueueWorker(guildId)
        })
    }

    function resolveBulk(guildId, channelId, count) {
        const candidates = channelId ? bufferedEntries(guildId, 73).filter((record) => (
            record.entry?.executor?.id
            && sameId(bulkAuditChannelId(record.entry), channelId)
            && record.count === count
            && !record.bulkConsumed
        )) : []
        if (new Set(candidates.map((record) => record.entry.executor.id)).size !== 1) return null
        const candidate = candidates.sort((left, right) => entryTimestamp(right.entry) - entryTimestamp(left.entry))[0]
        candidate.bulkConsumed = true
        candidate.expiresAt = now() + AUDIT_BUFFER_TTL_MS
        pruneRecords(stateForGuild(guildId), now())
        scheduleCleanup()
        return candidate.entry.executor
    }

    async function recordBulkDeletion(messages, channel) {
        const records = collectionValues(messages)
        if (!records.length) return
        const guild = channel?.guild ?? records[0]?.guild
        if (!guild?.id) return
        const channelId = channel?.id ?? messageChannelId(records[0])
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
