'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const migrationContext = new AsyncLocalStorage();
let activeMigration;

function isLeaderboardMigrationMode() {
    return String(process.env.WARDEN_LEADERBOARD_MIGRATION_MODE ?? '').toLowerCase() === 'true';
}

function createMigrationModeError() {
    const error = new Error('Leaderboards are temporarily unavailable while Staff complete encrypted-data migration.');
    error.code = 'LEADERBOARD_MIGRATION_MODE';
    return error;
}

function assertLeaderboardWritesAllowed() {
    if (isLeaderboardMigrationMode() && migrationContext.getStore() !== true) {
        throw createMigrationModeError();
    }
}

async function runExclusiveLeaderboardMigration(work) {
    if (!isLeaderboardMigrationMode()) {
        throw new Error('Set WARDEN_LEADERBOARD_MIGRATION_MODE=true and restart every Warden instance before migration.');
    }
    if (activeMigration) throw new Error('A Leaderboard migration is already running.');
    const operation = migrationContext.run(true, () => Promise.resolve().then(work));
    activeMigration = operation;
    try {
        return await operation;
    }
    finally {
        if (activeMigration === operation) activeMigration = undefined;
    }
}

module.exports = {
    assertLeaderboardWritesAllowed,
    isLeaderboardMigrationMode,
    runExclusiveLeaderboardMigration,
};
