'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');
const { createConsoleReporter } = require('../../logging/consoleReporting');
const { isTransientDatabaseError } = require('../db/errorPolicy');
const { createWebsiteSyncQueue, httpFailure, isTransient } = require('../websiteSyncQueue');
const { publicEvent } = require('./eventPayload');
const { runGuildMutation } = require('./guildMutations');
const repository = require('./repository');

const ENDPOINT_PATH = '/axi-events/v1/sync';
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const PAYLOAD_LIMIT_BYTES = 1024 * 1024;
const AUTOMATIC_DEBOUNCE_MS = 15_000;
const INTEREST_BATCH_MS = 5 * 60_000;
const WEBSITE_FAST_RETRIES = 3;
const WEBSITE_FAST_RETRY_MS = 60_000;
const WEBSITE_SLOW_RETRY_MS = 30 * 60_000;
const report = createConsoleReporter('Scheduled Events').forSubsystem('Website');

function requiredEnvironment() {
    const url = String(process.env.AXI_EVENTS_SYNC_URL ?? '').trim();
    const keyId = String(process.env.AXI_EVENTS_SYNC_KEY_ID ?? '').trim();
    const secret = String(process.env.AXI_EVENTS_SYNC_SECRET ?? '').trim();
    if (!url && !keyId && !secret) return undefined;
    if (!url || !keyId || !secret) {
        throw new Error('Scheduled event website publishing requires AXI_EVENTS_SYNC_URL, AXI_EVENTS_SYNC_KEY_ID, and AXI_EVENTS_SYNC_SECRET together.');
    }
    if (!/^[a-z0-9_-]{1,64}$/u.test(keyId)) {
        throw new Error('AXI_EVENTS_SYNC_KEY_ID must contain 1–64 lowercase letters, numbers, dashes, or underscores.');
    }
    if (secret.length < 32) {
        throw new Error('AXI_EVENTS_SYNC_SECRET must contain at least 32 characters.');
    }
    let endpoint;
    try { endpoint = new URL(url); }
    catch { throw new Error('AXI_EVENTS_SYNC_URL must be a valid HTTPS URL.'); }
    const suffix = `/wp-json${ENDPOINT_PATH}`;
    if (endpoint.protocol !== 'https:' || !endpoint.pathname.endsWith(suffix)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error(`AXI_EVENTS_SYNC_URL must target an HTTPS ${suffix} endpoint, optionally below the WordPress installation path.`);
    }
    return { endpoint, keyId, secret };
}

function isWebsiteSyncConfigured() {
    return Boolean(requiredEnvironment());
}

async function buildSnapshot(guildId, revision) {
    const items = await repository.listSnapshotItems(guildId);
    const events = items
        .filter((item) => item.publicationState === 'published')
        .map(publicEvent);
    const deletions = items
        .filter((item) => item.publicationState === 'delete_pending')
        .map((item) => item.eventId);
    return {
        schemaVersion: 2,
        guildId: String(guildId),
        revision: Number(revision),
        generatedAt: new Date().toISOString(),
        events,
        deletions,
    };
}

