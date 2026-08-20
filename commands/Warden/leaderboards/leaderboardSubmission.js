'use strict';

const { buildApprovalMessage } = require('./leaderboardApprovalMessages');
const { getLeaderboardApprovalChannelId } = require('../../../logging/loggingSettings/service');
const {
    insertSubmission,
    setApprovalMessageId,
} = require('../../../Warden/db/leaderboards/repository');
const {
    assertLeaderboardSubmissionAllowed,
    getSubmissionChannelId,
} = require('../../../Warden/leaderboards/policy');
const { runWithLeaderboardWriteLock } = require('../../../Warden/leaderboards/writeCoordinator');
const { assertUsableSubmissionChannel } = require('../../../Warden/leaderboards/submissionChannels');

async function createLeaderboardSubmission(interaction, type, submission) {
    const initialSettings = await assertLeaderboardSubmissionAllowed(interaction.guildId, type);
    const submissionChannelId = getSubmissionChannelId(initialSettings, type);
    const submissionChannel = assertUsableSubmissionChannel(
        await interaction.guild.channels.fetch(submissionChannelId),
        {
            guildId: interaction.guildId,
            botMember: interaction.guild.members?.me,
            label: type === 'speedrun' ? 'Speedrun' : 'Ace',
        },
    );
    const channelId = getLeaderboardApprovalChannelId(interaction.guildId);
    const channel = channelId && interaction.guild.channels.cache.get(channelId);
    if (!channel) throw new Error('Staff Channel not found.');

    const stored = await runWithLeaderboardWriteLock(interaction.guildId, async () => {
        const current = await assertLeaderboardSubmissionAllowed(interaction.guildId, type);
        if (getSubmissionChannelId(current, type) !== submissionChannelId) {
            const error = new Error('Leaderboard submission settings changed while the submission was being prepared. Please try again.');
            error.code = 'LEADERBOARD_SUBMISSION_SETTINGS_CHANGED';
            throw error;
        }
        return insertSubmission(type, submission);
    });
    let post;
    try {
        post = await channel.send(buildApprovalMessage(type, stored));
        const confirmed = await setApprovalMessageId(type, stored.id, post.id);
        return { submission: confirmed, submissionChannel };
    }
    catch (error) {
        error.submissionId = stored.id;
        error.approvalPostId = post?.id;
        throw error;
    }
}

async function publishLeaderboardSubmissionConfirmation(interaction, created, embed) {
    const submissionId = created?.submission?.id;
    const submissionChannel = created?.submissionChannel;
    if (!submissionId || !submissionChannel?.id || typeof submissionChannel.send !== 'function') {
        throw new Error('Leaderboard submission confirmation requires a stored submission and destination channel.');
    }
    await submissionChannel.send({ embeds: [embed] });
    await interaction.editReply({
        content: `✅ Submission #${submissionId} recorded and posted in <#${submissionChannel.id}>. It is now up for review by Staff.`,
    });
}

module.exports = {
    createLeaderboardSubmission,
    publishLeaderboardSubmissionConfirmation,
};
