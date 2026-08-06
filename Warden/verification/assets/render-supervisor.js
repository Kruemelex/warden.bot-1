const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const {
    VERIFICATION_IMAGE_OPERATION_BUSY,
    VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    VERIFICATION_IMAGE_PROCESS_FAILED,
    VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED,
    VERIFICATION_IMAGE_PROCESS_START_FAILED,
    createVerificationImageContractError,
    createVerificationImageProcessError,
    createVerificationImageRenderError,
} = require('./errors');
const {
    deserializeVerificationRenderError,
    normalizeRenderResult,
} = require('./render-contract');
const { createVerificationLogger } = require('../logging');

const rendererLog = createVerificationLogger('Renderer');
const PROCESS_FAILURE_BACKOFF_BASE_MS = 500;
const PROCESS_FAILURE_BACKOFF_MAX_MS = 10_000;
const PROCESS_FAILURE_LOG_INTERVAL_MS = 60_000;
const PROCESS_FAILURE_SEQUENCE_RESET_MS = 60_000;
const PROCESS_EXIT_GRACE_MS = 2_000;
const FOREGROUND_RENDER_CHILD_NICE = 10;
const STOCK_RENDER_CHILD_NICE = 19;
const RENDER_CHILD_NODE_ARGS = Object.freeze([
    '--max-old-space-size=128',
    '--expose-gc',
]);
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
    'PATH',
    'NODE_PATH',
    'LD_LIBRARY_PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
    'FONTCONFIG_PATH',
    'FONTCONFIG_FILE',
]);

function createBusyError(message = 'Verification image rendering is already active.') {
    return createVerificationImageContractError(message, VERIFICATION_IMAGE_OPERATION_BUSY);
}

function createTimeoutError(label, timeoutMs) {
    return createVerificationImageRenderError(
        `${label} timed out after ${timeoutMs}ms.`,
        VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    );
}

function buildRenderChildEnvironment(source = process.env) {
    const environment = {
        UV_THREADPOOL_SIZE: '1',
        WARDEN_VERIFICATION_RENDER_CHILD: '1',
    };
    for (const key of CHILD_ENVIRONMENT_KEYS) {
        if (typeof source[key] === 'string') environment[key] = source[key];
    }
    return environment;
}

function getRenderChildNice(priority) {
    return priority === 'stock'
        ? STOCK_RENDER_CHILD_NICE
        : FOREGROUND_RENDER_CHILD_NICE;
}

function buildRenderForkOptions(priority = 'live') {
    const options = {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'advanced',
        execArgv: [...RENDER_CHILD_NODE_ARGS],
        env: buildRenderChildEnvironment(),
    };

    if (process.platform !== 'win32') {
        const childNice = getRenderChildNice(priority);
        // Native renderer faults are intentionally contained in this child.
        // Keep foreground canvas work below the interaction-owning parent, and
        // speculative stock work below all foreground rendering. Also prevent
        // the host from retaining a potentially large native core file.
        options.execPath = '/bin/sh';
        options.execArgv = [
            '-c',
            `ulimit -c 0; if command -v nice >/dev/null 2>&1; then exec nice -n ${childNice} "$@"; else exec "$@"; fi`,
            'warden-verification-render',
            process.execPath,
            ...RENDER_CHILD_NODE_ARGS,
        ];
    }

    return options;
}

function normalizeProcessResult(result = {}, job) {
    return normalizeRenderResult(result, job, 'Verification image process');
}

/**
 * Native canvas fault supervisor.
 *
 * Whole-screen admission owns queuing and priority. This layer deliberately
 * has no second queue: exactly one disposable child may exist, and an overlap
 * is rejected as a contract violation. A worker_thread is not suitable here
 * because a native Skia SIGSEGV would still terminate the bot process.
 */
