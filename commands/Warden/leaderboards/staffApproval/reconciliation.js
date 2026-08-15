'use strict';

const Discord = require('discord.js');
const { createConsoleReporter } = require('../../../../logging/consoleReporting');
const { botLog } = require('../../../../functions');
const { getLeaderboardApprovalChannelId } = require('../../../../logging/loggingSettings/service');
const { retryTransientDatabaseOperation } = require('../../../../Warden/db/errorPolicy');
const {
    listPendingSubmissions,
    setApprovalMessageId,
} = require('../../../../Warden/db/leaderboards/repository');
const { buildApprovalMessage } = require('../leaderboardApprovalMessages');

const RECONCILIATION_INTERVAL_MS = 3500;
const activeReconciliations = new Map();
const report = createConsoleReporter('Leaderboard').forSubsystem('Reconciliation');

function isUnknownMessage(error) {
    return (error?.code ?? error?.rawError?.code) === 10008 || error?.status === 404;
}

async function reconcileSubmission(channel, type, submission) {
    const payload = buildApprovalMessage(type, submission);
    let message;
    if (submission.embed_id) {
        try {
            message = await channel.messages.fetch(submission.embed_id);
        }
        catch (error) {
            if (!isUnknownMessage(error)) throw error;
        }
    }
    if (message) await message.edit(payload);
    else {
        message = await channel.send(payload);
        await setApprovalMessageId(type, submission.id, message.id);
    }
    return message;
}

async function reportReconciliationError(guild, type, submission, error, reason) {
    report.error('Approval post refresh failed', error, {
        reason,
        type,
        submissionId: submission.id,
    });
    await botLog(
        guild,
        new Discord.EmbedBuilder()
            .setDescription(`\`\`\`${error.stack}\`\`\``)
            .setTitle(`⛔ Leaderboard reconciliation failed: ${type} #${submission.id}`),
        2,
        'error',
    ).catch((logError) => report.error('Discord error report failed', logError, {
        type,
        submissionId: submission.id,
    }));
}

async function reportReconciliationListError(guild, type, error, reason) {
    report.error('Pending submissions unavailable after retries', error, { reason, type });
    await botLog(
        guild,
        new Discord.EmbedBuilder()
            .setDescription(`\`\`\`${error.stack}\`\`\``)
            .setTitle(`⛔ Leaderboard reconciliation could not load ${type} submissions`),
        2,
        'error',
    ).catch((logError) => report.error('Discord error report failed', logError, { type }));
}

async function reconcilePendingLeaderboardApprovalsNow(guild, reason) {
    const channelId = getLeaderboardApprovalChannelId(guild.id);
    if (!channelId) return { reconciled: 0 };
    const channel = await guild.channels.fetch(channelId);
    let reconciled = 0;

    for (const type of ['speedrun', 'ace']) {
        let submissions;
        try {
            ({ value: submissions } = await retryTransientDatabaseOperation(
                () => listPendingSubmissions(type),
                { maxAttempts: 3, backoffMultiplier: 2 },
            ));
        }
        catch (error) {
            await reportReconciliationListError(guild, type, error, reason);
            continue;
        }
        const startedAt = Date.now();
        let typeReconciled = 0;
        let typeFailed = 0;
        for (let index = 0; index < submissions.length; index += 1) {
            const submission = submissions[index];
            try {
                await reconcileSubmission(channel, type, submission);
                reconciled += 1;
                typeReconciled += 1;
            }
            catch (error) {
                typeFailed += 1;
                await reportReconciliationError(guild, type, submission, error, reason);
            }
            if (index < submissions.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, RECONCILIATION_INTERVAL_MS));
            }
        }
        if (submissions.length > 0) {
            report.complete('Approval-post refresh completed', {
                reason,
                type,
                pending: submissions.length,
                reconciled: typeReconciled,
                failed: typeFailed,
                durationMs: Date.now() - startedAt,
            });
        }
    }
    return { reconciled };
}

function reconcilePendingLeaderboardApprovals(guild, { reason = 'unspecified' } = {}) {
    const guildId = String(guild?.id ?? '');
    if (!guildId) return Promise.reject(new Error('Leaderboard approval reconciliation requires a guild.'));
    const existing = activeReconciliations.get(guildId);
    if (existing) return existing;
    const operation = reconcilePendingLeaderboardApprovalsNow(guild, String(reason)).finally(() => {
        if (activeReconciliations.get(guildId) === operation) activeReconciliations.delete(guildId);
    });
    activeReconciliations.set(guildId, operation);
    return operation;
}

module.exports = {
    reconcilePendingLeaderboardApprovals,
};
