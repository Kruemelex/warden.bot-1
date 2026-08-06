const {
    buildModal: buildAdminModal,
    buildModalStringSelectField,
    buildModalTextLabel,
    getModalSingleSelectValue,
    getModalTextInput,
    getRequiredModalSingleSelect,
} = require('../../ux/components/modalFields');
const { acknowledgePanelInteraction } = require('../../ux/interactions/acknowledgement');
const {
    QUESTION_TASK_CONFIG_FIELDS,
    getNormalizedQuestionTaskType: getQuestionTaskType,
    getQuestionTaskEditorCapabilities,
    getQuestionTaskImageRoleConfig,
    getQuestionTaskModuleByType,
    isQuestionTaskType,
    normalizeQuestionTaskType: normalizeTaskType,
} = require('../domain/questionTasks/taskRegistry');
const { getQuestionAnswerType } = require('../domain/answerTypes');
const {
    createCustomQuestion,
    resetCatalogQuestionFieldsToTemplate,
    updateCatalogQuestionOptions,
} = require('../service');
const { startVerificationQuestionPreview } = require('../runtime/previewFlow');
const {
    getChallengeQuestions,
    getQuestionNumber,
    resolveQuestion,
} = require('../domain/challenges');
const {
    baselineEditsChanged,
    resolveBaselineEdits,
} = require('./edits');
const {
    replaceAdminPanel,
} = require('./panel');
const {
    respondAdminError,
    respondAdminModalError,
    respondAdminNoChanges,
    userErrorEmbed,
} = require('./feedback');
const {
    QUESTION_ANSWER_TYPE_OPTIONS,
    QUESTION_CREATE_ANSWER_TYPE_OPTIONS,
    buildBooleanSelectField,
    buildQuestionAnswerTypeSelectModalLabel,
    getQuestionClearSelectOptions,
    buildQuestionEditorPayload,
    buildQuestionOrderSelectField,
    getQuestionResetDefinitions,
    buildQuestionResetRevision,
    buildQuestionTaskSelectModalLabel,
    BOOLEAN_SELECT_OPTIONS,
    getQuestionOrderSelectOptions,
    isAnswerTypeSupportedByTask,
} = require('./questionPanel');
const { buildChallengeOverviewPanelPayload } = require('./challengeEditor');
const {
    beginQuestionModalSubmission,
    expectedCatalogQuestions,
    replyWithCommittedQuestionPanel,
    validateQuestionAdminInteraction,
    validateQuestionPanelInteraction,
} = require('./questionContext');

async function handleQuestionSelectMenu(interaction, parts, state = {}) {
    const [mode, guildId, ownerUserId, challengeId] = parts;
    const selectedQuestionId = interaction.values?.[0];
    if (!selectedQuestionId) return respondAdminError(interaction, { embeds: [userErrorEmbed('Please select a question.')] });
    const context = await validateQuestionAdminInteraction(
        interaction,
        [guildId, ownerUserId, challengeId, selectedQuestionId],
        { acknowledge: true },
    );
    if (context.error) return;
    const effectiveChallenge = context.challenge;
    const effectiveQuestion = resolveQuestion(effectiveChallenge, selectedQuestionId) ?? context.question;
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        buildPayload: () => buildQuestionEditorPayload({
            mode,
            guildId: context.guildId,
            ownerUserId: context.ownerUserId,
            challengeId: context.challengeId,
            challenge: effectiveChallenge,
            question: effectiveQuestion,
            catalogQuestion: context.catalogQuestionsById.get(String(effectiveQuestion.id)),
            questionChanges: context.questionChanges,
            enabledChallengeIds: context.snapshot.activeChallengeIds,
        }),
    });
}

async function handleQuestionPreviewButton(interaction, parts) {
    const [guildId, ownerUserId, challengeId, questionId] = parts;
    return startVerificationQuestionPreview(interaction, {
        guildId,
        challengeId,
        questionId,
    });
}