function createVerificationRenderSupervisor({
    processPath = path.join(__dirname, 'render-process.js'),
    forkProcess = fork,
} = {}) {
    let active;
    let nextJobId = 1;
    let shuttingDown = false;
    let shutdownPromise;
    let restartNotBefore = 0;
    let consecutiveProcessFailures = 0;
    let lastProcessFailureAt = 0;
    let lastProcessFailureLogAt = 0;
    let suppressedProcessFailureLogs = 0;
    let stockPriorityWarningLogged = false;

    function getStats() {
        return Object.freeze({
            active: active ? 1 : 0,
            queued: 0,
            processes: active ? 1 : 0,
            processLimit: 1,
            processCircuitState: restartNotBefore > Date.now() ? 'open' : 'closed',
            processRestartDelayMs: Math.max(0, restartNotBefore - Date.now()),
            activePriority: active?.job.priority,
            activePid: active?.child.pid,
            stockPriorityApplied: active?.job.priority === 'stock'
                ? active.stockPriorityApplied === true
                : undefined,
        });
    }

    function logResourceSnapshot(prefix) {
        const memory = process.memoryUsage();
        const toMiB = (bytes) => Math.round(bytes / 1024 / 1024);
        rendererLog.warn(prefix, undefined, {
            activeProcesses: active ? 1 : 0,
            parentRssMiB: toMiB(memory.rss),
            externalMiB: toMiB(memory.external),
            arrayBuffersMiB: toMiB(memory.arrayBuffers),
        });
    }

    function recordProcessFailure(error, context) {
        const now = Date.now();
        if (
            consecutiveProcessFailures < 1
            || now - lastProcessFailureAt >= PROCESS_FAILURE_SEQUENCE_RESET_MS
        ) {
            consecutiveProcessFailures = 0;
        }
        consecutiveProcessFailures += 1;
        lastProcessFailureAt = now;
        const delayMs = Math.min(
            PROCESS_FAILURE_BACKOFF_MAX_MS,
            PROCESS_FAILURE_BACKOFF_BASE_MS * (2 ** Math.min(10, consecutiveProcessFailures - 1)),
        );
        restartNotBefore = Math.max(restartNotBefore, now + delayMs);

        if (
            lastProcessFailureLogAt === 0
            || now - lastProcessFailureLogAt >= PROCESS_FAILURE_LOG_INTERVAL_MS
        ) {
            rendererLog.error(
                `${context}; native rendering remains temporarily unavailable`,
                error,
                { retryDelayMs: delayMs, suppressedFailures: suppressedProcessFailureLogs },
            );
            logResourceSnapshot('Native renderer failure');
            lastProcessFailureLogAt = now;
            suppressedProcessFailureLogs = 0;
        }
        else {
            suppressedProcessFailureLogs += 1;
        }
    }

    function markProcessHealthy() {
        if (consecutiveProcessFailures > 0) {
            rendererLog.success('Native renderer restored', {
                failures: consecutiveProcessFailures,
                suppressedFailures: suppressedProcessFailureLogs,
            });
        }
        restartNotBefore = 0;
        consecutiveProcessFailures = 0;
        lastProcessFailureAt = 0;
        suppressedProcessFailureLogs = 0;
    }

    function settleJob(job, method, value) {
        if (job.settled) return;
        job.settled = true;
        clearTimeout(job.renderTimer);
        if (job.signal && job.abortListener) {
            job.signal.removeEventListener('abort', job.abortListener);
        }
        method(value);
    }

    function buildUnexpectedExitError(slot, code, signal) {
        const details = signal ? `signal ${signal}` : `exit code ${code}`;
        return createVerificationImageProcessError(
            `Verification image process stopped unexpectedly (${details}).`,
            slot.failureCode ?? (
                slot.spawned
                    ? VERIFICATION_IMAGE_PROCESS_FAILED
                    : VERIFICATION_IMAGE_PROCESS_START_FAILED
            ),
            slot.processError ?? new Error(`Renderer exited with ${details}.`),
        );
    }

    function finishProcess(slot, code, signal) {
        if (slot.finished) return;
        slot.finished = true;
        clearTimeout(slot.exitGuardTimer);
        if (active === slot) active = undefined;

        const { job } = slot;
        try {
            if (!job.settled) {
                if (slot.cancelled) {
                    settleJob(
                        job,
                        job.reject,
                        job.signal?.reason ?? createBusyError(
                            'Verification image rendering was cancelled.',
                        ),
                    );
                }
                else if (slot.timedOut) {
                    settleJob(job, job.reject, createTimeoutError(job.label, job.timeoutMs));
                }
                else if (slot.terminalFailed) {
                    const error = buildUnexpectedExitError(slot, code, signal);
                    settleJob(job, job.reject, error);
                    if (!shuttingDown) {
                        recordProcessFailure(error, 'Native image process violated its lifecycle contract');
                    }
                }
                else if (code === 0 && !signal && slot.message?.ok === true) {
                    const result = normalizeProcessResult(slot.message.result, job);
                    markProcessHealthy();
                    settleJob(job, job.resolve, result);
                }
                else if (code === 0 && !signal && slot.message?.ok === false) {
                    markProcessHealthy();
                    settleJob(job, job.reject, deserializeVerificationRenderError(slot.message.error));
                }
                else {
                    const error = buildUnexpectedExitError(slot, code, signal);
                    settleJob(job, job.reject, error);
                    if (!shuttingDown) {
                        recordProcessFailure(error, 'Native image process failed and was contained');
                    }
                }
            }
        }
        catch (cause) {
            const error = createVerificationImageProcessError(
                `Verification image process returned an invalid result: ${cause.message}`,
                VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED,
                cause,
            );
            settleJob(job, job.reject, error);
            if (!shuttingDown) {
                recordProcessFailure(error, 'Native image process returned invalid IPC data');
            }
        }
        finally {
            slot.resolveExit?.();
        }
    }

    function forceProcessExit(slot, reason) {
        if (slot.finished) return;
        if (slot.exitRequested) return;
        slot.exitRequested = true;
        try {
            slot.child.kill('SIGKILL');
        }
        catch (error) {
            slot.processError ??= error;
        }
        slot.exitGuardTimer = setTimeout(() => {
            if (slot.finished) return;
            rendererLog.error(
                'Native child could not be reaped; rendering remains stopped.',
                createVerificationImageProcessError(
                    `Verification image process did not exit after ${reason}.`,
                    VERIFICATION_IMAGE_PROCESS_FAILED,
                    slot.processError,
                ),
            );
        }, PROCESS_EXIT_GRACE_MS);
        slot.exitGuardTimer.unref?.();
    }

    function startJob(job) {
        if (job.signal?.aborted) {
            settleJob(job, job.reject, job.signal.reason ?? createBusyError(
                'Verification image rendering was cancelled before it started.',
            ));
            return;
        }
        let child;
        try {
            child = forkProcess(processPath, [], buildRenderForkOptions(job.priority));
        }
        catch (cause) {
            const error = createVerificationImageProcessError(
                `Verification image process could not start: ${cause.message}`,
                VERIFICATION_IMAGE_PROCESS_START_FAILED,
                cause,
            );
            settleJob(job, job.reject, error);
            recordProcessFailure(error, 'Failed to start native image process');
            return;
        }

        const slot = {
            child,
            job,
            message: undefined,
            processError: undefined,
            failureCode: undefined,
            spawned: false,
            timedOut: false,
            cancelled: false,
            terminalFailed: false,
            stockPriorityApplied: false,
            finished: false,
            exitRequested: false,
            exitGuardTimer: undefined,
            resolveExit: undefined,
        };
        slot.exitPromise = new Promise((resolve) => {
            slot.resolveExit = resolve;
        });
        active = slot;
        if (job.signal) {
            job.abortListener = () => {
                if (slot.finished || slot.cancelled) return;
                slot.cancelled = true;
                clearTimeout(job.renderTimer);
                forceProcessExit(slot, 'stock-work cancellation');
            };
            job.signal.addEventListener('abort', job.abortListener, { once: true });
            if (job.signal.aborted) job.abortListener();
        }

        child.once('spawn', () => {
            slot.spawned = true;
            if (job.priority === 'stock') {
                try {
                    os.setPriority(child.pid, STOCK_RENDER_CHILD_NICE);
                    slot.stockPriorityApplied = os.getPriority(child.pid) >= STOCK_RENDER_CHILD_NICE;
                }
                catch (error) {
                    if (!stockPriorityWarningLogged) {
                        stockPriorityWarningLogged = true;
                        rendererLog.warn(
                            'Asset stock renderer: could not lower OS priority; '
                            + 'idle and queue admission safeguards remain active.',
                            error,
                        );
                    }
                }
            }
        });
        child.on('message', (message) => {
            if (slot.finished) return;
            if (message?.jobId !== job.id || slot.message) {
                slot.processError = new Error('Native renderer returned an invalid or duplicate job response.');
                slot.failureCode = VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED;
                slot.terminalFailed = true;
                forceProcessExit(slot, 'an invalid IPC response');
                return;
            }
            slot.message = message;
        });
        child.once('error', (error) => {
            slot.processError = error;
            slot.failureCode = slot.spawned
                ? VERIFICATION_IMAGE_PROCESS_FAILED
                : VERIFICATION_IMAGE_PROCESS_START_FAILED;
            slot.terminalFailed = true;
        });
        // "close" also follows a failed spawn, whereas "exit" is not guaranteed.
        child.once('close', (code, signal) => finishProcess(slot, code, signal));

        job.renderTimer = setTimeout(() => {
            if (slot.finished || active !== slot) return;
            slot.timedOut = true;
            rendererLog.error(`${job.label} timed out; killing its isolated process.`);
            recordProcessFailure(
                new Error(`${job.label} exceeded its native-process deadline.`),
                'Native image process timed out',
            );
            forceProcessExit(slot, 'a render timeout');
        }, job.timeoutMs);
        job.renderTimer.unref?.();

        try {
            child.send({
                jobId: job.id,
                type: job.type,
                payload: job.payload,
            }, (error) => {
                if (!error || slot.finished) return;
                slot.processError = error;
                slot.failureCode = VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED;
                slot.terminalFailed = true;
                forceProcessExit(slot, 'an IPC send failure');
            });
        }
        catch (error) {
            slot.processError = error;
            slot.failureCode = VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED;
            slot.terminalFailed = true;
            forceProcessExit(slot, 'an IPC send failure');
        }
    }

    function submit(type, payload, {
        priority = 'live',
        signal,
        timeoutMs,
        label = 'Verification image rendering',
    } = {}) {
        if (shuttingDown) {
            return Promise.reject(createBusyError('Verification image rendering is shutting down.'));
        }
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return Promise.reject(new Error('Verification render timeout must be a positive number.'));
        }
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? createBusyError(
                'Verification image rendering was cancelled.',
            ));
        }
        if (active) {
            return Promise.reject(createBusyError(
                'Verification image rendering received overlapping work outside screen admission.',
            ));
        }
        const recoveryDelayMs = restartNotBefore - Date.now();
        if (recoveryDelayMs > 0) {
            return Promise.reject(createVerificationImageProcessError(
                `Verification image rendering is recovering for ${recoveryDelayMs}ms.`,
                VERIFICATION_IMAGE_PROCESS_FAILED,
            ));
        }

        return new Promise((resolve, reject) => {
            const job = {
                id: nextJobId,
                type,
                payload,
                priority,
                signal,
                abortListener: undefined,
                timeoutMs,
                label,
                resolve,
                reject,
                settled: false,
                renderTimer: undefined,
            };
            nextJobId += 1;
            startJob(job);
        });
    }

    async function shutdown() {
        if (shutdownPromise) return shutdownPromise;
        shuttingDown = true;
        shutdownPromise = (async () => {
            const slot = active;
            if (!slot) return;
            settleJob(
                slot.job,
                slot.job.reject,
                createBusyError('Verification image rendering stopped before this job completed.'),
            );
            forceProcessExit(slot, 'renderer shutdown');
            await Promise.race([
                slot.exitPromise,
                new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_GRACE_MS + 250)),
            ]);
        })();
        return shutdownPromise;
    }

    function terminateActiveProcess() {
        shuttingDown = true;
        try {
            active?.child.kill('SIGKILL');
        }
        catch {
            // Node's exit event has no asynchronous cleanup opportunity.
        }
    }

    return {
        getStats,
        shutdown,
        submit,
        terminateActiveProcess,
    };
}

const verificationRenderSupervisor = createVerificationRenderSupervisor();
process.once('exit', verificationRenderSupervisor.terminateActiveProcess);

module.exports = {
    createVerificationRenderSupervisor,
    getVerificationRenderSupervisorStats: verificationRenderSupervisor.getStats,
    shutdownVerificationRenderSupervisor: verificationRenderSupervisor.shutdown,
    submitVerificationRenderJob: verificationRenderSupervisor.submit,
};
