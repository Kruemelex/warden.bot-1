'use strict';

let database;

const { normalizeGuildId } = require('../domain/identity');
const { normalizeBoolean } = require('./values');
const { withVerificationTransaction } = require('./transaction');
const { MAX_JOIN_EVENT_AGE_MS, RETIRED_AUTOKICK_RETENTION_MS } = require('../domain/autokickPolicy');
const { ensureVerificationAutokickQueueTable, ensureVerificationAutokickTables } = require('../../db/verification');

const DB_NOW = 'CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED)';
const MAX_FUTURE_SKEW_MS = 60_000;
const DEFAULT_AUTOKICK_SECONDS = 600;
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 3_600_000;
const MAX_RETRY_MS = 86_400_000;
const MAX_BATCH = 1000;
const MAX_UINT = 4294967295;
const REPORT_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PHASES = Object.freeze({
    waiting: 'waiting',
    verifying: 'verifying',
    kickIntent: 'kick_intent',
    terminal: 'terminal',
});
const DEADLINE_STAGES = Object.freeze({
    onboarding: 'onboarding',
    verification: 'verification',
});
const REPORT = Object.freeze({
    none: 'none',
    pending: 'pending',
    sending: 'sending',
    sent: 'sent',
    unknown: 'delivery_unknown',
    dead: 'dead',
});
const SELECT_COLUMNS = `guild_id, user_id, joined_at_ms, phase, deadline_stage, kick_due_at_ms,
    countdown_seconds, next_attempt_at_ms, lease_token, lease_expires_at_ms,
    attempt_count, unknown_attempt_count, dm_attempted_at_ms, kick_intent_at_ms, authorized_role_id,
    kick_succeeded_at_ms, terminal_at_ms, terminal_reason, dead_lettered_at_ms,
    last_error_code, report_status, report_nonce, report_dispatched_at_ms, report_message_id,
    report_attempt_count, report_next_attempt_at_ms, report_lease_token,
    report_lease_expires_at_ms, report_last_error_code, report_user_tag,
    report_display_name`;

function getDatabase() {
    if (!database) database = require('../../../Warden/db/database');
    return database;
}

function invariant(message) {
    const error = new Error(message);
    error.code = 'VERIFICATION_AUTOKICK_ROW_INVARIANT';
    return error;
}

function identifier(value, label) {
    const normalized = String(value ?? '').trim();
    if (!normalized || normalized.length > 32 || normalized.toLowerCase() === 'global') {
        throw new Error(`Verification autokick ${label} must be 1-32 characters.`);
    }
    return normalized;
}

function guildId(value) {
    return identifier(normalizeGuildId(value), 'guild ID');
}

function milliseconds(value, label, nullable = false) {
    if (nullable && (value === null || value === undefined)) return null;
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < 0) {
        throw new Error(`${label} must be a non-negative safe integer.`);
    }
    return normalized;
}

function positive(value, fallback, maximum, label) {
    const normalized = Number(value ?? fallback);
    if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
        throw new Error(`${label} must be between 1 and ${maximum}.`);
    }
    return normalized;
}

function opaqueToken(value, label = 'lease token') {
    const normalized = String(value ?? '');
    if (normalized.length < 16 || normalized.length > 64 || !/^[\x21-\x7e]+$/.test(normalized)) {
        throw new Error(`Verification autokick ${label} must be 16-64 printable ASCII characters.`);
    }
    return normalized;
}

function shortText(value, fallback, maximum = 64) {
    const normalized = String(value ?? fallback ?? '').trim();
    return normalized ? normalized.slice(0, maximum) : null;
}

function terminalReason(value, fallback) {
    const normalized = String(value ?? fallback ?? '');
    if (!/^[a-z0-9][a-z0-9._:-]{0,31}$/i.test(normalized)) {
        throw new Error('Verification autokick terminal reasons must be 1-32 ASCII identifier characters.');
    }
    return normalized;
}

function generation(options) {
    return {
        guildId: guildId(options?.guildId),
        userId: identifier(options?.userId, 'user ID'),
        joinedAtMs: milliseconds(options?.joinedAtMs, 'Verification autokick join timestamp'),
    };
}

function count(value, label) {
    const normalized = Number(value ?? 0);
    if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > MAX_UINT) {
        throw invariant(`Invalid ${label} in Verification autokick row.`);
    }
    return normalized;
}

