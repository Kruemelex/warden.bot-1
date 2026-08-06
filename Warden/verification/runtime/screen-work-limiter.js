const {
    VERIFICATION_IMAGE_OPERATION_BUSY,
    VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    createVerificationImageQueueError,
} = require('../assets/errors');
const { createPrioritySemaphore } = require('./priority-semaphore');
const { getBoundedEnvironmentInteger } = require('./environment');
const { createVerificationLogger } = require('../logging');

const screenWorkLog = createVerificationLogger('Screen work');

const DEFAULT_SCREEN_WORK_MAX_PENDING = 4;
const MAX_SCREEN_WORK_PENDING = 12;
const DEFAULT_SCREEN_WORK_QUEUE_TIMEOUT_MS = 60_000;
const SCREEN_WORK_STALL_WARNING_MS = 45_000;
const EVENT_LOOP_PROBE_INTERVAL_MS = 250;
const EVENT_LOOP_STALL_THRESHOLD_MS = 350;
const STOCK_STALL_SUSPENSION_MS = 5 * 60_000;
const SCREEN_WORK_PRIORITIES = Object.freeze({
    live: 'live',
    preview: 'admin',
    admin: 'admin',
    stock: 'background',
});
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function createScreenWorkError(message, code) {
    return createVerificationImageQueueError(message, code);
}

function mapAdmissionError(error, { label, maxPending, timeoutMs }) {
    if (error?.code === 'PRIORITY_SEMAPHORE_QUEUE_FULL') {
        return createScreenWorkError(
            `Verification image delivery is temporarily busy (${maxPending} screens pending).`,
            VERIFICATION_IMAGE_OPERATION_BUSY,
        );
    }
    if (error?.code === 'PRIORITY_SEMAPHORE_QUEUE_TIMEOUT') {
        return createScreenWorkError(
            `${label} timed out after ${timeoutMs}ms while waiting to start.`,
            VERIFICATION_IMAGE_OPERATION_TIMEOUT,
        );
    }
    return error;
}

