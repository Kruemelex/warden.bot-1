'use strict';

const { botIdent } = require('../../../../functions');
const database = require(`../../../../${botIdent().activeBot.botName}/db/database`);
const { retryTransientDatabaseOperation } = require('../../../../Warden/db/errorPolicy');

const TRANSACTION_ACQUIRE_TIMEOUT_MS = 10_000;
const TRANSACTION_QUERY_TIMEOUT_MS = 15_000;
const ACE_TRANSACTION_ATTEMPTS = 2;

const LEADERBOARDS = Object.freeze({
    ace: Object.freeze({
        editableColumns: new Set([
            'user_id', 'name', 'timetaken', 'mgauss', 'sgauss', 'mgaussfired',
            'sgaussfired', 'percenthulllost', 'score', 'link', 'shiptype',
        ]),
    }),
    speedrun: Object.freeze({
        editableColumns: new Set([
            'user_id', 'name', 'time', 'milliseconds', 'class', 'ship',
            'variant', 'link', 'comments',
        ]),
    }),
});

function getLeaderboard(name) {
    const normalized = String(name ?? '').toLowerCase();
    if (!LEADERBOARDS[normalized]) throw new Error('Unknown Leaderboard submission type.');
    return normalized;
}

function getSubmissionId(value) {
    const submissionId = Number(value);
    if (!Number.isSafeInteger(submissionId) || submissionId < 1) {
        throw new Error('Invalid Leaderboard submission ID.');
    }
    return submissionId;
}

function pendingError(submission) {
    if (!submission) return 'That submission no longer exists. It may already have been deleted.';
    if (Number(submission.approval) !== 0) return 'That submission is no longer pending approval.';
    return undefined;
}

async function loadSubmission(leaderboard, submissionId, { query = database.query } = {}) {
    const table = getLeaderboard(leaderboard);
    const id = getSubmissionId(submissionId);
    const rows = await query(`SELECT * FROM \`${table}\` WHERE id = (?)`, [id]);
    return rows[0];
}

async function loadPendingSubmission(leaderboard, submissionId) {
    const submission = await loadSubmission(leaderboard, submissionId);
    const error = pendingError(submission);
    if (error) throw new Error(error);
    return submission;
}

function acquireTransactionConnection() {
    if (typeof database.pool?.getConnection !== 'function') {
        throw new Error('Leaderboard transactions require Warden db.pool.getConnection.');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            const error = new Error(`Leaderboard database connection acquisition timed out after ${TRANSACTION_ACQUIRE_TIMEOUT_MS}ms.`);
            error.code = 'LEADERBOARD_TRANSACTION_ACQUIRE_TIMEOUT';
            reject(error);
        }, TRANSACTION_ACQUIRE_TIMEOUT_MS);
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

