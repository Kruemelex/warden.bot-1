const {
    createGalleryToken,
    resolveGalleryImageCountOptions,
    resolveGalleryImageCounts,
    getVerificationImagesByIds,
    getGalleryAttachmentCount,
    getImageRoleOverlap,
    getQuestionGeneratedImage,
    getRoleImageIds,
    validateImageReferences,
    buildPreparedGalleryAsset,
} = require('./shared/gallery');

const {
    shuffleArray,
    pickRandomItemsWithRepeatLimit,
} = require('./shared/random');
const { questionUsesPositionAnswer } = require('../answerTypes');

const IMAGE_ROLE_CONFIG = Object.freeze({
    label: 'Image Files',
    roles: Object.freeze([
        Object.freeze({
            key: 'solution',
            label: 'Solution Images',
            description: 'Images that count as correct answers.',
            validationLabel: 'Solution image files',
            missingCode: 'missing_solution_image_ids',
        }),
        Object.freeze({
            key: 'control',
            label: 'Control Images',
            description: 'Decoy/control images.',
            validationLabel: 'Control image files',
            missingCode: 'missing_control_image_ids',
        }),
    ]),
});

function validateConfig(question, context) {
    const generatedImage = getQuestionGeneratedImage(question);
    const validation = validateImageReferences(generatedImage, {
        ...context,
        questionId: question.id,
    }, IMAGE_ROLE_CONFIG.roles);
    const issues = [...validation.issues];
    const roleOverlap = getImageRoleOverlap(validation.roleIds, 'solution', 'control');
    if (roleOverlap) {
        issues.push({
            code: 'overlapping_gallery_image_roles',
            field: 'generatedImage.imageIds',
            label: 'Gallery image roles',
            message: `${context.challengeId}/${question.id}: ${roleOverlap.message}.`,
        });
    }
    let countOptions;

    try {
        countOptions = resolveGalleryImageCountOptions(generatedImage, context.challengeId);
    }
    catch (err) {
        issues.push({
            code: 'invalid_gallery_counts',
            field: 'generatedImage.gallerySize',
            label: 'Gallery image counts',
            message: `${context.challengeId}/${question.id}: ${err.message}`,
        });
    }

    const configuredSolutionRepeatLimit = generatedImage.maxSolutionImageRepeats
        ?? generatedImage.solutionImageCount?.max
        ?? 1;
    const maxSolutionImageRepeats = Math.floor(Number(configuredSolutionRepeatLimit));
    if (!Number.isInteger(maxSolutionImageRepeats) || maxSolutionImageRepeats < 1) {
        issues.push({
            code: 'invalid_solution_image_repeat_limit',
            field: 'generatedImage.maxSolutionImageRepeats',
            label: 'Solution image repeat limit',
            message: `${context.challengeId}/${question.id}: Solution image repeat limit must be a positive integer.`,
        });
    }
    else if (countOptions && validation.roleIds.solution.length > 0) {
        const maximumSolutionCount = Math.max(...countOptions.validSolutionCounts);
        const solutionCapacity = validation.roleIds.solution.length * maxSolutionImageRepeats;
        if (solutionCapacity < maximumSolutionCount) {
            issues.push({
                code: 'insufficient_solution_image_capacity',
                field: 'generatedImage.maxSolutionImageRepeats',
                label: 'Solution image capacity',
                message: `${context.challengeId}/${question.id}: Solution images provide ${solutionCapacity} slot${solutionCapacity === 1 ? '' : 's'}, but this gallery can require ${maximumSolutionCount}.`,
            });
        }
    }

    const configuredRepeatLimit = generatedImage.maxControlImageRepeats ?? 1;
    const maxControlImageRepeats = Math.floor(Number(configuredRepeatLimit));
    if (!Number.isInteger(maxControlImageRepeats) || maxControlImageRepeats < 1) {
        issues.push({
            code: 'invalid_control_image_repeat_limit',
            field: 'generatedImage.maxControlImageRepeats',
            label: 'Control image repeat limit',
            message: `${context.challengeId}/${question.id}: Control image repeat limit must be a positive integer.`,
        });
    }
    else if (countOptions && validation.roleIds.control.length > 0) {
        const maximumControlCount = Math.max(...countOptions.validSolutionCounts
            .map((solutionCount) => countOptions.gallerySize - solutionCount));
        const controlCapacity = validation.roleIds.control.length * maxControlImageRepeats;
        if (controlCapacity < maximumControlCount) {
            issues.push({
                code: 'insufficient_control_image_capacity',
                field: 'generatedImage.maxControlImageRepeats',
                label: 'Control image capacity',
                message: `${context.challengeId}/${question.id}: Control images provide ${controlCapacity} slot${controlCapacity === 1 ? '' : 's'}, but this gallery can require ${maximumControlCount}.`,
            });
        }
    }

    return issues;
}

