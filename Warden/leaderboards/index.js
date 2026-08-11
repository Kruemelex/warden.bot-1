'use strict';

const admin = require('./admin');
const personalHistory = require('../../commands/Warden/leaderboards/personalLeaderboardPagination');
const settings = require('./settings');
const publisher = require('./websitePublisher');
const { isLeaderboardMigrationMode } = require('../db/leaderboards/migrationGuard');

async function initializeLeaderboardWebsite({ guild, guildId } = {}) {
    if (!guild || String(guild.id) !== String(guildId)) {
        throw new Error('Leaderboard website startup requires Warden’s configured guild.');
    }
    await settings.initialize(guildId);
    if (isLeaderboardMigrationMode()) return { skipped: 'migration-mode' };
    if (!publisher.isWebsiteSyncConfigured()) return { skipped: 'unconfigured' };
    publisher.startWebsiteSyncLifecycle(guild);
    return publisher.requestWebsiteSync(guildId, { full: true }, { reason: 'startup' });
}

function shutdownLeaderboardWebsite() {
    publisher.stopWebsiteSyncLifecycle();
    settings.clear();
}

async function handleInteraction(interaction) {
    if (await personalHistory.handleInteraction(interaction)) return true;
    return admin.handleInteraction(interaction);
}

module.exports = {
    execute: admin.execute,
    handleInteraction,
    initializeLeaderboardWebsite,
    publishApprovedSubmission: publisher.publishApprovedSubmission,
    shutdownLeaderboardWebsite,
};
