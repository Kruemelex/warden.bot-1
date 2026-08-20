'use strict';

const database = require('../db/database');
const {
    assertApplicationEncryptionReady,
    createLookup,
    decryptJson,
    encryptJson,
} = require('../db/encryption/applicationEncryption');

const TABLE = 'warden_leaderboard_settings';
const GUILD_CONTEXT = 'warden:leaderboard-settings:guild';
const PAYLOAD_CONTEXT = 'warden:leaderboard-settings:payload';

let schemaReady;

function normalizeGuildId(value) {
    const guildId = String(value ?? '').trim();
    if (!/^\d{16,32}$/u.test(guildId)) throw new Error('Leaderboard settings require a valid guild ID.');
    return guildId;
}

function normalizeMode(value) {
    const mode = String(value ?? 'open').trim().toLowerCase();
    if (!['open', 'maintenance'].includes(mode)) throw new Error('Leaderboard mode must be open or maintenance.');
    return mode;
}

function normalizeSubmissionMode(value) {
    const mode = String(value ?? 'open').trim().toLowerCase();
    if (!['open', 'halted'].includes(mode)) throw new Error('Leaderboard submission mode must be open or halted.');
    return mode;
}

function normalizeChannelId(value) {
    if (value == null || String(value).trim() === '') return null;
    const channelId = String(value).trim();
    if (!/^\d{16,32}$/u.test(channelId)) throw new Error('Leaderboard submission channel must be a valid channel ID.');
    return channelId;
}

function normalizeUpdatedBy(value) {
    const userId = value == null ? null : String(value).trim();
    if (userId !== null && !/^\d{16,32}$/u.test(userId)) throw new Error('Leaderboard settings updater must be a valid user ID.');
    return userId;
}

function guildLookup(guildId) {
    return createLookup(GUILD_CONTEXT, normalizeGuildId(guildId));
}

function encodePayload(settings) {
    return encryptJson(PAYLOAD_CONTEXT, {
        guildId: normalizeGuildId(settings.guildId),
        mode: normalizeMode(settings.mode),
        speedrunSubmissionMode: normalizeSubmissionMode(settings.speedrunSubmissionMode),
        speedrunSubmissionChannelId: normalizeChannelId(settings.speedrunSubmissionChannelId),
        aceSubmissionMode: normalizeSubmissionMode(settings.aceSubmissionMode),
        aceSubmissionChannelId: normalizeChannelId(settings.aceSubmissionChannelId),
        websitePublishingEnabled: settings.websitePublishingEnabled !== false,
        updatedBy: normalizeUpdatedBy(settings.updatedBy),
    });
}

function mapRow(row) {
    if (!row) return undefined;
    const payload = decryptJson(PAYLOAD_CONTEXT, {
        keyVersion: row.key_version,
        nonce: row.payload_nonce,
        tag: row.payload_tag,
        ciphertext: row.encrypted_payload,
    });
    return Object.freeze({
        guildId: normalizeGuildId(payload.guildId),
        mode: normalizeMode(payload.mode),
        speedrunSubmissionMode: normalizeSubmissionMode(payload.speedrunSubmissionMode),
        speedrunSubmissionChannelId: normalizeChannelId(payload.speedrunSubmissionChannelId),
        aceSubmissionMode: normalizeSubmissionMode(payload.aceSubmissionMode),
        aceSubmissionChannelId: normalizeChannelId(payload.aceSubmissionChannelId),
        websitePublishingEnabled: payload.websitePublishingEnabled !== false,
        updatedBy: normalizeUpdatedBy(payload.updatedBy),
        settingsRevision: Number(row.settings_revision),
        publicationRevision: Number(row.publication_revision),
        updatedAtMs: Number(row.updated_at_ms),
    });
}

function ensureSchema() {
    assertApplicationEncryptionReady();
    if (!schemaReady) {
        schemaReady = database.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                guild_lookup BINARY(32) NOT NULL PRIMARY KEY,
                key_version SMALLINT UNSIGNED NOT NULL,
                payload_nonce BINARY(12) NOT NULL,
                payload_tag BINARY(16) NOT NULL,
                encrypted_payload MEDIUMBLOB NOT NULL,
                settings_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                publication_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                updated_at_ms BIGINT UNSIGNED NOT NULL
            ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `).catch((error) => {
            schemaReady = undefined;
            throw error;
        });
    }
    return schemaReady;
}

async function read(guildId) {
    await ensureSchema();
    const rows = await database.query(`SELECT * FROM ${TABLE} WHERE guild_lookup = ? LIMIT 1`, [guildLookup(guildId)]);
    return mapRow(rows?.[0]);
}

async function seed(guildId) {
    await ensureSchema();
    const settings = {
        guildId: normalizeGuildId(guildId),
        mode: 'open',
        speedrunSubmissionMode: 'open',
        speedrunSubmissionChannelId: null,
        aceSubmissionMode: 'open',
        aceSubmissionChannelId: null,
        websitePublishingEnabled: true,
        updatedBy: null,
    };
    const encrypted = encodePayload(settings);
    await database.query(`
        INSERT IGNORE INTO ${TABLE} (
            guild_lookup, key_version, payload_nonce, payload_tag, encrypted_payload, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
        guildLookup(settings.guildId), encrypted.keyVersion, encrypted.nonce,
        encrypted.tag, encrypted.ciphertext, Date.now(),
    ]);
    return read(settings.guildId);
}

async function update(guildId, patch, expectedRevision, updatedBy) {
    const current = await read(guildId) ?? await seed(guildId);
    const next = {
        ...current,
        ...(patch ?? {}),
        guildId: current.guildId,
        updatedBy: normalizeUpdatedBy(updatedBy),
    };
    const encrypted = encodePayload(next);
    const result = await database.query(`
        UPDATE ${TABLE}
        SET key_version = ?, payload_nonce = ?, payload_tag = ?, encrypted_payload = ?,
            settings_revision = settings_revision + 1, updated_at_ms = ?
        WHERE guild_lookup = ? AND settings_revision = ?
    `, [
        encrypted.keyVersion, encrypted.nonce, encrypted.tag, encrypted.ciphertext,
        Date.now(), guildLookup(current.guildId), Number(expectedRevision),
    ]);
    if (Number(result?.affectedRows) !== 1) {
        const error = new Error('Leaderboard settings were changed by another administrator. Reopen the panel and try again.');
        error.code = 'LEADERBOARD_SETTINGS_CONFLICT';
        throw error;
    }
    return read(current.guildId);
}

async function reservePublicationRevision(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await read(normalizedGuildId) ?? await seed(normalizedGuildId);
        const result = await database.query(`
            UPDATE ${TABLE}
            SET publication_revision = publication_revision + 1
            WHERE guild_lookup = ? AND publication_revision = ?
        `, [guildLookup(current.guildId), current.publicationRevision]);
        if (Number(result?.affectedRows) === 1) return read(current.guildId);
    }
    const error = new Error('Leaderboard website publication was changed concurrently. Try syncing again.');
    error.code = 'LEADERBOARD_PUBLICATION_CONFLICT';
    throw error;
}

module.exports = {
    TABLE,
    ensureSchema,
    read,
    reservePublicationRevision,
    seed,
    update,
};
