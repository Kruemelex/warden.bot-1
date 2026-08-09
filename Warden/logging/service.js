'use strict';

const { botIdent, registerBotLogDestinationResolver } = require('../../functions');
const store = require('./settingsStore');

const LOG_TYPE_CHANNEL_KEYS = Object.freeze({
    users: 'users',
    messages: 'messages',
    staff: 'staff',
    error: 'error',
});
const cache = new Map();

function assertConfiguredGuild(guildId) {
    const normalizedGuildId = String(guildId ?? '').trim();
    const configuredGuildId = String(process.env.GUILDID ?? botIdent().activeBot.guildId ?? '').trim();
    if (!normalizedGuildId || !configuredGuildId || normalizedGuildId !== configuredGuildId) {
        const error = new Error('Warden logging settings are available only in Warden’s configured server.');
        error.code = 'WARDEN_LOGGING_GUILD_MISMATCH';
        throw error;
    }
    return normalizedGuildId;
}

function normalizeChannelId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function getBootstrapChannels() {
    const activeBot = botIdent().activeBot;
    return {
        general: normalizeChannelId(activeBot.logsChannel),
        users: normalizeChannelId(activeBot.logsChannel),
        messages: normalizeChannelId(activeBot.messagesChannel),
        error: normalizeChannelId(activeBot.errorChannel),
        staff: normalizeChannelId(activeBot.staffChannel),
        approvals: normalizeChannelId(process.env.STAFFCHANNELID)
            ?? normalizeChannelId(activeBot.staffChannel),
    };
}

function publish(settings) {
    if (settings) cache.set(settings.guildId, settings);
    return settings;
}

function getCached(guildId) {
    return cache.get(String(guildId));
}

async function initializeGuild(guildId) {
    const normalizedGuildId = assertConfiguredGuild(guildId);
    await store.ensureSchema();
    const settings = await store.read(normalizedGuildId)
        ?? await store.seed(normalizedGuildId, getBootstrapChannels());
    publish(settings);
    return settings;
}

async function refreshGuild(guildId) {
    const normalizedGuildId = assertConfiguredGuild(guildId);
    const settings = await store.read(normalizedGuildId);
    if (!settings) return initializeGuild(guildId);
    return publish(settings);
}

function resolveBotLogDestination({ guildId, logType }) {
    try {
        assertConfiguredGuild(guildId);
    }
    catch (_error) {
        return guildId ? null : undefined;
    }
    const settings = getCached(guildId);
    if (!settings) return undefined;
    const channelKey = LOG_TYPE_CHANNEL_KEYS[logType] ?? 'general';
    return settings.channels[channelKey];
}

function registerDestinationResolver() {
    registerBotLogDestinationResolver(resolveBotLogDestination);
}

async function updateGuild(guildId, patch, expectedRevision, updatedBy) {
    const normalizedGuildId = assertConfiguredGuild(guildId);
    return publish(await store.update(
        normalizedGuildId,
        patch,
        expectedRevision,
        updatedBy,
    ));
}

function getLeaderboardApprovalChannelId(guildId) {
    try {
        assertConfiguredGuild(guildId);
    }
    catch (_error) {
        return null;
    }
    const settings = getCached(guildId);
    return settings
        ? settings.channels.approvals
        : normalizeChannelId(process.env.STAFFCHANNELID);
}

module.exports = {
    assertConfiguredGuild,
    getCached,
    getLeaderboardApprovalChannelId,
    initializeGuild,
    refreshGuild,
    registerDestinationResolver,
    updateGuild,
};
