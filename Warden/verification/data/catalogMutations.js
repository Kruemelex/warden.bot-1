const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const { normalizeGuildId } = require('../domain/identity');
const {
    parseStoredJson,
    stringifyJsonOrNull,
    cloneCatalogValue,
    comparableValuesEqual,
} = require('./values');
const {
    TEMPLATE_VERSION,
    MAX_CATALOG_QUESTIONS_PER_CHALLENGE,
    templateChallengeToCatalogRows,
    insertProtectedTemplateQuestionRow,
    getVerificationChallengeTemplate,
} = require('./catalogTemplates');
const {
    catalogRowsToChallenge,
    catalogRowToQuestion,
    questionToCatalogContentValues,
    orderTemplateThenCustom,
    assertExpectedCatalogValues,
    throwCatalogConflict,
} = require('./catalogTransforms');

const MAX_ACTIVE_CATALOG_CHALLENGES = VERIFICATION_UI_LIMITS.selectOptions;
const CATALOG_TIMESTAMP_SELECT = `*,
    UNIX_TIMESTAMP(created_at) AS created_at_epoch_seconds,
    UNIX_TIMESTAMP(updated_at) AS updated_at_epoch_seconds`;

async function updateLockedChallengeRow(query, guildId, challengeId, challenge, updatedBy) {
    await query(`
        UPDATE verification_challenge_catalog
        SET title = ?, description = ?, color = ?, fields_json = ?, updated_by = ?
        WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL
    `, [
        challenge.title ?? null,
        challenge.description ?? null,
        challenge.color ?? null,
        stringifyJsonOrNull(challenge.fields),
        String(updatedBy ?? 'admin'),
        guildId,
        challengeId,
    ]);
}

async function updateLockedQuestionRow(query, guildId, challengeId, questionId, question, updatedBy) {
    await query(`
        UPDATE verification_question_catalog
        SET question_order = ?, question_label = ?, question_text = ?, separate_step = ?,
            task_enabled = ?, task_type = ?, task_prompt_text = ?, task_image_ids_json = ?,
            task_image_directions_json = ?, task_config_json = ?,
            answer_required = ?, answer_type = ?, answer_input_label = ?,
            answer_input_placeholder = ?, answers_json = ?, updated_by = ?
        WHERE guild_id = ? AND challenge_id = ? AND question_id = ? AND deleted_at IS NULL
    `, [
        ...questionToCatalogContentValues(question),
        String(updatedBy ?? 'admin'),
        guildId,
        challengeId,
        questionId,
    ]);
}

async function resetProtectedQuestionRow(query, guildId, challengeId, question, updatedBy) {
    await query(`
        UPDATE verification_question_catalog
        SET question_order = ?, question_label = ?, question_text = ?, separate_step = ?,
            task_enabled = ?, task_type = ?, task_prompt_text = ?, task_image_ids_json = ?,
            task_image_directions_json = ?, task_config_json = ?,
            answer_required = ?, answer_type = ?, answer_input_label = ?,
            answer_input_placeholder = ?, answers_json = ?, source_type = 'template',
            source_template_id = ?, template_version = ?, protected_template = 1,
            deleted_at = NULL, updated_by = ?
        WHERE guild_id = ? AND challenge_id = ? AND question_id = ?
            AND source_type = 'template' AND protected_template = 1
    `, [
        ...questionToCatalogContentValues(question), question.id, TEMPLATE_VERSION,
        String(updatedBy ?? 'admin'), guildId, challengeId, question.id,
    ]);
}

async function resequenceLockedQuestionRows(query, guildId, challengeId, rows, updatedBy) {
    const ordered = [...rows].sort((left, right) => {
        const order = (Number(left.question_order) || Number.MAX_SAFE_INTEGER)
            - (Number(right.question_order) || Number.MAX_SAFE_INTEGER);
        return order || String(left.question_id).localeCompare(String(right.question_id));
    });
    for (const [index, row] of ordered.entries()) {
        if (Number(row.original_question_order ?? row.question_order) !== index + 1) {
            await query(`UPDATE verification_question_catalog SET question_order = ?, updated_by = ?
                WHERE guild_id = ? AND challenge_id = ? AND question_id = ? AND deleted_at IS NULL`,
            [index + 1, String(updatedBy ?? 'admin'), guildId, challengeId, row.question_id]);
        }
        row.question_order = index + 1;
    }
    return ordered;
}

