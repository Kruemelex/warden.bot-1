'use strict';

const Discord = require('discord.js');
const {
    buildModalStringSelectField,
    truncateSelectText,
} = require('../../../ux/components/modalFields');
const {
    buildQuestionScreens,
    getChallengeQuestions,
    getQuestionNumber,
    resolveQuestion,
} = require('../domain/challenges');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const {
    getUnknownVerificationImageIds,
    getVerificationImageInventory,
} = require('../assets/image-inventory');
const {
    DEFAULT_ROTATION_ALIGNMENT_DEGREES,
} = require('../domain/questionTasks/shared/degrees');
const {
    getQuestionTaskEditorCapabilities,
    getQuestionTaskImageRoleConfig,
    getQuestionTaskModuleByType,
    getQuestionTaskModules,
    getQuestionTaskResetGroups,
    getNormalizedQuestionTaskType: getQuestionTaskType,
    isGalleryQuestionTaskType,
    isQuestionTaskType,
    normalizeQuestionTaskType: normalizeTaskType,
} = require('../domain/questionTasks/taskRegistry');
const {
    getAnswerTypeDescriptor,
    getAnswerTypeDescriptors,
    getQuestionAnswerInputPresentation,
    getQuestionAnswerType,
    taskSupportsAnswerType,
} = require('../domain/answerTypes');
const {
    getGalleryPresentation,
    getGallerySize,
    getMaxControlImageRepeats,
    getMaxSolutionImageRepeats,
    getMaximumSolutionImageCount,
    getMinimumSolutionImageCount,
} = require('../domain/questionTasks/shared/gallery');
const {
    getRotationAlignmentConfig,
    getRotationAlignmentOffsets,
    getRotationClockPositionDegrees,
    getRotationGenerationDegrees,
    getRotationMaxPositionRepeats,
} = require('../domain/questionTasks/rotationAlignment');
const { evaluateChallengeConfigIssues } = require('../domain/validation');
const {
    ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
    isActiveChallengeLockedEditAction,
    isChallengeActive,
} = require('../domain/activeChallengePolicy');
const {
    buildAdminEditorSection,
    buildUpdatedAuditField,
    buildVerificationAdminPanel,
    formatJson,
    formatList,
} = require('./panel');

const QUESTION_LABEL_MAX_LENGTH = 128;
const QUESTION_TEXT_MAX_LENGTH = 4000;
const INTEGER_SELECT_OPTIONS = Object.freeze(Array.from(
    { length: VERIFICATION_UI_LIMITS.selectOptions },
    (_, index) => ({ label: String(index + 1), value: String(index + 1) }),
));
const GALLERY_PRESENTATION_OPTIONS = Object.freeze([
    { label: 'Composite Grid', value: 'composite', description: 'One labeled grid attachment; supports up to 25 images.' },
    { label: 'Individual Images', value: 'individual', description: 'Separate Discord attachments; supports up to 10 images.' },
]);

const QUESTION_TASK_TYPE_OPTIONS = Object.freeze(getQuestionTaskModules().map((taskModule) => Object.freeze({
    value: taskModule.type,
    label: taskModule.label,
    description: taskModule.description,
})));
const QUESTION_ANSWER_TYPE_OPTIONS = Object.freeze(getAnswerTypeDescriptors().map((descriptor) => Object.freeze({
    value: descriptor.type,
    label: descriptor.label,
    description: descriptor.description,
})));
const QUESTION_CREATE_ANSWER_TYPE_OPTIONS = Object.freeze(getAnswerTypeDescriptors({ availableOnCreate: true })
    .map((descriptor) => QUESTION_ANSWER_TYPE_OPTIONS.find((option) => option.value === descriptor.type)));

const BOOLEAN_SELECT_OPTIONS = [
    { label: 'True', value: 'true', description: 'Set to true.' },
    { label: 'False', value: 'false', description: 'Set to false.' },
];

function assertSelectOptionLimit(options, label) {
    const optionCount = Array.isArray(options) ? options.length : Number(options);
    if (optionCount > VERIFICATION_UI_LIMITS.selectOptions) {
        throw new Error(`${label} has ${optionCount} options, but Discord select menus support at most ${VERIFICATION_UI_LIMITS.selectOptions}. Reduce the configured entries.`);
    }
}

