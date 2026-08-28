const Discord = require('discord.js')

const AUDIT_RETRY_DELAYS_MS = [0, 700, 1400]
const AUDIT_ENTRY_MAX_AGE_MS = 30_000
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

function auditCount(entry) {
    const count = Number(entry?.extra?.count)
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

function entryTimestamp(entry) {
    return Number(entry?.createdTimestamp ?? entry?.createdAt?.getTime?.() ?? 0)
}

function auditEntryKey(entry, type) {
    return `${type}:${String(entry?.id ?? `${entry?.executor?.id ?? ''}:${entryTimestamp(entry)}:${entry?.target?.id ?? ''}:${auditChannelId(entry) ?? ''}`)}`
}

function entryMatchesChannel(entry, channelId) {
    const entryChannelId = auditChannelId(entry)
    return !channelId || entryChannelId === channelId
}

function recentEntry(entry, now) {
    const timestamp = entryTimestamp(entry)
    return timestamp > 0 && Math.abs(now - timestamp) <= AUDIT_ENTRY_MAX_AGE_MS
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
                message?.id ?? '',
                author?.id ?? '',
                authorName,
                messageCreatedAt(message),
                message?.content ?? '',
                attachmentUrls(message),
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
    const member = message?.member
        ?? message?.guild?.members?.cache?.get?.(author?.id)
    const name = member?.displayName
        ?? author?.globalName
        ?? author?.username
        ?? author?.tag
        ?? 'Unknown message author'
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
        contentLabel: 'Message',
        content: message?.content != null ? message.content : 'Cache Empty',
        author: buildMessageAuthorHeader(message),
    })
}

function collectionValues(messages) {
    if (!messages) return []
    if (typeof messages.values === 'function') return Array.from(messages.values())
    return Array.isArray(messages) ? messages : []
}

