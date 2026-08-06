let database;
const { normalizeGuildId } = require('../domain/identity');
const {
    parseStoredJson,
    stringifyJsonOrNull,
    normalizeBoolean,
    normalizeDatabaseTimestamp,
} = require('./values');
const { withVerificationTransaction } = require('./transaction');
const {
    ensureVerificationGuildSettingsTable,
    ensureVerificationAutokickTables,
} = require('../../db/verification');

function getDatabase() {
    if (!database) database = require('../../../Warden/db/database');
    return database;
}

const VERIFICATION_MODES = {
    challenge: 'challenge',
    halt: 'halt',
    oneClick: 'one-click',
};
const VALID_VERIFICATION_MODES = Object.values(VERIFICATION_MODES);
const DEFAULT_SCREEN_EXPIRY_SECONDS = 10 * 60;
const DEFAULT_COOLDOWN_SECONDS = 60;
const DEFAULT_AUTOKICK_SECONDS = 10 * 60;
const DB_NOW_MS_SQL = 'CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)';
const GUILD_SETTINGS_SELECT = `SELECT guild_id, verification_role_id, mode,
    active_challenge_ids_json, challenge_expiry_seconds, cooldown_seconds,
    autokick_enabled, autokick_enabled_since_ms, autokick_seconds,
    settings_revision, updated_by, updated_at,
    UNIX_TIMESTAMP(updated_at) AS updated_at_epoch_seconds
    FROM verification_guild_settings WHERE guild_id = ? LIMIT 1`;

function normalizeActiveChallengeIds(value) {
    let rawChallengeIds = value;
    if (!Array.isArray(rawChallengeIds)) {
        const text = String(value ?? '').trim();
        try {
            rawChallengeIds = JSON.parse(text);
        }
        catch (_err) {
            rawChallengeIds = text.split(/[\s,]+/);
        }
    }
    return [...new Set((Array.isArray(rawChallengeIds) ? rawChallengeIds : [rawChallengeIds])
        .map((challengeId) => String(challengeId ?? '').trim())
        .filter(Boolean))];
}

function normalizeVerificationMode(mode, fallback = VERIFICATION_MODES.challenge) {
    return VALID_VERIFICATION_MODES.includes(mode) ? mode : fallback;
}

function normalizeTimerSeconds(value, fallback) {
    const seconds = Math.floor(Number(value));
    return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
}

function normalizeRoleId(value) {
    const roleId = String(value ?? '').trim();
    return /^\d{17,20}$/.test(roleId) ? roleId : undefined;
}