async function showQuestionClearSelectorModal(interaction, parts, state = {}) {
    const context = await validateQuestionPanelInteraction(interaction, parts, state);
    if (context.error) return;
    const effectiveChallenge = context.challenge;
    const effectiveQuestion = resolveQuestion(effectiveChallenge, context.question.id) ?? context.question;
    const questionChanges = context.questionChanges;
    const definitions = getQuestionResetDefinitions(effectiveQuestion, questionChanges?.changes);

    if (definitions.length < 1) {
        return respondAdminError(interaction, {
            content: `There are no catalog fields to reset to template values for **${context.challengeId}/${context.question.id}**.`,
        });
    }

    const modal = buildAdminModal(
        context.panelSession.buildForm(
            'questionClearModal',
            [context.guildId, context.ownerUserId, context.challengeId, context.question.id],
            { reset_revision: buildQuestionResetRevision(questionChanges, effectiveQuestion) },
            interaction.customId,
        ),
        'Reset Question Fields',
        buildModalStringSelectField({
            label: 'Catalog field to reset',
            description: 'Select catalog fields to restore from the protected template for this Question.',
            customId: 'clear_field',
            placeholder: 'Choose catalog fields to reset...',
            options: getQuestionClearSelectOptions(definitions),
            selectedValues: [],
            minValues: 1,
            maxValues: 1,
            required: true,
        }),
    );

    return interaction.showModal(modal);
}

async function showQuestionModal(interaction, parts, state, buildModal) {
    const context = await validateQuestionPanelInteraction(interaction, parts, state);
    if (context.error) return;
    const modal = await buildModal(context, context.question);
    if (!modal) return;
    return interaction.showModal(modal);
}

function showQuestionOptionsModal(interaction, parts, state) {
    return showQuestionModal(interaction, parts, state, async (context, question) => {
        const effectiveChallenge = context.challenge;
        const effectiveQuestion = question;
        return buildAdminModal(
            context.panelSession.buildForm(
                'questionOptionsModal',
                [context.guildId, context.ownerUserId, context.challengeId, context.question.id],
                {
                    order_number: String(getQuestionNumber(effectiveChallenge, effectiveQuestion)),
                    question_order: Object.fromEntries(getChallengeQuestions(effectiveChallenge)
                        .map((candidate, index) => [String(candidate.id), index + 1])),
                    separate_step: effectiveQuestion.separateStep === true ? 'true' : 'false',
                    answer_type: getQuestionAnswerType(effectiveQuestion),
                    task_type: getQuestionTaskType(effectiveQuestion),
                },
                interaction.customId,
            ),
            'Question Options',
            buildQuestionOrderSelectField(effectiveChallenge, context.question.id),
            buildBooleanSelectField('separate_step', 'Separate Step', effectiveQuestion.separateStep === true),
            buildQuestionAnswerTypeSelectModalLabel(getQuestionAnswerType(effectiveQuestion)),
            buildQuestionTaskSelectModalLabel(getQuestionTaskType(effectiveQuestion)),
        );
    });
}

function parseBooleanSelect(value) {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error('Boolean select must be True or False.');
}

function parseOrderSelect(value) {
    const order = Number(value);
    if (!Number.isInteger(order) || order < 1) throw new Error('Please select a valid order number.');
    return order;
}

function buildQuestionOrderPatchMap(effectiveChallenge, selectedQuestionId, targetOrder) {
    const questions = getChallengeQuestions(effectiveChallenge);
    const questionIds = questions.map((question) => question.id);
    const currentIndex = questionIds.indexOf(selectedQuestionId);
    if (currentIndex < 0) throw new Error(`Unknown question ID: ${selectedQuestionId}`);
    const reorderedIds = [...questionIds];
    const [movedQuestionId] = reorderedIds.splice(currentIndex, 1);
    reorderedIds.splice(targetOrder - 1, 0, movedQuestionId);
    return Object.fromEntries(reorderedIds.map((questionId, index) => [questionId, { order: index + 1 }]));
}

function buildTaskTypePatch(taskType) {
    const normalizedTaskType = normalizeTaskType(taskType);
    const taskModule = getQuestionTaskModuleByType(normalizedTaskType);
    const retainedConfigFields = new Set(taskModule?.retainedConfigFields ?? []);
    const imageRoleConfig = getQuestionTaskImageRoleConfig(normalizedTaskType);
    const imageIdsKeepRoles = imageRoleConfig
        ? new Set(imageRoleConfig.roles.map((role) => role.key))
        : undefined;
    const generatedImage = {
        enabled: normalizedTaskType !== 'none',
        type: normalizedTaskType,
    };
    for (const field of QUESTION_TASK_CONFIG_FIELDS) {
        if (!retainedConfigFields.has(field)) generatedImage[field] = null;
    }

    return { generatedImage, imageIdsKeepRoles };
}

