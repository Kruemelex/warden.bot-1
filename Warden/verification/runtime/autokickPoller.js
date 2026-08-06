'use strict';

const { createVerificationLogger } = require('../logging');

const autokickPollerLog = createVerificationLogger('Autokick poller');

function createAutokickPoller(options) {
    const intervalMs = options.intervalMs;
    let timer;
    let activeRun;
    let stopped = false;
    let wakePending = false;

    function schedule(delayMs = intervalMs) {
        if (stopped || timer) return;
        timer = setTimeout(run, delayMs);
        timer.unref?.();
    }

    function run() {
        timer = undefined;
        if (stopped || activeRun) return;
        let nextDelayMs = intervalMs;
        let failed = false;
        activeRun = Promise.resolve()
            .then(() => options.process({ isStopping: () => stopped }))
            .then((requestedDelayMs) => {
                if (Number.isFinite(requestedDelayMs) && requestedDelayMs >= 0) {
                    nextDelayMs = requestedDelayMs;
                }
            })
            .catch(async (err) => {
                failed = true;
                try {
                    const requestedDelayMs = await options.onError(err);
                    if (Number.isFinite(requestedDelayMs) && requestedDelayMs >= 0) {
                        nextDelayMs = requestedDelayMs;
                    }
                }
                catch (reportError) {
                    autokickPollerLog.error(
                        'Poll failure reporting also failed:',
                        reportError,
                    );
                }
            })
            .finally(() => {
                activeRun = undefined;
                const runImmediately = wakePending && !failed;
                wakePending = false;
                schedule(runImmediately ? 0 : nextDelayMs);
            });
    }

    function wake() {
        if (stopped) return;
        if (activeRun) {
            wakePending = true;
            return;
        }
        if (timer) clearTimeout(timer);
        timer = undefined;
        schedule(0);
    }

    async function stop(timeoutMs = 10_000) {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (!activeRun) return true;
        if (timeoutMs === null) {
            await activeRun;
            return true;
        }

        let timeout;
        const completed = await Promise.race([
            activeRun.then(() => true),
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
                timeout.unref?.();
            }),
        ]);
        clearTimeout(timeout);
        return completed;
    }

    schedule(0);
    return Object.freeze({ stop, wake });
}

module.exports = { createAutokickPoller };