function normalizeEntry(row) {
    if (!row) return null;
    const text = (value) => value === null || value === undefined ? null : String(value);
    const entry = {
        guildId: String(row.guild_id),
        userId: String(row.user_id),
        joinedAtMs: milliseconds(row.joined_at_ms, 'Verification autokick join timestamp'),
        phase: text(row.phase),
        deadlineStage: text(row.deadline_stage),
        kickDueAtMs: milliseconds(row.kick_due_at_ms, 'Verification autokick deadline', true),
        countdownSeconds: row.countdown_seconds == null ? null : positive(row.countdown_seconds, undefined, MAX_UINT, 'Verification autokick countdown'),
        nextAttemptAtMs: milliseconds(row.next_attempt_at_ms, 'Verification autokick next attempt', true),
        leaseToken: text(row.lease_token),
        leaseExpiresAtMs: milliseconds(row.lease_expires_at_ms, 'Verification autokick lease expiry', true),
        attemptCount: count(row.attempt_count, 'attempt count'),
        unknownAttemptCount: count(row.unknown_attempt_count, 'unknown attempt count'),
        dmAttemptedAtMs: milliseconds(row.dm_attempted_at_ms, 'Verification autokick DM marker', true),
        authorizedRoleId: text(row.authorized_role_id),
        kickSucceededAtMs: milliseconds(row.kick_succeeded_at_ms, 'Verification autokick success timestamp', true),
        terminalAtMs: milliseconds(row.terminal_at_ms, 'Verification autokick terminal timestamp', true),
        terminalReason: text(row.terminal_reason),
        deadLetteredAtMs: milliseconds(row.dead_lettered_at_ms, 'Verification autokick dead-letter timestamp', true),
        lastErrorCode: text(row.last_error_code),
        reportStatus: text(row.report_status),
        reportNonce: text(row.report_nonce),
        reportDispatchedAtMs: milliseconds(row.report_dispatched_at_ms, 'Verification autokick report dispatch', true),
        reportMessageId: text(row.report_message_id),
        reportAttemptCount: count(row.report_attempt_count, 'report attempt count'),
        reportNextAttemptAtMs: milliseconds(row.report_next_attempt_at_ms, 'Verification autokick report retry', true),
        reportLeaseToken: text(row.report_lease_token),
        reportLeaseExpiresAtMs: milliseconds(row.report_lease_expires_at_ms, 'Verification autokick report lease expiry', true),
        reportLastErrorCode: text(row.report_last_error_code),
        reportUserTag: text(row.report_user_tag),
        reportDisplayName: text(row.report_display_name),
    };
    if (!Object.values(PHASES).includes(entry.phase)) throw invariant(`Unknown Verification autokick phase: ${entry.phase}`);
    if (!Object.values(DEADLINE_STAGES).includes(entry.deadlineStage)) {
        throw invariant(`Unknown Verification autokick deadline stage: ${entry.deadlineStage}`);
    }
    if (!Object.values(REPORT).includes(entry.reportStatus)) throw invariant(`Unknown Verification autokick report state: ${entry.reportStatus}`);
    return entry;
}