async function handleQuestionOptionsModalSubmit(interaction, parts, state = {}) {
    const submission = await beginQuestionModalSubmission(interaction, parts, state);
    if (submission.failed) return undefined;
    const { responseMode, context } = submission;

    const effectiveChallenge = context.challenge;
    const effectiveQuestion = resolveQuestion(effectiveChallenge, context.question.id);

    let orderNumber;
    let separateStep;
    let selectedAnswerType;
    try {
        orderNumber = parseOrderSelect(getRequiredModalSingleSelect(interaction, 'order_number', getQuestionOrderSelectOptions(effectiveChallenge, context.question.id), 'order number'));
        separateStep = parseBooleanSelect(getRequiredModalSingleSelect(interaction, 'separate_step', BOOLEAN_SELECT_OPTIONS, 'Separate Step'));
        selectedAnswerType = getRequiredModalSingleSelect(interaction, 'answer_type', QUESTION_ANSWER_TYPE_OPTIONS, 'answer mode');
    }
    catch (err) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] });
    }

    const currentTaskType = getQuestionTaskType(effectiveQuestion);
    const selectedTaskType = getModalSingleSelectValue(interaction, 'task_type') ?? currentTaskType;
    if (!isQuestionTaskType(selectedTaskType)) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Unknown task type selected.')] });
    }
    const currentAnswerType = getQuestionAnswerType(effectiveQuestion);
    if (!QUESTION_ANSWER_TYPE_OPTIONS.some((option) => option.value === selectedAnswerType)) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Unknown answer mode selected.')] });
    }
    let edits;
    try {
        edits = resolveBaselineEdits(state.baseline, {
            order: {
                baselineKey: 'order_number',
                current: String(getQuestionNumber(effectiveChallenge, effectiveQuestion)),
                submitted: String(orderNumber),
            },
            separateStep: {
                baselineKey: 'separate_step',
                current: effectiveQuestion.separateStep === true ? 'true' : 'false',
                submitted: String(separateStep),
            },
            answerType: {
                baselineKey: 'answer_type',
                current: currentAnswerType,
                submitted: selectedAnswerType,
            },
            taskType: {
                baselineKey: 'task_type',
                current: currentTaskType,
                submitted: selectedTaskType,
            },
        });
    }
    catch (err) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] });
    }
    const taskChanged = edits.taskType.changed;
    const answerTypeChanged = edits.answerType.changed;
    // A stale form may deliberately preserve a field changed by another
    // administrator. All dependent validation must use that preserved value,
    // never the value selected when this modal opened.
    const effectiveTargetTaskType = taskChanged ? selectedTaskType : currentTaskType;
    const effectiveTargetAnswerType = answerTypeChanged ? selectedAnswerType : currentAnswerType;

    if (!isAnswerTypeSupportedByTask(effectiveTargetAnswerType, effectiveTargetTaskType)) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Position and Gallery Count answers require a gallery task. Choose Standard Gallery or Rotation Alignment first.')] });
    }

    if (!baselineEditsChanged(edits)) {
        return respondAdminNoChanges(interaction, responseMode);
    }

    const patches = !edits.order.changed
        ? {}
        : buildQuestionOrderPatchMap(effectiveChallenge, context.question.id, orderNumber);
    const selectedPatch = {
        ...(patches[context.question.id] ?? {}),
        ...(edits.separateStep.changed ? { separateStep } : {}),
    };
    if (taskChanged) {
        const taskPatch = buildTaskTypePatch(selectedTaskType);
        const currentImageIds = effectiveQuestion.generatedImage?.imageIds ?? {};
        if (taskPatch.imageIdsKeepRoles) {
            taskPatch.generatedImage.imageIds = Object.fromEntries(Object.entries(currentImageIds).filter(([role]) => taskPatch.imageIdsKeepRoles.has(role)));
            if (getQuestionTaskEditorCapabilities(selectedTaskType).directions) {
                const retainedImageIds = new Set(Object.values(taskPatch.generatedImage.imageIds).flat().map(String));
                const currentDirections = effectiveQuestion.generatedImage?.imageDirections ?? {};
                taskPatch.generatedImage.imageDirections = Object.fromEntries(
                    Object.entries(currentDirections).filter(([imageId]) => retainedImageIds.has(String(imageId))),
                );
            }
        }
        delete taskPatch.imageIdsKeepRoles;
        Object.assign(selectedPatch, taskPatch);
    }
    if (answerTypeChanged) {
        selectedPatch.answer = {
            ...(selectedPatch.answer ?? {}),
            required: selectedAnswerType !== 'none',
            type: selectedAnswerType,
        };
    }
    patches[context.question.id] = selectedPatch;

    const updatedSettings = await updateCatalogQuestionOptions(context.guildId, context.challengeId, patches, interaction.user.id, {
        expected: expectedCatalogQuestions(context, Object.keys(patches)),
        expectedOrder: edits.order.changed ? state.baseline?.question_order : undefined,
    });
    return replyWithCommittedQuestionPanel(interaction, context, updatedSettings, state);
}

