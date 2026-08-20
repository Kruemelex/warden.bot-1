'use strict';

const settings = require('./settings');

function maintenanceError() {
    const error = new Error('Leaderboards are temporarily in maintenance mode. New submissions and Staff changes are paused.');
    error.code = 'LEADERBOARD_MAINTENANCE_MODE';
    return error;
}

function submissionHaltedError(type) {
    const label = type === 'speedrun' ? 'Speedrun' : 'Ace';
    const error = new Error(`${label} submissions are temporarily halted.`);
    error.code = 'LEADERBOARD_SUBMISSIONS_HALTED';
    error.submissionType = type;
    return error;
}

function submissionChannelUnconfiguredError(type) {
    const label = type === 'speedrun' ? 'Speedrun' : 'Ace';
    const error = new Error(`${label} submissions are unavailable until Staff configure their submission channel.`);
    error.code = 'LEADERBOARD_SUBMISSION_CHANNEL_UNCONFIGURED';
    error.submissionType = type;
    return error;
}

function getSubmissionChannelId(current, type) {
    return type === 'speedrun'
        ? current.speedrunSubmissionChannelId
        : current.aceSubmissionChannelId;
}

function isLeaderboardAvailabilityError(error) {
    return [
        'LEADERBOARD_MAINTENANCE_MODE',
        'LEADERBOARD_SUBMISSIONS_HALTED',
        'LEADERBOARD_SUBMISSION_CHANNEL_UNCONFIGURED',
    ].includes(error?.code);
}

async function assertLeaderboardMutationAllowed(guildId) {
    const current = await settings.get(guildId);
    if (current.mode === 'maintenance') throw maintenanceError();
    return current;
}

async function assertLeaderboardSubmissionAllowed(guildId, type) {
    if (!['speedrun', 'ace'].includes(type)) throw new Error('Unknown Leaderboard submission type.');
    const current = await assertLeaderboardMutationAllowed(guildId);
    const mode = type === 'speedrun' ? current.speedrunSubmissionMode : current.aceSubmissionMode;
    if (mode === 'halted') throw submissionHaltedError(type);
    if (!getSubmissionChannelId(current, type)) throw submissionChannelUnconfiguredError(type);
    return current;
}

module.exports = {
    assertLeaderboardMutationAllowed,
    assertLeaderboardSubmissionAllowed,
    isLeaderboardAvailabilityError,
    maintenanceError,
    getSubmissionChannelId,
    submissionChannelUnconfiguredError,
    submissionHaltedError,
};
