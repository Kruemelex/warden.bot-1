'use strict';

const { isLeaderboardMigrationMode } = require('../db/leaderboards/migrationGuard');
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

function isLeaderboardAvailabilityError(error) {
    return [
        'LEADERBOARD_MIGRATION_MODE',
        'LEADERBOARD_MAINTENANCE_MODE',
        'LEADERBOARD_SUBMISSIONS_HALTED',
    ].includes(error?.code);
}

async function assertLeaderboardMutationAllowed(guildId) {
    if (isLeaderboardMigrationMode()) {
        const error = new Error('Leaderboards are temporarily unavailable during encrypted-data migration.');
        error.code = 'LEADERBOARD_MIGRATION_MODE';
        throw error;
    }
    const current = await settings.get(guildId);
    if (current.mode === 'maintenance') throw maintenanceError();
    return current;
}

async function assertLeaderboardSubmissionAllowed(guildId, type) {
    if (!['speedrun', 'ace'].includes(type)) throw new Error('Unknown Leaderboard submission type.');
    const current = await assertLeaderboardMutationAllowed(guildId);
    const mode = type === 'speedrun' ? current.speedrunSubmissionMode : current.aceSubmissionMode;
    if (mode === 'halted') throw submissionHaltedError(type);
    return current;
}

module.exports = {
    assertLeaderboardMutationAllowed,
    assertLeaderboardSubmissionAllowed,
    isLeaderboardAvailabilityError,
    maintenanceError,
    submissionHaltedError,
};