function affected(result) {
    const value = Number(result?.affectedRows ?? 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function lockSettings(query, targetGuildId) {
    const rows = await query(`
        SELECT verification_role_id, autokick_enabled, autokick_enabled_since_ms,
            autokick_seconds, ${DB_NOW} AS db_now_ms
        FROM verification_guild_settings WHERE guild_id = ? LIMIT 1 FOR UPDATE
    `, [targetGuildId]);
    return rows?.[0] ?? null;
}

async function databaseNow(query, settings) {
    if (settings) return milliseconds(settings.db_now_ms, 'Verification database timestamp');
    const rows = await query(`SELECT ${DB_NOW} AS db_now_ms`);
    return milliseconds(rows?.[0]?.db_now_ms, 'Verification database timestamp');
}

async function selectGeneration(query, target, lock = false) {
    const rows = await query(`
        SELECT ${SELECT_COLUMNS} FROM verification_autokick_queue
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
        LIMIT 1${lock ? ' FOR UPDATE' : ''}
    `, [target.guildId, target.userId, target.joinedAtMs]);
    return normalizeEntry(rows?.[0]);
}

async function selectLatestGeneration(query, target, lock = false) {
    const rows = await query(`
        SELECT ${SELECT_COLUMNS} FROM verification_autokick_queue
        WHERE guild_id = ? AND user_id = ?
        ORDER BY joined_at_ms DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}
    `, [target.guildId, target.userId]);
    return normalizeEntry(rows?.[0]);
}

async function enqueueVerificationAutokickGeneration(options) {
    const target = generation(options);
    await ensureVerificationAutokickTables();
    return withVerificationTransaction(async (query) => {
        const settings = await lockSettings(query, target.guildId);
        if (!settings) return { status: 'settings-missing', entry: null };
        const now = await databaseNow(query, settings);
        const age = now - target.joinedAtMs;
        if (
            age < -MAX_FUTURE_SKEW_MS
            || (!options?.trustedReconciliation && age > MAX_JOIN_EVENT_AGE_MS)
        ) return { status: 'implausible-join', entry: null };
        if (!normalizeBoolean(settings.autokick_enabled)) return { status: 'disabled', entry: null };
        const enabledSince = Number(settings.autokick_enabled_since_ms);
        if (!Number.isSafeInteger(enabledSince) || target.joinedAtMs < enabledSince) return { status: 'before-enabled', entry: null };

        const latest = await selectLatestGeneration(query, target, true);
        if (latest?.joinedAtMs > target.joinedAtMs) return { status: 'stale-generation', entry: latest };
        if (latest?.joinedAtMs === target.joinedAtMs) return { status: latest.phase === PHASES.terminal ? 'terminal' : 'existing', entry: latest };
        if (latest && latest.phase !== PHASES.terminal) {
            await query(`
                UPDATE verification_autokick_queue
                SET phase = 'terminal', terminal_at_ms = ?, terminal_reason = 'membership-replaced',
                    next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL
                WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
            `, [now, target.guildId, target.userId, latest.joinedAtMs]);
        }
        const seconds = positive(settings.autokick_seconds, DEFAULT_AUTOKICK_SECONDS, MAX_UINT, 'Verification autokick countdown');
        await query(`
            INSERT INTO verification_autokick_queue
                (guild_id, user_id, joined_at_ms, phase, deadline_stage,
                 kick_due_at_ms, countdown_seconds, next_attempt_at_ms)
            VALUES (?, ?, ?, 'waiting', 'onboarding',
                    ? + (? * 1000), ?, ? + (? * 1000))
        `, [target.guildId, target.userId, target.joinedAtMs,
            target.joinedAtMs, seconds, seconds, target.joinedAtMs, seconds]);
        return { status: 'enqueued', entry: await selectGeneration(query, target) };
    });
}

async function resetVerificationAutokickCountdownAfterOnboarding(options) {
    const target = generation(options);
    await ensureVerificationAutokickTables();
    return withVerificationTransaction(async (query) => {
        const settings = await lockSettings(query, target.guildId);
        if (!settings || !normalizeBoolean(settings.autokick_enabled)) return { status: 'disabled', entry: null };
        const entry = await selectGeneration(query, target, true);
        if (!entry) return { status: 'missing', entry: null };
        if (entry.phase === PHASES.terminal) return { status: 'terminal', entry };
        if (entry.phase !== PHASES.waiting) return { status: entry.phase, entry };
        if (entry.deadlineStage === DEADLINE_STAGES.verification) return { status: 'already-reset', entry };
        if (entry.deadlineStage !== DEADLINE_STAGES.onboarding) throw invariant('Verification autokick countdown has an invalid deadline stage.');
        const seconds = positive(settings.autokick_seconds, DEFAULT_AUTOKICK_SECONDS, MAX_UINT, 'Verification autokick countdown');
        const result = await query(`
            UPDATE verification_autokick_queue
            SET deadline_stage = 'verification',
                kick_due_at_ms = ${DB_NOW} + (? * 1000), countdown_seconds = ?,
                next_attempt_at_ms = ${DB_NOW} + (? * 1000),
                lease_token = NULL, lease_expires_at_ms = NULL,
                dm_attempted_at_ms = NULL
            WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
              AND phase = 'waiting' AND deadline_stage = 'onboarding'
        `, [seconds, seconds, seconds, target.guildId, target.userId, target.joinedAtMs]);
        if (affected(result) !== 1) throw invariant('Locked Verification autokick countdown reset failed.');
        return { status: 'reset', entry: await selectGeneration(query, target) };
    });
}

async function getVerificationAutokickConfiguration(targetGuildId) {
    const normalizedGuildId = guildId(targetGuildId);
    await ensureVerificationAutokickTables();
    const rows = await getDatabase().query(`
        SELECT verification_role_id, autokick_enabled FROM verification_guild_settings
        WHERE guild_id = ? LIMIT 1
    `, [normalizedGuildId]);
    return {
        autokickEnabled: normalizeBoolean(rows?.[0]?.autokick_enabled),
        verificationRoleId: rows?.[0]?.verification_role_id ? String(rows[0].verification_role_id) : undefined,
    };
}

async function claimVerificationAutokickWork(options) {
    const targetGuildId = guildId(options?.guildId);
    const leaseToken = opaqueToken(options?.leaseToken);
    const leaseMs = positive(options?.leaseDurationMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'work lease');
    const limit = positive(options?.limit, 25, MAX_BATCH, 'work batch size');
    await ensureVerificationAutokickQueueTable();
    const update = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET lease_token = ?, lease_expires_at_ms = ${DB_NOW} + ?,
            next_attempt_at_ms = ${DB_NOW} + ?
        WHERE guild_id = ? AND phase <> 'terminal'
          AND (lease_token IS NULL OR lease_expires_at_ms <= ${DB_NOW})
          AND (
            (phase = 'waiting' AND kick_due_at_ms IS NOT NULL AND kick_due_at_ms <= ${DB_NOW}
                AND next_attempt_at_ms <= ${DB_NOW})
            OR (phase = 'verifying' AND next_attempt_at_ms <= ${DB_NOW})
            OR (phase = 'kick_intent' AND next_attempt_at_ms <= ${DB_NOW})
          )
        ORDER BY COALESCE(next_attempt_at_ms, 0), user_id, joined_at_ms LIMIT ?
    `, [leaseToken, leaseMs, leaseMs, targetGuildId, limit]);
    if (affected(update) < 1) return { status: 'empty', leaseToken, entries: [] };
    const rows = await getDatabase().query(`
        SELECT ${SELECT_COLUMNS} FROM verification_autokick_queue
        WHERE guild_id = ? AND lease_token = ? ORDER BY user_id, joined_at_ms
    `, [targetGuildId, leaseToken]);
    return { status: 'claimed', leaseToken, entries: (rows ?? []).map(normalizeEntry) };
}

async function getVerificationAutokickSchedule(targetGuildId) {
    const normalizedGuildId = guildId(targetGuildId);
    await ensureVerificationAutokickQueueTable();
    const rows = await getDatabase().query(`
        SELECT ${DB_NOW} AS db_now_ms, MIN(schedule.next_at_ms) AS next_available_at_ms
        FROM (
            SELECT CASE WHEN lease_token IS NOT NULL THEN lease_expires_at_ms ELSE next_attempt_at_ms END AS next_at_ms
            FROM verification_autokick_queue WHERE guild_id = ? AND phase <> 'terminal'
            UNION ALL
            SELECT CASE WHEN report_lease_token IS NOT NULL THEN report_lease_expires_at_ms ELSE report_next_attempt_at_ms END
            FROM verification_autokick_queue WHERE guild_id = ? AND report_status IN ('pending','sending')
        ) schedule
    `, [normalizedGuildId, normalizedGuildId]);
    return {
        databaseNowMs: milliseconds(rows?.[0]?.db_now_ms, 'Verification database timestamp'),
        nextAvailableAtMs: milliseconds(rows?.[0]?.next_available_at_ms, 'Verification autokick next availability', true),
    };
}

async function workCas(options, phases, setSql, setValues = [], extraWhere = '') {
    const target = generation(options);
    const leaseToken = opaqueToken(options?.leaseToken);
    const placeholders = phases.map(() => '?').join(', ');
    const result = await getDatabase().query(`
        UPDATE verification_autokick_queue SET ${setSql}
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
          AND lease_token = ? AND phase IN (${placeholders}) ${extraWhere}
    `, [...setValues, target.guildId, target.userId, target.joinedAtMs, leaseToken, ...phases]);
    return affected(result) === 1;
}

async function renewVerificationAutokickLease(options) {
    const leaseMs = positive(options?.leaseDurationMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'work lease');
    await ensureVerificationAutokickQueueTable();
    const renewed = await workCas(options, options?.phases ?? [PHASES.waiting, PHASES.verifying, PHASES.kickIntent],
        `lease_expires_at_ms = ${DB_NOW} + ?, next_attempt_at_ms = ${DB_NOW} + ?`, [leaseMs, leaseMs],
        `AND lease_expires_at_ms > ${DB_NOW}`);
    return { status: renewed ? 'renewed' : 'stale-lease', renewed };
}

async function markVerificationAutokickDmAttempted(options) {
    await ensureVerificationAutokickQueueTable();
    const marked = await workCas(options, [PHASES.waiting],
        `dm_attempted_at_ms = COALESCE(dm_attempted_at_ms, ${DB_NOW})`, [],
        `AND lease_expires_at_ms > ${DB_NOW}`);
    return { status: marked ? 'marked' : 'stale-lease', marked };
}

async function authorizeVerificationAutokickIntent(options) {
    const target = generation(options);
    const leaseToken = opaqueToken(options?.leaseToken);
    const deadlineStage = String(options?.deadlineStage ?? DEADLINE_STAGES.verification);
    if (!Object.values(DEADLINE_STAGES).includes(deadlineStage)) throw invariant('Invalid Verification autokick deadline stage.');
    const roleId = deadlineStage === DEADLINE_STAGES.verification
        ? identifier(options?.expectedVerificationRoleId, 'verification role ID')
        : null;
    const leaseMs = positive(options?.leaseDurationMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'kick-intent lease');
    const nonce = opaqueToken(options?.reportNonce, 'report nonce');
    await ensureVerificationAutokickTables();
    return withVerificationTransaction(async (query) => {
        const settings = await lockSettings(query, target.guildId);
        if (!settings || !normalizeBoolean(settings.autokick_enabled)) return { status: 'disabled', authorized: false };
        if (deadlineStage === DEADLINE_STAGES.verification
            && String(settings.verification_role_id ?? '') !== roleId) return { status: 'settings-changed', authorized: false };
        const now = await databaseNow(query, settings);
        const entry = await selectGeneration(query, target, true);
        if (!entry) return { status: 'missing', authorized: false };
        if (entry.phase !== PHASES.waiting
            || entry.deadlineStage !== deadlineStage
            || entry.leaseToken !== leaseToken) return { status: 'state-changed', authorized: false, entry };
        if (entry.leaseExpiresAtMs === null || entry.leaseExpiresAtMs <= now) return { status: 'lease-expired', authorized: false, entry };
        if (entry.kickDueAtMs === null || entry.kickDueAtMs > now) return { status: 'not-due', authorized: false, entry };
        const result = await query(`
            UPDATE verification_autokick_queue
            SET phase = 'kick_intent', kick_intent_at_ms = ${DB_NOW}, authorized_role_id = ?,
                report_nonce = ?, report_user_tag = ?, report_display_name = ?,
                lease_expires_at_ms = ${DB_NOW} + ?, next_attempt_at_ms = ${DB_NOW} + ?
            WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
              AND phase = 'waiting' AND deadline_stage = ?
              AND lease_token = ? AND lease_expires_at_ms > ${DB_NOW}
        `, [roleId, nonce, shortText(options?.userTag, target.userId, 128), shortText(options?.displayName, target.userId, 128),
            leaseMs, leaseMs, target.guildId, target.userId, target.joinedAtMs, deadlineStage, leaseToken]);
        if (affected(result) !== 1) throw invariant('Locked Verification kick-intent transition failed.');
        return { status: 'kick-intent', authorized: true, entry: await selectGeneration(query, target) };
    });
}

async function releaseVerificationAutokickWork(options) {
    const retryMs = positive(options?.retryDelayMs, 30_000, MAX_RETRY_MS, 'retry delay');
    await ensureVerificationAutokickQueueTable();
    const released = await workCas(options, options?.phases ?? [PHASES.waiting, PHASES.kickIntent],
        `next_attempt_at_ms = ${DB_NOW} + ?, lease_token = NULL, lease_expires_at_ms = NULL,
         attempt_count = LEAST(attempt_count + 1, ${MAX_UINT}), last_error_code = ?,
         unknown_attempt_count = LEAST(unknown_attempt_count + ?, ${MAX_UINT})`,
        [retryMs, shortText(options?.errorCode, 'unknown'), options?.unknownFailure === true ? 1 : 0]);
    return { status: released ? 'released' : 'stale-lease', released };
}

async function terminalizeVerificationAutokickWork(options) {
    const reason = terminalReason(options?.terminalReason);
    const dead = options?.deadLettered === true;
    await ensureVerificationAutokickQueueTable();
    const terminalized = await workCas(options, options?.phases ?? [PHASES.waiting, PHASES.verifying, PHASES.kickIntent],
        `phase = 'terminal', terminal_at_ms = ${DB_NOW}, terminal_reason = ?,
         dead_lettered_at_ms = CASE WHEN ? = 1 THEN ${DB_NOW} ELSE NULL END,
         next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
         attempt_count = LEAST(attempt_count + ?, ${MAX_UINT}), last_error_code = ?`,
        [reason, dead ? 1 : 0, options?.countFailure === true ? 1 : 0, shortText(options?.errorCode)]);
    return { status: terminalized ? (dead ? 'dead-lettered' : 'terminalized') : 'stale-lease', terminalized };
}

async function finishVerificationAutokickKick(options) {
    const target = generation(options);
    const nonce = opaqueToken(options?.reportNonce, 'report nonce');
    await ensureVerificationAutokickQueueTable();
    const result = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET phase = 'terminal', kick_succeeded_at_ms = ${DB_NOW}, terminal_at_ms = ${DB_NOW},
            terminal_reason = 'kicked', next_attempt_at_ms = NULL,
            lease_token = NULL, lease_expires_at_ms = NULL,
            report_status = 'pending', report_next_attempt_at_ms = ${DB_NOW}
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
          AND phase = 'kick_intent' AND report_nonce = ?
    `, [target.guildId, target.userId, target.joinedAtMs, nonce]);
    let finished = affected(result) === 1;
    if (!finished) {
        const entry = await selectGeneration(getDatabase().query.bind(getDatabase()), target);
        finished = entry?.phase === PHASES.terminal
            && entry.terminalReason === 'kicked'
            && entry.reportNonce === nonce;
    }
    return { status: finished ? 'finished' : 'stale-lease', finished };
}

async function finishVerificationAutokickOutcomeUnknown(options) {
    const target = generation(options);
    const nonce = opaqueToken(options?.reportNonce, 'report nonce');
    await ensureVerificationAutokickQueueTable();
    const result = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET phase = 'terminal', terminal_at_ms = ${DB_NOW}, terminal_reason = 'kick-outcome-unknown',
            next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
            report_status = 'pending', report_next_attempt_at_ms = ${DB_NOW}
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
          AND phase = 'kick_intent' AND report_nonce = ?
    `, [target.guildId, target.userId, target.joinedAtMs, nonce]);
    return { status: affected(result) === 1 ? 'finished' : 'stale-intent' };
}

async function beginVerificationAutokickCompletionFence(options) {
    const target = generation(options);
    const leaseToken = opaqueToken(options?.leaseToken);
    const expectedRoleId = identifier(options?.expectedVerificationRoleId, 'verification role ID');
    const completionReason = terminalReason(options?.completionReason, 'verified');
    const leaseMs = positive(options?.leaseDurationMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'completion lease');
    await ensureVerificationAutokickTables();
    return withVerificationTransaction(async (query) => {
        const settings = await lockSettings(query, target.guildId);
        if (String(settings?.verification_role_id ?? '') !== expectedRoleId) {
            return { status: 'settings-changed', safeToComplete: false, fenceAcquired: false };
        }
        const now = await databaseNow(query, settings);
        let entry = await selectLatestGeneration(query, target, true);
        if (entry?.joinedAtMs > target.joinedAtMs) {
            return { status: 'newer-generation', safeToComplete: false, fenceAcquired: false, entry };
        }
        if (entry?.joinedAtMs < target.joinedAtMs && entry.phase !== PHASES.terminal) {
            await query(`
                UPDATE verification_autokick_queue
                SET phase = 'terminal', terminal_at_ms = ${DB_NOW},
                    terminal_reason = 'membership-replaced', next_attempt_at_ms = NULL,
                    lease_token = NULL, lease_expires_at_ms = NULL
                WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
            `, [target.guildId, target.userId, entry.joinedAtMs]);
        }
        if (entry?.joinedAtMs !== target.joinedAtMs) entry = null;
        if (!entry) {
            await query(`
                INSERT INTO verification_autokick_queue
                    (guild_id, user_id, joined_at_ms, phase, authorized_role_id,
                     terminal_reason, next_attempt_at_ms, lease_token, lease_expires_at_ms)
                VALUES (?, ?, ?, 'verifying', ?, ?, ?, ?, ?)
            `, [target.guildId, target.userId, target.joinedAtMs, expectedRoleId, completionReason,
                now + leaseMs, leaseToken, now + leaseMs]);
            return { status: 'fenced', safeToComplete: true, fenceAcquired: true };
        }
        if (entry.phase === PHASES.kickIntent) return { status: 'kick-intent', safeToComplete: false, fenceAcquired: false, entry };
        if (entry.phase === PHASES.terminal) return { status: 'already-terminal', safeToComplete: entry.terminalReason !== 'kicked', fenceAcquired: false, entry };
        if (entry.phase === PHASES.verifying && entry.leaseExpiresAtMs > now && entry.leaseToken !== leaseToken) {
            return { status: 'completion-in-progress', safeToComplete: false, fenceAcquired: false, entry };
        }
        const result = await query(`
            UPDATE verification_autokick_queue
            SET phase = 'verifying', authorized_role_id = ?, terminal_reason = ?, next_attempt_at_ms = ?,
                lease_token = ?, lease_expires_at_ms = ?
            WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ? AND phase IN ('waiting','verifying')
        `, [expectedRoleId, completionReason, now + leaseMs, leaseToken, now + leaseMs,
            target.guildId, target.userId, target.joinedAtMs]);
        if (affected(result) !== 1) throw invariant('Locked Verification completion transition failed.');
        return { status: 'fenced', safeToComplete: true, fenceAcquired: true, entry: await selectGeneration(query, target) };
    });
}

async function finishVerificationAutokickCompletionFence(options) {
    const target = generation(options);
    const reason = terminalReason(options?.terminalReason, 'verified');
    await ensureVerificationAutokickQueueTable();
    const finished = await workCas(options, [PHASES.verifying],
        `phase = 'terminal', terminal_at_ms = ${DB_NOW}, terminal_reason = ?,
         next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL,
         report_status = 'none'`, [reason]);
    if (finished) return { status: 'finished', finished: true };

    // An UPDATE can report zero rows after a connection timeout even though its
    // prior attempt committed.  The terminal row is the authority here, not the
    // affected-row count returned by a later acknowledgement attempt.
    const existing = await selectGeneration(getDatabase().query.bind(getDatabase()), target);
    if (existing?.phase === PHASES.terminal && existing.terminalReason === reason) {
        return { status: 'finished', finished: true, acknowledgedByReadback: true };
    }
    if (existing) return { status: 'stale-fence', finished: false, entry: existing };

    if (options?.repairMissingCompletion !== true) {
        return { status: 'missing', finished: false };
    }

    // This repair is only called after the matching membership has already
    // received access.  It inserts an immutable terminal tombstone and never
    // updates an extant generation, so a rejoin, kick intent, or kicked result
    // always wins over this delayed acknowledgement.
    return withVerificationTransaction(async (query) => {
        const latest = await selectLatestGeneration(query, target, true);
        if (latest?.joinedAtMs > target.joinedAtMs) {
            return { status: 'newer-generation', finished: false, entry: latest };
        }
        const current = await selectGeneration(query, target, true);
        if (current?.phase === PHASES.terminal && current.terminalReason === reason) {
            return { status: 'finished', finished: true, acknowledgedByReadback: true };
        }
        if (current) return { status: 'stale-fence', finished: false, entry: current };
        await query(`
            INSERT IGNORE INTO verification_autokick_queue
                (guild_id, user_id, joined_at_ms, phase, deadline_stage, terminal_at_ms, terminal_reason,
                 next_attempt_at_ms, lease_token, lease_expires_at_ms, report_status)
            VALUES (?, ?, ?, 'terminal', 'verification', ${DB_NOW}, ?, NULL, NULL, NULL, 'none')
        `, [target.guildId, target.userId, target.joinedAtMs, reason]);
        const repaired = await selectGeneration(query, target, true);
        const repairedTerminal = repaired?.phase === PHASES.terminal
            && repaired.terminalReason === reason;
        return {
            status: repairedTerminal ? 'repaired' : 'stale-fence',
            finished: repairedTerminal,
            repaired: repairedTerminal,
            entry: repaired,
        };
    });
}

async function releaseVerificationAutokickCompletionFence(options) {
    await ensureVerificationAutokickQueueTable();
    const released = await workCas(options, [PHASES.verifying],
        `next_attempt_at_ms = ${DB_NOW},
         lease_token = NULL, lease_expires_at_ms = NULL, last_error_code = ?`,
        [shortText(options?.errorCode)]);
    return { status: released ? 'released' : 'stale-fence', released };
}

async function recoverVerificationAutokickCompletion(options) {
    await ensureVerificationAutokickQueueTable();
    const verified = options?.verified === true;
    const reason = terminalReason(options?.terminalReason, 'verified');
    const recovered = await workCas(options, [PHASES.verifying], verified
        ? `phase = 'terminal', terminal_at_ms = ${DB_NOW}, terminal_reason = ?,
           next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL`
        : `next_attempt_at_ms = ${DB_NOW},
           lease_token = NULL, lease_expires_at_ms = NULL`, verified ? [reason] : []);
    return { status: recovered ? (verified ? 'verified' : 'verifying') : 'stale-lease', recovered };
}

async function retireVerificationAutokickGeneration(options) {
    const target = generation(options);
    const reason = terminalReason(options?.terminalReason, 'event-retired');
    await ensureVerificationAutokickQueueTable();
    return withVerificationTransaction(async (query) => {
        const entry = await selectGeneration(query, target, true);
        if (!entry) {
            if (options?.insertIfMissing === false) return { status: 'unchanged' };
            const now = await databaseNow(query);
            await query(`
                INSERT INTO verification_autokick_queue
                    (guild_id, user_id, joined_at_ms, phase, terminal_at_ms, terminal_reason)
                VALUES (?, ?, ?, 'terminal', ?, ?)
            `, [target.guildId, target.userId, target.joinedAtMs, now, reason]);
            return { status: 'retired' };
        }
        if (entry.phase === PHASES.kickIntent) return { status: 'kick-intent', entry };
        if (entry.phase === PHASES.terminal) return { status: 'already-retired', entry };
        await query(`
            UPDATE verification_autokick_queue
            SET phase = 'terminal', terminal_at_ms = ${DB_NOW}, terminal_reason = ?,
                next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL
            WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ? AND phase IN ('waiting','verifying')
        `, [reason, target.guildId, target.userId, target.joinedAtMs]);
        return { status: 'retired' };
    });
}

async function retireDisabledVerificationAutokickQueue(targetGuildId) {
    const normalizedGuildId = guildId(targetGuildId);
    await ensureVerificationAutokickTables();
    return withVerificationTransaction(async (query) => {
        const settings = await lockSettings(query, normalizedGuildId);
        if (normalizeBoolean(settings?.autokick_enabled)) return { status: 'enabled', retired: 0 };
        const result = await query(`
            UPDATE verification_autokick_queue
            SET phase = 'terminal', terminal_at_ms = ${DB_NOW}, terminal_reason = 'settings-disabled',
                next_attempt_at_ms = NULL, lease_token = NULL, lease_expires_at_ms = NULL
            WHERE guild_id = ? AND phase = 'waiting'
        `, [normalizedGuildId]);
        return { status: 'disabled', retired: affected(result) };
    });
}

async function claimPendingVerificationAutokickReports(options) {
    const targetGuildId = guildId(options?.guildId);
    const leaseToken = opaqueToken(options?.leaseToken, 'report lease token');
    const leaseMs = positive(options?.leaseDurationMs, DEFAULT_LEASE_MS, MAX_LEASE_MS, 'report lease');
    const limit = positive(options?.limit, 10, MAX_BATCH, 'report batch size');
    await ensureVerificationAutokickQueueTable();
    await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET report_status = CASE
                WHEN report_message_id IS NOT NULL THEN 'sent'
                WHEN report_dispatched_at_ms IS NOT NULL THEN 'delivery_unknown'
                ELSE 'pending'
            END,
            report_lease_token = NULL, report_lease_expires_at_ms = NULL,
            report_next_attempt_at_ms = CASE
                WHEN report_message_id IS NULL AND report_dispatched_at_ms IS NULL THEN ${DB_NOW}
                ELSE NULL END
        WHERE guild_id = ? AND report_status = 'sending'
          AND report_lease_expires_at_ms <= ${DB_NOW}
    `, [targetGuildId]);
    const update = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET report_status = 'sending', report_lease_token = ?,
            report_lease_expires_at_ms = ${DB_NOW} + ?
        WHERE guild_id = ? AND phase = 'terminal'
          AND terminal_reason IN ('kicked','kick-outcome-unknown')
          AND report_status = 'pending' AND report_next_attempt_at_ms <= ${DB_NOW}
        ORDER BY report_next_attempt_at_ms, user_id, joined_at_ms LIMIT ?
    `, [leaseToken, leaseMs, targetGuildId, limit]);
    if (affected(update) < 1) return { status: 'empty', leaseToken, entries: [] };
    const rows = await getDatabase().query(`
        SELECT ${SELECT_COLUMNS} FROM verification_autokick_queue
        WHERE guild_id = ? AND report_status = 'sending' AND report_lease_token = ?
        ORDER BY user_id, joined_at_ms
    `, [targetGuildId, leaseToken]);
    return { status: 'claimed', leaseToken, entries: (rows ?? []).map(normalizeEntry) };
}

async function markVerificationAutokickReportDispatched(options) {
    const target = generation(options);
    const leaseToken = opaqueToken(options?.leaseToken, 'report lease token');
    await ensureVerificationAutokickQueueTable();
    const result = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET report_dispatched_at_ms = COALESCE(report_dispatched_at_ms, ${DB_NOW}),
            report_attempt_count = LEAST(report_attempt_count + 1, ${MAX_UINT})
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
          AND report_status = 'sending' AND report_lease_token = ?
          AND report_lease_expires_at_ms > ${DB_NOW}
    `, [target.guildId, target.userId, target.joinedAtMs, leaseToken]);
    const marked = affected(result) === 1;
    return { status: marked ? 'marked' : 'stale-report-lease', marked };
}