function getQuestionTaskTypeLabel(taskType) {
    return getQuestionTaskModuleByType(normalizeTaskType(taskType))?.label ?? 'None';
}

function isAnswerTypeSupportedByTask(answerType, taskType) {
    return taskSupportsAnswerType(
        getQuestionTaskModuleByType(normalizeTaskType(taskType)),
        answerType,
    );
}


function getRoleSpecificImageLimitLines(question, roleKey) {
    if (roleKey === 'solution') {
        return [
            `- **Minimum per gallery:** ${getMinimumSolutionImageCount(question)}`,
            `- **Maximum per gallery:** ${getMaximumSolutionImageCount(question)}`,
            `- **Maximum occurrences per image:** ${getMaxSolutionImageRepeats(question)}`,
        ];
    }
    if (roleKey === 'control') {
        const gallerySize = getGallerySize(question);
        return [
            `- **Minimum per gallery:** ${Math.max(0, gallerySize - getMaximumSolutionImageCount(question))}`,
            `- **Maximum per gallery:** ${Math.max(0, gallerySize - getMinimumSolutionImageCount(question))}`,
            `- **Maximum occurrences per image:** ${getMaxControlImageRepeats(question)}`,
        ];
    }
    return [];
}

function getAnswerInputLabel(question) {
    return getQuestionAnswerInputPresentation(question).label;
}

function getAnswerInputPlaceholder(question) {
    return getQuestionAnswerInputPresentation(question).placeholder;
}

function getAllowedRolesForQuestion(question) {
    return getQuestionTaskImageRoleConfig(getQuestionTaskType(question))?.roles.map((role) => role.key) ?? [];
}

function buildQuestionCatalogLines(challenge) {
    const questions = challenge?.questions ?? [];
    return questions.length > 0
        ? questions.map((question, index) => `${index + 1}. **${question.id}** — ${question.label ?? 'Question'} (${getQuestionTaskTypeLabel(getQuestionTaskType(question))})`)
        : ['None'];
}

function buildQuestionCatalogValue(challenge) {
    return buildQuestionCatalogLines(challenge).join('\n');
}

function buildQuestionViewResponse(challengeId, challenge, question, options = {}) {
    const { hideEditableFields = false, ...responseOptions } = options;
    const effectiveQuestion = question;
    const taskType = getQuestionTaskType(effectiveQuestion);
    const imageIds = effectiveQuestion.generatedImage?.imageIds ?? {};
    const imageDirections = effectiveQuestion.generatedImage?.imageDirections ?? {};
    const answers = effectiveQuestion.answer?.accepted ?? [];
    const configurationWarnings = new Set(evaluateChallengeConfigIssues(challenge)
        .filter((issue) => issue.questionId === question.id)
        .map((issue) => issue.field));
    const warningLabel = (label, field) => configurationWarnings.has(field) ? `⚠️ ${label}` : label;
    const fields = [
        { name: 'Challenge', value: challengeId, inline: true },
        { name: 'ID', value: question.id, inline: true },
    ];

    if (!hideEditableFields) {
        fields.push(
            { name: 'Order', value: String(getQuestionNumber(challenge, question)), inline: true },
            { name: 'Label', value: effectiveQuestion.label ?? 'Not set', inline: true },
            { name: 'Separate', value: String(effectiveQuestion.separateStep === true), inline: true },
            { name: 'Task', value: getQuestionTaskTypeLabel(taskType), inline: true },
            { name: 'Text', value: effectiveQuestion.text ?? 'Not set', inline: false },
        );

        if (taskUsesPromptText(taskType)) {
            fields.push({ name: warningLabel('Task prompt', 'generatedImage.text'), value: effectiveQuestion.generatedImage?.text ?? 'Not set', inline: false });
        }
        if (taskUsesImageIds(taskType)) {
            fields.push({ name: 'Images by role', value: formatJson(imageIds), inline: false });
        }
        if (taskUsesDirections(taskType)) fields.push({ name: 'Image directions', value: formatJson(imageDirections), inline: false });

        if (effectiveQuestion.answer?.required === true) {
            fields.push({ name: 'Answer type', value: getQuestionAnswerType(effectiveQuestion), inline: true });
            if (getAnswerTypeDescriptor(getQuestionAnswerType(effectiveQuestion))?.editableAcceptedAnswers) {
                fields.push({ name: warningLabel('Accepted answers', 'answer.accepted'), value: formatList(answers), inline: false });
            }
        }
        else fields.push({ name: 'Answer', value: 'Not required', inline: true });
    }
    fields.push(...buildUpdatedAuditField(question));

    return {
        title: `Verification Question: ${question.id}`,
        description: '',
        fields,
        ...responseOptions,
    };
}

