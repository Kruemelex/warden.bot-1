const Discord = require('discord.js');
const { createDescriptorModalEditor } = require('../../ux/interactions/editor');
const {
    buildExistingTextField,
    buildModal: buildAdminModal,
    getModalTextInput,
} = require('../../ux/components/modalFields');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const { PROMPT_TEXT_MAX_LENGTH } = require('../domain/questionTasks/promptText');
const { getQuestionTaskEditorCapabilities } = require('../domain/questionTasks/taskRegistry');
const { getAnswerTypeDescriptor } = require('../domain/answerTypes');
const { updateCatalogQuestionAnswers, updateCatalogQuestionFields, updateCatalogQuestionOptions, updateCatalogQuestionPrompt } = require('../service');
const { parseAnswerOverrideList, resolveBaselineAnswersEdit, resolveBaselineEdit } = require('./edits');
const { respondAdminModalError, respondAdminNoChanges, userErrorEmbed } = require('./feedback');
const { getNormalizedQuestionTaskType: getQuestionTaskType } = require('../domain/questionTasks/taskRegistry');
const {
    QUESTION_LABEL_MAX_LENGTH,
    QUESTION_TEXT_MAX_LENGTH,
    getAnswerInputLabel,
    getAnswerInputPlaceholder,
} = require('./questionPanel');
const {
    beginQuestionModalSubmission,
    expectedCatalogQuestions,
    replyWithCommittedQuestionPanel,
    validateQuestionPanelInteraction,
} = require('./questionContext');

const field = (customId, label, currentValue, options = {}) => ({ customId, label, currentValue, ...options });
const expectedQuestion = (context) => ({ expected: expectedCatalogQuestions(context, [context.question.id]) });
const answerSupports = (question, capability) =>
    question.answer?.required === true
    && getAnswerTypeDescriptor(question.answer?.type)?.[capability] === true;

function writeQuestionText({ context, edits, userId }) {
    return updateCatalogQuestionFields(context.guildId, context.challengeId, context.question.id, {
        ...(edits.label.changed ? { label: edits.label.value } : {}),
        ...(edits.text.changed ? { text: edits.text.value } : {}),
    }, userId, expectedQuestion(context));
}

const writePromptImageText = ({ context, edits, userId }) => updateCatalogQuestionPrompt(
    context.guildId, context.challengeId, context.question.id, edits.image_text.value, userId, expectedQuestion(context),
);

function writeAnswerPrompt({ context, edits, userId }) {
    return updateCatalogQuestionOptions(context.guildId, context.challengeId, {
        [context.question.id]: {
            answer: {
                ...(edits.answer_input_label.changed ? { inputLabel: edits.answer_input_label.value } : {}),
                ...(edits.answer_input_placeholder.changed ? { inputPlaceholder: edits.answer_input_placeholder.value } : {}),
            },
        },
    }, userId, expectedQuestion(context));
}

const writeAcceptedAnswers = ({ context, edits, userId }) => updateCatalogQuestionAnswers(
    context.guildId, context.challengeId, context.question.id, edits.answers.value, userId, expectedQuestion(context),
);