function validatePendingImageIds(question, pendingImageIds) {
    const solutionIds = pendingImageIds.solution ?? [];
    const controlIds = pendingImageIds.control ?? [];
    const roleOverlap = getImageRoleOverlap(pendingImageIds, 'solution', 'control');
    if (roleOverlap) return roleOverlap.message;

    if (solutionIds.length > 0 || controlIds.length > 0) {
        let countOptions;
        try {
            countOptions = resolveGalleryImageCountOptions(question.generatedImage ?? {}, 'this challenge');
        }
        catch (err) {
            return err.message;
        }
        const maximumSolutionCount = Math.max(...countOptions.validSolutionCounts);
        const configuredSolutionRepeatLimit = Math.floor(Number(
            question.generatedImage?.maxSolutionImageRepeats ?? maximumSolutionCount,
        ));
        const maxSolutionImageRepeats = Number.isInteger(configuredSolutionRepeatLimit)
            && configuredSolutionRepeatLimit > 0
            ? configuredSolutionRepeatLimit
            : maximumSolutionCount;
        const availableSolutionCapacity = solutionIds.length * maxSolutionImageRepeats;
        if (solutionIds.length > 0 && availableSolutionCapacity < maximumSolutionCount) {
            return `Solution images can fill at most ${availableSolutionCapacity} gallery slot${availableSolutionCapacity === 1 ? '' : 's'}, but this question may need ${maximumSolutionCount}. Add more solution image files or increase maxSolutionImageRepeats.`;
        }

        const requiredControlCapacity = Math.max(...countOptions.validSolutionCounts
            .map((solutionCount) => countOptions.gallerySize - solutionCount));
        const configuredRepeatLimit = Math.floor(Number(question.generatedImage?.maxControlImageRepeats ?? 1));
        const maxControlImageRepeats = Number.isInteger(configuredRepeatLimit) && configuredRepeatLimit > 0
            ? configuredRepeatLimit
            : 1;
        const availableControlCapacity = controlIds.length * maxControlImageRepeats;
        if (controlIds.length > 0 && availableControlCapacity < requiredControlCapacity) {
            return `Control images can fill at most ${availableControlCapacity} gallery slot${availableControlCapacity === 1 ? '' : 's'}, but this question may need ${requiredControlCapacity}. Add more control image files or increase maxControlImageRepeats.`;
        }
    }
    return undefined;
}

function createGalleryState(question, context) {
    const generatedImage = getQuestionGeneratedImage(question);
    const { challengeId, verificationImages } = context;

    const { solutionCount, controlCount } = resolveGalleryImageCounts(generatedImage, challengeId);
    const solutionIds = getRoleImageIds(generatedImage, 'solution');
    const controlIds = getRoleImageIds(generatedImage, 'control');

    if (questionUsesPositionAnswer(question) && solutionIds.length < 1) {
        throw new Error(`Verification challenge "${challengeId}" question "${question.id}" has no configured solution image files.`);
    }

    if (controlIds.length < 1) {
        throw new Error(`Verification challenge "${challengeId}" question "${question.id}" has no configured control image files.`);
    }

    const solutionImages = getVerificationImagesByIds(verificationImages, solutionIds, 'solution', challengeId);
    const controlImages = getVerificationImagesByIds(verificationImages, controlIds, 'control', challengeId);
    const maxSolutionImageRepeats = generatedImage.maxSolutionImageRepeats ?? solutionCount;
    const maxControlImageRepeats = generatedImage.maxControlImageRepeats ?? 1;
    const selectedImages = shuffleArray([
        ...pickRandomItemsWithRepeatLimit(solutionImages, solutionCount, maxSolutionImageRepeats, 'solution'),
        ...pickRandomItemsWithRepeatLimit(controlImages, controlCount, maxControlImageRepeats, 'control'),
    ]).map((image, index) => ({
        ...image,
        position: index + 1,
    }));

    return {
        token: createGalleryToken(),
        selectedImages,
        useCompositeImage: generatedImage.compositeImageGallery === true,
        showPositionLabels: questionUsesPositionAnswer(question),
        solutionPositions: selectedImages
            .filter((image) => image.role === 'solution')
            .map((image) => image.position)
            .sort((left, right) => left - right),
    };
}

async function prepareAsset(question, context) {
    const galleryState = await context.helpers.prepareGalleryImageAttachments(createGalleryState(question, context));
    return buildPreparedGalleryAsset('gallery-standard', galleryState, context.helpers);
}

module.exports = {
    type: 'gallery-standard',
    label: 'Standard Gallery',
    description: 'Generate solution and control images',
    gallery: true,
    editorCapabilities: Object.freeze({
        galleryLimits: true,
        imageIds: true,
        roleSpecificGalleryLimits: true,
    }),
    imageRoleConfig: IMAGE_ROLE_CONFIG,
    retainedConfigFields: Object.freeze([
        'imageIds',
        'gallerySize',
        'compositeImageGallery',
        'solutionImageCount',
        'maxSolutionImageRepeats',
        'maxControlImageRepeats',
    ]),
    resetGroups: Object.freeze([
        Object.freeze({
            field: 'gallery-limits',
            label: 'Reset Gallery Limits',
            changedFields: Object.freeze([
                'gallerySize',
                'compositeImageGallery',
                'solutionImageCount',
                'maxSolutionImageRepeats',
                'maxControlImageRepeats',
            ]),
            paths: Object.freeze([
                'generatedImage.gallerySize',
                'generatedImage.compositeImageGallery',
                'generatedImage.solutionImageCount',
                'generatedImage.maxSolutionImageRepeats',
                'generatedImage.maxControlImageRepeats',
            ]),
        }),
    ]),
    providesPositionAnswers: true,
    providesGalleryCountAnswers: true,
    getAttachmentCount: getGalleryAttachmentCount,
    validatePendingImageIds,
    validateConfig,
    prepareAsset,
};