function validateQuestionImageIds(question, role, imageIds) {
    const taskType = getQuestionTaskType(question);
    const allowedRoles = getAllowedRolesForQuestion(question);
    if (!allowedRoles.includes(role)) {
        return `Role **${role}** is not valid for ${getQuestionTaskTypeLabel(taskType)}. Use: ${allowedRoles.join(', ') || 'none'}.`;
    }

    const roleConfig = getQuestionTaskImageRoleConfig(taskType)?.roles.find((candidate) => candidate.key === role);
    if (roleConfig?.maxValues && imageIds.length > roleConfig.maxValues) {
        return `${roleConfig.label} accepts at most ${roleConfig.maxValues} image${roleConfig.maxValues === 1 ? '' : 's'}.`;
    }

    const unknownImageIds = getUnknownVerificationImageIds(imageIds, getVerificationImageInventory());
    if (unknownImageIds.length > 0) {
        return `Configured image file${unknownImageIds.length === 1 ? ' is' : 's are'} unavailable in /home/container/verificationImages: ${unknownImageIds.join(', ')}.`;
    }

    return undefined;
}

function validatePendingQuestionImageIds(question, role, imageIds) {
    const validationError = validateQuestionImageIds(question, role, imageIds);
    if (validationError) return validationError;

    const pendingImageIds = {
        ...(question.generatedImage?.imageIds ?? {}),
        [role]: imageIds,
    };

    const taskModule = getQuestionTaskModuleByType(getQuestionTaskType(question));
    return taskModule?.validatePendingImageIds?.(question, pendingImageIds);
}

function getChallengeAuditIssues(challenge, enabledChallengeIds) {
    return [...new Set(evaluateChallengeConfigIssues(challenge, enabledChallengeIds)
        .map((issue) => issue.message ?? issue.label)
        .filter(Boolean))];
}

function buildChallengeAuditFields(challenge, enabledChallengeIds) {
    const effectiveChallenge = challenge;
    const screens = buildQuestionScreens(effectiveChallenge);
    const issues = getChallengeAuditIssues(challenge, enabledChallengeIds);

    return [
        { name: 'Status', value: enabledChallengeIds.includes(challenge.id) ? 'Active/enabled' : 'Not active', inline: true },
        { name: 'Screens', value: String(screens.length), inline: true },
        { name: 'Issues', value: formatList(issues, 'No issues found').slice(0, 1024), inline: false },
    ];
}

function assertQuestionSelectMenuLimit(challenge) {
    const questions = getChallengeQuestions(challenge);
    if (questions.length > VERIFICATION_UI_LIMITS.selectOptions) {
        throw new Error(`This challenge has ${questions.length} questions, but Verification Admin supports at most ${VERIFICATION_UI_LIMITS.selectOptions}.`);
    }
}

function buildQuestionSelectRow(mode, guildId, ownerUserId, challengeId, challenge, selectedQuestionId, panelSession) {
    const questions = getChallengeQuestions(challenge);
    assertQuestionSelectMenuLimit(challenge);

    const selectMenu = new Discord.StringSelectMenuBuilder()
        .setCustomId(panelSession.build('questionSelect', mode, guildId, ownerUserId, challengeId))
        .setPlaceholder('Choose a question...')
        .addOptions(questions.map((question, index) => {
            if (String(question.id ?? '').length > 100) {
                throw new Error(`Question ID is too long for a select-menu value: ${question.id}`);
            }
            const labelBase = `${index + 1}. ${question.label || question.id}`;
            const option = new Discord.StringSelectMenuOptionBuilder()
                .setLabel(truncateSelectText(labelBase))
                .setValue(String(question.id))
                .setDescription(truncateSelectText(question.id || getQuestionTaskTypeLabel(getQuestionTaskType(question)) || 'Question'));
            if (selectedQuestionId && String(question.id) === String(selectedQuestionId)) option.setDefault(true);
            return option;
        }));

    return new Discord.ActionRowBuilder().addComponents(selectMenu);
}

