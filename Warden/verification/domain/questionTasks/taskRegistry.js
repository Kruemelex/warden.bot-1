const none = require('./none');
const promptText = require('./promptText');
const staticImage = require('./staticImage');
const galleryStandard = require('./galleryStandard');
const rotationAlignment = require('./rotationAlignment');

const questionTaskModules = new Map([
    [none.type, none],
    [promptText.type, promptText],
    [staticImage.type, staticImage],
    [galleryStandard.type, galleryStandard],
    [rotationAlignment.type, rotationAlignment],
]);

const QUESTION_TASK_CONFIG_FIELDS = Object.freeze([...new Set([
    ...[...questionTaskModules.values()].flatMap((taskModule) => taskModule.retainedConfigFields ?? []),
])]);

function getQuestionTaskModules() {
    return [...questionTaskModules.values()];
}

function getQuestionTaskModuleByType(taskType) {
    return questionTaskModules.get(String(taskType ?? ''));
}

function isQuestionTaskType(taskType) {
    return questionTaskModules.has(String(taskType ?? ''));
}

function normalizeQuestionTaskType(taskType) {
    const normalized = String(taskType ?? 'none').trim() || 'none';
    return isQuestionTaskType(normalized) ? normalized : 'none';
}

function getQuestionTaskType(question) {
    const generatedImage = question?.generatedImage ?? {};

    if (generatedImage.enabled !== true || generatedImage.type === 'none') {
        return 'none';
    }

    return generatedImage.type ?? 'none';
}

function getNormalizedQuestionTaskType(question) {
    return normalizeQuestionTaskType(getQuestionTaskType(question));
}

function getQuestionTaskModule(question) {
    const taskType = getQuestionTaskType(question);
    return questionTaskModules.get(taskType);
}

function getQuestionTaskImageRoleConfig(taskType) {
    return getQuestionTaskModuleByType(normalizeQuestionTaskType(taskType))?.imageRoleConfig;
}

function getQuestionTaskEditorCapabilities(taskType) {
    return getQuestionTaskModuleByType(normalizeQuestionTaskType(taskType))?.editorCapabilities ?? {};
}

function getQuestionTaskResetGroups(taskType) {
    return getQuestionTaskModuleByType(normalizeQuestionTaskType(taskType))?.resetGroups ?? [];
}

function isGalleryQuestionTaskType(taskType) {
    return getQuestionTaskModuleByType(normalizeQuestionTaskType(taskType))?.gallery === true;
}

function requireQuestionTaskModule(question, challengeId) {
    const taskType = getQuestionTaskType(question);
    const taskModule = questionTaskModules.get(taskType);

    if (!taskModule) {
        throw new Error(`Unsupported question task type "${taskType}" for challenge "${challengeId}" question "${question?.id}".`);
    }

    return taskModule;
}

module.exports = {
    QUESTION_TASK_CONFIG_FIELDS,
    getQuestionTaskEditorCapabilities,
    getQuestionTaskImageRoleConfig,
    getQuestionTaskModuleByType,
    getQuestionTaskModules,
    getQuestionTaskResetGroups,
    getQuestionTaskType,
    getNormalizedQuestionTaskType,
    getQuestionTaskModule,
    isGalleryQuestionTaskType,
    isQuestionTaskType,
    normalizeQuestionTaskType,
    requireQuestionTaskModule,
};
