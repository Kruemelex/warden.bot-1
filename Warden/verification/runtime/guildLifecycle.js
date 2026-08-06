'use strict';

const { createVerificationLogger } = require('../logging');
const { normalizeGuildId } = require('../domain/identity');

const guildLifecycleLog = createVerificationLogger('Guild lifecycle');

const lifecycleByGuild = new Map();
const TRACKED_TASK_DISPOSAL_DEADLINE_MS = 5_000;

function createDisposedError(guildId) {
    const error = new Error('Verification guild lifecycle is no longer active.');
    error.code = 'VERIFICATION_GUILD_LIFECYCLE_DISPOSED';
    error.guildId = guildId;
    return error;
}

function getDisposalDeadline(options) {
    const requested = Number(options?.disposalDeadlineMs);
    if (!Number.isFinite(requested)) return TRACKED_TASK_DISPOSAL_DEADLINE_MS;
    return Math.min(TRACKED_TASK_DISPOSAL_DEADLINE_MS, Math.max(0, requested));
}

async function settleBeforeDeadline(work, deadlineAt) {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (remainingMs < 1) {
        await Promise.resolve();
        return { settled: false };
    }
    let timeout;
    try {
        return await Promise.race([
            work.then((value) => ({ settled: true, value })),
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve({ settled: false }), remainingMs);
            }),
        ]);
    }
    finally {
        if (timeout) clearTimeout(timeout);
    }
}