function buildQuestionSelectionComponents(mode, guildId, ownerUserId, challengeId, challenge, selectedQuestionId, panelSession) {
    const questionCount = getChallengeQuestions(challenge).length;
    return questionCount > 0 && questionCount <= VERIFICATION_UI_LIMITS.selectOptions
        ? [buildQuestionSelectRow(mode, guildId, ownerUserId, challengeId, challenge, selectedQuestionId, panelSession)]
        : [];
}

function buildQuestionManagementSections(mode, guildId, ownerUserId, challengeId, challenge, panelSession, challengeActive = false) {
    if (mode !== 'edit') return [];
    const questionLimitReached = getChallengeQuestions(challenge).length >= VERIFICATION_UI_LIMITS.selectOptions;
    const createButton = new Discord.ButtonBuilder()
        .setCustomId(panelSession.build('questionCreate', mode, guildId, ownerUserId, challengeId))
        .setLabel(questionLimitReached ? 'Question Limit Reached' : 'Create Question')
        .setStyle(Discord.ButtonStyle.Success)
        .setDisabled(questionLimitReached || challengeActive);
    return [buildAdminEditorSection('Available Questions', buildQuestionCatalogLines(challenge), createButton)];
}

function buildQuestionSelectionPrompt(challenge) {
    const questionCount = getChallengeQuestions(challenge).length;
    if (questionCount > VERIFICATION_UI_LIMITS.selectOptions) {
        return `### Question selection unavailable\nThis challenge has ${questionCount} questions, but Verification Admin supports at most ${VERIFICATION_UI_LIMITS.selectOptions}.`;
    }
    if (questionCount < 1) return '### Select to continue\nCreate a question to open its interactive question editor.';
    return '### Select to continue\nChoose a question from the list above to open its interactive question editor.';
}

function buildQuestionEditorNavigation(mode, guildId, userId, challengeId, questionId, panelSession) {
    if (!challengeId) return [];

    return [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId(panelSession.build('challengeOverview', mode, guildId, userId, challengeId))
            .setLabel('Back')
            .setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder()
            .setCustomId(panelSession.build('questionPreview', guildId, userId, challengeId, questionId))
            .setLabel('Preview')
            .setStyle(Discord.ButtonStyle.Primary),
    )];
}

function buildQuestionEditorPayload({
    mode, guildId, ownerUserId, challengeId, challenge, question, catalogQuestion, questionChanges,
    enabledChallengeIds = [],
}) {
    return buildVerificationAdminPanel({
        guildId,
        ownerUserId,
        key: `question:${guildId}:${challengeId}:${question.id}`,
        state: {
            panelViewModel: Object.freeze({
                mode, challenge, question, catalogQuestion, questionChanges, enabledChallengeIds,
            }),
        },
        compose: (panelSession) => {
            const challengeActive = isChallengeActive(enabledChallengeIds, challengeId);
            const editor = mode === 'edit'
                ? buildQuestionEditPanelComponents(
                    guildId,
                    ownerUserId,
                    challengeId,
                    challenge,
                    question.id,
                    question,
                    panelSession,
                    challengeActive,
                )
                : undefined;
            const panel = buildQuestionViewResponse(
                challengeId,
                challenge,
                question,
                {
                    navigationActions: buildQuestionEditorNavigation(
                        mode,
                        guildId,
                        ownerUserId,
                        challengeId,
                        question.id,
                        panelSession,
                    ),
                    sections: editor?.sections ?? [],
                    hideEditableFields: Boolean(editor),
                },
            );
            return panel;
        },
    });
}

