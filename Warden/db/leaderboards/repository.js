'use strict';

const crypto = require('node:crypto');
const database = require('../database');
const {
    assertApplicationEncryptionReady,
    createLookup,
    decryptJson,
    encryptJson,
} = require('../encryption/applicationEncryption');
const { TABLES, ensureLeaderboardSchema } = require('./schema');
const {
    isTransientDatabaseError,
    retryTransientDatabaseOperation,
} = require('../errorPolicy');
const { runLeaderboardTransaction } = require('./transaction');
const { assertLeaderboardWritesAllowed } = require('./migrationGuard');

const PAYLOAD_FIELDS = Object.freeze({
    speedrun: Object.freeze([
        'user_id', 'name', 'time', 'milliseconds', 'class', 'ship', 'variant',
        'link', 'comments', 'embed_id',
    ]),
    ace: Object.freeze([
        'user_id', 'name', 'timetaken', 'mgauss', 'sgauss', 'mgaussfired',
        'sgaussfired', 'percenthulllost', 'score', 'link', 'shiptype', 'embed_id',
    ]),
});

function getType(value) {
    const type = String(value ?? '').toLowerCase();
    if (!TABLES[type]) throw new Error(`Unknown Leaderboard type: ${type || 'empty'}.`);
    return type;
}

function getSubmissionId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid Leaderboard submission ID.');
    return id;
}

function context(type) {
    return `warden:leaderboard:${getType(type)}:payload`;
}

function lookup(type, field, value) {
    return createLookup(`warden:leaderboard:${getType(type)}:${field}`, value, {
        normalize: field !== 'user',
    });
}

function payloadFor(type, value) {
    return Object.fromEntries(PAYLOAD_FIELDS[getType(type)].map((field) => [
        field,
        value?.[field] ?? null,
    ]));
}

function encryptedColumns(type, value) {
    const encrypted = encryptJson(context(type), payloadFor(type, value));
    return {
        keyVersion: encrypted.keyVersion,
        nonce: encrypted.nonce,
        tag: encrypted.tag,
        payload: encrypted.ciphertext,
    };
}

function decodeRow(type, row) {
    if (!row) return undefined;
    const payload = decryptJson(context(type), {
        keyVersion: row.key_version,
        nonce: row.payload_nonce,
        tag: row.payload_tag,
        ciphertext: row.encrypted_payload,
    });
    return Object.freeze({
        id: Number(row.id),
        approval: Number(row.approval),
        date: Number(row.submitted_at_ms),
        row_revision: Number(row.row_revision),
        ...payload,
    });
}

async function initializeLeaderboards() {
    assertApplicationEncryptionReady();
    await ensureLeaderboardSchema();
}

async function insertSubmission(type, submission, { sourceId = null } = {}) {
    assertLeaderboardWritesAllowed();
    const normalizedType = getType(type);
    await initializeLeaderboards();
    const encrypted = encryptedColumns(normalizedType, submission);
    const nonce = crypto.randomBytes(16);
    const identityColumns = sourceId == null ? [] : ['id'];
    const identityValues = sourceId == null ? [] : [getSubmissionId(sourceId)];
    const common = [
        Number(submission.approval ?? 0) ? 1 : 0,
        Number(submission.date ?? Date.now()),
        nonce,
        lookup(normalizedType, 'user', submission.user_id),
    ];
    const specific = normalizedType === 'speedrun'
        ? [lookup(normalizedType, 'variant', submission.variant), lookup(normalizedType, 'class', submission.class)]
        : [lookup(normalizedType, 'shiptype', submission.shiptype)];
    const columns = normalizedType === 'speedrun'
        ? [...identityColumns, 'approval', 'submitted_at_ms', 'submission_nonce', 'user_lookup', 'variant_lookup', 'class_lookup']
        : [...identityColumns, 'approval', 'submitted_at_ms', 'submission_nonce', 'user_lookup', 'shiptype_lookup'];
    const values = [...identityValues, ...common, ...specific,
        encrypted.keyVersion, encrypted.nonce, encrypted.tag, encrypted.payload];
    const placeholders = values
        .map(() => '?').join(', ');
    try {
        const result = await database.query(
            `INSERT INTO ${TABLES[normalizedType]} (${columns.join(', ')}, key_version, payload_nonce, payload_tag, encrypted_payload)
             VALUES (${placeholders})`,
            values,
        );
        return loadSubmission(normalizedType, sourceId ?? result.insertId);
    }
    catch (error) {
        if (!isTransientDatabaseError(error)) throw error;
        const { value: rows } = await retryTransientDatabaseOperation(() => database.query(
            `SELECT * FROM ${TABLES[normalizedType]} WHERE submission_nonce = ? LIMIT 1`,
            [nonce],
        ));
        if (!rows?.[0]) throw error;
        return decodeRow(normalizedType, rows[0]);
    }
}

