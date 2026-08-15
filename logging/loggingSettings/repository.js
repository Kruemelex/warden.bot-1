'use strict';

const CHANNEL_KEYS = Object.freeze([
    'general',
    'users',
    'messages',
    'error',
    'staff',
    'approvals',
]);

function normalizeGuildId(value) {
    const guildId = String(value ?? '').trim();
    if (!guildId) throw new Error('Logging settings require a guild ID.');
    return guildId;
}

function normalizeOptionalId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function normalizeRevision(value) {
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('Logging settings require a non-negative revision.');
    }
    return revision;
}

function payloadFor(guildId, channels, updatedBy) {
    return {
        guildId: normalizeGuildId(guildId),
        channels: Object.fromEntries(CHANNEL_KEYS.map((key) => [
            key,
            normalizeOptionalId(channels?.[key]),
        ])),
        updatedBy: normalizeOptionalId(updatedBy),
    };
}

function createLoggingSettingsRepository({ database, encryption, tableName, context }) {
    if (!database?.query) throw new TypeError('Logging settings require a database query adapter.');
    if (!encryption?.assertApplicationEncryptionReady
        || !encryption?.createLookup
        || !encryption?.decryptJson
        || !encryption?.encryptJson) {
        throw new TypeError('Logging settings require an application encryption adapter.');
    }
    if (!/^[a-z][a-z0-9_]*$/u.test(String(tableName))) {
        throw new TypeError('Logging settings require a safe table name.');
    }
    if (!/^[a-z0-9][a-z0-9:._-]{2,127}$/u.test(String(context))) {
        throw new TypeError('Logging settings require an encryption context.');
    }

    let schemaReady;

    function ensureSchema() {
        if (!schemaReady) {
            encryption.assertApplicationEncryptionReady();
            schemaReady = database.query(`
                CREATE TABLE IF NOT EXISTS ${tableName} (
                    guild_lookup BINARY(32) NOT NULL PRIMARY KEY,
                    key_version SMALLINT UNSIGNED NOT NULL,
                    payload_nonce BINARY(12) NOT NULL,
                    payload_tag BINARY(16) NOT NULL,
                    encrypted_payload MEDIUMBLOB NOT NULL,
                    settings_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            `).catch((error) => {
                schemaReady = undefined;
                throw error;
            });
        }
        return schemaReady;
    }

    function mapRow(row, requestedGuildId) {
        if (!row) return undefined;
        const decrypted = encryption.decryptJson(context, {
            keyVersion: row.key_version,
            nonce: row.payload_nonce,
            tag: row.payload_tag,
            ciphertext: row.encrypted_payload,
        });
        const decryptedPayload = payloadFor(
            decrypted?.guildId,
            decrypted?.channels,
            decrypted?.updatedBy,
        );
        if (decryptedPayload.guildId !== normalizeGuildId(requestedGuildId)) {
            const error = new Error('Encrypted logging settings belong to a different guild.');
            error.code = 'LOGGING_SETTINGS_GUILD_MISMATCH';
            throw error;
        }
        return Object.freeze({
            guildId: decryptedPayload.guildId,
            channels: Object.freeze(decryptedPayload.channels),
            settingsRevision: Number(row.settings_revision),
            updatedBy: decryptedPayload.updatedBy,
            updatedAt: row.updated_at ?? null,
        });
    }

    function lookup(guildId) {
        return encryption.createLookup(`${context}:guild`, normalizeGuildId(guildId));
    }

    function encryptedPayload(guildId, channels, updatedBy) {
        const encrypted = encryption.encryptJson(context, payloadFor(guildId, channels, updatedBy));
        return [encrypted.keyVersion, encrypted.nonce, encrypted.tag, encrypted.ciphertext];
    }

    async function read(guildId) {
        await ensureSchema();
        const normalizedGuildId = normalizeGuildId(guildId);
        const rows = await database.query(
            `SELECT * FROM ${tableName} WHERE guild_lookup = ? LIMIT 1`,
            [lookup(normalizedGuildId)],
        );
        return mapRow(rows?.[0], normalizedGuildId);
    }

    async function seed(guildId, channels) {
        await ensureSchema();
        const normalizedGuildId = normalizeGuildId(guildId);
        const encrypted = encryptedPayload(normalizedGuildId, channels, null);
        await database.query(
            `INSERT IGNORE INTO ${tableName} (
                guild_lookup, key_version, payload_nonce, payload_tag, encrypted_payload
            ) VALUES (?, ?, ?, ?, ?)`,
            [lookup(normalizedGuildId), ...encrypted],
        );
        return read(normalizedGuildId);
    }

    async function update(guildId, patch, expectedRevision, updatedBy) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const current = await read(normalizedGuildId);
        if (!current) {
            const error = new Error('Logging settings do not exist for this guild.');
            error.code = 'LOGGING_SETTINGS_MISSING';
            throw error;
        }
        const channels = { ...current.channels };
        for (const [key, value] of Object.entries(patch.channels ?? {})) {
            if (!CHANNEL_KEYS.includes(key)) throw new Error(`Unknown logging channel setting: ${key}`);
            channels[key] = normalizeOptionalId(value);
        }
        if (Object.keys(patch.channels ?? {}).length < 1) return current;
        const encrypted = encryptedPayload(normalizedGuildId, channels, updatedBy);
        const result = await database.query(
            `UPDATE ${tableName}
             SET key_version = ?, payload_nonce = ?, payload_tag = ?, encrypted_payload = ?,
                 settings_revision = settings_revision + 1, updated_at = CURRENT_TIMESTAMP
             WHERE guild_lookup = ? AND settings_revision = ?`,
            [...encrypted, lookup(normalizedGuildId), normalizeRevision(expectedRevision)],
        );
        if (result?.affectedRows !== 1) {
            const error = new Error('Logging settings were changed by another administrator. Reopen the panel and try again.');
            error.code = 'LOGGING_SETTINGS_CONFLICT';
            throw error;
        }
        return read(normalizedGuildId);
    }

    return Object.freeze({ ensureSchema, read, seed, update });
}

module.exports = {
    CHANNEL_KEYS,
    createLoggingSettingsRepository,
};