function createMessageDeletionLogger({ botLog, buildCopyableMessageEmbeds, discord = Discord, wait = sleep, retryDelays = AUDIT_RETRY_DELAYS_MS, now = Date.now } = {}) {
    if (typeof botLog !== 'function') throw new Error('A botLog function is required.')
    if (typeof buildCopyableMessageEmbeds !== 'function') throw new Error('A message embed builder is required.')
    const pendingByGuild = new Map()
    const auditUsageByGuild = new Map()

    async function fetchAuditEntries(guild, type) {
        const logs = await guild.fetchAuditLogs({ type, limit: 20 })
        return auditEntries(logs)
    }

    function usageForGuild(guildId) {
        const usageByEntry = auditUsageByGuild.get(guildId) ?? new Map()
        auditUsageByGuild.set(guildId, usageByEntry)
        const currentTime = now()
        for (const [key, usage] of usageByEntry) {
            if (usage.expiresAt <= currentTime) usageByEntry.delete(key)
        }
        return { usageByEntry, currentTime }
    }

    function candidatesForMessage(entries, message) {
        const authorId = message?.author?.id
        const channelId = message?.channelId ?? message?.channel?.id
        if (!authorId) return []
        return entries.filter((entry) => (
            entry?.executor?.id
            && String(entry?.target?.id ?? '') === String(authorId)
            && entryMatchesChannel(entry, channelId)
            && recentEntry(entry, now())
        ))
    }

    function resolveBatch(entries, pending, guildId) {
        const { usageByEntry, currentTime } = usageForGuild(guildId)
        const candidates = new Map()
        for (const record of pending) candidates.set(record, candidatesForMessage(entries, record.message))

        const ambiguous = new Set()
        for (const [record, matches] of candidates) {
            const executors = new Set(matches.map((entry) => entry.executor.id))
            if (executors.size > 1) ambiguous.add(record)
        }

        const matched = new Map()
        const partialEntriesByRecord = new Map()
        const groups = new Map()
        for (const record of pending) {
            if (ambiguous.has(record)) continue
            const matches = candidates.get(record)
            if (!matches?.length) continue
            const authorId = String(record.message?.author?.id ?? '')
            const channelId = String(record.message?.channelId ?? record.message?.channel?.id ?? '')
            const executorIds = [...new Set(matches.map((entry) => entry.executor.id))].sort().join(',')
            const key = `${authorId}\0${channelId}\0${executorIds}`
            const group = groups.get(key) ?? []
            group.push(record)
            groups.set(key, group)
        }

        for (const records of groups.values()) {
            const commonEntries = records[0] && [...candidates.get(records[0])]
                .filter((entry) => records.every((record) => candidates.get(record).some((candidate) => (
                    auditEntryKey(candidate, 'message') === auditEntryKey(entry, 'message')
                ))))
                .sort((left, right) => entryTimestamp(right) - entryTimestamp(left))
            const available = commonEntries.reduce((total, entry) => {
                const priorUsage = usageByEntry.get(auditEntryKey(entry, 'message'))?.used ?? 0
                return total + Math.max(0, auditCount(entry) - priorUsage)
            }, 0)
            if (available < records.length) {
                for (const record of records) partialEntriesByRecord.set(record, commonEntries)
                continue
            }

            const allocated = new Map()
            for (const record of records) {
                const entry = commonEntries.find((candidate) => {
                    const key = auditEntryKey(candidate, 'message')
                    const used = (usageByEntry.get(key)?.used ?? 0) + (allocated.get(key) ?? 0)
                    return used < auditCount(candidate)
                })
                if (!entry) break
                const key = auditEntryKey(entry, 'message')
                allocated.set(key, (allocated.get(key) ?? 0) + 1)
                matched.set(record, entry.executor)
            }
            for (const [key, used] of allocated) {
                const existing = usageByEntry.get(key)
                usageByEntry.set(key, {
                    used: (existing?.used ?? 0) + used,
                    expiresAt: Math.max(existing?.expiresAt ?? 0, currentTime + AUDIT_ENTRY_MAX_AGE_MS),
                })
            }
        }
        return { matched, ambiguous, candidates, partialEntriesByRecord }
    }

    async function logSingle(message, deletedBy) {
        const embeds = makeNormalDeletionEmbeds({ buildCopyableMessageEmbeds, message, deletedBy })
        for (const embed of embeds) await botLog(message.guild, embed, 1, 'messages')
    }

    async function flushGuild(guildId) {
        const batch = pendingByGuild.get(guildId)
        if (!batch) return
        pendingByGuild.delete(guildId)
        try {
            let unresolved = [...batch.records]
            let auditFailed = false
            const ambiguous = new Set()
            const uncertain = new Set()
            const partialEntriesByRecord = new Map()

            for (const delay of retryDelays) {
                if (!unresolved.length) break
                if (delay > 0) await wait(delay)
                if (!unresolved.length) break
                try {
                    const entries = await fetchAuditEntries(batch.guild, 72)
                    const resolution = resolveBatch(entries, unresolved, guildId)
                    for (const record of resolution.ambiguous) ambiguous.add(record)
                    const resolved = new Set(resolution.matched.keys())
                    for (const [record, entries] of resolution.partialEntriesByRecord) {
                        partialEntriesByRecord.set(record, entries)
                    }
                    for (const record of unresolved) {
                        if (resolved.has(record) || resolution.ambiguous.has(record)) continue
                        if (resolution.candidates.get(record)?.length) uncertain.add(record)
                        else record.successfulNoMatchAttempts = (record.successfulNoMatchAttempts ?? 0) + 1
                    }
                    await Promise.all([...resolution.matched].map(([record, executor]) => logSingle(record.message, executor)))
                    for (const record of resolved) partialEntriesByRecord.delete(record)
                    unresolved = unresolved.filter((record) => !resolved.has(record))
                } catch (error) {
                    auditFailed = true
                    batch.lastAuditError = error
                }
            }

            if (auditFailed && unresolved.length && batch.lastAuditError) {
                console.error('Message deletion audit reconciliation failed after retries:', batch.lastAuditError)
            }
            if (unresolved.length) {
                const { usageByEntry, currentTime } = usageForGuild(guildId)
                for (const record of unresolved) {
                    for (const entry of partialEntriesByRecord.get(record) ?? []) {
                        const key = auditEntryKey(entry, 'message')
                        const existing = usageByEntry.get(key)
                        usageByEntry.set(key, {
                            used: Math.max(existing?.used ?? 0, auditCount(entry)),
                            expiresAt: Math.max(existing?.expiresAt ?? 0, currentTime + AUDIT_ENTRY_MAX_AGE_MS),
                        })
                    }
                }
            }
            await Promise.all(unresolved.map((record) => logSingle(
                record.message,
                !auditFailed && !ambiguous.has(record) && !uncertain.has(record)
                    && record.successfulNoMatchAttempts >= 2 && record.message?.author?.id
                    ? 'self'
                    : 'unavailable',
            )))
        } finally {
            for (const record of batch.records) record.resolve()
        }
    }

    function recordSingleDeletion(message) {
        const guildId = message?.guild?.id
        if (!guildId || !message?.guild) return Promise.resolve()
        let batch = pendingByGuild.get(guildId)
        if (!batch) {
            batch = { guild: message.guild, records: [], timer: null }
            pendingByGuild.set(guildId, batch)
            batch.timer = setTimeout(() => {
                flushGuild(guildId).catch((error) => console.error('Message deletion logging failed:', error))
            }, 0)
        }
        return new Promise((resolve) => batch.records.push({ message, resolve }))
    }

    function bulkAuditCandidates(entries, channelId, recordCount) {
        return entries.filter((entry) => (
            entry?.executor?.id
            && Boolean(channelId)
            && auditChannelId(entry) === channelId
            && Number.isFinite(Number(entry?.extra?.count))
            && Math.floor(Number(entry.extra.count)) === recordCount
            && recentEntry(entry, now())
        ))
    }

    async function recordBulkDeletion(messages, channel) {
        const records = collectionValues(messages)
        if (!records.length) return
        const guild = channel?.guild ?? records[0]?.guild
        if (!guild) return
        const channelId = channel?.id ?? records[0]?.channelId ?? records[0]?.channel?.id
        let executor = null
        let auditFailed = false
        let lastAuditError
        for (const delay of retryDelays) {
            if (delay > 0) await wait(delay)
            try {
                const { usageByEntry, currentTime } = usageForGuild(guild.id)
                const matches = bulkAuditCandidates(await fetchAuditEntries(guild, 73), channelId, records.length)
                    .filter((entry) => !usageByEntry.has(auditEntryKey(entry, 'bulk')))
                const executors = new Map(matches.map((entry) => [entry.executor.id, entry.executor]))
                if (executors.size === 1) {
                    const entry = matches.sort((left, right) => entryTimestamp(right) - entryTimestamp(left))[0]
                    executor = entry.executor
                    usageByEntry.set(auditEntryKey(entry, 'bulk'), {
                        used: 1,
                        expiresAt: currentTime + AUDIT_ENTRY_MAX_AGE_MS,
                    })
                    break
                }
            } catch (error) {
                auditFailed = true
                lastAuditError = error
            }
        }
        if (auditFailed && !executor && lastAuditError) {
            console.error('Bulk message deletion audit reconciliation failed after retries:', lastAuditError)
        }
        const recovered = records.filter((message) => Boolean(message?.author?.id) && !message?.partial)
        const authors = new Map()
        for (const message of sortMessages(recovered)) {
            authors.set(message.author.id, (authors.get(message.author.id) ?? 0) + 1)
        }
        const authorText = authors.size
            ? [...authors.entries()].map(([id, count]) => `<@${id}> (${count})`).join(', ')
            : 'record unavailable'
        const deletedBy = executor?.id ? `<@${executor.id}>` : 'record unavailable'
        const description = [
            `Deleted by: ${deletedBy}`,
            `Messages deleted: ${records.length}`,
            `Message records recovered: ${recovered.length}`,
            `Records unavailable: ${records.length - recovered.length}`,
            '',
            `Message Authors: ${authorText}`,
            '',
            `Channel: ${channelId ? `<#${channelId}>` : 'record unavailable'}`,
        ].join('\n')
        const embed = new discord.EmbedBuilder()
            .setTitle('Messages Bulk Deleted 🗑️')
            .setDescription(description)
        const csv = buildBulkCsv(records)
        await botLog(guild, embed, 1, 'messages', {
            files: [{ attachment: Buffer.from(csv, 'utf8'), name: 'bulk-deleted-messages.csv' }],
        })
    }

    return { recordSingleDeletion, recordBulkDeletion }
}

module.exports = {
    createMessageDeletionLogger,
    buildBulkCsv,
    csvEscape,
}
