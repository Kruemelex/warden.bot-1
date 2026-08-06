const { verificationChallenges } = require('../domain/challengeTemplates');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const { normalizeGuildId } = require('../domain/identity');
const { stringifyJsonOrNull } = require('./values');
const { questionToCatalogContentValues } = require('./catalogTransforms');

const TEMPLATE_VERSION = 2;
const SEEDED_GUILD_CACHE_MAX = 100;
const MAX_CATALOG_QUESTIONS_PER_CHALLENGE = VERIFICATION_UI_LIMITS.selectOptions;
const seededGuilds = new Map();
const seedLoads = new Map();

function templateChallengeToCatalogRows(challenge, guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    if ((challenge.questions?.length ?? 0) > MAX_CATALOG_QUESTIONS_PER_CHALLENGE) {
        const error = new Error(`A verification challenge template can have at most ${MAX_CATALOG_QUESTIONS_PER_CHALLENGE} questions.`);
        error.code = 'VERIFICATION_QUESTION_LIMIT';
        throw error;
    }
    const challengeRow = {
        guild_id: normalizedGuildId,
        challenge_id: challenge.id,
        source_type: 'template',
        source_template_id: challenge.id,
        template_version: TEMPLATE_VERSION,
        protected_template: 1,
        title: challenge.title ?? null,
        description: challenge.description ?? null,
        color: challenge.color ?? null,
        fields_json: stringifyJsonOrNull(challenge.fields),
    };

    const questionRows = (challenge.questions ?? []).map((question, index) => {
        const [
            questionOrder,
            questionLabel,
            questionText,
            separateStep,
            taskEnabled,
            taskType,
            taskPromptText,
            taskImageIdsJson,
            taskImageDirectionsJson,
            taskConfigJson,
            answerRequired,
            answerType,
            answerInputLabel,
            answerInputPlaceholder,
            answersJson,
        ] = questionToCatalogContentValues({ ...question, order: index + 1 });

        return {
            guild_id: normalizedGuildId,
            challenge_id: challenge.id,
            question_id: question.id,
            question_order: questionOrder,
            source_type: 'template',
            source_template_id: question.id,
            template_version: TEMPLATE_VERSION,
            protected_template: 1,
            question_label: questionLabel,
            question_text: questionText,
            separate_step: separateStep,
            task_enabled: taskEnabled,
            task_type: taskType,
            task_prompt_text: taskPromptText,
            task_image_ids_json: taskImageIdsJson,
            task_image_directions_json: taskImageDirectionsJson,
            task_config_json: taskConfigJson,
            answer_required: answerRequired,
            answer_type: answerType,
            answer_input_label: answerInputLabel,
            answer_input_placeholder: answerInputPlaceholder,
            answers_json: answersJson,
        };
    });

    return { challengeRow, questionRows };
}

async function insertChallengeRowIfMissing(row, query) {
    await query(`
        INSERT IGNORE INTO verification_challenge_catalog (
            guild_id, challenge_id, source_type, source_template_id, template_version, protected_template,
            title, description, color, fields_json, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'seed')
    `, [row.guild_id, row.challenge_id, row.source_type, row.source_template_id, row.template_version, row.protected_template, row.title, row.description, row.color, row.fields_json]);
}

async function insertQuestionRowIfMissing(row, query) {
    await query(`
        INSERT IGNORE INTO verification_question_catalog (
            guild_id, challenge_id, question_id, question_order, source_type, source_template_id,
            template_version, protected_template, question_label, question_text, separate_step,
            task_enabled, task_type, task_prompt_text, task_image_ids_json,
            task_image_directions_json, task_config_json, answer_required, answer_type,
            answer_input_label, answer_input_placeholder, answers_json, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', 'seed')
    `, [row.guild_id, row.challenge_id, row.question_id, row.question_order, row.source_type, row.source_template_id, row.template_version, row.protected_template, row.question_label, row.question_text, row.separate_step, row.task_enabled, row.task_type, row.task_prompt_text, row.task_image_ids_json, row.task_image_directions_json, row.task_config_json, row.answer_required, row.answer_type, row.answer_input_label, row.answer_input_placeholder, row.answers_json]);
}

