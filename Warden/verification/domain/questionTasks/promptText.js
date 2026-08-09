const PROMPT_TEXT_MAX_LENGTH = 256;

function assertPromptTextLength(promptText) {
    const text = String(promptText ?? '');
    if (text.length > PROMPT_TEXT_MAX_LENGTH) {
        throw new Error(`Prompt image text exceeds the ${PROMPT_TEXT_MAX_LENGTH}-character rendering limit.`);
    }
    return text;
}

function validateConfig(question, context) {
    const promptText = question?.generatedImage?.text;
    if (!promptText) {
        return [{
            code: 'missing_task_prompt_text',
            field: 'generatedImage.text',
            label: 'Task prompt text',
            message: `${context.challengeId}/${question.id}: Prompt Text task requires configured task prompt text.`,
        }];
    }
    if (String(promptText).length <= PROMPT_TEXT_MAX_LENGTH) return [];

    return [{
        code: 'task_prompt_text_too_long',
        field: 'generatedImage.text',
        label: 'Task prompt text',
        message: `${context.challengeId}/${question.id}: Prompt image text exceeds the ${PROMPT_TEXT_MAX_LENGTH}-character rendering limit.`,
    }];
}

module.exports = {
    PROMPT_TEXT_MAX_LENGTH,
    assertPromptTextLength,
    type: 'prompt-text',
    label: 'Prompt Text',
    description: 'Prompt image text',
    editorCapabilities: Object.freeze({ promptText: true }),
    imageRoleConfig: undefined,
    retainedConfigFields: Object.freeze(['text']),
    resetGroups: Object.freeze([
        Object.freeze({
            field: 'image-text',
            label: 'Reset Prompt Text',
            changedFields: Object.freeze(['text']),
            paths: Object.freeze(['generatedImage.text']),
        }),
    ]),
    validateConfig,
    getAttachmentCount(question) {
        return question?.generatedImage?.text ? 1 : 0;
    },

    async prepareAsset(question, context) {
        const generatedImage = question.generatedImage ?? {};
        const promptText = generatedImage.text;
        const label = context.label ?? question.label ?? question.id;
        const { challengeId, helpers } = context;

        if (!promptText) {
            throw new Error(`Verification challenge "${challengeId}" question "${question.id}" requires configured generated image text.`);
        }
        assertPromptTextLength(promptText);

        const promptImage = await helpers.createPromptImageAttachment(promptText);

        return {
            type: 'prompt-text',
            promptText,
            promptImage,
            files: [promptImage.attachment],
            displayItems: [{
                type: 'image',
                displayUrl: promptImage.displayUrl,
                description: `${label} prompt`,
            }],
        };
    },
};
