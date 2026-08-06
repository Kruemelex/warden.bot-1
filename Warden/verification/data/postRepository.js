'use strict';

const {
    ensureVerificationGuildSettingsTable,
} = require('../../db/verification');
const { withVerificationTransaction } = require('./transaction');
const { normalizeGuildId } = require('../domain/identity');
const {
    parseStoredJson,
    stringifyJsonOrNull,
} = require('./values');

const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function normalizeDiscordId(value, label) {
    const id = String(value ?? '').trim();
    if (!DISCORD_ID_PATTERN.test(id)) {
        const error = new Error(`Verification post ${label} is invalid.`);
        error.code = 'VERIFICATION_POST_ID_INVALID';
        throw error;
    }
    return id;
}

function normalizeVerificationPost(value) {
    return Object.freeze({
        channelId: normalizeDiscordId(value?.channelId, 'channel ID'),
        messageId: normalizeDiscordId(value?.messageId, 'message ID'),
    });
}

function postKey(post) {
    return `${post.channelId}:${post.messageId}`;
}

function normalizeVerificationPosts(value, guildId) {
    const posts = parseStoredJson(
        value,
        [],
        `verification posts for guild ${guildId}`,
        'array',
    ).map(normalizeVerificationPost);
    return Object.freeze([...new Map(posts.map((post) => [postKey(post), post])).values()]);
}

function defaultQuery(sql, values) {
    return require('../../../Warden/db/database').query(sql, values);
}

async function readVerificationPosts(guildId, query = defaultQuery, { forUpdate = false } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const rows = await query(
        `SELECT verification_posts_json
         FROM verification_guild_settings
         WHERE guild_id = ?
         LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [normalizedGuildId],
    );
    if (rows.length < 1) {
        const error = new Error(`Verification settings are not initialized for guild ${normalizedGuildId}.`);
        error.code = 'VERIFICATION_SETTINGS_NOT_INITIALIZED';
        throw error;
    }
    return normalizeVerificationPosts(rows[0].verification_posts_json, normalizedGuildId);
}

async function mutateVerificationPosts(guildId, mutate) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await ensureVerificationGuildSettingsTable();
    return withVerificationTransaction(async (query) => {
        const current = await readVerificationPosts(normalizedGuildId, query, { forUpdate: true });
        const next = normalizeVerificationPosts(
            stringifyJsonOrNull(await mutate([...current])),
            normalizedGuildId,
        );
        // Registry maintenance is not a verification settings edit.
        await query(
            `UPDATE verification_guild_settings
             SET verification_posts_json = ?, updated_at = updated_at
             WHERE guild_id = ?`,
            [stringifyJsonOrNull(next), normalizedGuildId],
        );
        return next;
    });
}

async function listVerificationPosts(guildId) {
    await ensureVerificationGuildSettingsTable();
    return readVerificationPosts(guildId);
}

function registerVerificationPost(guildId, value) {
    const post = normalizeVerificationPost(value);
    return mutateVerificationPosts(guildId, (posts) => {
        if (!posts.some((candidate) => postKey(candidate) === postKey(post))) posts.push(post);
        return posts;
    });
}

function removeVerificationPosts(guildId, values) {
    const removals = new Set([].concat(values ?? []).map(normalizeVerificationPost).map(postKey));
    if (removals.size < 1) return listVerificationPosts(guildId);
    return mutateVerificationPosts(
        guildId,
        (posts) => posts.filter((post) => !removals.has(postKey(post))),
    );
}

module.exports = {
    listVerificationPosts,
    registerVerificationPost,
    removeVerificationPosts,
};
