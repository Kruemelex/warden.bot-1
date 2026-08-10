'use strict';

const database = require('../database');

const ACQUIRE_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 15_000;
const TRANSACTION_ATTEMPTS = 2;

function acquireConnection() {
    if (typeof database.pool?.getConnection !== 'function') {
        throw new Error('Leaderboard transactions require Warden db.pool.getConnection.');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            const error = new Error(`Leaderboard connection acquisition timed out after ${ACQUIRE_TIMEOUT_MS}ms.`);
            error.code = 'LEADERBOARD_ACQUIRE_TIMEOUT';
            reject(error);
        }, ACQUIRE_TIMEOUT_MS);
        timer.unref?.();
        try {
            database.pool.getConnection((error, connection) => {
                if (settled) {
                    try { connection?.release(); }
                    catch { connection?.destroy(); }
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(connection);
            });
        }
        catch (error) {
            settled = true;
            clearTimeout(timer);
            reject(error);
        }
    });
}

async function withLeaderboardTransaction(work) {
    const connection = await acquireConnection();
    let usable = true;
    let started = false;
    let committed = false;
    const query = (sql, values) => new Promise((resolve, reject) => {
        connection.query({ sql, values, timeout: QUERY_TIMEOUT_MS }, (error, rows) => {
            if (error?.fatal || error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
                usable = false;
                connection.destroy();
            }
            if (error) reject(error);
            else resolve(rows);
        });
    });
    try {
        await query('START TRANSACTION');
        started = true;
        const result = await work(query);
        await query('COMMIT');
        committed = true;
        return result;
    }
    catch (error) {
        if (started && !committed && usable) {
            try {
                await query('ROLLBACK');
            }
            catch (rollbackError) {
                usable = false;
                connection.destroy();
                throw new AggregateError(
                    [error, rollbackError],
                    'Leaderboard transaction failed and could not be rolled back cleanly.',
                    { cause: error },
                );
            }
        }
        throw error;
    }
    finally {
        if (usable) {
            try { connection.release(); }
            catch { connection.destroy(); }
        }
    }
}

async function runLeaderboardTransaction(work, {
    withTransaction = withLeaderboardTransaction,
    attempts = TRANSACTION_ATTEMPTS,
} = {}) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await withTransaction(work);
        }
        catch (error) {
            const retryable = ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(error?.code));
            if (!retryable || attempt === attempts) throw error;
        }
    }
    throw new Error('Leaderboard transaction exhausted its retry limit.');
}

module.exports = {
    runLeaderboardTransaction,
    withLeaderboardTransaction,
};
