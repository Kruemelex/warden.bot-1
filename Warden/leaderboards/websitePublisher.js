'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');
const { createConsoleReporter } = require('../../consoleReporting');
const { isLeaderboardMigrationMode } = require('../db/leaderboards/migrationGuard');
const { listAceBoard, listSpeedrunBoard } = require('../db/leaderboards/repository');
const settings = require('./settings');
const settingsRepository = require('./settingsRepository');

const ENDPOINT_PATH = '/axi-leaderboards/v1/sync';
const MAX_ENTRIES_PER_BOARD = 25;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SPEEDRUN_BOARDS = Object.freeze(
    ['cyclops', 'basilisk', 'medusa', 'hydra'].flatMap((variant) => (
        ['small', 'medium', 'large'].map((shipClass) => Object.freeze({ variant, shipClass }))
    )),
);
const ACE_BOARDS = Object.freeze(['chieftain', 'challenger', 'kraitmk2', 'fdl']);
const report = createConsoleReporter('Warden').forSubsystem('Leaderboard website');

let scheduledSync;
const operations = new Map();

function requiredEnvironment() {
    const url = String(process.env.AXI_LEADERBOARDS_SYNC_URL ?? '').trim();
    const keyId = String(process.env.AXI_LEADERBOARDS_SYNC_KEY_ID ?? '').trim();
    const secret = String(process.env.AXI_LEADERBOARDS_SYNC_SECRET ?? '').trim();
    if (!url && !keyId && !secret) return undefined;
    if (!url || !keyId || !secret) {
        throw new Error('Leaderboard website publishing requires AXI_LEADERBOARDS_SYNC_URL, AXI_LEADERBOARDS_SYNC_KEY_ID, and AXI_LEADERBOARDS_SYNC_SECRET together.');
    }
    if (!/^[a-z0-9_-]{1,64}$/u.test(keyId)) {
        throw new Error('AXI_LEADERBOARDS_SYNC_KEY_ID must contain 1–64 lowercase letters, numbers, dashes, or underscores.');
    }
    if (secret.length < 32) {
        throw new Error('AXI_LEADERBOARDS_SYNC_SECRET must contain at least 32 characters.');
    }
    let endpoint;
    try { endpoint = new URL(url); }
    catch { throw new Error('AXI_LEADERBOARDS_SYNC_URL must be a valid HTTPS URL.'); }
    const restPathSuffix = `/wp-json${ENDPOINT_PATH}`;
    if (endpoint.protocol !== 'https:' || !endpoint.pathname.endsWith(restPathSuffix)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error(`AXI_LEADERBOARDS_SYNC_URL must target an HTTPS ${restPathSuffix} endpoint, optionally below the WordPress installation path.`);
    }
    return { endpoint, keyId, secret };
}

function isWebsiteSyncConfigured() {
    return Boolean(requiredEnvironment());
}

function speedrunKey({ variant, shipClass }) {
    return `${variant}:${shipClass}`;
}