async function finishVerificationAutokickReport(options) {
    const target = generation(options);
    const leaseToken = opaqueToken(options?.leaseToken, 'report lease token');
    const messageId = identifier(options?.messageId, 'report message ID');
    await ensureVerificationAutokickQueueTable();
    const result = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET report_status = 'sent', report_message_id = ?, report_next_attempt_at_ms = NULL,
            report_lease_token = NULL, report_lease_expires_at_ms = NULL,
            report_last_error_code = NULL
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
          AND ((report_status = 'sending' AND report_lease_token = ?)
            OR report_status = 'delivery_unknown')
    `, [messageId, target.guildId, target.userId, target.joinedAtMs, leaseToken]);
    let finished = affected(result) === 1;
    if (!finished) {
        const rows = await getDatabase().query(`
            SELECT report_status, report_message_id FROM verification_autokick_queue
            WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ? LIMIT 1
        `, [target.guildId, target.userId, target.joinedAtMs]);
        finished = rows?.[0]?.report_status === REPORT.sent
            && String(rows[0].report_message_id ?? '') === messageId;
    }
    return { status: finished ? 'sent' : 'stale-report-lease', finished };
}

async function releaseVerificationAutokickReport(options) {
    const target = generation(options);
    const leaseToken = opaqueToken(options?.leaseToken, 'report lease token');
    const retryMs = positive(options?.retryDelayMs, 30_000, MAX_RETRY_MS, 'report retry delay');
    const dead = options?.deadLettered === true;
    const unknown = options?.deliveryUnknown === true;
    await ensureVerificationAutokickQueueTable();
    const result = await getDatabase().query(`
        UPDATE verification_autokick_queue
        SET report_status = ?, report_next_attempt_at_ms = CASE WHEN ? = 1 THEN NULL ELSE ${DB_NOW} + ? END,
            report_lease_token = NULL, report_lease_expires_at_ms = NULL,
            report_last_error_code = ?
        WHERE guild_id = ? AND user_id = ? AND joined_at_ms = ?
          AND report_status = 'sending' AND report_lease_token = ?
    `, [dead ? REPORT.dead : unknown ? REPORT.unknown : REPORT.pending, dead || unknown ? 1 : 0, retryMs, shortText(options?.errorCode, 'unknown'),
        target.guildId, target.userId, target.joinedAtMs, leaseToken]);
    const released = affected(result) === 1;
    return { status: released ? (dead ? 'dead' : unknown ? 'delivery-unknown' : 'pending') : 'stale-report-lease', released };
}

async function cleanupRetiredVerificationAutokickEntries(options = {}) {
    const retentionMs = positive(options.retentionMs, RETIRED_AUTOKICK_RETENTION_MS, Number.MAX_SAFE_INTEGER, 'retention');
    const limit = positive(options.limit, 500, 5000, 'cleanup batch size');
    const cutoff = milliseconds(options.retiredBeforeMs ?? Date.now() - retentionMs, 'cleanup cutoff');
    const auditCutoff = Math.min(cutoff, Date.now() - REPORT_AUDIT_RETENTION_MS);
    await ensureVerificationAutokickQueueTable();
    const result = await getDatabase().query(`
        DELETE FROM verification_autokick_queue
        WHERE phase = 'terminal'
          AND ((terminal_at_ms < ? AND report_status IN ('none','sent'))
            OR (terminal_at_ms < ? AND report_status IN ('delivery_unknown','dead')))
        ORDER BY terminal_at_ms LIMIT ?
    `, [cutoff, auditCutoff, limit]);
    return { deleted: affected(result), cutoffMs: cutoff };
}

module.exports = {
    DEADLINE_STAGES,
    PHASES,
    authorizeVerificationAutokickIntent,
    beginVerificationAutokickCompletionFence,
    resetVerificationAutokickCountdownAfterOnboarding,
    claimPendingVerificationAutokickReports,
    claimVerificationAutokickWork,
    cleanupRetiredVerificationAutokickEntries,
    enqueueVerificationAutokickGeneration,
    finishVerificationAutokickCompletionFence,
    finishVerificationAutokickKick,
    finishVerificationAutokickOutcomeUnknown,
    finishVerificationAutokickReport,
    getVerificationAutokickConfiguration,
    getVerificationAutokickSchedule,
    markVerificationAutokickDmAttempted,
    markVerificationAutokickReportDispatched,
    recoverVerificationAutokickCompletion,
    releaseVerificationAutokickCompletionFence,
    releaseVerificationAutokickReport,
    releaseVerificationAutokickWork,
    renewVerificationAutokickLease,
    retireDisabledVerificationAutokickQueue,
    retireVerificationAutokickGeneration,
    terminalizeVerificationAutokickWork,
};
