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
            pruneState(state, currentTime)
            if (!state.records.size && !state.auditSnapshots.size && !state.auditUnits.length && !state.events.length && state.overflowUntil <= currentTime && !state.queue && !state.worker) {
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
            records: new Map(), auditSnapshots: new Map(), auditUnits: [], events: [], overflowUntil: 0, order: 0, queue: null, worker: null,
        }
        guildStates.set(guildId, state)
        if (!existing) scheduleCleanup()
        pruneState(state, now())
        return state
    }

    function pruneState(state, currentTime) {
        for (const [key, record] of state.records) if (record.expiresAt <= currentTime) state.records.delete(key)
        const recent = [...state.records.entries()].sort(([, left], [, right]) => (
            right.expiresAt - left.expiresAt || entryTimestamp(right.entry) - entryTimestamp(left.entry)
        ))
        for (const [key] of recent.slice(AUDIT_BUFFER_MAX_ENTRIES)) state.records.delete(key)
        for (const [key, snapshot] of state.auditSnapshots) if (snapshot.expiresAt <= currentTime) state.auditSnapshots.delete(key)
        const snapshots = [...state.auditSnapshots.entries()].sort(([, left], [, right]) => (
            right.expiresAt - left.expiresAt || right.order - left.order
        ))
        for (const [key] of snapshots.slice(AUDIT_BUFFER_MAX_ENTRIES)) state.auditSnapshots.delete(key)
        state.auditUnits = state.auditUnits.filter((unit) => unit.expiresAt > currentTime)
            .sort((left, right) => right.expiresAt - left.expiresAt || right.order - left.order)
            .slice(0, AUDIT_BUFFER_MAX_ENTRIES)
        if (state.overflowUntil <= currentTime) state.overflowUntil = 0
        const events = state.events.filter((event) => event.expiresAt > currentTime)
            .sort((left, right) => left.order - right.order)
        const active = events.filter((event) => !event.delivered)
        const delivered = events.filter((event) => event.delivered)
        const dropped = delivered.slice(0, Math.max(0, delivered.length - AUDIT_BUFFER_MAX_ENTRIES))
        for (const event of dropped) if (event.tombstone) state.overflowUntil = Math.max(state.overflowUntil, event.expiresAt)
        state.events = [...active, ...delivered.slice(-AUDIT_BUFFER_MAX_ENTRIES)].sort((left, right) => left.order - right.order)
    }

    function mergeAuditUnits(state, entries, currentTime) {
        for (const entry of entries) {
            if (!auditExecutorId(entry)) continue
            const key = auditEntryKey(entry, 72)
            const snapshot = state.auditSnapshots.get(key) ?? { count: 0 }
            const count = Math.max(snapshot.count, auditCount(entry))
            for (let index = snapshot.count; index < count; index += 1) {
                state.auditUnits.push({
                    key, executor: entry.executor ?? { id: auditExecutorId(entry) }, targetId: auditTargetId(entry),
                    channelId: auditChannelId(entry), entryTimestamp: entryTimestamp(entry),
                    order: ++state.order, consumed: false, expiresAt: currentTime + AUDIT_BUFFER_TTL_MS,
                })
            }
            snapshot.count = count
            snapshot.order = state.order
            snapshot.expiresAt = currentTime + AUDIT_BUFFER_TTL_MS
            state.auditSnapshots.set(key, snapshot)
        }
    }

    function mergeEntries(state, type, entries, preferCurrent = false) {
        const currentTime = now()
        if (type === 72) {
            mergeAuditUnits(state, entries, currentTime)
            pruneState(state, currentTime)
            scheduleCleanup()
            return
        }
        for (const entry of entries) {
            if (!entry?.executor?.id) continue
            const key = auditEntryKey(entry, type)
            const existing = state.records.get(key)
            const record = existing ?? {
                key, type, bulkConsumed: false,
            }
            record.entry = preferCurrent || !existing || entryTimestamp(entry) >= entryTimestamp(existing.entry)
                ? entry : existing.entry
            record.count = Math.max(record.count ?? 0, auditCount(entry))
            record.expiresAt = currentTime + AUDIT_BUFFER_TTL_MS
            state.records.set(key, record)
        }
        pruneState(state, currentTime)
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

    function exactCandidates(state, event) {
        return state.auditUnits.filter((unit) => (
            !unit.consumed
            && sameId(unit.targetId, event.authorId)
            && sameId(unit.channelId, event.channelId)
            && Math.abs(unit.entryTimestamp - event.createdAt) <= AUDIT_ENTRY_MAX_AGE_MS
        )).sort((left, right) => left.order - right.order)
    }

    function barrierCount(state, event, candidates) {
        if (!candidates.length) return 0
        const timestamps = candidates.map((unit) => unit.entryTimestamp)
        const earliest = Math.min(...timestamps)
        const latest = Math.max(...timestamps)
        return state.events.filter((barrier) => (
            barrier.tombstone && barrier.order < event.order && barrier.channelId
            && sameId(barrier.channelId, event.channelId)
            && (!barrier.authorId || sameId(barrier.authorId, event.authorId))
            && barrier.createdAt >= earliest - AUDIT_ENTRY_MAX_AGE_MS
            && barrier.createdAt <= latest + AUDIT_ENTRY_MAX_AGE_MS
        )).length
    }

    function reconcileEvents(state) {
        if (state.overflowUntil > now()) return
        const groups = new Map()
        for (const event of state.events) {
            if (event.delivered || event.executor || !event.authorId || !event.channelId) continue
            const key = `${event.authorId}\0${event.channelId}`
            const group = groups.get(key) ?? []
            group.push(event)
            groups.set(key, group)
        }
        for (const events of groups.values()) {
            const ordered = [...events].sort((left, right) => left.order - right.order)
            const candidates = exactCandidates(state, ordered[0]).filter((unit) => (
                ordered.every((event) => Math.abs(unit.entryTimestamp - event.createdAt) <= AUDIT_ENTRY_MAX_AGE_MS)
            ))
            const barriers = barrierCount(state, ordered[0], candidates)
            if (candidates.length - barriers < ordered.length) continue
            const executors = new Set(candidates.map((unit) => unit.executor?.id).filter(Boolean))
            if (executors.size !== 1) {
                for (const unit of candidates) unit.consumed = true
                continue
            }
            for (const [index, event] of ordered.entries()) {
                const unit = candidates[barriers + index]
                unit.consumed = true
                event.executor = unit.executor
            }
        }
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
        reconcileEvents(state)
        const fetchErrors = []
        let fetchedAuditRecords = false
        let unresolved = queue.events.filter((event) => !event.executor)
        if (unresolved.length) {
            try {
                await fetchEntries(queue.guild, state, 72)
                fetchedAuditRecords = true
                reconcileEvents(state)
                unresolved = queue.events.filter((event) => !event.executor)
            } catch (error) {
                fetchErrors.push(error)
            }
        }
        for (const delay of reconciliationDelays) {
            if (!unresolved.length) break
            await wait(delay)
            reconcileEvents(state)
            unresolved = queue.events.filter((event) => !event.executor)
            if (!unresolved.length) break
            try {
                await fetchEntries(queue.guild, state, 72)
                fetchedAuditRecords = true
                reconcileEvents(state)
                unresolved = queue.events.filter((event) => !event.executor)
            } catch (error) {
                fetchErrors.push(error)
            }
        }
        if (fetchErrors.length && !fetchedAuditRecords) {
            console.error('Message deletion audit reconciliation failed after bounded retries:', fetchErrors.at(-1))
        }
        try {
            const deliveryErrors = []
            for (const event of queue.events) {
                await attemptSingleDelivery(deliveryErrors, event, event.executor ?? 'unavailable')
                event.delivered = true
                event.tombstone = !event.executor
            }
            if (deliveryErrors.length) throw new AggregateError(deliveryErrors, 'Message deletion BotLog delivery failed.')
        } finally {
            for (const event of queue.events) event.resolve()
        }
    }

    function createDeletionEvent(state, message, resolve) {
        const currentTime = now()
        const event = {
            message, resolve, authorId: message?.author?.id, channelId: messageChannelId(message),
            order: ++state.order, createdAt: currentTime, expiresAt: currentTime + AUDIT_BUFFER_TTL_MS,
            delivered: false, tombstone: false, executor: null,
        }
        state.events.push(event)
        pruneState(state, currentTime)
        scheduleCleanup()
        return event
    }

    async function deliverUnavailableEvent(event) {
        event.tombstone = true
        try {
            const errors = []
            await attemptSingleDelivery(errors, event, 'unavailable')
            if (errors.length) throw new AggregateError(errors, 'Message deletion BotLog delivery failed.')
        } catch (error) {
            console.error('Message deletion logging failed:', error)
        }
        event.delivered = true
        event.resolve()
    }

    function recordSingleDeletion(message) {
        const guild = message?.guild
        if (!guild?.id) return Promise.resolve()
        const state = stateForGuild(guild.id)
        if (!message?.author?.id || !messageChannelId(message)) {
            let resolve
            const result = new Promise((done) => { resolve = done })
            const event = createDeletionEvent(state, message, resolve)
            void deliverUnavailableEvent(event)
            return result
        }
        let queue = state.queue
        if (!queue) {
            queue = { guild, events: [], readyAt: now() + batchDelay }
            state.queue = queue
            startSingleWorker(guild.id, state)
        }
        return new Promise((resolve) => queue.events.push(createDeletionEvent(state, message, resolve)))
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
        pruneState(state, now())
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