function beginVerificationGuildLifecycle(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const existing = lifecycleByGuild.get(normalizedGuildId);
    if (existing) return existing.publicHandle;

    const controller = new AbortController();
    const state = {
        controller,
        disposers: [],
        disposePromise: undefined,
        guildId: normalizedGuildId,
        tasks: new Set(),
        taskSources: new Map(),
        timers: new Set(),
    };

    function isCurrent() {
        return !controller.signal.aborted && lifecycleByGuild.get(normalizedGuildId) === state;
    }

    function assertCurrent() {
        if (!isCurrent()) throw createDisposedError(normalizedGuildId);
    }

    function track(task) {
        assertCurrent();
        const promise = Promise.resolve(task);
        state.tasks.add(promise);
        state.taskSources.set(promise, task);
        void promise.then(
            () => {
                state.tasks.delete(promise);
                state.taskSources.delete(promise);
            },
            () => {
                state.tasks.delete(promise);
                state.taskSources.delete(promise);
            },
        );
        return promise;
    }

    function addDisposer(disposer) {
        assertCurrent();
        if (typeof disposer !== 'function') {
            throw new TypeError('Verification lifecycle disposers must be functions.');
        }
        state.disposers.push(disposer);
        return disposer;
    }

    function scheduleRepeating(work, intervalMs) {
        assertCurrent();
        if (typeof work !== 'function') {
            throw new TypeError('Verification lifecycle scheduled work must be a function.');
        }
        const delayMs = Math.max(1, Number(intervalMs) || 1);
        const timerState = { timer: undefined };
        state.timers.add(timerState);

        const schedule = () => {
            if (!isCurrent()) return;
            timerState.timer = setTimeout(run, delayMs);
            timerState.timer.unref?.();
        };
        const run = () => {
            timerState.timer = undefined;
            if (!isCurrent()) return;
            const task = Promise.resolve().then(() => work(controller.signal));
            state.tasks.add(task);
            void task
                .catch((error) => {
                    if (isCurrent()) guildLifecycleLog.warn('Guild lifecycle task failed:', error);
                })
                .finally(() => {
                    state.tasks.delete(task);
                    schedule();
                });
        };
        schedule();
        return () => {
            if (timerState.timer) clearTimeout(timerState.timer);
            timerState.timer = undefined;
            state.timers.delete(timerState);
        };
    }

    function cancelTrackedTasks(reason) {
        for (const source of state.taskSources.values()) {
            const cancel = typeof source?.abort === 'function'
                ? source.abort
                : typeof source?.cancel === 'function' ? source.cancel : undefined;
            if (!cancel) continue;
            try {
                const cancellation = cancel.call(source, reason);
                if (cancellation?.then) {
                    void Promise.resolve(cancellation).catch((error) => {
                        guildLifecycleLog.warn('Failed to cancel guild lifecycle task:', error, {
                            guildId: normalizedGuildId,
                        });
                    });
                }
            }
            catch (error) {
                guildLifecycleLog.warn('Failed to cancel guild lifecycle task:', error, {
                    guildId: normalizedGuildId,
                });
            }
        }
    }

    async function dispose(reason = createDisposedError(normalizedGuildId), options) {
        if (state.disposePromise) return state.disposePromise;
        state.disposePromise = (async () => {
            controller.abort(reason);
            for (const timerState of state.timers) {
                if (timerState.timer) clearTimeout(timerState.timer);
                timerState.timer = undefined;
            }
            state.timers.clear();
            cancelTrackedTasks(reason);

            const deadlineAt = Date.now() + getDisposalDeadline(options);
            const trackedTasks = [...state.tasks];
            const trackedWork = Promise.allSettled(trackedTasks);
            const taskResult = await settleBeforeDeadline(trackedWork, deadlineAt);
            const stuckTaskCount = taskResult.settled
                ? 0
                : trackedTasks.filter((task) => state.tasks.has(task)).length;

            const disposerWork = (async () => {
                const results = [];
                for (const disposer of [...state.disposers].reverse()) {
                    results.push(await Promise.resolve().then(disposer).then(
                        () => undefined,
                        (error) => error,
                    ));
                }
                return results;
            })();
            const disposerResult = await settleBeforeDeadline(disposerWork, deadlineAt);
            const cleanupPending = !taskResult.settled || !disposerResult.settled;

            const finishDisposal = (results, reportLateErrors = false) => {
                state.disposers.length = 0;
                if (lifecycleByGuild.get(normalizedGuildId) === state) {
                    lifecycleByGuild.delete(normalizedGuildId);
                }
                const errors = results.filter(Boolean);
                if (reportLateErrors && errors.length > 0) {
                    guildLifecycleLog.warn(
                        'Guild lifecycle cleanup completed after its deadline with errors.',
                        errors.length === 1 ? errors[0] : new AggregateError(errors),
                        { guildId: normalizedGuildId, errorCount: errors.length },
                    );
                }
                return errors;
            };

            if (cleanupPending) {
                // Keep the aborted lifecycle registered until late cleanup
                // finishes. A replacement cannot overlap resources still owned
                // by this generation, while top-level shutdown remains bounded.
                void Promise.all([trackedWork, disposerWork])
                    .then(([, results]) => finishDisposal(results, true));
            }
            else {
                const errors = finishDisposal(disposerResult.value);
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) {
                    throw new AggregateError(errors, 'Verification guild lifecycle disposal failed.');
                }
            }
            if (stuckTaskCount > 0 || cleanupPending) {
                guildLifecycleLog.warn(
                    'Guild lifecycle disposal deadline exceeded; continuing after aborting stuck work.',
                    undefined,
                    { cleanupPending, guildId: normalizedGuildId, stuckTaskCount },
                );
            }
        })();
        return state.disposePromise;
    }

    state.publicHandle = Object.freeze({
        addDisposer,
        assertCurrent,
        dispose,
        guildId: normalizedGuildId,
        isCurrent,
        scheduleRepeating,
        signal: controller.signal,
        track,
    });
    lifecycleByGuild.set(normalizedGuildId, state);
    return state.publicHandle;
}

function getVerificationGuildLifecycle(guildId) {
    return lifecycleByGuild.get(normalizeGuildId(guildId))?.publicHandle;
}

async function disposeVerificationGuildLifecycle(guildId, reason) {
    const lifecycle = getVerificationGuildLifecycle(guildId);
    if (!lifecycle) return false;
    await lifecycle.dispose(reason);
    return true;
}

async function disposeAllVerificationGuildLifecycles(reason) {
    const lifecycles = [...lifecycleByGuild.values()].map((state) => state.publicHandle);
    const results = await Promise.allSettled(lifecycles.map((lifecycle) => lifecycle.dispose(reason)));
    const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
        throw new AggregateError(errors, 'Multiple Verification guild lifecycles failed to stop.');
    }
}

module.exports = {
    beginVerificationGuildLifecycle,
    disposeAllVerificationGuildLifecycles,
    disposeVerificationGuildLifecycle,
    getVerificationGuildLifecycle,
};
