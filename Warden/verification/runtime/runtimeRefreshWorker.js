'use strict';

const { isTransientDatabaseError } = require('../../db/errorPolicy');
const { createVerificationLogger } = require('../logging');
const { refreshVerificationRuntimeContext } = require('../service');

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const TRANSIENT_REFRESH_ERROR_CODES = new Set([
    'VERIFICATION_SNAPSHOT_TIMEOUT',
]);

const runtimeRefreshLog = createVerificationLogger('Runtime refresh');

function isTransientRefreshError(error) {
    if (isTransientDatabaseError(error)) return true;
    const visited = new Set();
    for (let current = error; current && !visited.has(current); current = current.cause) {
        visited.add(current);
        if (TRANSIENT_REFRESH_ERROR_CODES.has(String(current?.code ?? ''))) return true;
    }
    return false;
}

function delayUntilRetry(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve(false);
        let timer;
        const finish = (ready) => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener?.('abort', abort);
            resolve(ready);
        };
        const abort = () => finish(false);
        timer = setTimeout(() => finish(true), ms);
        timer.unref?.();
        signal?.addEventListener?.('abort', abort, { once: true });
    });
}

function attachFirstRefreshFailure(finalError, firstError) {
    const normalizedError = finalError instanceof Error
        ? finalError
        : new Error(String(finalError));
    if (normalizedError !== firstError && normalizedError.cause === undefined) {
        normalizedError.cause = firstError;
    }
    normalizedError.verificationRuntimeRefreshRetryAttempted = true;
    return normalizedError;
}

function startVerificationRuntimeRefreshWorker({
    guildId,
    lifecycle,
    intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    refresh = refreshVerificationRuntimeContext,
    sleep = delayUntilRetry,
    logger = runtimeRefreshLog,
} = {}) {
    if (!lifecycle || typeof lifecycle.scheduleRepeating !== 'function') {
        throw new TypeError('Verification runtime refresh requires a guild lifecycle owner.');
    }
    lifecycle.assertCurrent();
    if (String(lifecycle.guildId) !== String(guildId)) {
        throw new TypeError('Verification runtime refresh lifecycle ownership must match the guild.');
    }

    let failureEpisodeActive = false;

    return lifecycle.scheduleRepeating(async (signal) => {
        let failure;
        try {
            await refresh({ guildId: lifecycle.guildId });
        }
        catch (firstError) {
            failure = firstError;
            if (isTransientRefreshError(firstError)) {
                const shouldRetry = await sleep(retryDelayMs, signal);
                if (!shouldRetry || !lifecycle.isCurrent()) return;
                try {
                    await refresh({ guildId: lifecycle.guildId });
                    failure = undefined;
                }
                catch (retryError) {
                    failure = attachFirstRefreshFailure(retryError, firstError);
                }
            }
        }

        if (!lifecycle.isCurrent()) return;
        if (!failure) {
            failureEpisodeActive = false;
            return;
        }
        if (failureEpisodeActive) return;

        failureEpisodeActive = true;
        logger.warn(
            failure.verificationRuntimeRefreshRetryAttempted
                ? 'Refresh failed after retry; retaining the last-known-good context.'
                : 'Refresh failed; retaining the last-known-good context.',
            failure,
            { guildId: lifecycle.guildId },
        );
    }, intervalMs);
}

module.exports = {
    DEFAULT_REFRESH_INTERVAL_MS,
    startVerificationRuntimeRefreshWorker,
};
