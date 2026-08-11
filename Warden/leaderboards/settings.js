'use strict';

const { botIdent } = require('../../functions');
const repository = require('./settingsRepository');
const { runWithLeaderboardWriteLock } = require('./writeCoordinator');

const cache = new Map();

function configuredGuildId() {
    return String(process.env.GUILDID ?? botIdent().activeBot?.guildId ?? '').trim();
}

function assertConfiguredGuild(guildId) {
    const normalized = String(guildId ?? '').trim();
    const configured = configuredGuildId();
    if (!normalized || !configured || normalized !== configured) {
        const error = new Error('Leaderboard settings are available only in Warden’s configured server.');
        error.code = 'LEADERBOARD_SETTINGS_GUILD_MISMATCH';
        throw error;
    }
    return normalized;
}

function publish(settings) {
    if (settings) cache.set(String(settings.guildId), settings);
    return settings;
}

async function initialize(guildId) {
    const normalized = assertConfiguredGuild(guildId);
    await repository.ensureSchema();
    return publish(await repository.read(normalized) ?? await repository.seed(normalized));
}

async function refresh(guildId) {
    const normalized = assertConfiguredGuild(guildId);
    return publish(await repository.read(normalized) ?? await repository.seed(normalized));
}

async function get(guildId) {
    const normalized = assertConfiguredGuild(guildId);
    return cache.get(normalized) ?? refresh(normalized);
}

async function update(guildId, patch, expectedRevision, updatedBy) {
    const normalized = assertConfiguredGuild(guildId);
    return runWithLeaderboardWriteLock(normalized, async () => (
        publish(await repository.update(normalized, patch, expectedRevision, updatedBy))
    ));
}

function clear() {
    cache.clear();
}

module.exports = {
    assertConfiguredGuild,
    clear,
    get,
    initialize,
    refresh,
    update,
};