function normalizeSettingsRevision(value) {
    const revision = Math.floor(Number(value));
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeEnabledSinceMs(value) {
    if (value === null || value === undefined) return undefined;
    const milliseconds = Number(value);
    return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

function defaultVerificationSettings() {
    return {
        verificationRoleId: undefined,
        mode: VERIFICATION_MODES.challenge,
        activeChallengeIds: ['placeholder'],
        screenExpirySeconds: DEFAULT_SCREEN_EXPIRY_SECONDS,
        cooldownSeconds: DEFAULT_COOLDOWN_SECONDS,
        autokickEnabled: false,
        autokickEnabledSinceMs: undefined,
        autokickSeconds: DEFAULT_AUTOKICK_SECONDS,
        settingsRevision: 0,
    };
}

function normalizeSettings(settings) {
    const defaults = defaultVerificationSettings();
    const mode = normalizeVerificationMode(settings?.mode, defaults.mode);
    const activeChallengeIds = normalizeActiveChallengeIds(settings?.activeChallengeIds ?? defaults.activeChallengeIds);
    return {
        verificationRoleId: normalizeRoleId(settings?.verificationRoleId),
        mode,
        activeChallengeIds: mode === VERIFICATION_MODES.challenge && activeChallengeIds.length < 1
            ? defaults.activeChallengeIds
            : activeChallengeIds,
        screenExpirySeconds: normalizeTimerSeconds(settings?.screenExpirySeconds, defaults.screenExpirySeconds),
        cooldownSeconds: normalizeTimerSeconds(settings?.cooldownSeconds, defaults.cooldownSeconds),
        autokickEnabled: normalizeBoolean(settings?.autokickEnabled),
        autokickEnabledSinceMs: normalizeEnabledSinceMs(settings?.autokickEnabledSinceMs),
        autokickSeconds: normalizeTimerSeconds(settings?.autokickSeconds, defaults.autokickSeconds),
        settingsRevision: normalizeSettingsRevision(settings?.settingsRevision),
    };
}

function parseGuildSettingsRow(row) {
    const settings = normalizeSettings({
        verificationRoleId: row.verification_role_id,
        mode: row.mode,
        activeChallengeIds: parseStoredJson(
            row.active_challenge_ids_json,
            [],
            `verification settings for guild ${row.guild_id}`,
            'array',
        ),
        // Retain the deployed column name; its authoritative runtime meaning is
        // now the full allowance granted to each delivered screen.
        screenExpirySeconds: row.challenge_expiry_seconds,
        cooldownSeconds: row.cooldown_seconds,
        autokickEnabled: row.autokick_enabled,
        autokickEnabledSinceMs: row.autokick_enabled_since_ms,
        autokickSeconds: row.autokick_seconds,
        settingsRevision: row.settings_revision,
    });
    return {
        ...settings,
        updatedBy: row.updated_by ?? undefined,
        updatedAt: normalizeDatabaseTimestamp(row.updated_at, row.updated_at_epoch_seconds),
    };
}

function defaultQuery(sql, values) {
    return getDatabase().query(sql, values);
}

async function readVerificationGuildSettings(guildId, query = defaultQuery, { forUpdate = false } = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const rows = await query(
        `${GUILD_SETTINGS_SELECT}${forUpdate ? ' FOR UPDATE' : ''}`,
        [normalizedGuildId],
    );
    const row = rows?.[0];
    if (!row) {
        const error = new Error(`Verification settings are not initialized for guild ${normalizedGuildId}.`);
        error.code = 'VERIFICATION_SETTINGS_NOT_INITIALIZED';
        throw error;
    }
    return parseGuildSettingsRow(row);
}

async function ensureVerificationGuildSettings(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const defaults = normalizeSettings(defaultVerificationSettings());
    await ensureVerificationGuildSettingsTable();
    await getDatabase().query(
        `INSERT IGNORE INTO verification_guild_settings
            (guild_id, verification_role_id, mode, active_challenge_ids_json,
             challenge_expiry_seconds, cooldown_seconds, autokick_enabled,
             autokick_enabled_since_ms, autokick_seconds, settings_revision, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL)`,
        [
            normalizedGuildId,
            defaults.verificationRoleId ?? null,
            defaults.mode,
            stringifyJsonOrNull(defaults.activeChallengeIds),
            defaults.screenExpirySeconds,
            defaults.cooldownSeconds,
            defaults.autokickEnabled ? 1 : 0,
            defaults.autokickSeconds,
        ],
    );
    return readVerificationGuildSettings(normalizedGuildId);
}

async function saveVerificationGuildSettingsOnly(guildId, settings, updatedBy, options = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const normalizedSettings = normalizeSettings(settings);
    await ensureVerificationAutokickTables();
    const expectedRevision = options.expectedRevision === undefined
        ? undefined
        : normalizeSettingsRevision(options.expectedRevision);
    let savedSettings;
    let finalized;

    await withVerificationTransaction(async (query) => {
        const currentRows = await query(`
            SELECT verification_role_id, autokick_enabled, autokick_enabled_since_ms,
                ${DB_NOW_MS_SQL} AS db_now_ms
            FROM verification_guild_settings
            WHERE guild_id = ?
            LIMIT 1 FOR UPDATE
        `, [normalizedGuildId]);
        const currentRow = currentRows?.[0];
        let databaseNowMs = normalizeEnabledSinceMs(currentRow?.db_now_ms);
        if (databaseNowMs === undefined) {
            const databaseTimeRows = await query(`SELECT ${DB_NOW_MS_SQL} AS db_now_ms`);
            databaseNowMs = normalizeEnabledSinceMs(databaseTimeRows?.[0]?.db_now_ms);
        }
        if (databaseNowMs === undefined) {
            throw new Error('Verification settings could not read the database clock.');
        }
        const wasAutokickEnabled = normalizeBoolean(currentRow?.autokick_enabled);
        const verificationRoleChanged = Boolean(
            currentRow
            && normalizeRoleId(currentRow.verification_role_id) !== normalizedSettings.verificationRoleId
        );
        const autokickEnabledSinceMs = normalizedSettings.autokickEnabled
            ? (
                wasAutokickEnabled && !verificationRoleChanged
                    ? normalizeEnabledSinceMs(currentRow?.autokick_enabled_since_ms) ?? databaseNowMs
                    : databaseNowMs
            )
            : null;
        const settingsValues = [
            normalizedSettings.verificationRoleId ?? null,
            normalizedSettings.mode,
            stringifyJsonOrNull(normalizedSettings.activeChallengeIds),
            normalizedSettings.screenExpirySeconds,
            normalizedSettings.cooldownSeconds,
            normalizedSettings.autokickEnabled ? 1 : 0,
            autokickEnabledSinceMs,
            normalizedSettings.autokickSeconds,
            updatedBy ? String(updatedBy) : null,
        ];
        if (expectedRevision === undefined) {
            await query(
                `INSERT INTO verification_guild_settings (guild_id, verification_role_id, mode, active_challenge_ids_json, challenge_expiry_seconds, cooldown_seconds, autokick_enabled, autokick_enabled_since_ms, autokick_seconds, settings_revision, updated_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                 ON DUPLICATE KEY UPDATE
                    verification_role_id = VALUES(verification_role_id),
                    mode = VALUES(mode),
                    active_challenge_ids_json = VALUES(active_challenge_ids_json),
                    challenge_expiry_seconds = VALUES(challenge_expiry_seconds),
                    cooldown_seconds = VALUES(cooldown_seconds),
                    autokick_enabled = VALUES(autokick_enabled),
                    autokick_enabled_since_ms = VALUES(autokick_enabled_since_ms),
                    autokick_seconds = VALUES(autokick_seconds),
                    settings_revision = settings_revision + 1,
                    updated_by = VALUES(updated_by)`,
                [normalizedGuildId, ...settingsValues],
            );
        }
        else {
            const result = await query(
                `UPDATE verification_guild_settings
                 SET verification_role_id = ?, mode = ?, active_challenge_ids_json = ?,
                 challenge_expiry_seconds = ?, cooldown_seconds = ?, autokick_enabled = ?,
                 autokick_enabled_since_ms = ?, autokick_seconds = ?, updated_by = ?,
                 settings_revision = settings_revision + 1
                 WHERE guild_id = ? AND settings_revision = ?`,
                [...settingsValues, normalizedGuildId, expectedRevision],
            );
            if (result.affectedRows !== 1) {
                const error = new Error('Verification settings changed while this editor was open. Reopen it and apply your changes again.');
                error.code = 'VERIFICATION_SETTINGS_CONFLICT';
                throw error;
            }
        }

        const autokickWasTurnedOff = wasAutokickEnabled && !normalizedSettings.autokickEnabled;
        const shouldRetireAutokickQueue = autokickWasTurnedOff || verificationRoleChanged;
        if (shouldRetireAutokickQueue) {
            const terminalReason = normalizedSettings.autokickEnabled
                ? 'verification-role-changed'
                : 'settings-disabled';
            await query(`
                SELECT user_id, joined_at_ms
                FROM verification_autokick_queue
                WHERE guild_id = ? AND phase = 'waiting'
                ORDER BY user_id, joined_at_ms
                FOR UPDATE
            `, [normalizedGuildId]);
            await query(
                `UPDATE verification_autokick_queue
                 SET phase = 'terminal',
                     terminal_reason = ?,
                     kick_due_at_ms = NULL,
                     countdown_seconds = NULL,
                     terminal_at_ms = ?,
                     next_attempt_at_ms = NULL,
                     lease_token = NULL,
                     lease_expires_at_ms = NULL
                 WHERE guild_id = ? AND phase = 'waiting'`,
                [terminalReason, databaseNowMs, normalizedGuildId],
            );
        }

        savedSettings = await readVerificationGuildSettings(normalizedGuildId, query);
        if (typeof options.finalize === 'function') {
            finalized = await options.finalize(query, savedSettings);
        }
    }, { isolationLevel: 'REPEATABLE READ' });

    return typeof options.finalize === 'function'
        ? finalized
        : savedSettings;
}

module.exports = {
    VERIFICATION_MODES,
    ensureVerificationGuildSettings,
    readVerificationGuildSettings,
    saveVerificationGuildSettingsOnly,
};