async function seedVerificationChallengeTemplates(guildId, query, ensureCatalogTables) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await ensureCatalogTables();

    for (const challenge of Object.values(verificationChallenges)) {
        const { challengeRow, questionRows } = templateChallengeToCatalogRows(challenge, normalizedGuildId);
        await insertChallengeRowIfMissing(challengeRow, query);
        const challengeRows = await query(`SELECT source_type, protected_template
            FROM verification_challenge_catalog
            WHERE guild_id = ? AND challenge_id = ? FOR UPDATE`,
        [normalizedGuildId, challenge.id]);
        const persistedChallenge = challengeRows?.[0];
        if (
            persistedChallenge?.source_type !== 'template'
            || !Boolean(Number(persistedChallenge.protected_template))
        ) {
            throw new Error(`Protected verification template ID is owned by a custom challenge: ${challenge.id}`);
        }
        const activeQuestionRows = await query(`SELECT question_id
            FROM verification_question_catalog
            WHERE guild_id = ? AND challenge_id = ? AND deleted_at IS NULL
            FOR UPDATE`, [normalizedGuildId, challenge.id]);
        const activeQuestionIds = new Set((activeQuestionRows ?? []).map((row) => String(row.question_id)));
        const missingTemplateQuestions = questionRows.filter((row) => !activeQuestionIds.has(String(row.question_id)));
        if (activeQuestionIds.size + missingTemplateQuestions.length > MAX_CATALOG_QUESTIONS_PER_CHALLENGE) {
            const error = new Error(`Seeding verification template ${challenge.id} would exceed the ${MAX_CATALOG_QUESTIONS_PER_CHALLENGE}-question challenge limit.`);
            error.code = 'VERIFICATION_QUESTION_LIMIT';
            throw error;
        }
        for (const questionRow of questionRows) {
            await insertQuestionRowIfMissing(questionRow, query);
        }
    }
}

function markGuildTemplatesSeeded(guildId) {
    seededGuilds.delete(guildId);
    seededGuilds.set(guildId, true);
    while (seededGuilds.size > SEEDED_GUILD_CACHE_MAX) {
        seededGuilds.delete(seededGuilds.keys().next().value);
    }
}

async function ensureVerificationChallengeTemplatesSeeded(guildId, {
    query,
    defaultQuery,
    ensureCatalogTables,
    withTransaction,
}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const canMemoize = query === defaultQuery;

    if (!canMemoize) return seedVerificationChallengeTemplates(normalizedGuildId, query, ensureCatalogTables);
    if (seededGuilds.has(normalizedGuildId)) {
        markGuildTemplatesSeeded(normalizedGuildId);
        return;
    }
    if (seedLoads.has(normalizedGuildId)) return seedLoads.get(normalizedGuildId);

    const load = withTransaction((transactionQuery) =>
        seedVerificationChallengeTemplates(normalizedGuildId, transactionQuery, ensureCatalogTables))
        .then(() => markGuildTemplatesSeeded(normalizedGuildId))
        .finally(() => seedLoads.delete(normalizedGuildId));
    seedLoads.set(normalizedGuildId, load);
    return load;
}

async function insertProtectedTemplateQuestionRow(row, updatedBy, query) {
    const actor = String(updatedBy ?? 'admin');
    await query(`
        INSERT INTO verification_question_catalog (
            guild_id, challenge_id, question_id, question_order, source_type, source_template_id,
            template_version, protected_template, question_label, question_text, separate_step,
            task_enabled, task_type, task_prompt_text, task_image_ids_json,
            task_image_directions_json, task_config_json, answer_required, answer_type,
            answer_input_label, answer_input_placeholder, answers_json, created_by, updated_by
        ) VALUES (?, ?, ?, ?, 'template', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [row.guild_id, row.challenge_id, row.question_id, row.question_order, row.source_template_id,
        row.template_version, row.question_label, row.question_text, row.separate_step, row.task_enabled,
        row.task_type, row.task_prompt_text, row.task_image_ids_json,
        row.task_image_directions_json, row.task_config_json, row.answer_required, row.answer_type,
        row.answer_input_label, row.answer_input_placeholder, row.answers_json, actor, actor]);
}

function getVerificationChallengeTemplate(challengeId) {
    const normalizedChallengeId = String(challengeId ?? '').trim();
    const template = verificationChallenges[normalizedChallengeId];
    if (!template) return undefined;

    const normalized = template;
    return {
        ...normalized,
        questions: (normalized.questions ?? []).map((question, index) => ({
            ...question,
            order: index + 1,
        })),
    };
}

module.exports = {
    TEMPLATE_VERSION,
    MAX_CATALOG_QUESTIONS_PER_CHALLENGE,
    templateChallengeToCatalogRows,
    ensureVerificationChallengeTemplatesSeeded,
    insertProtectedTemplateQuestionRow,
    getVerificationChallengeTemplate,
};