/* The table is intentionally limited to simple text editors; complex select/cross-field editors stay bespoke. */
const QUESTION_FIELD_EDITOR_DESCRIPTORS = Object.freeze({
    text: {
        modalAction: 'questionTextModal', title: 'Edit Question Text',
        fields: [
            field('label', 'Label', (question) => question.label ?? '', { maxLength: QUESTION_LABEL_MAX_LENGTH }),
            field('text', 'Question Text', (question) => question.text ?? '', { style: Discord.TextInputStyle.Paragraph, maxLength: QUESTION_TEXT_MAX_LENGTH }),
        ],
        validate: ({ label, text }) => !label || !text
            ? 'Question label and text cannot be blank. Use the explicit reset action when applicable.' : undefined,
        resolveEdits: resolveScalarEdits,
        write: writeQuestionText,
    },
    imageText: {
        modalAction: 'questionImageTextModal', title: 'Edit Prompt Image Text',
        showAvailable: ({ question, parts }) => getQuestionTaskEditorCapabilities(parts[4] ?? getQuestionTaskType(question)).promptText
            ? undefined : 'This question does not use prompt image text.',
        submitAvailable: (question) => getQuestionTaskEditorCapabilities(getQuestionTaskType(question)).promptText
            ? undefined : 'This question does not use prompt image text.',
        fields: [field('image_text', 'Prompt Image Text', (question) => question.generatedImage?.text ?? '', {
            style: Discord.TextInputStyle.Paragraph, maxLength: PROMPT_TEXT_MAX_LENGTH,
        })],
        validate: ({ image_text: imageText }) => {
            if (!imageText) return 'Prompt image text cannot be blank. Use the explicit reset action when applicable.';
            return imageText.length > PROMPT_TEXT_MAX_LENGTH ? `Prompt image text cannot exceed ${PROMPT_TEXT_MAX_LENGTH} characters.` : undefined;
        },
        resolveEdits: resolveScalarEdits,
        write: writePromptImageText,
    },
    answerPrompt: {
        modalAction: 'questionAnswerPromptModal', title: 'Edit Answer Prompt',
        showAvailable: ({ question }) => answerSupports(question, 'editablePrompt')
            ? undefined : 'This question does not use an editable answer prompt.',
        submitAvailable: (question) => answerSupports(question, 'editablePrompt')
            ? undefined : 'This question no longer uses an editable answer prompt.',
        fields: [
            field('answer_input_label', 'Input Label', getAnswerInputLabel, {
                baseline: (question) => question.answer?.inputLabel ?? '', current: (question) => question.answer?.inputLabel ?? '',
                maxLength: VERIFICATION_UI_LIMITS.modalLabelLength, required: true, description: 'Label shown above the answer input.',
            }),
            field('answer_input_placeholder', 'Input Placeholder', getAnswerInputPlaceholder, {
                baseline: (question) => question.answer?.inputPlaceholder ?? '', current: (question) => question.answer?.inputPlaceholder ?? '',
                maxLength: VERIFICATION_UI_LIMITS.textInputPlaceholderLength, required: true, description: 'Hint displayed inside the answer input.',
            }),
        ],
        validate: ({ answer_input_label: label, answer_input_placeholder: placeholder }) => !label || !placeholder
            ? 'The answer input label and placeholder cannot be blank.' : undefined,
        resolveEdits: resolveScalarEdits,
        write: writeAnswerPrompt,
    },
    answers: {
        modalAction: 'questionAnswersModal', title: 'Edit Accepted Answers',
        showAvailable: ({ question, parts }) => getAnswerTypeDescriptor(parts[4] ?? question.answer?.type)?.editableAcceptedAnswers
            ? undefined : 'This question does not use editable text answers.',
        submitAvailable: (question) => answerSupports(question, 'editableAcceptedAnswers')
            ? undefined : 'This question does not use editable text answers.',
        fields: [field('answers', 'Accepted Answers', (question) => (question.answer?.accepted ?? []).join('\n'), {
            style: Discord.TextInputStyle.Paragraph, description: 'Comma or newline separated accepted answers.', maxLength: QUESTION_TEXT_MAX_LENGTH,
            parse: parseAnswerOverrideList,
        })],
        validate: ({ answers }) => answers.length < 1 ? 'Please provide at least one accepted answer.' : undefined,
        resolveEdits: ({ baseline, question, values }) => ({
            answers: resolveBaselineAnswersEdit(baseline, question.answer?.accepted, values.answers),
        }),
        write: writeAcceptedAnswers,
    },
});

function buildEditorFields(descriptor, question) {
    return descriptor.fields.map(({ customId, label, currentValue, baseline: _baseline, current: _current, parse: _parse, ...options }) =>
        buildExistingTextField({ customId, label, currentValue: currentValue(question), ...options }));
}

function captureBaseline(descriptor, question) {
    return Object.fromEntries(descriptor.fields.map((definition) => [
        definition.customId, (definition.baseline ?? definition.currentValue)(question),
    ]));
}

