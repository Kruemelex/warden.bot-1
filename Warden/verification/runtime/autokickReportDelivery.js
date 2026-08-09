'use strict';

const crypto = require('node:crypto');
const Discord = require('discord.js');
const { botLog } = require('../../../functions');

const REPORT_NAMESPACE = 'warden:verification-autokick:v1';
const pendingAcknowledgements = new Map();

function generation(source) {
    return {
        guildId: String(source?.guildId ?? ''),
        userId: String(source?.userId ?? ''),
        joinedAtMs: Number(source?.joinedAtMs),
    };
}

function reportKey(source) {
    const target = generation(source);
    return `${target.guildId}:${target.userId}:${target.joinedAtMs}`;
}

function buildAutokickReportNonce(source) {
    const target = generation(source);
    if (!target.guildId || !target.userId || !Number.isSafeInteger(target.joinedAtMs)) {
        throw new Error('Verification autokick report requires a complete membership generation.');
    }
    return crypto.createHash('sha256')
        .update(REPORT_NAMESPACE).update('\0')
        .update(target.guildId).update('\0')
        .update(target.userId).update('\0')
        .update(String(target.joinedAtMs))
        .digest('hex').slice(0, 24);
}

function formatAutokickReportUser(entry) {
    const userTag = String(entry.reportUserTag ?? entry.userId ?? '').trim();
    const displayName = String(entry.reportDisplayName ?? '').trim();
    return displayName ? `${userTag} (${displayName})` : userTag;
}

function buildAutokickReportEmbed(entry) {
    const user = formatAutokickReportUser(entry);
    const outcomeUnknown = entry.terminalReason === 'kick-outcome-unknown';
    return new Discord.EmbedBuilder()
        .setTitle(outcomeUnknown ? 'Verification Autokick Outcome Unconfirmed' : 'Verification Autokick')
        .setDescription(outcomeUnknown
            ? `User ${user} was absent after an authorized autokick, but Discord did not provide durable kick confirmation.`
            : `User ${user} was autokicked after not completing verification.`)
        .addFields(
            { name: 'User', value: `<@${entry.userId}>` },
            { name: 'ID', value: `\`\`\`${entry.userId}\`\`\`` },
        );
}

function isPermanentReportError(error) {
    const code = error?.code ?? error?.rawError?.code;
    return new Set([
        Discord.RESTJSONErrorCodes.MissingAccess,
        Discord.RESTJSONErrorCodes.MissingPermissions,
        Discord.RESTJSONErrorCodes.UnknownChannel,
        'WARDEN_BOTLOG_CHANNEL_UNAVAILABLE',
    ].filter((value) => value !== undefined)).has(code);
}

async function acknowledge(record, finishReport) {
    const result = await finishReport({
        ...generation(record),
        leaseToken: record.leaseToken,
        messageId: record.messageId,
    });
    if (!result?.finished) throw new Error('Verification autokick report acknowledgement lost its lease.');
    pendingAcknowledgements.delete(reportKey(record));
    return result;
}

async function deliverAutokickReport({
    guild, entry, leaseToken, finishReport, markDispatched, releaseReport,
    retryDelayMs, maxAttempts = 5,
}) {
    const nonce = entry.reportNonce ?? buildAutokickReportNonce(entry);
    let message;
    try {
        message = await botLog(
            guild,
            buildAutokickReportEmbed(entry),
            1,
            'users',
            {
                nonce,
                enforceNonce: true,
                requireDelivery: true,
                beforeDispatch: async () => {
                    const dispatch = await markDispatched({ ...generation(entry), leaseToken });
                    if (!dispatch?.marked) {
                        const error = new Error('Verification autokick report lost its dispatch lease.');
                        error.code = 'VERIFICATION_AUTOKICK_REPORT_STALE_LEASE';
                        throw error;
                    }
                },
            },
        );
    }
    catch (error) {
        const deliveryUnknown = error?.deliveryMayHaveSucceeded === true;
        await releaseReport({
            ...generation(entry),
            leaseToken,
            retryDelayMs,
            deadLettered: isPermanentReportError(error)
                || entry.reportAttemptCount + 1 >= maxAttempts,
            deliveryUnknown,
            errorCode: error?.code ?? error?.name,
        });
        throw error;
    }

    const record = { ...generation(entry), leaseToken, messageId: String(message.id) };
    try {
        return await acknowledge(record, finishReport);
    }
    catch (error) {
        pendingAcknowledgements.set(reportKey(record), record);
        error.reportAcknowledgementPending = true;
        throw error;
    }
}

async function flushAutokickReportAcknowledgements(guildId, finishReport) {
    const records = [...pendingAcknowledgements.values()]
        .filter((record) => record.guildId === String(guildId));
    const failures = [];
    for (const record of records) {
        try { await acknowledge(record, finishReport); }
        catch (error) { failures.push(error); }
    }
    return { attempted: records.length, remaining: failures.length, failures };
}

function clearAutokickReportAcknowledgements(guildId) {
    const targetGuildId = guildId === undefined || guildId === null ? undefined : String(guildId);
    let cleared = 0;
    for (const [key, record] of pendingAcknowledgements.entries()) {
        if (targetGuildId !== undefined && record.guildId !== targetGuildId) continue;
        pendingAcknowledgements.delete(key);
        cleared += 1;
    }
    return cleared;
}

module.exports = {
    buildAutokickReportNonce,
    clearAutokickReportAcknowledgements,
    deliverAutokickReport,
    flushAutokickReportAcknowledgements,
};