async function loadSubmission(type, id) {
    const normalizedType = getType(type);
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT * FROM ${TABLES[normalizedType]} WHERE id = ? LIMIT 1`,
        [getSubmissionId(id)],
    );
    return decodeRow(normalizedType, rows?.[0]);
}

async function listPendingSubmissions(type) {
    const normalizedType = getType(type);
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT * FROM ${TABLES[normalizedType]} WHERE approval = 0 ORDER BY id`,
    );
    return (rows ?? []).map((row) => decodeRow(normalizedType, row));
}

async function listSpeedrunBoard(variant, shipClass) {
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT * FROM ${TABLES.speedrun}
         WHERE variant_lookup = ? AND class_lookup = ? AND approval = 1`,
        [lookup('speedrun', 'variant', variant), lookup('speedrun', 'class', shipClass)],
    );
    return (rows ?? []).map((row) => decodeRow('speedrun', row))
        .sort((left, right) => (Number(left.time) * 1000 + Number(left.milliseconds))
            - (Number(right.time) * 1000 + Number(right.milliseconds)) || left.id - right.id);
}

async function listAceBoard(shiptype, { limit = 10 } = {}) {
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT * FROM ${TABLES.ace} WHERE shiptype_lookup = ? AND approval = 1`,
        [lookup('ace', 'shiptype', shiptype)],
    );
    return (rows ?? []).map((row) => decodeRow('ace', row))
        .sort((left, right) => Number(right.score) - Number(left.score) || left.id - right.id)
        .slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 10);
}

async function findSpeedrunBest(userId, variant, shipClass) {
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT * FROM ${TABLES.speedrun}
         WHERE user_lookup = ? AND variant_lookup = ? AND class_lookup = ?`,
        [lookup('speedrun', 'user', userId), lookup('speedrun', 'variant', variant), lookup('speedrun', 'class', shipClass)],
    );
    return (rows ?? []).map((row) => decodeRow('speedrun', row))
        .sort((left, right) => (Number(left.time) * 1000 + Number(left.milliseconds))
            - (Number(right.time) * 1000 + Number(right.milliseconds)) || left.id - right.id)[0];
}

async function findAceApproved(userId) {
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT * FROM ${TABLES.ace} WHERE user_lookup = ? AND approval = 1`,
        [lookup('ace', 'user', userId)],
    );
    return (rows ?? []).map((row) => decodeRow('ace', row))
        .sort((left, right) => Number(right.score) - Number(left.score) || left.id - right.id)[0];
}

async function updatePayload(type, id, mutate, { requirePending = false } = {}) {
    assertLeaderboardWritesAllowed();
    const normalizedType = getType(type);
    const current = await loadSubmission(normalizedType, id);
    if (!current || (requirePending && current.approval !== 0)) return undefined;
    const next = { ...current, ...await mutate({ ...current }) };
    const encrypted = encryptedColumns(normalizedType, next);
    const lookupAssignments = normalizedType === 'speedrun'
        ? ['user_lookup = ?', 'variant_lookup = ?', 'class_lookup = ?']
        : ['user_lookup = ?', 'shiptype_lookup = ?'];
    const lookupValues = normalizedType === 'speedrun'
        ? [lookup(normalizedType, 'user', next.user_id), lookup(normalizedType, 'variant', next.variant), lookup(normalizedType, 'class', next.class)]
        : [lookup(normalizedType, 'user', next.user_id), lookup(normalizedType, 'shiptype', next.shiptype)];
    const result = await database.query(
        `UPDATE ${TABLES[normalizedType]}
         SET ${lookupAssignments.join(', ')}, key_version = ?, payload_nonce = ?, payload_tag = ?,
             encrypted_payload = ?, row_revision = row_revision + 1
         WHERE id = ? AND row_revision = ?${requirePending ? ' AND approval = 0' : ''}`,
        [...lookupValues, encrypted.keyVersion, encrypted.nonce, encrypted.tag, encrypted.payload,
            Number(id), current.row_revision],
    );
    if (Number(result.affectedRows) !== 1) {
        const error = new Error('The submission changed concurrently. Reload it and try again.');
        error.code = 'ENCRYPTED_LEADERBOARD_CONFLICT';
        throw error;
    }
    return loadSubmission(normalizedType, id);
}

