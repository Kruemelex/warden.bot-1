function normalizeTextAnswer(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function parsePositionAnswer(value) {
    const normalizedInput = String(value ?? '').trim();
    if (!normalizedInput) return [];
    return normalizedInput.split(/[\s,]+/).filter(Boolean).map(Number);
}

function validateTextAnswer({ answer, submittedValue }) {
    const normalizer = answer.normalizer ?? normalizeTextAnswer;
    const normalizedAnswer = normalizer(submittedValue);
    return (answer.accepted ?? [])
        .map((validAnswer) => normalizer(validAnswer))
        .includes(normalizedAnswer);
}

function validatePositionAnswer({ question, questionAssets, submittedValue }) {
    const expectedPositions = questionAssets.solutionPositions ?? [];
    const gallerySize = questionAssets.gallerySize
        ?? question.generatedImage?.gallerySize
        ?? questionAssets.selectedImages?.length
        ?? 0;
    const submittedPositions = parsePositionAnswer(submittedValue);
    if (submittedPositions.length !== expectedPositions.length) return false;
    if (submittedPositions.some((position) =>
        !Number.isInteger(position) || position < 1 || position > gallerySize)) return false;
    if (new Set(submittedPositions).size !== submittedPositions.length) return false;
    const sortedSubmittedPositions = [...submittedPositions].sort((left, right) => left - right);
    return expectedPositions.every((expectedPosition, index) =>
        sortedSubmittedPositions[index] === expectedPosition);
}

function validateGalleryCountAnswer({ questionAssets, submittedValue }) {
    const expectedPositions = questionAssets.solutionPositions ?? [];
    const normalizedInput = String(submittedValue ?? '').trim();
    return expectedPositions.length > 0
        && /^\d+$/.test(normalizedInput)
        && Number(normalizedInput) === expectedPositions.length;
}

const ANSWER_TYPE_DESCRIPTORS = Object.freeze([
    Object.freeze({
        type: 'none',
        label: 'No Answer',
        description: 'Do not require an answer for this question.',
        availableOnCreate: true,
    }),
    Object.freeze({
        type: 'text',
        label: 'Text Answer',
        description: 'Require an accepted text answer.',
        availableOnCreate: true,
        editableAcceptedAnswers: true,
        editablePrompt: true,
        defaultInputLabel: 'Verification answer',
        defaultInputPlaceholder: 'Enter your answer here',
        validate: validateTextAnswer,
    }),
    Object.freeze({
        type: 'positions',
        label: 'Position Answer',
        description: 'Require gallery image position(s).',
        taskCapability: 'providesPositionAnswers',
        availableOnCreate: false,
        showsPositionLabels: true,
        defaultInputLabel: ({ positionMaximum = '?' }) => `Image position(s) (1-${positionMaximum})`,
        defaultInputPlaceholder: 'If multiple, separate position numbers by commas or spaces',
        validate: validatePositionAnswer,
    }),
    Object.freeze({
        type: 'gallery-count',
        label: 'Gallery Count',
        description: 'Require the number of generated solution images.',
        taskCapability: 'providesGalleryCountAnswers',
        availableOnCreate: false,
        editablePrompt: true,
        defaultInputLabel: 'Number of matching images',
        defaultInputPlaceholder: 'Enter a whole number',
        validate: validateGalleryCountAnswer,
    }),
]);

const answerTypesById = new Map(ANSWER_TYPE_DESCRIPTORS.map((descriptor) => [
    descriptor.type,
    descriptor,
]));

function getAnswerTypeDescriptor(answerType) {
    return answerTypesById.get(String(answerType ?? ''));
}

function getAnswerTypeDescriptors({ availableOnCreate } = {}) {
    return ANSWER_TYPE_DESCRIPTORS.filter((descriptor) =>
        availableOnCreate === undefined || descriptor.availableOnCreate === availableOnCreate);
}

function isSupportedAnswerType(answerType) {
    return answerTypesById.has(String(answerType ?? ''));
}

function normalizeAnswerType(answerType, fallback = 'text') {
    const normalized = String(answerType ?? '');
    return isSupportedAnswerType(normalized) ? normalized : fallback;
}

function getQuestionAnswerType(question) {
    if (question?.answer?.required !== true) return 'none';
    return normalizeAnswerType(question.answer?.type, 'text');
}

function getQuestionAnswerInputPresentation(question) {
    return getAnswerInputPresentation({
        ...(question?.answer ?? {}),
        type: getQuestionAnswerType(question),
    });
}

function taskSupportsAnswerType(taskModule, answerType) {
    const descriptor = getAnswerTypeDescriptor(answerType);
    if (!descriptor) return false;
    if (!descriptor.taskCapability) return true;
    return taskModule?.[descriptor.taskCapability] === true;
}

function getAnswerInputPresentation(answer = {}, context = {}) {
    const descriptor = getAnswerTypeDescriptor(answer.type);
    const configuredLabel = descriptor?.defaultInputLabel;
    return {
        label: (descriptor?.editablePrompt ? answer.inputLabel : undefined)
            ?? (typeof configuredLabel === 'function' ? configuredLabel(context) : configuredLabel)
            ?? 'Verification answer',
        placeholder: (descriptor?.editablePrompt ? answer.inputPlaceholder : undefined)
            ?? descriptor?.defaultInputPlaceholder
            ?? 'Enter your answer here',
    };
}

function questionUsesPositionAnswer(question) {
    return question?.answer?.required === true
        && getAnswerTypeDescriptor(question.answer?.type)?.showsPositionLabels === true;
}

function validateRequiredAnswer(answer, submittedValue, question, questionAssets = {}) {
    const descriptor = getAnswerTypeDescriptor(answer?.type);
    if (!descriptor?.validate) return { ok: false, reason: 'unsupported_answer_type' };
    return descriptor.validate({
        answer,
        question,
        questionAssets,
        submittedValue,
    })
        ? { ok: true }
        : { ok: false, reason: 'incorrect' };
}

module.exports = {
    getAnswerInputPresentation,
    getAnswerTypeDescriptor,
    getAnswerTypeDescriptors,
    getQuestionAnswerInputPresentation,
    getQuestionAnswerType,
    isSupportedAnswerType,
    normalizeAnswerType,
    questionUsesPositionAnswer,
    taskSupportsAnswerType,
    validateRequiredAnswer,
};