function createCatalogMutations({ ensureCatalogTables, withTransaction }) {
    const withCatalogTransaction = (work) => withTransaction(
        work,
        { isolationLevel: 'REPEATABLE READ' },
    );

    async function lockGuildSettings(query, guildId) {
        const rows = await query(
            'SELECT guild_id FROM verification_guild_settings WHERE guild_id = ? FOR UPDATE',
            [guildId],
        );
        if (!rows?.length) {
            const error = new Error(`Verification settings are not initialized for guild ${guildId}.`);
            error.code = 'VERIFICATION_SETTINGS_NOT_INITIALIZED';
            throw error;
        }
    }

    async function finalizeMutation(finalize, query, result) {
        return typeof finalize === 'function'
            ? finalize(query, result)
            : result;
    }

    async function mutateVerificationChallengeCatalogEntry({ guildId, challengeId, updatedBy, expected, mutate, finalize }) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const normalizedChallengeId = String(challengeId ?? '').trim();
        if (!normalizedChallengeId) throw new Error('Verification challenge ID is required.');
        if (normalizedChallengeId.length > 100) throw new Error('Verification challenge ID must be at most 100 characters.');
        if (typeof mutate !== 'function') throw new TypeError('Verification challenge mutation callback is required.');

        await ensureCatalogTables();
        const updatedChallenge = await withCatalogTransaction(async (query) => {
            await lockGuildSettings(query, normalizedGuildId);
            const rows = await query(`
                SELECT ${CATALOG_TIMESTAMP_SELECT} FROM verification_challenge_catalog
                WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL
                FOR UPDATE
            `, [normalizedGuildId, normalizedChallengeId]);
            const row = rows?.[0];
            if (!row) throw new Error(`Unknown verification challenge: ${normalizedChallengeId}`);

            const currentChallenge = catalogRowsToChallenge(row, []);
            assertExpectedCatalogValues(currentChallenge, expected, 'Verification challenge');
            const nextChallenge = mutate(cloneCatalogValue(currentChallenge));
            if (!nextChallenge || String(nextChallenge.id) !== normalizedChallengeId) {
                throw new Error('Verification challenge mutations cannot change the challenge ID.');
            }
            if (!comparableValuesEqual(currentChallenge, nextChallenge)) {
                await updateLockedChallengeRow(query, normalizedGuildId, normalizedChallengeId, nextChallenge, updatedBy);
            }
            return finalizeMutation(finalize, query, nextChallenge);
        });

        return updatedChallenge;
    }

    async function mutateVerificationQuestionCatalogEntries({
        guildId,
        challengeId,
        questionIds,
        updatedBy,
        expected,
        expectedOrder,
        mutate,
        finalize,
    }) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const normalizedChallengeId = String(challengeId ?? '').trim();
        const normalizedQuestionIds = [...new Set((questionIds ?? [])
            .map((questionId) => String(questionId ?? '').trim())
            .filter(Boolean))];
        if (!normalizedChallengeId) throw new Error('Verification challenge ID is required.');
        if (normalizedQuestionIds.length < 1) throw new Error('At least one verification question ID is required.');
        if (typeof mutate !== 'function') throw new TypeError('Verification question mutation callback is required.');

        await ensureCatalogTables();
        const updatedQuestions = await withCatalogTransaction(async (query) => {
            await lockGuildSettings(query, normalizedGuildId);
            const placeholders = normalizedQuestionIds.map(() => '?').join(', ');
            const protectsCompleteOrder = expectedOrder !== undefined;
            if (protectsCompleteOrder) {
                const parent = await query(`
                    SELECT challenge_id FROM verification_challenge_catalog
                    WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL
                    FOR UPDATE
                `, [normalizedGuildId, normalizedChallengeId]);
                if (!parent?.length) throw new Error(`Unknown verification challenge: ${normalizedChallengeId}`);
            }
            const rows = await query(protectsCompleteOrder
                ? `SELECT ${CATALOG_TIMESTAMP_SELECT} FROM verification_question_catalog
                    WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL
                    ORDER BY question_order, question_id FOR UPDATE`
                : `SELECT ${CATALOG_TIMESTAMP_SELECT} FROM verification_question_catalog
                    WHERE guild_id = ? AND challenge_id = ? AND question_id IN (${placeholders})
                        AND deleted_at IS NULL
                    FOR UPDATE`,
            protectsCompleteOrder
                ? [normalizedGuildId, normalizedChallengeId]
                : [normalizedGuildId, normalizedChallengeId, ...normalizedQuestionIds]);
            const currentQuestions = new Map((rows ?? []).map((row) => [String(row.question_id), catalogRowToQuestion(row)]));
            const missingQuestionId = normalizedQuestionIds.find((questionId) => !currentQuestions.has(questionId));
            if (missingQuestionId) {
                throw new Error(`Unknown verification question: ${normalizedChallengeId}/${missingQuestionId}`);
            }
            if (protectsCompleteOrder) {
                const openingOrder = new Map(Object.entries(expectedOrder ?? {})
                    .map(([questionId, order]) => [String(questionId), Number(order)]));
                if (openingOrder.size !== currentQuestions.size
                    || [...currentQuestions].some(([questionId, question]) =>
                        openingOrder.get(questionId) !== Number(question.order))) {
                    throwCatalogConflict('Verification question order');
                }
            }
            for (const questionId of normalizedQuestionIds) {
                assertExpectedCatalogValues(
                    currentQuestions.get(questionId),
                    expected?.[questionId],
                    'Verification question',
                );
            }

            const workingQuestions = new Map([...currentQuestions.entries()]
                .map(([questionId, question]) => [questionId, cloneCatalogValue(question)]));
            const nextQuestions = mutate(workingQuestions);
            if (!(nextQuestions instanceof Map)) {
                throw new TypeError('Verification question mutation callback must return a Map.');
            }
            for (const questionId of normalizedQuestionIds) {
                const nextQuestion = nextQuestions.get(questionId);
                if (!nextQuestion || String(nextQuestion.id) !== questionId) {
                    throw new Error('Verification question mutations cannot remove or rename targeted questions.');
                }
                if (!comparableValuesEqual(currentQuestions.get(questionId), nextQuestion)) {
                    await updateLockedQuestionRow(
                        query,
                        normalizedGuildId,
                        normalizedChallengeId,
                        questionId,
                        nextQuestion,
                        updatedBy,
                    );
                }
            }
            return finalizeMutation(finalize, query, nextQuestions);
        });

        return updatedQuestions;
    }

    async function createVerificationChallengeCatalogEntry({ guildId, challengeId, title, description, color, createdBy, finalize }) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const normalizedChallengeId = String(challengeId ?? '').trim();
        if (!normalizedChallengeId) throw new Error('Verification challenge ID is required.');
        if (normalizedChallengeId.length > 100) throw new Error('Verification challenge ID must be at most 100 characters.');
        await ensureCatalogTables();
        const challenge = await withCatalogTransaction(async (query) => {
            await lockGuildSettings(query, normalizedGuildId);
            // Lock the guild's primary-key range so concurrent creates serialize before
            // enforcing Discord's 25-option challenge selector limit.
            const guildRows = await query(`
                SELECT challenge_id FROM verification_challenge_catalog
                WHERE guild_id = ? FOR UPDATE
            `, [normalizedGuildId]);
            const activeRows = await query(`
                SELECT challenge_id FROM verification_challenge_catalog
                WHERE guild_id = ? AND deleted_at IS NULL FOR UPDATE
            `, [normalizedGuildId]);
            if ((activeRows?.length ?? 0) >= MAX_ACTIVE_CATALOG_CHALLENGES) {
                const error = new Error(`A server can have at most ${MAX_ACTIVE_CATALOG_CHALLENGES} verification challenges.`);
                error.code = 'VERIFICATION_CHALLENGE_LIMIT';
                throw error;
            }
            const rows = await query(`
                SELECT challenge_id FROM verification_challenge_catalog
                WHERE guild_id = ? AND challenge_id = ? FOR UPDATE
            `, [normalizedGuildId, normalizedChallengeId]);
            if (rows?.length || guildRows.some((row) => String(row.challenge_id) === normalizedChallengeId)) {
                throw new Error(`Verification challenge ID already exists: ${normalizedChallengeId}`);
            }
            await query(`
                INSERT INTO verification_challenge_catalog
                    (guild_id, challenge_id, source_type, template_version, protected_template,
                     title, description, color, created_by, updated_by)
                VALUES (?, ?, 'admin', ?, 0, ?, ?, ?, ?, ?)
            `, [normalizedGuildId, normalizedChallengeId, TEMPLATE_VERSION, title ?? null,
                description ?? null, color ?? null, String(createdBy ?? 'admin'), String(createdBy ?? 'admin')]);
            return finalizeMutation(finalize, query, {
                id: normalizedChallengeId,
                sourceType: 'admin',
                protectedTemplate: false,
                title,
                description,
                color,
                questions: [],
            });
        });
        return challenge;
    }

    async function createVerificationQuestionCatalogEntry({ guildId, challengeId, question, createdBy, finalize }) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const normalizedChallengeId = String(challengeId ?? '').trim();
        const normalizedQuestionId = String(question?.id ?? '').trim();
        if (!normalizedChallengeId || !normalizedQuestionId) throw new Error('Challenge and question IDs are required.');
        if (normalizedChallengeId.length > 100 || normalizedQuestionId.length > 100) {
            throw new Error('Challenge and question IDs must be at most 100 characters.');
        }
        await ensureCatalogTables();
        const created = await withCatalogTransaction(async (query) => {
            await lockGuildSettings(query, normalizedGuildId);
            const parentRows = await query(`SELECT challenge_id FROM verification_challenge_catalog
                WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL FOR UPDATE`,
            [normalizedGuildId, normalizedChallengeId]);
            if (!parentRows?.length) throw new Error(`Unknown verification challenge: ${normalizedChallengeId}`);
            const siblingRows = await query(`SELECT question_id, question_order FROM verification_question_catalog
                WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL ORDER BY question_order FOR UPDATE`,
            [normalizedGuildId, normalizedChallengeId]);
            if (siblingRows.length >= MAX_CATALOG_QUESTIONS_PER_CHALLENGE) {
                const error = new Error(`A verification challenge can have at most ${MAX_CATALOG_QUESTIONS_PER_CHALLENGE} questions.`);
                error.code = 'VERIFICATION_QUESTION_LIMIT';
                throw error;
            }
            if (siblingRows.some((row) => String(row.question_id) === normalizedQuestionId)) {
                throw new Error(`Verification question ID already exists: ${normalizedChallengeId}/${normalizedQuestionId}`);
            }
            const collisionRows = await query(`SELECT question_id FROM verification_question_catalog
                WHERE guild_id = ? AND challenge_id = ? AND question_id = ? FOR UPDATE`,
            [normalizedGuildId, normalizedChallengeId, normalizedQuestionId]);
            if (collisionRows?.length) throw new Error(`Verification question ID already exists: ${normalizedChallengeId}/${normalizedQuestionId}`);
            await resequenceLockedQuestionRows(query, normalizedGuildId, normalizedChallengeId, siblingRows, createdBy);
            const createdQuestion = { ...question, id: normalizedQuestionId, order: siblingRows.length + 1 };
            await query(`INSERT INTO verification_question_catalog
                (guild_id, challenge_id, question_id, question_order, source_type, template_version,
                 protected_template, question_label, question_text, separate_step, task_enabled, task_type,
                 task_prompt_text, task_image_ids_json, task_image_directions_json,
                 task_config_json, answer_required, answer_type, answer_input_label, answer_input_placeholder,
                 answers_json, created_by, updated_by)
                VALUES (?, ?, ?, ?, 'admin', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                normalizedGuildId, normalizedChallengeId, normalizedQuestionId, createdQuestion.order, TEMPLATE_VERSION,
                ...questionToCatalogContentValues(createdQuestion).slice(1), String(createdBy ?? 'admin'), String(createdBy ?? 'admin'),
            ]);
            return finalizeMutation(finalize, query, {
                ...createdQuestion,
                sourceType: 'admin',
                protectedTemplate: false,
            });
        });
        return created;
    }

    async function deleteOrResetVerificationChallengeCatalogEntry({ guildId, challengeId, updatedBy, expected, finalize }) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const normalizedChallengeId = String(challengeId ?? '').trim();
        await ensureCatalogTables();
        const result = await withCatalogTransaction(async (query) => {
            const settingsRows = await query(`SELECT active_challenge_ids_json FROM verification_guild_settings
                WHERE guild_id = ? LIMIT 1 FOR UPDATE`, [normalizedGuildId]);
            const rows = await query(`SELECT ${CATALOG_TIMESTAMP_SELECT} FROM verification_challenge_catalog
                WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL FOR UPDATE`,
            [normalizedGuildId, normalizedChallengeId]);
            const row = rows?.[0];
            if (!row) throw new Error(`Unknown verification challenge: ${normalizedChallengeId}`);
            assertExpectedCatalogValues(catalogRowsToChallenge(row), expected, 'Verification challenge');
            const isProtectedTemplate = row.source_type === 'template' && Boolean(Number(row.protected_template));
            const isCustom = row.source_type === 'admin' && !Boolean(Number(row.protected_template));
            if (!isProtectedTemplate && !isCustom) throw new Error('Verification challenge catalog ownership metadata is inconsistent.');
            const questionRows = await query(`SELECT question_id, question_order, source_type, protected_template, deleted_at
                FROM verification_question_catalog
                WHERE guild_id = ? AND challenge_id = ? FOR UPDATE`,
            [normalizedGuildId, normalizedChallengeId]);
            for (const questionRow of questionRows) {
                const protectedQuestion = questionRow.source_type === 'template' && Boolean(Number(questionRow.protected_template));
                const customQuestion = questionRow.source_type === 'admin' && !Boolean(Number(questionRow.protected_template));
                if (!protectedQuestion && !customQuestion) {
                    throw new Error(`Verification question catalog ownership metadata is inconsistent: ${normalizedChallengeId}/${questionRow.question_id}`);
                }
            }
            if (isCustom) {
                const parsedActiveIds = parseStoredJson(
                    settingsRows?.[0]?.active_challenge_ids_json,
                    [],
                    `verification settings for guild ${normalizedGuildId}`,
                    'array',
                );
                const activeIds = (Array.isArray(parsedActiveIds) ? parsedActiveIds : []).map(String);
                if (activeIds.includes(normalizedChallengeId)) {
                    const error = new Error('Deactivate this verification challenge in Settings before deleting it.');
                    error.code = 'VERIFICATION_CHALLENGE_ACTIVE';
                    throw error;
                }
                await query(`UPDATE verification_question_catalog SET deleted_at = CURRENT_TIMESTAMP, updated_by = ?
                    WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL`,
                [String(updatedBy ?? 'admin'), normalizedGuildId, normalizedChallengeId]);
                await query(`UPDATE verification_challenge_catalog SET deleted_at = CURRENT_TIMESTAMP, updated_by = ?
                    WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL`,
                [String(updatedBy ?? 'admin'), normalizedGuildId, normalizedChallengeId]);
                return finalizeMutation(finalize, query, {
                    action: 'deleted',
                    challengeId: normalizedChallengeId,
                });
            }
            const template = getVerificationChallengeTemplate(normalizedChallengeId);
            if (!template) throw new Error(`Missing protected verification challenge template: ${normalizedChallengeId}`);
            await updateLockedChallengeRow(query, normalizedGuildId, normalizedChallengeId, template, updatedBy);
            const currentTemplateIds = new Set((template.questions ?? []).map((question) => String(question.id)));
            const templateCatalogRows = templateChallengeToCatalogRows(template, normalizedGuildId).questionRows;
            const obsoleteProtectedRows = questionRows.filter((questionRow) =>
                questionRow.source_type === 'template' && Boolean(Number(questionRow.protected_template))
                && !currentTemplateIds.has(String(questionRow.question_id)) && !questionRow.deleted_at);
            for (const obsoleteRow of obsoleteProtectedRows) {
                await query(`UPDATE verification_question_catalog
                    SET deleted_at = CURRENT_TIMESTAMP, updated_by = ?
                    WHERE guild_id = ? AND challenge_id = ? AND question_id = ?
                        AND source_type = 'template' AND protected_template = 1 AND deleted_at IS NULL`,
                [String(updatedBy ?? 'admin'), normalizedGuildId, normalizedChallengeId, obsoleteRow.question_id]);
            }
            for (const question of template.questions ?? []) {
                const existing = questionRows.find((row) => String(row.question_id) === String(question.id));
                if (existing && (existing.source_type !== 'template' || !Boolean(Number(existing.protected_template)))) {
                    throw new Error(`Protected template question ID is owned by a custom row: ${normalizedChallengeId}/${question.id}`);
                }
                if (existing) {
                    await resetProtectedQuestionRow(query, normalizedGuildId, normalizedChallengeId, question, updatedBy);
                }
                else {
                    const templateRow = templateCatalogRows.find((candidate) => candidate.question_id === question.id);
                    await insertProtectedTemplateQuestionRow(templateRow, updatedBy, query);
                }
            }
            const activeCustomRows = questionRows.filter((questionRow) =>
                questionRow.source_type === 'admin' && !Boolean(Number(questionRow.protected_template)) && !questionRow.deleted_at);
            if ((template.questions?.length ?? 0) + activeCustomRows.length > MAX_CATALOG_QUESTIONS_PER_CHALLENGE) {
                const error = new Error(`Resetting this template would exceed the ${MAX_CATALOG_QUESTIONS_PER_CHALLENGE}-question challenge limit.`);
                error.code = 'VERIFICATION_QUESTION_LIMIT';
                throw error;
            }
            const deterministicRows = orderTemplateThenCustom([
                ...(template.questions ?? []).map((question) => ({ question_id: question.id, question_order: question.order })),
                ...activeCustomRows,
            ], template);
            await resequenceLockedQuestionRows(query, normalizedGuildId, normalizedChallengeId, deterministicRows, updatedBy);
            return finalizeMutation(finalize, query, {
                action: 'reset',
                challengeId: normalizedChallengeId,
            });
        });
        return result;
    }

    async function deleteOrResetVerificationQuestionCatalogEntry({ guildId, challengeId, questionId, updatedBy, expected, finalize }) {
        const normalizedGuildId = normalizeGuildId(guildId);
        const normalizedChallengeId = String(challengeId ?? '').trim();
        const normalizedQuestionId = String(questionId ?? '').trim();
        await ensureCatalogTables();
        const result = await withCatalogTransaction(async (query) => {
            await lockGuildSettings(query, normalizedGuildId);
            const parent = await query(`SELECT challenge_id FROM verification_challenge_catalog
                WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL FOR UPDATE`, [normalizedGuildId, normalizedChallengeId]);
            if (!parent?.length) throw new Error(`Unknown verification challenge: ${normalizedChallengeId}`);
            const siblings = await query(`SELECT * FROM verification_question_catalog
                WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL ORDER BY question_order, question_id FOR UPDATE`,
            [normalizedGuildId, normalizedChallengeId]);
            const row = siblings.find((candidate) => String(candidate.question_id) === normalizedQuestionId);
            if (!row) throw new Error(`Unknown verification question: ${normalizedChallengeId}/${normalizedQuestionId}`);
            assertExpectedCatalogValues(catalogRowToQuestion(row), expected, 'Verification question');
            const isProtectedTemplate = row.source_type === 'template' && Boolean(Number(row.protected_template));
            const isCustom = row.source_type === 'admin' && !Boolean(Number(row.protected_template));
            if (!isProtectedTemplate && !isCustom) throw new Error('Verification question catalog ownership metadata is inconsistent.');
            if (isProtectedTemplate) {
                const templateQuestion = getVerificationChallengeTemplate(normalizedChallengeId)?.questions
                    ?.find((question) => question.id === normalizedQuestionId);
                if (!templateQuestion) throw new Error(`Missing protected verification question template: ${normalizedChallengeId}/${normalizedQuestionId}`);
                await updateLockedQuestionRow(query, normalizedGuildId, normalizedChallengeId, normalizedQuestionId, templateQuestion, updatedBy);
                const reordered = orderTemplateThenCustom(siblings, getVerificationChallengeTemplate(normalizedChallengeId));
                await resequenceLockedQuestionRows(query, normalizedGuildId, normalizedChallengeId, reordered, updatedBy);
                return finalizeMutation(finalize, query, {
                    action: 'reset',
                    challengeId: normalizedChallengeId,
                    questionId: normalizedQuestionId,
                });
            }
            await query(`UPDATE verification_question_catalog SET deleted_at = CURRENT_TIMESTAMP, updated_by = ?
                WHERE guild_id = ? AND challenge_id = ? AND question_id = ? AND deleted_at IS NULL`,
            [String(updatedBy ?? 'admin'), normalizedGuildId, normalizedChallengeId, normalizedQuestionId]);
            const remaining = siblings.filter((candidate) => String(candidate.question_id) !== normalizedQuestionId);
            await resequenceLockedQuestionRows(query, normalizedGuildId, normalizedChallengeId, remaining, updatedBy);
            return finalizeMutation(finalize, query, {
                action: 'deleted',
                challengeId: normalizedChallengeId,
                questionId: normalizedQuestionId,
            });
        });
        return result;
    }

    return {
        mutateVerificationChallengeCatalogEntry,
        mutateVerificationQuestionCatalogEntries,
        createVerificationChallengeCatalogEntry,
        createVerificationQuestionCatalogEntry,
        deleteOrResetVerificationChallengeCatalogEntry,
        deleteOrResetVerificationQuestionCatalogEntry,
    };
}

module.exports = {
    createCatalogMutations,
};
