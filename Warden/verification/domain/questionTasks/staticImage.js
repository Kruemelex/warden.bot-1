const {
    getVerificationImagesByIds,
    getQuestionGeneratedImage,
    getRoleImageIds,
    validateImageReferences,
} = require('./shared/gallery');

const IMAGE_ROLE_CONFIG = Object.freeze({
    label: 'Static Image File',
    roles: Object.freeze([
        Object.freeze({
            key: 'source',
            label: 'Source Image',
            description: 'The single local image displayed for this question.',
            validationLabel: 'Source image file',
            missingCode: 'missing_static_image_id',
            maxValues: 1,
        }),
    ]),
});

function validateConfig(question, context) {
    const generatedImage = getQuestionGeneratedImage(question);
    const issues = validateImageReferences(generatedImage, {
        ...context,
        questionId: question.id,
        taskLabel: 'Static Image',
    }, IMAGE_ROLE_CONFIG.roles).issues;
    if (Object.prototype.hasOwnProperty.call(generatedImage, 'url')) {
        issues.push({
            code: 'retired_remote_image_config',
            field: 'generatedImage',
            label: 'Static image configuration',
            message: `${context.challengeId}/${question.id}: This Static Image still has retired remote-image data. Use Reset Task Fields to apply the local template.`,
        });
    }
    return issues;
}

module.exports = {
    type: 'static-image',
    label: 'Static Image',
    description: 'Local static reference image',
    editorCapabilities: Object.freeze({ imageIds: true }),
    imageRoleConfig: IMAGE_ROLE_CONFIG,
    retainedConfigFields: Object.freeze(['imageIds']),
    getAttachmentCount(question) {
        const generatedImage = getQuestionGeneratedImage(question);
        return getRoleImageIds(generatedImage, 'source').length === 1 ? 1 : 0;
    },
    validateConfig,

    async prepareAsset(question, context) {
        const generatedImage = getQuestionGeneratedImage(question);
        const label = context.label ?? question.label ?? question.id;
        const sourceIds = getRoleImageIds(generatedImage, 'source');

        if (sourceIds.length !== 1) {
            throw new Error(`Static Image task "${context.challengeId}/${question.id}" requires one local image.`);
        }

        const sourceImage = getVerificationImagesByIds(context.verificationImages, sourceIds, 'source', context.challengeId)[0];
        const prepared = await context.helpers.prepareGalleryImageAttachments({
            selectedImages: [{
                ...sourceImage,
                position: 1,
            }],
            useCompositeImage: false,
        });
        const image = prepared.selectedImages[0];

        return {
            type: 'static-image',
            galleryState: prepared,
            displayItems: [{
                type: 'image',
                displayUrl: image.displayUrl,
                description: label,
            }],
            files: [image.attachment],
        };
    },
};