function buildQuestionEditPanelComponents(
    guildId, userId, challengeId, challenge, questionId, effectiveQuestion, panelSession, challengeActive = false,
) {
    const button = (action, label, style = Discord.ButtonStyle.Secondary, ...extraParts) => new Discord.ButtonBuilder()
        .setCustomId(panelSession.build(action, guildId, userId, challengeId, questionId, ...extraParts))
        .setLabel(label)
        .setStyle(style)
        .setDisabled(challengeActive && isActiveChallengeLockedEditAction(action));

    const taskType = getQuestionTaskType(effectiveQuestion);
    const taskCapabilities = getQuestionTaskEditorCapabilities(taskType);
    const answerType = effectiveQuestion.answer?.type;
    const answerDescriptor = getAnswerTypeDescriptor(answerType);
    const configurationWarnings = new Set(evaluateChallengeConfigIssues(challenge)
        .filter((issue) => issue.questionId === questionId)
        .map((issue) => issue.field));
    const warningTitle = (title, ...fields) => fields.some((field) => [...configurationWarnings]
        .some((warning) => warning === field || warning?.startsWith(`${field}.`))) ? `⚠️ ${title}` : title;
    const section = (title, value, action, ...extraParts) => buildAdminEditorSection(
        title,
        value,
        button(action, 'Edit', Discord.ButtonStyle.Secondary, ...extraParts),
    );
    const destructiveAction = effectiveQuestion.protectedTemplate === true
        ? button('questionClearSelector', 'Reset to Template', Discord.ButtonStyle.Danger)
        : new Discord.ButtonBuilder()
            .setCustomId(panelSession.build('questionDelete', 'edit', guildId, userId, challengeId, questionId))
            .setLabel('Delete Question')
            .setStyle(Discord.ButtonStyle.Danger)
            .setDisabled(challengeActive);
    const sections = [
        ...(challengeActive ? [buildAdminEditorSection(undefined, ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE)] : []),
        buildAdminEditorSection(undefined, `Question **${questionId}** for challenge **${challengeId}**.`, destructiveAction),
        section(warningTitle('Question options', 'generatedImage.type', 'answer'), [
            `- **Order:** ${getQuestionNumber(challenge, effectiveQuestion)}`,
            `- **Task:** ${getQuestionTaskTypeLabel(taskType)}`,
            `- **Answer:** ${effectiveQuestion.answer?.required === true ? getQuestionAnswerType(effectiveQuestion) : 'Not required'}`,
            `- **Separate step:** ${effectiveQuestion.separateStep === true ? 'Yes' : 'No'}`,
        ].filter(Boolean), 'questionEditOptions'),
        section('Question label & text', [
            `- **Label:** ${effectiveQuestion.label ?? 'Not set'}`,
            `- **Text:** ${effectiveQuestion.text ?? 'Not set'}`,
        ], 'questionEditText'),
    ];

    if (taskUsesPromptText(taskType)) sections.push(section(warningTitle('Task prompt', 'generatedImage.text'), `- **Prompt:** ${effectiveQuestion.generatedImage?.text ?? 'Not set'}`, 'questionEditImageText', taskType));
    if (effectiveQuestion.answer?.required === true && answerDescriptor?.editableAcceptedAnswers) {
        sections.push(section(warningTitle('Accepted answers', 'answer.accepted'), formatList(effectiveQuestion.answer?.accepted), 'questionEditAnswers', answerType));
    }
    if (effectiveQuestion.answer?.required === true && answerDescriptor?.editablePrompt) {
        sections.push(section(warningTitle('Answer prompt', 'answer.inputLabel', 'answer.inputPlaceholder'), [
            `- **Label:** ${getAnswerInputLabel(effectiveQuestion)}`,
            `- **Placeholder:** ${getAnswerInputPlaceholder(effectiveQuestion)}`,
        ], 'questionEditAnswerPrompt', answerType));
    }
    if (isGalleryQuestionTaskType(taskType)) {
        const roleSpecificLimits = taskCapabilities.roleSpecificGalleryLimits === true;
        sections.push(section(warningTitle(roleSpecificLimits ? 'Gallery layout' : 'Gallery limits',
            'generatedImage.gallerySize',
            ...(!roleSpecificLimits ? ['generatedImage.solutionImageCount'] : [])), [
            `- **Presentation:** ${getGalleryPresentation(effectiveQuestion) === 'composite' ? 'Composite grid' : 'Individual images'}`,
            `- **Gallery size:** ${getGallerySize(effectiveQuestion)} total images`,
            ...(!roleSpecificLimits ? [
                `- **Minimum solution images:** ${getMinimumSolutionImageCount(effectiveQuestion)}`,
                `- **Maximum solution images:** ${getMaximumSolutionImageCount(effectiveQuestion)}`,
            ] : []),
        ], 'questionEditGalleryLimits'));
    }
    if (taskUsesDirections(taskType)) {
        const offsets = getRotationAlignmentOffsets(effectiveQuestion);
        sections.push(section(warningTitle('Rotation settings',
            'generatedImage.rotationAlignment.clockPositionDegrees',
            'generatedImage.rotationAlignment.rotationDegrees',
            'generatedImage.rotationAlignment.maxImageOrientationRepeats',
            'generatedImage.rotationAlignment.alignmentRule'), [
            `- **Clock positions:** ${getRotationClockPositionDegrees(effectiveQuestion).map((degrees) => `${degrees}°`).join(', ')}`,
            `- **Generated rotations:** ${getRotationGenerationDegrees(effectiveQuestion).map((degrees) => `${degrees}°`).join(', ')}`,
            `- **Maximum position repetitions:** ${getRotationMaxPositionRepeats(effectiveQuestion)}`,
            `- **Target offsets:** Center ${offsets.center}° • Outer ${offsets.outer}°`,
        ], 'questionEditRotationSettings', taskType));
    }
    if (taskUsesImageIds(taskType)) {
        for (const role of getQuestionTaskImageRoleConfig(taskType).roles) {
            const roleLimitFields = taskCapabilities.roleSpecificGalleryLimits
                ? role.key === 'solution'
                    ? ['generatedImage.solutionImageCount', 'generatedImage.maxSolutionImageRepeats']
                    : role.key === 'control'
                        ? ['generatedImage.maxControlImageRepeats']
                        : []
                : [];
            const selectedImageIds = effectiveQuestion.generatedImage?.imageIds?.[role.key] ?? [];
            const limitLines = taskCapabilities.roleSpecificGalleryLimits
                ? getRoleSpecificImageLimitLines(effectiveQuestion, role.key)
                : [];
            sections.push(section(
                warningTitle(role.label, `generatedImage.imageIds.${role.key}`, ...roleLimitFields),
                [
                    ...limitLines,
                    ...(limitLines.length > 0 ? [''] : []),
                    ...(selectedImageIds.length > 0
                        ? selectedImageIds.map((imageId) => `- ${imageId}`)
                        : ['None selected']),
                ],
                'questionImagesOpen',
                role.key,
            ));
        }
    }
    if (taskUsesDirections(taskType)) {
        sections.push(section(warningTitle('Image directions', 'generatedImage.imageDirections'), `- **Configured directions:**\n${formatJson(effectiveQuestion.generatedImage?.imageDirections)}`, 'questionEditDirections', taskType));
    }

    return { sections, actions: [] };
}

