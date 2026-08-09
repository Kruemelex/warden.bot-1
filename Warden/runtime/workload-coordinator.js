'use strict';

const WORKLOAD_PRIORITIES = Object.freeze({
    foreground: 0,
    maintenance: 1,
    speculative: 2,
});
const DEFAULT_SPECULATIVE_QUIET_MS = 60_000;
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function normalizePriority(priority) {
    if (Object.hasOwn(WORKLOAD_PRIORITIES, priority)) return priority;
    throw new TypeError(`Unknown Warden workload priority: ${priority}.`);
}

function createInterruptionError(interruptedBy, retryAfterMs) {
    const error = new Error(`Warden background work yielded to ${interruptedBy}.`);
    error.name = 'AbortError';
    error.code = 'WARDEN_WORKLOAD_INTERRUPTED';
    error.interruptedBy = interruptedBy;
    if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
    return error;
}

function isWardenWorkloadInterruption(error) {
    return error?.code === 'WARDEN_WORKLOAD_INTERRUPTED';
}

function createWardenWorkloadCoordinator({
    initialQuietMs = DEFAULT_SPECULATIVE_QUIET_MS,
    now = Date.now,
    speculativeQuietMs = DEFAULT_SPECULATIVE_QUIET_MS,
} = {}) {
    if (!Number.isFinite(initialQuietMs) || initialQuietMs < 0) {
        throw new RangeError('Initial speculative quiet time must be a non-negative number.');
    }
    if (!Number.isFinite(speculativeQuietMs) || speculativeQuietMs < 0) {
        throw new RangeError('Speculative quiet time must be a non-negative number.');
    }
    const jobs = new Set();
    const generationControllers = new Map([
        ['maintenance', new AbortController()],
        ['speculative', new AbortController()],
    ]);
    const interrupted = { maintenance: 0, speculative: 0 };
    let lastForegroundAt = now();
    let speculativeNotBefore = lastForegroundAt + initialQuietMs;

    function getStats() {
        const byPriority = {};
        for (const priority of ['maintenance', 'speculative']) {
            const matching = [...jobs].filter((job) => job.priority === priority);
            byPriority[priority] = Object.freeze({
                active: matching.filter((job) => job.active).length,
                queued: matching.filter((job) => !job.active).length,
                interrupted: interrupted[priority],
            });
        }
        const currentTime = now();
        return Object.freeze({
            byPriority: Object.freeze(byPriority),
            foregroundIdleMs: Math.max(0, currentTime - lastForegroundAt),
            speculativeDelayMs: Math.max(0, speculativeNotBefore - currentTime),
        });
    }

    function getInterruptionSignal(priority) {
        const normalized = normalizePriority(priority);
        if (normalized === 'foreground') return NEVER_ABORTED_SIGNAL;
        return generationControllers.get(normalized).signal;
    }

    function interruptLowerPriority(priority, interruptedBy = `${priority} work`) {
        const normalized = normalizePriority(priority);
        const threshold = WORKLOAD_PRIORITIES[normalized];
        if (normalized === 'foreground') {
            lastForegroundAt = now();
            speculativeNotBefore = Math.max(
                speculativeNotBefore,
                lastForegroundAt + speculativeQuietMs,
            );
        }
        const result = {};
        for (const candidate of ['maintenance', 'speculative']) {
            if (WORKLOAD_PRIORITIES[candidate] <= threshold) continue;
            const matching = [...jobs].filter((job) => (
                job.priority === candidate && !job.signal.aborted
            ));
            const active = matching.filter((job) => job.active).length;
            const queued = matching.length - active;
            result[candidate] = Object.freeze({ active, queued });
            interrupted[candidate] += matching.length;
            const controller = generationControllers.get(candidate);
            controller.abort(createInterruptionError(interruptedBy));
            generationControllers.set(candidate, new AbortController());
        }
        return Object.freeze(result);
    }

    async function run(operation, {
        priority = 'maintenance',
        label = `${priority} work`,
        signal,
    } = {}) {
        if (typeof operation !== 'function') throw new TypeError('Warden workload operation must be a function.');
        const normalized = normalizePriority(priority);
        if (normalized === 'foreground') {
            throw new TypeError('Foreground work should notify the coordinator instead of registering as interruptible.');
        }
        interruptLowerPriority(normalized, label);
        const blockingJob = [...jobs].find((job) => (
            WORKLOAD_PRIORITIES[job.priority] < WORKLOAD_PRIORITIES[normalized]
        ));
        if (blockingJob) throw createInterruptionError(blockingJob.label);
        if (normalized === 'speculative') {
            const retryAfterMs = Math.max(0, speculativeNotBefore - now());
            if (retryAfterMs > 0) throw createInterruptionError('foreground quiet period', retryAfterMs);
        }
        const operationSignal = AbortSignal.any([
            getInterruptionSignal(normalized),
            signal ?? NEVER_ABORTED_SIGNAL,
        ]);
        if (operationSignal.aborted) throw operationSignal.reason;
        const job = { active: false, label, priority: normalized, signal: operationSignal };
        jobs.add(job);
        try {
            return await operation({
                signal: operationSignal,
                markActive: () => { job.active = true; },
            });
        }
        finally {
            jobs.delete(job);
        }
    }

    return Object.freeze({
        getInterruptionSignal,
        getStats,
        interruptLowerPriority,
        run,
    });
}

const wardenWorkloadCoordinator = createWardenWorkloadCoordinator();

function noteWardenForegroundActivity(interruptedBy) {
    return wardenWorkloadCoordinator.interruptLowerPriority('foreground', interruptedBy);
}

function runWardenMaintenanceWork(operation, options = {}) {
    return wardenWorkloadCoordinator.run(async ({ signal, markActive }) => {
        markActive();
        return operation({ signal });
    }, { ...options, priority: 'maintenance' });
}

module.exports = {
    DEFAULT_SPECULATIVE_QUIET_MS,
    WORKLOAD_PRIORITIES,
    createWardenWorkloadCoordinator,
    isWardenWorkloadInterruption,
    noteWardenForegroundActivity,
    runWardenMaintenanceWork,
    wardenWorkloadCoordinator,
};
