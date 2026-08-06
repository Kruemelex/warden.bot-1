'use strict';

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
    'ER_CON_COUNT_ERROR',
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'ER_QUERY_INTERRUPTED',
    'ER_SERVER_SHUTDOWN',
    'ER_TOO_MANY_USER_CONNECTIONS',
]);

function isTransientDatabaseError(error) {
    const visited = new Set();
    for (let current = error; current && !visited.has(current); current = current.cause) {
        visited.add(current);
        const code = String(current?.code ?? current?.errorno ?? '');
        if (
            /^(?:PROTOCOL_|WARDEN_DB_|ECONN|ETIMEDOUT|EAI_AGAIN|ENET|EHOST|ENOTFOUND|EPIPE)/.test(code)
            || TRANSIENT_DATABASE_ERROR_CODES.has(code)
            || String(current?.message ?? '').includes('Query inactivity timeout')
        ) return true;
    }
    return false;
}

function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function retryTransientDatabaseOperation(operation, options = {}) {
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    const sleep = options.sleep ?? delay;
    try {
        return {
            value: await operation(),
            retried: false,
        };
    }
    catch (firstError) {
        if (!isTransientDatabaseError(firstError)) throw firstError;
        await sleep(retryDelayMs);
        try {
            return {
                value: await operation(),
                retried: true,
                firstError,
            };
        }
        catch (retryError) {
            const finalError = retryError instanceof Error
                ? retryError
                : new Error(String(retryError));
            // Capture the retry failure's own classification before attaching
            // the first attempt as diagnostic context. Consumers can then
            // distinguish an organic wrapped transient error from the earlier
            // transient failure in `cause`.
            finalError.databaseRetryFinalErrorTransient = isTransientDatabaseError(finalError);
            if (finalError !== firstError && finalError.cause === undefined) {
                finalError.cause = firstError;
            }
            finalError.databaseRetryAttempted = true;
            throw finalError;
        }
    }
}

module.exports = {
    isTransientDatabaseError,
    retryTransientDatabaseOperation,
};
