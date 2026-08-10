'use strict';

const {
    botIdent,
    getIdentityBrandColor,
    registerBotLogDestinationResolver,
} = require('../functions');

const DESTINATION_KEYS = Object.freeze({
    Warden: Object.freeze(['general', 'error', 'staff', 'approvals', 'users', 'messages']),
    GuardianAI: Object.freeze(['general', 'error', 'staff', 'users', 'messages']),
});
const LOG_TYPE_CHANNEL_KEYS = Object.freeze({
    users: 'users',
    messages: 'messages',
    staff: 'staff',
    error: 'error',
});
const cache = new Map();
let activeStore;
let activeStoreBotName;

function getProfile() {
    const activeBot = botIdent().activeBot;
    const botName = activeBot?.botName;
    const destinationKeys = DESTINATION_KEYS[botName];
    if (!destinationKeys) throw new Error(`Logging settings do not support bot identity: ${botName ?? 'unknown'}.`);
    return Object.freeze({
        botName,
        destinationKeys,
        identityBrandColor: getIdentityBrandColor(),
    });
}

function getStore() {
    const { botName } = getProfile();
    if (!activeStore || activeStoreBotName !== botName) {
        activeStore = require(`../${botName}/db/logging`);
        activeStoreBotName = botName;
    }
    return activeStore;
}

function cacheKey(guildId) {
    return `${getProfile().botName}:${String(guildId)}`;
}

function assertConfiguredGuild(guildId) {
    const { botName } = getProfile();
    const normalizedGuildId = String(guildId ?? '').trim();
    const configuredGuildId = String(process.env.GUILDID ?? botIdent().activeBot.guildId ?? '').trim();
    if (!normalizedGuildId || !configuredGuildId || normalizedGuildId !== configuredGuildId) {
        const error = new Error(`${botName} logging settings are available only in ${botName}’s configured server.`);
        error.code = 'LOGGING_SETTINGS_GUILD_MISMATCH';
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
    const { botName } = getProfile();
    return {
        general: normalizeChannelId(activeBot.logsChannel),
        users: normalizeChannelId(botName === 'GuardianAI' ? activeBot.staffChannel : activeBot.logsChannel),
        messages: normalizeChannelId(activeBot.messagesChannel),
        error: normalizeChannelId(activeBot.errorChannel),
        staff: normalizeChannelId(activeBot.staffChannel),
        approvals: botName === 'Warden'
            ? normalizeChannelId(process.env.STAFFCHANNELID) ?? normalizeChannelId(activeBot.staffChannel)
            : null,
    };
}

function publish(settings) {
    if (settings) cache.set(cacheKey(settings.guildId), settings);
    return settings;
}

function getCached(guildId) {
    return cache.get(cacheKey(guildId));
}

async function initializeGuild(guildId) {
    const normalizedGuildId = assertConfiguredGuild(guildId);
    const store = getStore();
    await store.ensureSchema();
    const settings = await store.read(normalizedGuildId)
        ?? await store.seed(normalizedGuildId, getBootstrapChannels());
    return publish(settings);
}

async function refreshGuild(guildId) {
    const normalizedGuildId = assertConfiguredGuild(guildId);
    const settings = await getStore().read(normalizedGuildId);
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
    if (!settings) return null;
    const channelKey = LOG_TYPE_CHANNEL_KEYS[logType] ?? 'general';
    return settings.channels[channelKey];
}

function registerDestinationResolver() {
    registerBotLogDestinationResolver(resolveBotLogDestination);
}

async function updateGuild(guildId, patch, expectedRevision, updatedBy) {
    const normalizedGuildId = assertConfiguredGuild(guildId);
    const allowed = new Set(getProfile().destinationKeys);
    for (const key of Object.keys(patch.channels ?? {})) {
        if (!allowed.has(key)) throw new Error(`The active bot does not support the ${key} logging destination.`);
    }
    return publish(await getStore().update(
        normalizedGuildId,
        patch,
        expectedRevision,
        updatedBy,
    ));
}

function getLeaderboardApprovalChannelId(guildId) {
    if (!getProfile().destinationKeys.includes('approvals')) return null;
    try {
        assertConfiguredGuild(guildId);
    }
    catch (_error) {
        return null;
    }
    const settings = getCached(guildId);
    return settings?.channels.approvals ?? null;
}

module.exports = {
    assertConfiguredGuild,
    getCached,
    getLeaderboardApprovalChannelId,
    getProfile,
    initializeGuild,
    refreshGuild,
    registerDestinationResolver,
    updateGuild,
};
