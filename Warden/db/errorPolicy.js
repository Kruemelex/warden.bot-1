'use strict';

const TRANSIENT_DATABASE_ERROR_CODES = new Set([
    'ER_CON_COUNT_ERROR',
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'ER_QUERY_INTERRUPTED',
    'ER_SERVER_SHUTDOWN',
    'ER_TOO_MANY_USER_CONNECTIONS',
]);
const MAX_DATABASE_RETRY_DELAY_MS = 5 * 60 * 1000;

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

function isRetryableDatabaseRead(sql) {
    const statement = String(sql ?? '').trim();
    if (!/^SELECT\b/iu.test(statement)) return false;

    const withoutTrailingTerminator = statement.replace(/;\s*$/u, '');
    if (withoutTrailingTerminator.includes(';')) return false;
    if (/\bFOR\s+(?:UPDATE|SHARE)\b/iu.test(withoutTrailingTerminator)) return false;
    if (/\bLOCK\s+IN\s+SHARE\s+MODE\b/iu.test(withoutTrailingTerminator)) return false;
    if (/\b(?:GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS)\s*\(/iu.test(withoutTrailingTerminator)) return false;
    if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/iu.test(withoutTrailingTerminator)) return false;
    return true;
}

function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function retryTransientDatabaseOperation(operation, options = {}) {
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    const maxAttempts = options.maxAttempts ?? 2;
    const backoffMultiplier = options.backoffMultiplier ?? 1;
    const sleep = options.sleep ?? delay;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw new RangeError('Database retry maxAttempts must be an integer between 1 and 10.');
    }
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_DATABASE_RETRY_DELAY_MS) {
        throw new RangeError(`Database retry delay must be between 0 and ${MAX_DATABASE_RETRY_DELAY_MS}ms.`);
    }
    if (!Number.isFinite(backoffMultiplier) || backoffMultiplier < 1) {
        throw new RangeError('Database retry backoffMultiplier must be at least 1.');
    }
    const lastDelayExponent = Math.max(0, maxAttempts - 2);
    const maximumDelayMs = retryDelayMs * (backoffMultiplier ** lastDelayExponent);
    if (!Number.isFinite(maximumDelayMs) || maximumDelayMs > MAX_DATABASE_RETRY_DELAY_MS) {
        throw new RangeError(`Database retry backoff must not exceed ${MAX_DATABASE_RETRY_DELAY_MS}ms.`);
    }

    let firstError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return {
                value: await operation(),
                retried: attempt > 1,
                attempts: attempt,
                firstError,
            };
        }
        catch (operationError) {
            const error = operationError instanceof Error
                ? operationError
                : new Error(String(operationError));
            if (!firstError) firstError = error;
            const retryable = isTransientDatabaseError(error)
                && error.databaseRetryAttempted !== true
                && attempt < maxAttempts;
            if (retryable) {
                const delayMs = retryDelayMs * (backoffMultiplier ** (attempt - 1));
                await sleep(delayMs);
                continue;
            }
            if (attempt === 1) throw error;
            // Capture the retry failure's own classification before attaching
            // the first attempt as diagnostic context. Consumers can then
            // distinguish an organic wrapped transient error from the earlier
            // transient failure in `cause`.
            error.databaseRetryFinalErrorTransient = isTransientDatabaseError(error);
            if (error !== firstError && error.cause === undefined) {
                error.cause = firstError;
            }
            error.databaseRetryAttempted = true;
            error.databaseRetryAttempts = attempt;
            throw error;
        }
    }
    throw new Error('Database retry loop exhausted unexpectedly.');
}

module.exports = {
    isRetryableDatabaseRead,
    isTransientDatabaseError,
    retryTransientDatabaseOperation,
};