function hasOwnValue(object, key) {
    return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function getQuestionResetDefinitions(effectiveQuestion, catalogChanges = {}) {
    const definitions = [];
    const add = (field, label, paths) => definitions.push({ field, label, paths: Array.isArray(paths) ? paths : [paths] });
    const generatedImageChanges = catalogChanges.generatedImage ?? {};
    const answerChanges = catalogChanges.answer ?? {};
    const taskType = getQuestionTaskType(effectiveQuestion);
    const taskCapabilities = getQuestionTaskEditorCapabilities(taskType);

    if (hasOwnValue(catalogChanges, 'order')) add('order', 'Reset Order', 'order');
    if (hasOwnValue(catalogChanges, 'separateStep')) add('separate-step', 'Reset Separate Step', 'separateStep');
    if (hasOwnValue(catalogChanges, 'label')) add('label', 'Reset Label', 'label');
    if (hasOwnValue(catalogChanges, 'text')) add('text', 'Reset Text', 'text');
    if (Object.keys(generatedImageChanges).length > 0) add('task', 'Reset Task Fields', 'generatedImage');
    for (const resetGroup of getQuestionTaskResetGroups(taskType)) {
        if (resetGroup.changedFields.some((field) => hasOwnValue(generatedImageChanges, field))) {
            add(resetGroup.field, resetGroup.label, resetGroup.paths);
        }
    }
    if (taskCapabilities.imageIds && hasOwnValue(generatedImageChanges, 'imageIds')) add('image-ids', 'Reset Images', 'generatedImage.imageIds');
    if (hasOwnValue(answerChanges, 'required') || hasOwnValue(answerChanges, 'type')) add('answer-mode', 'Reset Answer Mode', ['answer.required', 'answer.type', 'answer.inputLabel', 'answer.inputPlaceholder', 'answer.accepted']);
    const answerDescriptor = getAnswerTypeDescriptor(effectiveQuestion.answer?.type);
    if (answerDescriptor?.editableAcceptedAnswers && hasOwnValue(answerChanges, 'accepted')) {
        add('answers', 'Reset Answers', 'answer.accepted');
    }
    if (answerDescriptor?.editablePrompt && (hasOwnValue(answerChanges, 'inputLabel') || hasOwnValue(answerChanges, 'inputPlaceholder'))) {
        add('answer-prompt', 'Reset Answer Prompt', ['answer.inputLabel', 'answer.inputPlaceholder']);
    }

    if (definitions.length >= 2) {
        definitions.push({ field: 'all-visible', label: 'Reset All Visible Fields', paths: [...new Set(definitions.flatMap((definition) => definition.paths))] });
    }
    return definitions;
}

function buildQuestionResetRevision(questionChanges = {}, question = {}) {
    return JSON.stringify({
        updatedAt: questionChanges.updatedAt ?? question.updatedAt ?? null,
        updatedBy: questionChanges.updatedBy ?? question.updatedBy ?? null,
        changes: questionChanges.changes ?? {},
    });
}

function getQuestionClearSelectOptions(definitions) {
    return definitions.map((definition) => ({
        label: definition.label,
        value: definition.field,
        description: definition.paths.length === 1 ? definition.paths[0] : `${definition.paths.length} catalog fields`,
    }));
}

function getQuestionOrderSelectOptions(effectiveChallenge, selectedQuestionId) {
    const questions = getChallengeQuestions(effectiveChallenge);
    const orderOptions = questions.map((question, index) => ({
        label: String(index + 1),
        value: String(index + 1),
        description: question.id === selectedQuestionId
            ? `Current position: ${question.id}`
            : question.id,
    }));

    return orderOptions;
}

function buildQuestionOrderSelectField(effectiveChallenge, selectedQuestionId) {
    const options = getQuestionOrderSelectOptions(effectiveChallenge, selectedQuestionId);
    assertSelectOptionLimit(options, 'Question order options');
    const currentOrderValue = String(getChallengeQuestions(effectiveChallenge).findIndex((question) => question.id === selectedQuestionId) + 1);

    return buildModalStringSelectField({
        label: 'Order Number',
        description: 'Current order is preselected. Change it only to reorder this question.',
        customId: 'order_number',
        placeholder: 'Choose order number...',
        options,
        selectedValues: [currentOrderValue],
        minValues: 1,
        maxValues: 1,
        required: true,
    });
}

function buildBooleanSelectField(customId, label, currentValue) {
    return buildModalStringSelectField({
        label,
        description: `Current value is preselected: ${currentValue === true ? 'true' : 'false'}.`,
        customId,
        placeholder: `Choose ${label.toLowerCase()}...`,
        options: BOOLEAN_SELECT_OPTIONS,
        selectedValues: [currentValue === true ? 'true' : 'false'],
        minValues: 1,
        maxValues: 1,
        required: true,
    });
}

function buildDirectionDegreeOptions() {
    return DEFAULT_ROTATION_ALIGNMENT_DEGREES.map((degrees) => ({
        label: `${degrees}°`,
        value: String(degrees),
        description: `${degrees} degree orientation`,
    }));
}

function getQuestionDirectionImageIds(question) {
    const imageIds = question?.generatedImage?.imageIds ?? {};
    return [...new Set([...(imageIds.center ?? []), ...(imageIds.outer ?? [])].map(String))];
}

function buildImageDirectionImageSelectField(imageIds) {
    const options = imageIds.map((imageId, index) => ({
        label: imageId,
        value: `image-${index}`,
        description: 'Configured Rotation Alignment image',
    }));
    assertSelectOptionLimit(options, 'Configured Rotation Alignment images');

    return buildModalStringSelectField({
        label: 'Images',
        description: 'Choose one or multiple images.',
        customId: 'direction_image_ids',
        placeholder: 'Choose configured images...',
        options,
        selectedValues: [],
        minValues: 1,
        maxValues: Math.max(1, options.length),
        required: true,
    });
}

function buildDirectionDegreesSelectField() {
    const options = buildDirectionDegreeOptions();

    return buildModalStringSelectField({
        label: 'Direction / Orientation',
        description: 'Select from degree steps on a compass.',
        customId: 'direction_degrees',
        placeholder: 'Choose directions...',
        options,
        selectedValues: [],
        minValues: 1,
        maxValues: options.length,
        required: true,
    });
}

function getIntegerSelectOptions(maximum = VERIFICATION_UI_LIMITS.selectOptions) {
    const limit = Math.max(1, Math.min(VERIFICATION_UI_LIMITS.selectOptions, Math.floor(Number(maximum)) || 1));
    return INTEGER_SELECT_OPTIONS.slice(0, limit);
}

function buildIntegerSelectField(customId, label, currentValue, description, maximum) {
    const options = getIntegerSelectOptions(maximum);
    return buildModalStringSelectField({
        label,
        description,
        customId,
        placeholder: `Choose ${label.toLowerCase()}...`,
        options,
        selectedValues: [String(currentValue)],
        minValues: 1,
        maxValues: 1,
        required: true,
    });
}

function buildDegreeSelectField(customId, label, selectedValues, description, multiple = false) {
    const options = buildDirectionDegreeOptions();
    return buildModalStringSelectField({
        label,
        description,
        customId,
        placeholder: `Choose ${label.toLowerCase()}...`,
        options,
        selectedValues: [].concat(selectedValues).map(String),
        minValues: 1,
        maxValues: multiple ? options.length : 1,
        required: true,
    });
}

function taskUsesPromptText(taskType) {
    return getQuestionTaskEditorCapabilities(taskType).promptText === true;
}

function taskUsesImageIds(taskType) {
    return getQuestionTaskEditorCapabilities(taskType).imageIds === true;
}

function taskUsesDirections(taskType) {
    return getQuestionTaskEditorCapabilities(taskType).directions === true;
}

function buildQuestionTaskSelectModalLabel(currentTaskType) {
    const taskType = normalizeTaskType(currentTaskType);
    return buildModalStringSelectField({
        label: 'Task',
        description: 'Current task is preselected. Change only if needed.',
        customId: 'task_type',
        placeholder: `Task: ${getQuestionTaskTypeLabel(taskType)}`,
        options: QUESTION_TASK_TYPE_OPTIONS,
        selectedValues: [taskType],
        minValues: 1,
        maxValues: 1,
        required: true,
    });
}

function buildQuestionAnswerTypeSelectModalLabel(currentAnswerType, options = QUESTION_ANSWER_TYPE_OPTIONS) {
    const normalizedAnswerType = options.some((option) => option.value === currentAnswerType)
        ? currentAnswerType
        : 'none';
    return buildModalStringSelectField({
        label: 'Answer Mode',
        description: options === QUESTION_CREATE_ANSWER_TYPE_OPTIONS ? 'Gallery tasks can enable position or count answers later.' : 'Position and Gallery Count answers require a gallery task.',
        customId: 'answer_type',
        placeholder: `Answer: ${QUESTION_ANSWER_TYPE_OPTIONS.find((option) => option.value === normalizedAnswerType)?.label ?? 'No Answer'}`,
        options,
        selectedValues: [normalizedAnswerType],
        minValues: 1,
        maxValues: 1,
        required: true,
    });
}

module.exports = {
    BOOLEAN_SELECT_OPTIONS,
    GALLERY_PRESENTATION_OPTIONS,
    QUESTION_ANSWER_TYPE_OPTIONS,
    QUESTION_CREATE_ANSWER_TYPE_OPTIONS,
    QUESTION_LABEL_MAX_LENGTH,
    QUESTION_TEXT_MAX_LENGTH,
    buildBooleanSelectField,
    buildDirectionDegreesSelectField,
    buildDegreeSelectField,
    buildIntegerSelectField,
    buildImageDirectionImageSelectField,
    buildQuestionAnswerTypeSelectModalLabel,
    buildQuestionCatalogValue,
    buildQuestionEditorPayload,
    buildQuestionManagementSections,
    buildQuestionOrderSelectField,
    buildQuestionResetRevision,
    buildQuestionSelectionComponents,
    buildQuestionSelectionPrompt,
    buildQuestionTaskSelectModalLabel,
    buildChallengeAuditFields,
    getQuestionOrderSelectOptions,
    getQuestionClearSelectOptions,
    getQuestionDirectionImageIds,
    getIntegerSelectOptions,
    getQuestionResetDefinitions,
    getAnswerInputLabel,
    getAnswerInputPlaceholder,
    isAnswerTypeSupportedByTask,
    validatePendingQuestionImageIds,
};