async function setApprovalMessageId(type, id, messageId) {
    return updatePayload(type, id, () => ({ embed_id: messageId == null ? null : String(messageId) }), {
        requirePending: true,
    });
}

function pendingError(submission) {
    if (!submission) return 'That submission no longer exists. It may already have been deleted.';
    if (Number(submission.approval) !== 0) return 'That submission is no longer pending approval.';
    return undefined;
}

async function loadPendingSubmission(type, id) {
    const submission = await loadSubmission(type, id);
    const error = pendingError(submission);
    if (error) throw new Error(error);
    return submission;
}

async function commitPendingEdits({ context: editContext, object, edits, extraValues = {} }) {
    const changed = Object.fromEntries(Object.entries(edits)
        .filter(([, edit]) => edit?.changed === true)
        .map(([field, edit]) => [field, edit.value]));
    const patch = { ...changed, ...extraValues };
    if (Object.keys(patch).length === 0) return object;
    return updatePayload(editContext.leaderboard, editContext.submissionId, () => patch, {
        requirePending: true,
    });
}

async function approvePendingSubmission(type, id) {
    assertLeaderboardWritesAllowed();
    const normalizedType = getType(type);
    const submissionId = getSubmissionId(id);
    await initializeLeaderboards();
    const approve = async (query) => {
        const result = await query(
            `UPDATE ${TABLES[normalizedType]} SET approval = 1, row_revision = row_revision + 1
             WHERE id = ? AND approval = 0`,
            [submissionId],
        );
        const newlyApproved = Number(result.affectedRows) === 1;
        const rows = await query(`SELECT * FROM ${TABLES[normalizedType]} WHERE id = ? LIMIT 1`, [submissionId]);
        const submission = decodeRow(normalizedType, rows?.[0]);
        if (!submission || Number(submission.approval) !== 1) {
            throw new Error(newlyApproved
                ? 'The approved submission could not be reloaded.'
                : 'That submission is no longer pending approval.');
        }
        if (normalizedType === 'ace') {
            // A retry that recovers an already-approved row must not displace a
            // newer approval that completed after the original response failed.
            const idComparison = newlyApproved ? '<>' : '<';
            await query(
                `DELETE FROM ${TABLES.ace}
                 WHERE user_lookup = ? AND shiptype_lookup = ? AND approval = 1 AND id ${idComparison} ?`,
                [lookup('ace', 'user', submission.user_id), lookup('ace', 'shiptype', submission.shiptype), submissionId],
            );
        }
        return { submission, newlyApproved };
    };
    return normalizedType === 'ace'
        ? runLeaderboardTransaction(approve)
        : approve(database.query);
}

async function deletePendingSubmission(type, id, { expectedUserId } = {}) {
    assertLeaderboardWritesAllowed();
    const normalizedType = getType(type);
    const submissionId = Number(id);
    const expectedLookup = expectedUserId == null
        ? undefined
        : lookup(normalizedType, 'user', expectedUserId);
    const { value: result } = await retryTransientDatabaseOperation(() => database.query(
        `DELETE FROM ${TABLES[normalizedType]}
         WHERE id = ? AND approval = 0${expectedLookup ? ' AND user_lookup = ?' : ''}`,
        expectedLookup ? [submissionId, expectedLookup] : [submissionId],
    ));
    if (Number(result.affectedRows) !== 1) {
        throw new Error('That submission is no longer pending approval.');
    }
}

async function hasSubmissionId(type, id) {
    const normalizedType = getType(type);
    await initializeLeaderboards();
    const rows = await database.query(
        `SELECT id FROM ${TABLES[normalizedType]} WHERE id = ? LIMIT 1`,
        [getSubmissionId(id)],
    );
    return rows?.[0]?.id != null;
}

module.exports = {
    TABLES,
    approvePendingSubmission,
    commitPendingEdits,
    decodeRow,
    deletePendingSubmission,
    findAceApproved,
    findSpeedrunBest,
    getLeaderboard: getType,
    getSubmissionId,
    hasSubmissionId,
    initializeLeaderboards,
    insertSubmission,
    listAceBoard,
    listPendingSubmissions,
    listSpeedrunBoard,
    loadSubmission,
    loadPendingSubmission,
    pendingError,
    setApprovalMessageId,
    updatePayload,
};
