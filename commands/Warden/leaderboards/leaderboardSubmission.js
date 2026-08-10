'use strict';

const { buildApprovalMessage } = require('./leaderboardApprovalMessages');
const { getLeaderboardApprovalChannelId } = require('../../../loggingSettings/service');
const {
    insertSubmission,
    setApprovalMessageId,
} = require('../../../Warden/db/leaderboards/repository');

async function createLeaderboardSubmission(interaction, type, submission) {
    const channelId = getLeaderboardApprovalChannelId(interaction.guildId);
    const channel = channelId && interaction.guild.channels.cache.get(channelId);
    if (!channel) throw new Error('Staff Channel not found.');

    const stored = await insertSubmission(type, submission);
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
