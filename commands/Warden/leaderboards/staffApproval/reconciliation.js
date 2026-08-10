'use strict';

const Discord = require('discord.js');
const { botLog } = require('../../../../functions');
const { getLeaderboardApprovalChannelId } = require('../../../../loggingSettings/service');
const {
    listPendingSubmissions,
    setApprovalMessageId,
} = require('../../../../Warden/db/leaderboards/repository');
const { buildApprovalMessage } = require('../leaderboardApprovalMessages');
const { isLeaderboardMigrationMode } = require('../../../../Warden/db/leaderboards/migrationGuard');

const RECONCILIATION_INTERVAL_MS = 3500;

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

async function reportReconciliationError(guild, type, submission, error) {
    console.error(`Leaderboard reconciliation failed for ${type} #${submission.id}:`, error);
    await botLog(
        guild,
        new Discord.EmbedBuilder()
            .setDescription(`\`\`\`${error.stack}\`\`\``)
            .setTitle(`⛔ Fatal error experienced: reconcileLeaderboard(${type}, ${submission.id})`),
        2,
        'error',
    ).catch((logError) => console.error('Failed to log Leaderboard reconciliation error:', logError));
}

async function reconcilePendingLeaderboardApprovals(guild) {
    if (isLeaderboardMigrationMode()) return { reconciled: 0, skipped: 'migration-mode' };
    const channelId = getLeaderboardApprovalChannelId(guild.id);
    if (!channelId) return { reconciled: 0 };
    const channel = await guild.channels.fetch(channelId);
    let reconciled = 0;

    for (const type of ['speedrun', 'ace']) {
        const submissions = await listPendingSubmissions(type);
        for (let index = 0; index < submissions.length; index += 1) {
            const submission = submissions[index];
            try {
                const message = await reconcileSubmission(channel, type, submission);
                reconciled += 1;
                const minutesRemaining = (((submissions.length - index - 1) * RECONCILIATION_INTERVAL_MS) / 60000).toFixed(2);
                console.log(`Processed leaderboard message: ${type}`.green, {
                    id: submission.id,
                    embed_id: message.id,
                }, minutesRemaining);
            }
            catch (error) {
                await reportReconciliationError(guild, type, submission, error);
            }
            if (index < submissions.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, RECONCILIATION_INTERVAL_MS));
            }
        }
        if (submissions.length > 0) console.log(`Processed ${type} Messages Completed`.cyan);
    }
    return { reconciled };
}

module.exports = {
    reconcilePendingLeaderboardApprovals,
};