function publicSubmissionDate(value) {
    const date = new Date(Number(value));
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function normalizeRequest(request = {}) {
    if (request.full) return { full: true, speedrun: [], ace: [] };
    const speedrun = new Map();
    const speedrunBoards = request.speedrun instanceof Map
        ? request.speedrun.values()
        : request.speedrun ?? [];
    for (const board of speedrunBoards) {
        const variant = String(board?.variant ?? '').toLowerCase();
        const shipClass = String(board?.shipClass ?? '').toLowerCase();
        if (SPEEDRUN_BOARDS.some((candidate) => candidate.variant === variant && candidate.shipClass === shipClass)) {
            speedrun.set(speedrunKey({ variant, shipClass }), { variant, shipClass });
        }
    }
    const ace = new Set();
    const aceBoards = request.ace instanceof Set ? request.ace.values() : request.ace ?? [];
    for (const value of aceBoards) {
        const shiptype = String(value ?? '').toLowerCase();
        if (ACE_BOARDS.includes(shiptype)) ace.add(shiptype);
    }
    return { full: false, speedrun: [...speedrun.values()], ace: [...ace] };
}

function mergeRequest(left, right) {
    if (left.full || right.full) return normalizeRequest({ full: true });
    return normalizeRequest({
        speedrun: [...left.speedrun, ...right.speedrun],
        ace: [...left.ace, ...right.ace],
    });
}

function publicSpeedrunEntry(row) {
    const totalSeconds = Number(row.time);
    return {
        pilotName: String(row.name ?? ''),
        link: String(row.link ?? ''),
        hours: Math.floor(totalSeconds / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
        milliseconds: row.milliseconds == null ? null : Number(row.milliseconds),
        ship: String(row.ship ?? ''),
        submissionDate: publicSubmissionDate(row.date),
    };
}

function publicAceEntry(row) {
    return {
        pilotName: String(row.name ?? ''),
        link: String(row.link ?? ''),
        score: Number(row.score),
        timeTaken: Number(row.timetaken),
        smallGauss: Number(row.sgauss),
        smallGaussFired: Number(row.sgaussfired),
        mediumGauss: Number(row.mgauss),
        mediumGaussFired: Number(row.mgaussfired),
        hullDamage: Number(row.percenthulllost),
        submissionDate: publicSubmissionDate(row.date),
    };
}

async function buildSnapshot(guildId, request, revision) {
    const normalized = normalizeRequest(request);
    const speedrunBoards = normalized.full ? SPEEDRUN_BOARDS : normalized.speedrun;
    const aceBoards = normalized.full ? ACE_BOARDS : normalized.ace;
    const boards = { speedrun: {}, ace: {} };
    for (const board of speedrunBoards) {
        const rows = await listSpeedrunBoard(board.variant, board.shipClass);
        boards.speedrun[speedrunKey(board)] = {
            variant: board.variant,
            shipClass: board.shipClass,
            entries: rows.slice(0, MAX_ENTRIES_PER_BOARD).map(publicSpeedrunEntry),
        };
    }
    for (const shiptype of aceBoards) {
        const rows = await listAceBoard(shiptype, { limit: MAX_ENTRIES_PER_BOARD });
        boards.ace[shiptype] = {
            shiptype,
            entries: rows.slice(0, MAX_ENTRIES_PER_BOARD).map(publicAceEntry),
        };
    }
    return {
        schemaVersion: 1,
        guildId: String(guildId),
        revision: Number(revision),
        generatedAt: new Date().toISOString(),
        scope: normalized.full ? 'full' : 'targeted',
        boards,
    };
}

function sendSignedPayload(config, payload) {
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    if (rawBody.length > 1024 * 1024) throw new Error('Leaderboard website payload exceeds the 1 MiB endpoint limit.');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(18).toString('base64url');
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const canonical = `POST\n${ENDPOINT_PATH}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = crypto.createHmac('sha256', config.secret).update(canonical, 'utf8').digest('hex');
    return new Promise((resolve, reject) => {
        const request = https.request(config.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': rawBody.length,
                'X-AXI-Key-Id': config.keyId,
                'X-AXI-Timestamp': timestamp,
                'X-AXI-Nonce': nonce,
                'X-AXI-Content-SHA256': bodyHash,
                'X-AXI-Signature': signature,
            },
            timeout: REQUEST_TIMEOUT_MS,
        }, (response) => {
            let responseBytes = 0;
            response.on('data', (chunk) => {
                responseBytes += chunk.length;
                if (responseBytes > RESPONSE_LIMIT_BYTES) {
                    request.destroy(new Error('Leaderboard website response exceeded 64 KiB.'));
                }
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`Leaderboard website returned HTTP ${response.statusCode}.`));
                }
                else resolve({ statusCode: response.statusCode, responseBytes });
            });
        });
        request.once('timeout', () => request.destroy(new Error('Leaderboard website request timed out.')));
        request.once('error', reject);
        request.end(rawBody);
    });
}

async function publishRequest(guildId, request, { force = false, reason = 'automatic' } = {}) {
    if (isLeaderboardMigrationMode()) {
        const error = new Error('Leaderboard website publishing is unavailable during encrypted-data migration.');
        error.code = 'LEADERBOARD_MIGRATION_MODE';
        throw error;
    }
    const config = requiredEnvironment();
    if (!config) {
        const error = new Error('Leaderboard website publishing is not configured. Set AXI_LEADERBOARDS_SYNC_URL, AXI_LEADERBOARDS_SYNC_KEY_ID, and AXI_LEADERBOARDS_SYNC_SECRET.');
        error.code = 'LEADERBOARD_WEBSITE_SYNC_UNCONFIGURED';
        throw error;
    }
    const current = await settings.get(guildId);
    if (!current.websitePublishingEnabled && !force) return { skipped: 'disabled' };
    const revised = await settingsRepository.reservePublicationRevision(guildId);
    const snapshot = await buildSnapshot(guildId, request, revised.publicationRevision);
    const response = await sendSignedPayload(config, snapshot);
    report.success('Snapshot published', {
        reason,
        scope: snapshot.scope,
        revision: snapshot.revision,
        speedrunBoards: Object.keys(snapshot.boards.speedrun).length,
        aceBoards: Object.keys(snapshot.boards.ace).length,
    });
    return { snapshot, response };
}

function requestWebsiteSync(guildId, request, options) {
    const key = String(guildId);
    const normalized = normalizeRequest(request);
    const existing = operations.get(key);
    if (existing) {
        existing.pending = existing.pending ? mergeRequest(existing.pending, normalized) : normalized;
        return existing.promise;
    }
    const state = { pending: normalized, promise: undefined };
    state.promise = (async () => {
        let lastResult;
        while (state.pending) {
            const next = state.pending;
            state.pending = undefined;
            lastResult = await publishRequest(key, next, options);
        }
        return lastResult;
    })().finally(() => {
        if (operations.get(key) === state) operations.delete(key);
    });
    operations.set(key, state);
    return state.promise;
}

async function publishApprovedSubmission(guildId, leaderboard, submission) {
    const request = leaderboard === 'speedrun'
        ? { speedrun: [{ variant: submission.variant, shipClass: submission.class }] }
        : { ace: [submission.shiptype] };
    return requestWebsiteSync(guildId, request, { reason: 'approval' });
}

function startWebsiteSyncLifecycle(guild) {
    if (!guild?.id || scheduledSync) return;
    const run = () => requestWebsiteSync(guild.id, { full: true }, { reason: 'daily' })
        .catch((error) => report.warn('Scheduled sync failed', error));
    scheduledSync = setInterval(run, DAILY_SYNC_INTERVAL_MS);
    scheduledSync.unref?.();
}

function stopWebsiteSyncLifecycle() {
    if (scheduledSync) clearInterval(scheduledSync);
    scheduledSync = undefined;
}

module.exports = {
    ACE_BOARDS,
    ENDPOINT_PATH,
    MAX_ENTRIES_PER_BOARD,
    SPEEDRUN_BOARDS,
    buildSnapshot,
    isWebsiteSyncConfigured,
    publishApprovedSubmission,
    requestWebsiteSync,
    startWebsiteSyncLifecycle,
    stopWebsiteSyncLifecycle,
};
