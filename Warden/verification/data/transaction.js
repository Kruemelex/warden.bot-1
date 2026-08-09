let database;
const { createVerificationLogger } = require('../logging');

const transactionLog = createVerificationLogger('Data transaction');

const VERIFICATION_CONNECTION_ACQUIRE_TIMEOUT_MS = 10_000;
const VERIFICATION_TRANSACTION_QUERY_TIMEOUT_MS = 15_000;
const VERIFICATION_TRANSACTION_ISOLATION_LEVELS = new Set([
    'READ COMMITTED',
    'REPEATABLE READ',
    'SERIALIZABLE',
]);

function getDatabase() {
    if (!database) database = require('../../../Warden/db/database');
    return database;
}

function destroyConnection(connection) {
    try {
        connection.destroy();
    }
    catch (err) {
        transactionLog.warn('Failed to destroy an unusable verification database connection:', err);
    }
}

function releaseLateConnection(connection) {
    if (!connection) return;
    try {
        connection.release();
    }
    catch (err) {
        destroyConnection(connection);
    }
}

function acquireVerificationConnection() {
    const db = getDatabase();
    if (typeof db.pool?.getConnection !== 'function') {
        throw new Error('Verification transactions require Warden db.pool.getConnection.');
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            const err = new Error(`Verification database connection acquisition timed out after ${VERIFICATION_CONNECTION_ACQUIRE_TIMEOUT_MS}ms.`);
            err.code = 'VERIFICATION_TRANSACTION_ACQUIRE_TIMEOUT';
            reject(err);
        }, VERIFICATION_CONNECTION_ACQUIRE_TIMEOUT_MS);
        timer.unref?.();

        try {
            db.pool.getConnection((err, connection) => {
                if (settled) {
                    releaseLateConnection(connection);
                    return;
                }

                settled = true;
                clearTimeout(timer);
                if (err) return reject(err);
                resolve(connection);
            });
        }
        catch (err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        }
    });
}

async function withVerificationTransaction(callback, options = {}) {
    if (typeof callback !== 'function') {
        throw new TypeError('Verification transaction callback is required.');
    }
    const isolationLevel = typeof options.isolationLevel === 'string'
        ? options.isolationLevel.toUpperCase()
        : options.isolationLevel;
    if (isolationLevel !== undefined && !VERIFICATION_TRANSACTION_ISOLATION_LEVELS.has(isolationLevel)) {
        throw new TypeError(`Unsupported verification transaction isolation level: ${options.isolationLevel}`);
    }

    const connection = await acquireVerificationConnection();
    let connectionUsable = true;
    let transactionStarted = false;
    let transactionCommitted = false;

    const query = (sql, values) => new Promise((resolve, reject) => {
        try {
            connection.query({
                sql,
                values,
                timeout: VERIFICATION_TRANSACTION_QUERY_TIMEOUT_MS,
            }, (err, rows) => {
                if (err?.fatal || err?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
                    connectionUsable = false;
                    destroyConnection(connection);
                }
                if (err) return reject(err);
                resolve(rows);
            });
        }
        catch (err) {
            reject(err);
        }
    });

    try {
        if (isolationLevel) await query(`SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
        await query('START TRANSACTION');
        transactionStarted = true;
        const result = await callback(query);
        await query('COMMIT');
        transactionCommitted = true;
        return result;
    }
    catch (err) {
        let rollbackError;
        if (transactionStarted && !transactionCommitted && connectionUsable) {
            try {
                await query('ROLLBACK');
            }
            catch (rollbackErr) {
                rollbackError = rollbackErr;
                if (connectionUsable) {
                    connectionUsable = false;
                    destroyConnection(connection);
                }
            }
        }
        if (rollbackError) {
            throw new AggregateError(
                [err, rollbackError],
                'Verification transaction failed and could not be rolled back cleanly.',
                { cause: err },
            );
        }
        throw err;
    }
    finally {
        if (connectionUsable) {
            try {
                connection.release();
            }
            catch (err) {
                destroyConnection(connection);
            }
        }
    }
}

module.exports = {
    withVerificationTransaction,
};
