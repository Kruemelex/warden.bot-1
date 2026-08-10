'use strict';

const database = require('../database');
const {
    initializeLeaderboards,
    insertSubmission,
    loadSubmission,
    TABLES,
} = require('./repository');

const SOURCE_COLUMNS = Object.freeze({
    speedrun: Object.freeze(['id', 'user_id', 'name', 'time', 'class', 'ship', 'variant', 'link', 'approval', 'date', 'comments', 'milliseconds', 'embed_id']),
    ace: Object.freeze(['id', 'user_id', 'name', 'timetaken', 'mgauss', 'sgauss', 'mgaussfired', 'sgaussfired', 'percenthulllost', 'score', 'link', 'approval', 'date', 'shiptype', 'embed_id']),
});
const NUMERIC_FIELDS = new Set([
    'id', 'time', 'approval', 'date', 'milliseconds', 'timetaken', 'mgauss',
    'sgauss', 'mgaussfired', 'sgaussfired', 'percenthulllost', 'score',
]);
const MIGRATION_LOCK_NAME = 'warden:leaderboard:migration';
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_QUERY_TIMEOUT_MS = 10_000;

function acquireMigrationConnection() {
    if (typeof database.pool?.getConnection !== 'function') {
        throw new Error('Leaderboard migration requires Warden db.pool.getConnection.');
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            reject(new Error(`Leaderboard migration connection acquisition timed out after ${LOCK_ACQUIRE_TIMEOUT_MS}ms.`));
        }, LOCK_ACQUIRE_TIMEOUT_MS);
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

async function withDatabaseMigrationLock(work) {
    const connection = await acquireMigrationConnection();
    let usable = true;
    const query = (sql, values) => new Promise((resolve, reject) => {
        connection.query({ sql, values, timeout: LOCK_QUERY_TIMEOUT_MS }, (error, rows) => {
            if (error?.fatal || error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
                usable = false;
                connection.destroy();
            }
            if (error) reject(error);
            else resolve(rows);
        });
    });
    let acquired = false;
    try {
        const rows = await query('SELECT GET_LOCK(?, 0) AS acquired', [MIGRATION_LOCK_NAME]);
        acquired = Number(rows?.[0]?.acquired) === 1;
        if (!acquired) throw new Error('A Leaderboard migration is already running on another Warden instance.');
        return await work();
    }
    finally {
        if (acquired && usable) {
            try {
                const rows = await query('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK_NAME]);
                if (Number(rows?.[0]?.released) !== 1) {
                    usable = false;
                    connection.destroy();
                }
            }
            catch {
                usable = false;
                connection.destroy();
            }
        }
        if (usable) {
            try { connection.release(); }
            catch { connection.destroy(); }
        }
    }
}

function assertBatchSize(value) {
    const size = Number(value ?? 100);
    if (!Number.isSafeInteger(size) || size < 1 || size > 500) {
        throw new Error('Leaderboard migration batch size must be between 1 and 500.');
    }
    return size;
}

function normalizedRecord(type, row) {
    return Object.fromEntries(SOURCE_COLUMNS[type].map((field) => {
        const value = row?.[field];
        if (value == null) return [field, null];
        return [field, NUMERIC_FIELDS.has(field) ? Number(value) : String(value)];
    }));
}

function assertMatchingRecord(type, legacy, encrypted) {
    const source = normalizedRecord(type, legacy);
    const target = normalizedRecord(type, encrypted);
    for (const field of SOURCE_COLUMNS[type]) {
        if (!Object.is(source[field], target[field])) {
            throw new Error(`Leaderboard migration preflight found conflicting ${type} submission #${source.id} (${field}).`);
        }
    }
}

async function assertLegacyMigrationSafe(type, { batchSize = 100 } = {}) {
    if (!SOURCE_COLUMNS[type]) throw new Error(`Unsupported Leaderboard migration type: ${type}.`);
    const size = assertBatchSize(batchSize);
    await initializeLeaderboards();
    const orphanRows = await database.query(
        `SELECT target.id FROM ${TABLES[type]} target
         LEFT JOIN \`${type}\` source ON source.id = target.id
         WHERE source.id IS NULL LIMIT 1`,
    );
    if (orphanRows?.[0]) {
        throw new Error(`Leaderboard migration preflight found orphan ${type} submission #${orphanRows[0].id}.`);
    }

    let cursor = 0;
    while (true) {
        const rows = await database.query(
            `SELECT ${SOURCE_COLUMNS[type].join(', ')} FROM \`${type}\`
             WHERE id > ? ORDER BY id ASC LIMIT ${size}`,
            [cursor],
        );
        if (!rows?.length) break;
        for (const row of rows) {
            cursor = Number(row.id);
            const existing = await loadSubmission(type, row.id);
            if (existing) assertMatchingRecord(type, row, existing);
        }
        if (rows.length < size) break;
    }
}

async function countRows(table) {
    const rows = await database.query(`SELECT COUNT(*) AS row_count FROM ${table}`);
    return Number(rows?.[0]?.row_count ?? 0);
}

async function inspectLegacyLeaderboards(options = {}) {
    await assertLegacyMigrationSafe('speedrun', options);
    await assertLegacyMigrationSafe('ace', options);
    const report = {};
    for (const type of ['speedrun', 'ace']) {
        const legacyRows = await countRows(`\`${type}\``);
        const encryptedRows = await countRows(TABLES[type]);
        report[type] = Object.freeze({
            legacyRows,
            encryptedRows,
            missingRows: legacyRows - encryptedRows,
        });
    }
    return Object.freeze(report);
}

async function verifyLegacyMigrationComplete(options = {}) {
    const report = await inspectLegacyLeaderboards(options);
    for (const [type, counts] of Object.entries(report)) {
        if (counts.missingRows !== 0) {
            throw new Error(`Leaderboard migration audit found ${counts.missingRows} missing ${type} rows.`);
        }
    }
    return report;
}

async function copyLegacyLeaderboard(type, { batchSize = 100, onProgress } = {}) {
    const size = assertBatchSize(batchSize);
    let cursor = 0;
    let copied = 0;
    let skipped = 0;

    while (true) {
        const rows = await database.query(
            `SELECT ${SOURCE_COLUMNS[type].join(', ')} FROM \`${type}\`
             WHERE id > ? ORDER BY id ASC LIMIT ${size}`,
            [cursor],
        );
        if (!rows?.length) break;
        for (const row of rows) {
            cursor = Number(row.id);
            if (await loadSubmission(type, row.id)) {
                skipped += 1;
                continue;
            }
            await insertSubmission(type, row, { sourceId: row.id });
            copied += 1;
        }
        await onProgress?.({ type, cursor, copied, skipped });
        if (rows.length < size) break;
    }
    return Object.freeze({ type, copied, skipped, lastLegacyId: cursor });
}

async function migrateLegacyLeaderboard(type, options = {}) {
    await assertLegacyMigrationSafe(type, options);
    return copyLegacyLeaderboard(type, options);
}

async function migrateLegacyLeaderboards(options = {}) {
    await assertLegacyMigrationSafe('speedrun', options);
    await assertLegacyMigrationSafe('ace', options);
    const speedrun = await copyLegacyLeaderboard('speedrun', options);
    const ace = await copyLegacyLeaderboard('ace', options);
    const audit = await verifyLegacyMigrationComplete(options);
    return Object.freeze({ speedrun, ace, audit });
}

module.exports = {
    assertLegacyMigrationSafe,
    inspectLegacyLeaderboards,
    migrateLegacyLeaderboard,
    migrateLegacyLeaderboards,
    verifyLegacyMigrationComplete,
    withDatabaseMigrationLock,
};
