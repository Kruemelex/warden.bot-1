const {
    parseStoredJson,
    stringifyJsonOrNull,
    comparableValuesEqual,
    normalizeDatabaseTimestamp,
} = require('./values');

const DEDICATED_TASK_KEYS = new Set(['enabled', 'type', 'text', 'imageIds', 'imageDirections']);

function nullableBoolean(value) {
    if (value === null || value === undefined) return null;
    return Boolean(Number(value));
}

function booleanToTinyInt(value) {
    if (value === null || value === undefined) return null;
    return value ? 1 : 0;
}

function pruneNullishObject(value) {
    return Object.fromEntries(
        Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined && entry !== null),
    );
}

function catalogRowsToChallenge(challengeRow, questionRows = []) {
    const challengeContext = `verification challenge ${challengeRow.guild_id}/${challengeRow.challenge_id}`;
    const rowsWithIndex = questionRows.map((row, index) => ({ row, index }));
    rowsWithIndex.sort((a, b) => {
        const orderA = a.row.question_order ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.row.question_order ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        const idCompare = String(a.row.question_id).localeCompare(String(b.row.question_id));
        return idCompare || a.index - b.index;
    });

    return {
        id: challengeRow.challenge_id,
        sourceType: challengeRow.source_type,
        sourceTemplateId: challengeRow.source_template_id ?? undefined,
        templateVersion: Number(challengeRow.template_version) || undefined,
        protectedTemplate: Boolean(Number(challengeRow.protected_template)),
        title: challengeRow.title ?? undefined,
        description: challengeRow.description ?? undefined,
        color: challengeRow.color ?? undefined,
        fields: parseStoredJson(challengeRow.fields_json, undefined, `${challengeContext} fields`, 'array'),
        questions: rowsWithIndex.map(({ row }) => catalogRowToQuestion(row)),
        createdBy: challengeRow.created_by ?? undefined,
        updatedBy: challengeRow.updated_by ?? undefined,
        createdAt: normalizeDatabaseTimestamp(challengeRow.created_at, challengeRow.created_at_epoch_seconds),
        updatedAt: normalizeDatabaseTimestamp(challengeRow.updated_at, challengeRow.updated_at_epoch_seconds),
    };
}

function catalogRowToQuestion(row) {
    const questionContext = `verification question ${row.guild_id}/${row.challenge_id}/${row.question_id}`;
    const taskConfig = parseStoredJson(row.task_config_json, {}, `${questionContext} task configuration`, 'object');
    const generatedImage = pruneNullishObject({
        enabled: nullableBoolean(row.task_enabled),
        type: row.task_type ?? undefined,
        text: row.task_prompt_text ?? undefined,
        imageIds: parseStoredJson(row.task_image_ids_json, undefined, `${questionContext} image IDs`, 'object'),
        imageDirections: parseStoredJson(row.task_image_directions_json, undefined, `${questionContext} image directions`, 'object'),
        ...taskConfig,
    });
    const answer = pruneNullishObject({
        required: nullableBoolean(row.answer_required),
        type: row.answer_type ?? undefined,
        inputLabel: row.answer_input_label ?? undefined,
        inputPlaceholder: row.answer_input_placeholder ?? undefined,
        accepted: parseStoredJson(row.answers_json, undefined, `${questionContext} accepted answers`, 'array'),
    });

    return {
        id: row.question_id,
        sourceType: row.source_type,
        sourceTemplateId: row.source_template_id ?? undefined,
        templateVersion: Number(row.template_version) || undefined,
        protectedTemplate: Boolean(Number(row.protected_template)),
        order: row.question_order ?? undefined,
        label: row.question_label ?? undefined,
        text: row.question_text ?? undefined,
        separateStep: nullableBoolean(row.separate_step),
        ...(Object.keys(generatedImage).length > 0 ? { generatedImage } : {}),
        ...(Object.keys(answer).length > 0 ? { answer } : {}),
        createdBy: row.created_by ?? undefined,
        updatedBy: row.updated_by ?? undefined,
        createdAt: normalizeDatabaseTimestamp(row.created_at, row.created_at_epoch_seconds),
        updatedAt: normalizeDatabaseTimestamp(row.updated_at, row.updated_at_epoch_seconds),
    };
}

function questionToCatalogContentValues(question = {}) {
    const generatedImage = question.generatedImage ?? {};
    const answer = question.answer ?? {};
    const taskConfig = Object.fromEntries(
        Object.entries(generatedImage).filter(([key]) => !DEDICATED_TASK_KEYS.has(key)),
    );
    const numericOrder = Number(question.order);

    return [
        Number.isInteger(numericOrder) && numericOrder > 0 ? numericOrder : null,
        question.label ?? null,
        question.text ?? null,
        booleanToTinyInt(question.separateStep),
        booleanToTinyInt(generatedImage.enabled),
        generatedImage.type ?? null,
        generatedImage.text ?? null,
        stringifyJsonOrNull(generatedImage.imageIds),
        stringifyJsonOrNull(generatedImage.imageDirections),
        stringifyJsonOrNull(taskConfig),
        booleanToTinyInt(answer.required),
        answer.type ?? null,
        answer.inputLabel ?? null,
        answer.inputPlaceholder ?? null,
        stringifyJsonOrNull(answer.accepted),
    ];
}

function orderTemplateThenCustom(rows, template) {
    const templateOrder = new Map((template?.questions ?? []).map((question, index) => [String(question.id), index]));
    const protectedRows = rows.filter((row) => templateOrder.has(String(row.question_id)))
        .sort((left, right) => templateOrder.get(String(left.question_id)) - templateOrder.get(String(right.question_id)));
    const customRows = rows.filter((row) => !templateOrder.has(String(row.question_id)))
        .sort((left, right) => (Number(left.question_order) || Number.MAX_SAFE_INTEGER)
            - (Number(right.question_order) || Number.MAX_SAFE_INTEGER)
            || String(left.question_id).localeCompare(String(right.question_id)));
    return [...protectedRows, ...customRows].map((row, index) => ({ ...row,
        original_question_order: row.question_order, question_order: index + 1 }));
}

function assertExpectedCatalogValues(current, expected, label) {
    for (const [field, value] of Object.entries(expected ?? {})) {
        if (comparableValuesEqual(current?.[field], value)) continue;
        throwCatalogConflict(label);
    }
}

function throwCatalogConflict(label) {
    const error = new Error(`${label} changed while this editor was open. Reopen it and apply your changes again.`);
    error.code = 'VERIFICATION_CATALOG_CONFLICT';
    throw error;
}

module.exports = {
    catalogRowsToChallenge,
    catalogRowToQuestion,
    questionToCatalogContentValues,
    orderTemplateThenCustom,
    assertExpectedCatalogValues,
    throwCatalogConflict,
};
