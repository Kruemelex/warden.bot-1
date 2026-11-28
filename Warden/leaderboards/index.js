'use strict';

const admin = require('./admin');
const personalHistory = require('../../commands/Warden/leaderboards/personalLeaderboardPagination');
const settings = require('./settings');
const publisher = require('./websitePublisher');
let websiteStartup;

async function initializeLeaderboardWebsite({ guild, guildId } = {}) {
    if (!guild || String(guild.id) !== String(guildId)) {
        throw new Error('Leaderboard website startup requires Warden’s configured guild.');
    }
    if (websiteStartup) return websiteStartup;
    const attempt = (async () => {
        await settings.initialize(guildId);
        if (websiteStartup !== attempt) return { skipped: 'shutdown' };
        if (!publisher.isWebsiteSyncConfigured()) return { skipped: 'unconfigured' };
        publisher.startWebsiteSyncLifecycle(guild);
        return publisher.requestWebsiteSync(guildId, { full: true }, { reason: 'startup' });
    })();
    websiteStartup = attempt;
    return websiteStartup;
}

async function shutdownLeaderboardWebsite() {
    const startup = websiteStartup;
    websiteStartup = undefined;
    await publisher.stopWebsiteSyncLifecycle();
    await Promise.allSettled([startup]);
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