function createVerificationScreenWorkLimiter({
    maxPending = getBoundedEnvironmentInteger(
        'VERIFICATION_SCREEN_QUEUE_LIMIT',
        DEFAULT_SCREEN_WORK_MAX_PENDING,
        1,
        MAX_SCREEN_WORK_PENDING,
    ),
    monitorEventLoop = false,
} = {}) {
    if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > MAX_SCREEN_WORK_PENDING) {
        throw new Error(
            `Verification screen-work queue limit must be between 1 and ${MAX_SCREEN_WORK_PENDING}.`,
        );
    }

    const semaphore = createPrioritySemaphore({ capacity: 1, maxPending });
    let activeMeta;
    let lastForegroundAt = Date.now();
    let latestEventLoopLagMs = 0;
    let stockSuspendedUntil = 0;
    let stockPreemptions = 0;
    const stockJobs = new Set();
    let stockInterruptionController = new AbortController();

    function getStats() {
        const stats = semaphore.getStats();
        return Object.freeze({
            active: stats.active,
            activePriority: activeMeta?.priorityName,
            activeLabel: activeMeta?.label,
            queued: stats.queued,
            concurrency: stats.capacity,
            queueLimit: stats.maxPending,
            foregroundIdleMs: Math.max(0, Date.now() - lastForegroundAt),
            eventLoopLagMs: latestEventLoopLagMs,
            stockSuspendedMs: Math.max(0, stockSuspendedUntil - Date.now()),
            stockPreemptions,
        });
    }

    function createStockAbortError(message, interruptedBy) {
        const error = new Error(message);
        error.name = 'AbortError';
        error.code = 'VERIFICATION_SCREEN_WORK_ABORTED';
        if (interruptedBy) error.interruptedBy = interruptedBy;
        return error;
    }

    function abortStockJobs(message, interruptedBy) {
        let activeStockAborted = false;
        let queuedStockAborted = 0;
        const interruption = createStockAbortError(message, interruptedBy);
        stockInterruptionController.abort(interruption);
        stockInterruptionController = new AbortController();
        for (const job of stockJobs) {
            if (job.signal?.aborted || job.controller.signal.aborted) continue;
            job.controller.abort(interruption);
            if (job.started) activeStockAborted = true;
            else queuedStockAborted += 1;
        }
        stockPreemptions += Number(activeStockAborted) + queuedStockAborted;
        return Object.freeze({ activeStockAborted, queuedStockAborted });
    }

    function getStockInterruptionSignal() {
        return stockInterruptionController.signal;
    }

    function noteForegroundActivity(interruptedBy = 'foreground work') {
        lastForegroundAt = Date.now();
        return abortStockJobs(
            'Verification asset stock preparation yielded to foreground work.',
            interruptedBy,
        );
    }

    function suspendStockWork(reason, durationMs = STOCK_STALL_SUSPENSION_MS) {
        stockSuspendedUntil = Math.max(stockSuspendedUntil, Date.now() + durationMs);
        const result = abortStockJobs(
            `Verification asset stock preparation was suspended: ${reason}`,
            reason,
        );
        if (result.activeStockAborted || result.queuedStockAborted > 0) {
            screenWorkLog.warn('Asset stock suspended', undefined, { durationMs, reason });
        }
        return result;
    }

    async function run(operation, {
        priority = 'live',
        timeoutMs = DEFAULT_SCREEN_WORK_QUEUE_TIMEOUT_MS,
        label = 'Preparing verification screen',
        signal,
    } = {}) {
        if (typeof operation !== 'function') {
            throw new TypeError('Verification screen work must be a function.');
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            throw new Error('Verification screen-work queue timeout must be positive.');
        }

        const priorityName = Object.hasOwn(SCREEN_WORK_PRIORITIES, priority)
            ? priority
            : 'admin';
        const admissionPriority = SCREEN_WORK_PRIORITIES[priorityName];
        if (priorityName !== 'stock') noteForegroundActivity();
        else if (stockSuspendedUntil > Date.now()) {
            throw createStockAbortError(
                'Verification asset stock preparation is suspended while responsiveness recovers.',
            );
        }

        const stockJob = priorityName === 'stock'
            ? { controller: new AbortController(), started: false }
            : undefined;
        const operationSignal = stockJob
            ? AbortSignal.any([
                stockJob.controller.signal,
                signal ?? NEVER_ABORTED_SIGNAL,
            ])
            : signal ?? NEVER_ABORTED_SIGNAL;
        if (stockJob) {
            stockJob.signal = operationSignal;
            stockJobs.add(stockJob);
        }

        try {
            return await semaphore.run(async () => {
                if (stockJob) stockJob.started = true;
                activeMeta = { label, priorityName };
                const stallTimer = setTimeout(() => {
                    const memory = process.memoryUsage();
                    const toMiB = (bytes) => Math.round(bytes / 1024 / 1024);
                    screenWorkLog.warn('Active screen work exceeded its expected duration', undefined, {
                        label,
                        activeDurationMs: SCREEN_WORK_STALL_WARNING_MS,
                        parentRssMiB: toMiB(memory.rss),
                        externalMiB: toMiB(memory.external),
                    });
                }, SCREEN_WORK_STALL_WARNING_MS);
                stallTimer.unref?.();
                try {
                    return await operation({ signal: operationSignal });
                }
                finally {
                    clearTimeout(stallTimer);
                    activeMeta = undefined;
                }
            }, {
                priority: admissionPriority,
                timeoutMs,
                signal: operationSignal,
            });
        }
        catch (error) {
            throw mapAdmissionError(error, { label, maxPending, timeoutMs });
        }
        finally {
            if (stockJob) stockJobs.delete(stockJob);
        }
    }

    if (monitorEventLoop) {
        let expectedProbeAt = Date.now() + EVENT_LOOP_PROBE_INTERVAL_MS;
        const eventLoopProbe = setInterval(() => {
            const now = Date.now();
            latestEventLoopLagMs = Math.max(0, now - expectedProbeAt);
            expectedProbeAt = now + EVENT_LOOP_PROBE_INTERVAL_MS;
            if (
                stockJobs.size > 0
                && latestEventLoopLagMs >= EVENT_LOOP_STALL_THRESHOLD_MS
            ) {
                suspendStockWork(
                    `parent event loop was delayed by ${latestEventLoopLagMs}ms`,
                );
            }
        }, EVENT_LOOP_PROBE_INTERVAL_MS);
        eventLoopProbe.unref?.();
    }

    return {
        getStats,
        getStockInterruptionSignal,
        noteForegroundActivity,
        run,
    };
}

const verificationScreenWorkLimiter = createVerificationScreenWorkLimiter({
    monitorEventLoop: true,
});

module.exports = {
    createVerificationScreenWorkLimiter,
    getVerificationStockInterruptionSignal: verificationScreenWorkLimiter.getStockInterruptionSignal,
    getVerificationScreenWorkStats: verificationScreenWorkLimiter.getStats,
    noteVerificationForegroundActivity: verificationScreenWorkLimiter.noteForegroundActivity,
    runVerificationScreenWork: verificationScreenWorkLimiter.run,
};
