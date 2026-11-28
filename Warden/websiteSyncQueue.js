const MIN_RETRY_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504, 508]);
const TRANSIENT_NETWORK = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE']);
const PERMANENT_CODES = new Set(['bridge_unconfigured', 'trash_unavailable', 'invalid_target',
    'invalid_additional_taxonomy', 'invalid_additional_terms']);

function httpFailure(label, response, body) {
    let code;
    try { code = JSON.parse(body)?.code; }
    catch { code = undefined; }
    const status = response.statusCode;
    const error = new Error(`${label} returned HTTP ${status}.`);
    error.status = status;
    error.retryable = TRANSIENT_STATUS.has(status) && !PERMANENT_CODES.has(code);
    const header = response.headers?.['retry-after'];
    if (error.retryable && typeof header === 'string') {
        const delay = (/^\d+$/u).test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = delay;
    }
    return error;
}

function isTransient(error) {
    return error?.retryable === true || TRANSIENT_NETWORK.has(error?.code) ||
        (error?.code === 'ABORT_ERR' && error.cause?.name === 'TimeoutError');
}

function backoffMs(attempt, random = Math.random) {
    const ceiling = Math.min(MAX_BACKOFF_MS, 2 ** Math.min(attempt, 10) * MIN_RETRY_MS);
    return Math.round(ceiling * (0.5 + random() * 0.5));
}

function createWebsiteSyncQueue({
    send, merge, onFailure, retryDelay = backoffMs, isRetryable = isTransient, now = Date.now, random = Math.random,
}) {
    const queues = new Map();
    let stopped = false;

    function settle(waiters, error, result) {
        for (const waiter of waiters) {
            if (error) waiter.reject(error);
            else waiter.resolve(result);
        }
    }

    function schedule(key, state) {
        if (state.running || state.blocked || !state.pending || stopped) return;
        const due = Math.max(state.due, state.retryAt);
        if (state.timer && state.timerDue === due) return;
        clearTimeout(state.timer);
        const delay = due - now();
        if (delay > 0) {
            state.timerDue = due;
            state.timer = setTimeout(() => {
                state.timer = undefined;
                schedule(key, state);
            }, Math.min(delay, MAX_TIMER_MS));
            state.timer.unref?.();
            return;
        }
        state.timer = undefined;
        const job = state.pending;
        state.pending = undefined;
        state.due = Infinity;
        const started = now();
        const controller = new AbortController();
        const { signal } = controller;
        state.controller = controller;
        const waiters = state.waiters.splice(0);
        state.running = Promise.resolve().then(() => {
            if (signal.aborted) return { skipped: signal.reason };
            return send(key, job, { signal, retry: state.retryAt > 0 });
        }).then((result) => {
            if (!signal.aborted) resetRetry(state);
            settle(waiters, null, result);
        }, (error) => {
            if (signal.aborted) {
                settle(waiters, null, { skipped: signal.reason });
                return;
            }
            state.pending = state.pending ? merge(job, state.pending) : job;
            state.due = now();
            const retryMs = isRetryable(error) ? Math.max(error.retryAfterMs ?? 0, retryDelay(++state.failures, random)) : 0;
            if (retryMs) {
                state.retryAt = now() + retryMs;
                state.retryAfter = now() + (error.retryAfterMs ?? 0);
            } else {
                state.blocked = true;
            }
            settle([...waiters, ...state.waiters.splice(0)], error);
            onFailure?.({ error, retryMs, failures: state.failures, durationMs: now() - started });
        }).finally(() => {
            state.controller = undefined;
            state.running = undefined;
            if (state.pending) schedule(key, state);
            else queues.delete(key);
        });
    }

    function resetRetry(state) {
        state.blocked = false;
        state.failures = 0;
        state.retryAt = 0;
        state.retryAfter = 0;
    }

    function request(key, job, { debounceMs = 0, manual = false, retryNow = false, waitForDelivery = true } = {}) {
        if (stopped) return Promise.resolve({ skipped: 'shutdown' });
        let state = queues.get(key);
        if (!state) {
            state = { waiters: [], due: Infinity };
            resetRetry(state);
            queues.set(key, state);
        }
        state.pending = state.pending ? merge(state.pending, job) : job;
        if (manual) state.blocked = false;
        if (state.blocked) return Promise.resolve({ skipped: 'blocked' });
        if (manual && retryNow && state.retryAfter <= now()) state.retryAt = 0;
        state.due = Math.min(state.due, now() + debounceMs);
        if (state.retryAt > now()) {
            schedule(key, state);
            return Promise.resolve({ skipped: 'retry scheduled' });
        }
        if (!waitForDelivery) {
            schedule(key, state);
            return Promise.resolve({ queued: true });
        }
        const result = new Promise((resolve, reject) => {
            state.waiters.push({ resolve, reject });
        });
        schedule(key, state);
        return result;
    }

    function cancel(key, reason) {
        const state = queues.get(key);
        if (!state) return;
        clearTimeout(state.timer);
        state.timer = undefined;
        state.pending = undefined;
        state.due = Infinity;
        resetRetry(state);
        settle(state.waiters.splice(0), null, { skipped: reason });
        state.controller?.abort(reason);
        if (!state.running) queues.delete(key);
    }

    async function shutdown() {
        stopped = true;
        for (const key of queues.keys()) cancel(key, 'shutdown');
        await Promise.allSettled([...queues.values()].map((state) => state.running));
        queues.clear();
    }

    return { request, cancel, shutdown, start: () => { stopped = false; } };
}

module.exports = { backoffMs, createWebsiteSyncQueue, httpFailure, isTransient };