function sendSignedPayload(config, payload, signal) {
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
    if (rawBody.length > PAYLOAD_LIMIT_BYTES) throw new Error('Scheduled event website payload exceeds the 1 MiB endpoint limit.');
    const started = Date.now();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(18).toString('base64url');
    const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const canonical = `POST\n${ENDPOINT_PATH}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = crypto.createHmac('sha256', config.secret).update(canonical, 'utf8').digest('hex');
    return new Promise((resolve, reject) => {
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
            signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        }, (response) => {
            let responseBytes = 0;
            const responseChunks = [];
            response.on('data', (chunk) => {
                responseBytes += chunk.length;
                if (responseBytes > RESPONSE_LIMIT_BYTES) request.destroy(new Error('Scheduled event website response exceeded 64 KiB.'));
                else responseChunks.push(chunk);
            });
            response.once('error', reject);
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(httpFailure('Scheduled event website', response, Buffer.concat(responseChunks).toString('utf8')));
                }
                else {
                    let body;
                    try {
                        body = JSON.parse(Buffer.concat(responseChunks).toString('utf8'));
                    }
                    catch {
                        reject(Object.assign(new Error('Scheduled event website returned an invalid success response.'), {
                            retryable: true,
                        }));
                        return;
                    }
                    if (body?.success !== true || Number(body?.revision) !== Number(payload.revision)) {
                        reject(new Error('Scheduled event website did not confirm the submitted snapshot revision.'));
                        return;
                    }
                    resolve({ statusCode: response.statusCode, responseBytes, body, payloadBytes: rawBody.length, durationMs: Date.now() - started });
                }
            });
        });
        request.once('timeout', () => request.destroy(Object.assign(
            new Error('Scheduled event website request timed out.'), { code: 'ETIMEDOUT' },
        )));
        request.once('error', reject);
        request.end(rawBody);
    });
}

async function publishSnapshot(guildId, { reason, signal }) {
    if (signal.aborted) return { skipped: signal.reason };
    if (await repository.isWebsiteSyncPaused(guildId)) return { skipped: 'paused' };
    const config = requiredEnvironment();
    if (!config) return { skipped: 'unconfigured' };
    const initial = await repository.listSnapshotItems(guildId);
    if (initial.length < 1) return { skipped: 'no-publications' };
    const revision = await repository.reservePublicationRevision(guildId);
    if (revision == null) return { skipped: 'no-publications' };
    const snapshot = await buildSnapshot(guildId, revision);
    const paused = await repository.isWebsiteSyncPaused(guildId);
    if (signal.aborted) return { skipped: signal.reason };
    if (paused) return { skipped: 'paused' };
    const response = await sendSignedPayload(config, snapshot, signal);
    const completedDeletions = await repository.completeWebsiteDeletions(guildId, snapshot.deletions);
    const cleanedTerminalEvents = await repository.cleanupDeliveredTerminalEvents(
        guildId,
        [
            ...snapshot.events.filter((event) => event.status === 'ended').map((event) => event.id),
            ...snapshot.deletions,
        ],
    );
    report.success('Snapshot published', {
        reason,
        revision: snapshot.revision,
        ...(process.env.AXI_WEBSITE_SYNC_DIAGNOSTICS === '1' ? {
            payloadBytes: response.payloadBytes, durationMs: response.durationMs,
        } : {}),
        events: snapshot.events.length,
        deletions: completedDeletions,
        terminalEventsCleaned: cleanedTerminalEvents,
    });
    return { snapshot, response, completedDeletions, cleanedTerminalEvents };
}

const queue = createWebsiteSyncQueue({
    send: (guildId, job, { signal, retry }) => runGuildMutation(guildId, () =>
        publishSnapshot(guildId, { reason: retry ? 'website retry' : job.reason, signal })),
    merge: (previous, next) => (next.reason === 'interest changed' ? previous : next),
    isRetryable: (error) => isTransient(error) || isTransientDatabaseError(error),
    retryDelay: (attempt) => attempt <= WEBSITE_FAST_RETRIES ? WEBSITE_FAST_RETRY_MS : WEBSITE_SLOW_RETRY_MS,
    onFailure({ error, retryMs, failures, durationMs }) {
        if (!retryMs) {
            report.warn('Website sync needs manual attention', error);
            return;
        }
        report.warn(failures <= WEBSITE_FAST_RETRIES ? 'Website sync retry scheduled' : 'Website sync waiting for next recovery check', undefined, {
            retryInMs: retryMs,
            ...(process.env.AXI_WEBSITE_SYNC_DIAGNOSTICS === '1' ? { status: error.status, durationMs } : {}),
        });
    },
});

function requestWebsiteSync(guildId, { reason = 'automatic', debounceMs = 0 } = {}) {
    const manual = reason === 'manual' || reason === 'sync enabled';
    return queue.request(String(guildId), { reason }, { debounceMs, manual, retryNow: manual });
}

function requestAutomaticWebsiteSync(guildId, reason = 'event update') {
    return queue.request(String(guildId), { reason }, {
        debounceMs: reason === 'interest changed' ? INTEREST_BATCH_MS : AUTOMATIC_DEBOUNCE_MS,
        waitForDelivery: false,
    });
}

function pauseWebsiteSync(guildId) {
    queue.cancel(String(guildId), 'paused');
}

module.exports = {
    ENDPOINT_PATH,
    PAYLOAD_LIMIT_BYTES,
    REQUEST_TIMEOUT_MS,
    buildSnapshot,
    isWebsiteSyncConfigured,
    pauseWebsiteSync,
    requestAutomaticWebsiteSync,
    requestWebsiteSync,
    sendSignedPayload,
    start: queue.start,
    shutdown: queue.shutdown,
};