async function withLeaderboardTransaction(callback) {
    const connection = await acquireTransactionConnection();
    let usable = true;
    let started = false;
    let committed = false;
    const query = (sql, values) => new Promise((resolve, reject) => {
        connection.query({ sql, values, timeout: TRANSACTION_QUERY_TIMEOUT_MS }, (error, rows) => {
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
        const result = await callback(query);
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

function isRetryableTransactionError(error) {
    return ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(error?.code));
}

async function runAceTransaction(work, {
    withTransaction = withLeaderboardTransaction,
    attempts = ACE_TRANSACTION_ATTEMPTS,
} = {}) {
    let attempt = 0;
    while (attempt < attempts) {
        attempt += 1;
        try {
            return await withTransaction(work);
        }
        catch (error) {
            if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
        }
    }
    throw new Error('Ace approval transaction exhausted its retry limit.');
}

async function commitPendingEdits({ context, object, edits, extraValues = {} }) {
    const leaderboard = getLeaderboard(context.leaderboard);
    const allowedColumns = LEADERBOARDS[leaderboard].editableColumns;
    const changed = Object.entries(edits).filter(([, edit]) => edit?.changed === true);
    const assignments = [...changed.map(([column, edit]) => [column, edit.value]), ...Object.entries(extraValues)];
    if (assignments.length < 1) return object;
    for (const [column] of assignments) {
        if (!allowedColumns.has(column)) throw new Error(`Unsafe Leaderboard edit column: ${column}`);
    }

    const comparedColumns = [...new Set(assignments.map(([column]) => column))];
    const setSql = assignments.map(([column]) => `\`${column}\` = (?)`).join(', ');
    const compareSql = comparedColumns.map((column) => `\`${column}\` <=> (?)`).join(' AND ');
    const values = [
        ...assignments.map(([, value]) => value),
        context.submissionId,
        ...comparedColumns.map((column) => object[column]),
    ];
    const result = await database.query(
        `UPDATE \`${leaderboard}\` SET ${setSql} WHERE id = (?) AND approval = 0 AND ${compareSql}`,
        values,
    );
    if (Number(result.affectedRows) !== 1) {
        const error = new Error('This submission changed or stopped being pending while the editor was open. Reopen Edit and apply the change again.');
        error.code = 'LEADERBOARD_EDIT_CONFLICT';
        throw error;
    }
    return loadSubmission(leaderboard, context.submissionId);
}

/**
 * Guardedly approve a pending row, then reload its committed values. If a
 * previous attempt committed but its reload/delivery failed, the same approval
 * button can recover the already-approved row and finish resolving the post.
 */
async function approvePendingSubmission(leaderboard, submissionId, {
    query = database.query,
    withTransaction = withLeaderboardTransaction,
} = {}) {
    const table = getLeaderboard(leaderboard);
    const id = getSubmissionId(submissionId);
    if (table === 'ace') {
        return runAceTransaction(async (transactionQuery) => {
            const result = await transactionQuery(
                'UPDATE `ace` SET approval = 1 WHERE id = (?) AND approval = 0',
                [id],
            );
            const newlyApproved = Number(result.affectedRows) === 1;
            const submission = await loadSubmission(table, id, { query: transactionQuery });
            if (!submission || Number(submission.approval) !== 1) {
                throw new Error(newlyApproved
                    ? 'The approved submission could not be reloaded.'
                    : 'That submission is no longer pending approval.');
            }

            // Both operations live in one transaction. Competing pending Ace
            // approvals can deadlock while replacing one another; the bounded
            // transaction retry makes the later successful approval the winner.
            const idComparison = newlyApproved ? '!=' : '<';
            await transactionQuery(
                `DELETE FROM \`ace\` WHERE user_id <=> (?) AND approval = 1 AND id ${idComparison} (?) AND shiptype <=> (?)`,
                [submission.user_id, submission.id, submission.shiptype],
            );
            return { submission, newlyApproved };
        }, { withTransaction });
    }

    const result = await query(
        `UPDATE \`${table}\` SET approval = 1 WHERE id = (?) AND approval = 0`,
        [id],
    );
    const newlyApproved = Number(result.affectedRows) === 1;
    const submission = await loadSubmission(table, id, { query });
    if (!submission || Number(submission.approval) !== 1) {
        throw new Error(newlyApproved
            ? 'The approved submission could not be reloaded.'
            : 'That submission is no longer pending approval.');
    }
    return { submission, newlyApproved };
}

async function deletePendingSubmission(leaderboard, submissionId, {
    expectedUserId,
    retryOperation = retryTransientDatabaseOperation,
} = {}) {
    const table = getLeaderboard(leaderboard);
    const id = getSubmissionId(submissionId);
    const userCompareSql = expectedUserId === undefined ? '' : ' AND user_id <=> (?)';
    const { value: result } = await retryOperation(() => database.query(
        `DELETE FROM \`${table}\` WHERE id = (?) AND approval = 0${userCompareSql}`,
        expectedUserId === undefined ? [id] : [id, expectedUserId],
    ));
    if (Number(result.affectedRows) !== 1) throw new Error('That submission is no longer pending approval.');
}

module.exports = {
    approvePendingSubmission,
    commitPendingEdits,
    deletePendingSubmission,
    getLeaderboard,
    getSubmissionId,
    loadPendingSubmission,
    loadSubmission,
    pendingError,
};