async function handleQuestionClearModalSubmit(interaction, parts = [], state = {}) {
    const submission = await beginQuestionModalSubmission(interaction, parts, state);
    if (submission.failed) return undefined;
    const { responseMode, context } = submission;

    const effectiveChallenge = context.challenge;
    const effectiveQuestion = resolveQuestion(effectiveChallenge, context.question.id) ?? context.question;
    const questionChanges = context.questionChanges;
    if (state.baseline?.reset_revision && state.baseline.reset_revision !== buildQuestionResetRevision(questionChanges, effectiveQuestion)) {
        return respondAdminModalError(interaction, responseMode, {
            embeds: [userErrorEmbed('This question changed after the reset editor opened. Reopen it and confirm the current catalog fields before resetting.')],
        });
    }
    const definitions = getQuestionResetDefinitions(effectiveQuestion, questionChanges?.changes);
    const clearMap = Object.fromEntries(definitions.map((definition) => [definition.field, definition.paths]));

    let selectedField;
    try {
        selectedField = getRequiredModalSingleSelect(interaction, 'clear_field', getQuestionClearSelectOptions(definitions), 'catalog field to reset');
    }
    catch (err) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] });
    }

    const paths = clearMap[selectedField];
    if (!paths) return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('That clear action is no longer available for this question’s current Task/Answer.')] });

    const updatedSettings = await resetCatalogQuestionFieldsToTemplate(context.guildId, context.challengeId, context.question.id, paths, interaction.user.id, {
        expected: expectedCatalogQuestions(context, [context.question.id]),
    });
    return replyWithCommittedQuestionPanel(interaction, context, updatedSettings, state);
}

function showCreateQuestionModal(interaction, parts, state = {}) {
    const [mode, guildId, ownerUserId, challengeId] = parts;
    if (mode !== 'edit') return respondAdminError(interaction, { embeds: [userErrorEmbed('Questions can only be created from an editable challenge panel.')] });
    return interaction.showModal(buildAdminModal(
        state.panelSession.buildForm(
            'questionCreateModal',
            [mode, guildId, ownerUserId, challengeId],
            {},
            interaction.customId,
        ),
        'Create Question',
        buildModalTextLabel('question_id', 'Question ID', { placeholder: 'lowercase-kebab-case (max 100)', maxLength: 100, required: true }),
        buildModalTextLabel('question_label', 'Question Label', { maxLength: 128, required: true }),
        buildModalTextLabel('question_text', 'Question Text', { maxLength: 4000, required: true }),
        buildQuestionAnswerTypeSelectModalLabel('none', QUESTION_CREATE_ANSWER_TYPE_OPTIONS),
    ));
}

async function handleCreateQuestionModal(interaction, parts, state = {}) {
    const [mode, guildId, ownerUserId, challengeId] = parts;
    const responseMode = await acknowledgePanelInteraction(interaction, {
        sourceCustomId: state.sourceCustomId,
        panelSession: state.panelSession,
        formGeneration: state.formGeneration,
    });
    if (mode !== 'edit') return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Questions can only be created from an editable challenge panel.')] });
    let created;
    try {
        created = await createCustomQuestion(guildId, challengeId, {
            id: getModalTextInput(interaction, 'question_id'), label: getModalTextInput(interaction, 'question_label'),
            text: getModalTextInput(interaction, 'question_text'),
            answerType: getRequiredModalSingleSelect(interaction, 'answer_type', QUESTION_CREATE_ANSWER_TYPE_OPTIONS, 'answer mode'),
        }, interaction.user.id);
    }
    catch (err) { return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] }); }
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        committed: true,
        buildPayload: () => buildChallengeOverviewPanelPayload({
            enabledChallengeIds: created.snapshot.guildSettings.activeChallengeIds ?? [],
            mode,
            guildId,
            userId: ownerUserId,
            challengeId,
            challenge: created.snapshot.challengesById.get(String(challengeId)),
        }),
    });
}

module.exports = {
    handleCreateQuestionModal,
    handleQuestionClearModalSubmit,
    handleQuestionOptionsModalSubmit,
    handleQuestionPreviewButton,
    handleQuestionSelectMenu,
    showCreateQuestionModal,
    showQuestionClearSelectorModal,
    showQuestionOptionsModal,
};