function readValues(descriptor, interaction) {
    return Object.fromEntries(descriptor.fields.map((definition) => {
        const value = getModalTextInput(interaction, definition.customId);
        return [definition.customId, definition.parse ? definition.parse(value) : value];
    }));
}

function resolveScalarEdits({ descriptor, baseline, question, values }) {
    return Object.fromEntries(descriptor.fields.map((definition) => [
        definition.customId,
        resolveBaselineEdit(
            definition.customId,
            baseline,
            (definition.current ?? definition.baseline ?? definition.currentValue)(question),
            values[definition.customId],
        ),
    ]));
}

const DESCRIPTOR_MODAL_EDITORS = Object.freeze(Object.fromEntries(
    Object.entries(QUESTION_FIELD_EDITOR_DESCRIPTORS).map(([name, descriptor]) => [name, {
        action: descriptor.modalAction,
        title: descriptor.title,
        available: ({ phase, object: question, parts }) => phase === 'open'
            ? descriptor.showAvailable?.({ question, parts })
            : descriptor.submitAvailable?.(question),
        build: ({ object: question }) => ({
            baseline: captureBaseline(descriptor, question),
            fields: buildEditorFields(descriptor, question),
        }),
        read: ({ interaction }) => readValues(descriptor, interaction),
        validateValues: ({ values, object: question }) => descriptor.validate?.(values, question),
        resolve: ({ state, object: question, values }) => descriptor.resolveEdits({
            descriptor,
            baseline: state.baseline,
            question,
            values,
        }),
        commit: ({ context, edits, actorId }) => descriptor.write({
            context,
            edits,
            userId: actorId,
        }),
    }]),
));

const questionFieldModalEditor = createDescriptorModalEditor({
    descriptors: DESCRIPTOR_MODAL_EDITORS,
    loadOpenContext: ({ interaction, parts, state }) =>
        validateQuestionPanelInteraction(interaction, parts, state),
    beginSubmission: ({ interaction, parts, state }) => beginQuestionModalSubmission(interaction, parts, state),
    getObject: (context) => context.question,
    getModalParts: ({ context }) => [
        context.guildId,
        context.ownerUserId,
        context.challengeId,
        context.question.id,
    ],
    buildCustomId: ({ action, modalParts, baseline, state, interaction }) =>
        state.panelSession.buildForm(action, modalParts, baseline, interaction.customId),
    buildModal: ({ customId, title, fields }) => buildAdminModal(customId, title, ...fields),
    respondError: ({ interaction, acknowledgement, message }) =>
        respondAdminModalError(interaction, acknowledgement, { embeds: [userErrorEmbed(message)] }),
    respondNoChanges: ({ interaction, acknowledgement }) =>
        respondAdminNoChanges(interaction, acknowledgement),
    complete: ({ interaction, context, result, state }) =>
        replyWithCommittedQuestionPanel(
            interaction,
            context,
            result,
            state,
        ),
});

const openQuestionField = (name) => (interaction, parts, state) =>
    questionFieldModalEditor.open(name, interaction, parts, state);
const submitQuestionField = (name) => (interaction, parts, state) =>
    questionFieldModalEditor.submit(name, interaction, parts, state);
const showQuestionTextModal = openQuestionField('text');
const showQuestionImageTextModal = openQuestionField('imageText');
const showQuestionAnswerPromptModal = openQuestionField('answerPrompt');
const showQuestionAnswersModal = openQuestionField('answers');
const handleQuestionTextModalSubmit = submitQuestionField('text');
const handleQuestionImageTextModalSubmit = submitQuestionField('imageText');
const handleQuestionAnswerPromptModalSubmit = submitQuestionField('answerPrompt');
const handleQuestionAnswersModalSubmit = submitQuestionField('answers');

module.exports = {
    handleQuestionAnswerPromptModalSubmit,
    handleQuestionAnswersModalSubmit,
    handleQuestionImageTextModalSubmit,
    handleQuestionTextModalSubmit,
    showQuestionAnswerPromptModal,
    showQuestionAnswersModal,
    showQuestionImageTextModal,
    showQuestionTextModal,
};
