'use strict';

const { buildApprovalMessage } = require('./leaderboardApprovalMessages');
const { getLeaderboardApprovalChannelId } = require('../../../loggingSettings/service');
const {
    insertSubmission,
    setApprovalMessageId,
} = require('../../../Warden/db/leaderboards/repository');
const { assertLeaderboardSubmissionAllowed } = require('../../../Warden/leaderboards/policy');
const { runWithLeaderboardWriteLock } = require('../../../Warden/leaderboards/writeCoordinator');

async function createLeaderboardSubmission(interaction, type, submission) {
    await assertLeaderboardSubmissionAllowed(interaction.guildId, type);
    const channelId = getLeaderboardApprovalChannelId(interaction.guildId);
    const channel = channelId && interaction.guild.channels.cache.get(channelId);
    if (!channel) throw new Error('Staff Channel not found.');

    const stored = await runWithLeaderboardWriteLock(interaction.guildId, async () => {
        await assertLeaderboardSubmissionAllowed(interaction.guildId, type);
        return insertSubmission(type, submission);
    });
    let post;
    try {
        post = await channel.send(buildApprovalMessage(type, stored));
        return await setApprovalMessageId(type, stored.id, post.id);
    }
    catch (error) {
        error.submissionId = stored.id;
        error.approvalPostId = post?.id;
        throw error;
    }
}

module.exports = {
    createLeaderboardSubmission,
};
