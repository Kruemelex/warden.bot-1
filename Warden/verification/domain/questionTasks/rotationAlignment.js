const {
    createGalleryToken,
    resolveGalleryImageCountOptions,
    resolveGalleryImageCounts,
    getVerificationImagesByIds,
    getGalleryAttachmentCount,
    getImageRoleOverlap,
    getQuestionGeneratedImage,
    getRoleImageIds,
    getGallerySize,
    validateImageReferences,
    buildPreparedGalleryAsset,
} = require('./shared/gallery');

const {
    DEFAULT_ROTATION_ALIGNMENT_DEGREES,
    normalizeDegrees,
    getDegreeList,
    hasDirection,
    getWorldDirections,
    isAllowedRotationDegree,
} = require('./shared/degrees');

const {
    shuffleArray,
    pickRandomItem,
    pickRandomItems,
} = require('./shared/random');
const { VERIFICATION_UI_LIMITS } = require('../limits');
const { questionUsesPositionAnswer } = require('../answerTypes');

const IMAGE_ROLE_CONFIG = Object.freeze({
    label: 'Rotation Image Files',
    roles: Object.freeze([
        Object.freeze({
            key: 'center',
            label: 'Center Images',
            description: 'Center/source images for generated tiles.',
            validationLabel: 'Center image files',
            missingCode: 'missing_center_image_ids',
        }),
        Object.freeze({
            key: 'outer',
            label: 'Outer Images',
            description: 'Outer/source images for generated tiles.',
            validationLabel: 'Outer image files',
            missingCode: 'missing_outer_image_ids',
        }),
    ]),
});

function getRotationAlignmentDirections(imageDirections, imageId, challengeId) {
    const directions = getDegreeList(imageDirections?.[imageId], []);

    if (directions.length < 1) {
        throw new Error(`Verification challenge "${challengeId}" has no configured image directions for "${imageId}".`);
    }

    return directions;
}

function pickClockPositionDegrees(clockDegrees, gallerySize, maxRepeats) {
    const { normalizedClockDegrees, limit, capacity } = resolveClockPositionCapacity(clockDegrees, gallerySize, maxRepeats);

    if (capacity < gallerySize) {
        throw new Error(`Rotation-alignment gallery does not have enough clock-position capacity. Required ${gallerySize}, capacity ${capacity}. Increase maxImageOrientationRepeats or add clock positions.`);
    }

    const counts = new Map();
    const selected = [];

    for (let index = 0; index < gallerySize; index += 1) {
        const available = normalizedClockDegrees.filter((degrees) => (counts.get(degrees) ?? 0) < limit);
        const degrees = pickRandomItem(available);
        counts.set(degrees, (counts.get(degrees) ?? 0) + 1);
        selected.push(degrees);
    }

    return selected;
}

function resolveClockPositionCapacity(clockDegrees, gallerySize, maxRepeats) {
    const normalizedClockDegrees = [...new Set(clockDegrees ?? [])];
    const limit = maxRepeats === undefined || maxRepeats === null
        ? gallerySize
        : Math.floor(Number(maxRepeats));

    if (normalizedClockDegrees.length < 1) {
        throw new Error('Rotation-alignment gallery requires at least one clock position degree.');
    }
    if (!Number.isInteger(limit) || limit < 1) {
        throw new Error('Rotation-alignment maxImageOrientationRepeats must be a positive integer.');
    }

    return {
        normalizedClockDegrees,
        limit,
        capacity: normalizedClockDegrees.length * limit,
    };
}

function getRotationAlignmentConfig(question) {
    return question?.generatedImage?.rotationAlignment ?? {};
}

function getRotationClockPositionDegrees(question) {
    return getDegreeList(getRotationAlignmentConfig(question).clockPositionDegrees);
}

function getRotationGenerationDegrees(question) {
    return getDegreeList(getRotationAlignmentConfig(question).rotationDegrees);
}

function getRotationMaxPositionRepeats(question) {
    const configured = Number(getRotationAlignmentConfig(question).maxImageOrientationRepeats);
    return Number.isInteger(configured) && configured > 0 ? configured : getGallerySize(question);
}

function getRotationAlignmentOffsets(question) {
    const alignmentRule = getRotationAlignmentConfig(question).alignmentRule ?? {};
    return {
        center: normalizeDegrees(alignmentRule.centerTargetOffsetDegrees ?? 0),
        outer: normalizeDegrees(alignmentRule.outerTargetOffsetDegrees ?? 180),
    };
}

function getInvalidDirectionValues(value) {
    return (Array.isArray(value) ? value : []).filter((degrees) => !isAllowedRotationDegree(degrees));
}

function validatePendingImageIds(_question, pendingImageIds) {
    const centerIds = pendingImageIds.center ?? [];
    const outerIds = pendingImageIds.outer ?? [];
    const roleOverlap = getImageRoleOverlap(pendingImageIds, 'center', 'outer');
    if (roleOverlap) return roleOverlap.message;
    if (new Set([...centerIds, ...outerIds].map(String)).size > VERIFICATION_UI_LIMITS.selectOptions) {
        return `Rotation Alignment accepts at most ${VERIFICATION_UI_LIMITS.selectOptions} configured images so their directions remain editable in Discord.`;
    }
    return undefined;
}

function validateConfig(question, context) {
    const generatedImage = getQuestionGeneratedImage(question);
    const validation = validateImageReferences(generatedImage, {
        ...context,
        questionId: question.id,
    }, IMAGE_ROLE_CONFIG.roles);
    const issues = [...validation.issues];
    const prefix = `${context.challengeId}/${question.id}`;
    const roleOverlap = getImageRoleOverlap(validation.roleIds, 'center', 'outer');
    if (roleOverlap) {
        issues.push({
            code: 'overlapping_rotation_image_roles',
            field: 'generatedImage.imageIds',
            label: 'Rotation image roles',
            message: `${prefix}: ${roleOverlap.message}.`,
        });
    }
    const imageDirections = generatedImage.imageDirections ?? {};

    const availableImageIds = new Set((validation.inventory?.images ?? []).map((image) => String(image.id)));
    const referencedImageIds = [...new Set([...validation.roleIds.center, ...validation.roleIds.outer])]
        .filter((imageId) => availableImageIds.has(imageId));
    if (new Set([...validation.roleIds.center, ...validation.roleIds.outer]).size > VERIFICATION_UI_LIMITS.selectOptions) {
        issues.push({
            code: 'too_many_rotation_source_images',
            field: 'generatedImage.imageIds',
            label: 'Rotation source images',
            message: `${prefix}: Rotation Alignment accepts at most ${VERIFICATION_UI_LIMITS.selectOptions} configured images so their directions remain editable in Discord.`,
        });
    }
    for (const imageId of referencedImageIds) {
        if (!Array.isArray(imageDirections[imageId]) || imageDirections[imageId].length < 1) {
            issues.push({
                code: 'missing_image_directions',
                field: `generatedImage.imageDirections.${imageId}`,
                label: 'Image directions',
                message: `${prefix}: Rotation Alignment task requires image directions for ${imageId}.`,
            });
        }
        else if (getInvalidDirectionValues(imageDirections[imageId]).length > 0) {
            issues.push({
                code: 'invalid_image_directions',
                field: `generatedImage.imageDirections.${imageId}`,
                label: 'Image directions',
                message: `${prefix}: Rotation Alignment task has invalid image directions for ${imageId}.`,
            });
        }
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
            message: `${prefix}: ${err.message}`,
        });
    }

    if (countOptions) {
        const rotationAlignment = generatedImage.rotationAlignment ?? {};
        for (const [field, label] of [
            ['clockPositionDegrees', 'Clock positions'],
            ['rotationDegrees', 'Generated rotations'],
        ]) {
            const configuredDegrees = rotationAlignment[field];
            if (configuredDegrees !== undefined
                && (!Array.isArray(configuredDegrees) || configuredDegrees.some((degrees) => !isAllowedRotationDegree(degrees)))) {
                issues.push({
                    code: `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
                    field: `generatedImage.rotationAlignment.${field}`,
                    label,
                    message: `${prefix}: ${label} must use valid 45-degree compass steps.`,
                });
            }
        }
        const alignmentRule = rotationAlignment.alignmentRule ?? {};
        for (const [field, label] of [
            ['centerTargetOffsetDegrees', 'Center target offset'],
            ['outerTargetOffsetDegrees', 'Outer target offset'],
        ]) {
            if (alignmentRule[field] !== undefined && !isAllowedRotationDegree(alignmentRule[field])) {
                issues.push({
                    code: `invalid_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
                    field: `generatedImage.rotationAlignment.alignmentRule.${field}`,
                    label,
                    message: `${prefix}: ${label} must use a valid 45-degree compass step.`,
                });
            }
        }
        const clockDegrees = getDegreeList(rotationAlignment.clockPositionDegrees);
        try {
            const { capacity } = resolveClockPositionCapacity(
                clockDegrees,
                countOptions.gallerySize,
                rotationAlignment.maxImageOrientationRepeats,
            );
            if (capacity < countOptions.gallerySize) {
                issues.push({
                    code: 'insufficient_clock_position_capacity',
                    field: 'generatedImage.rotationAlignment.maxImageOrientationRepeats',
                    label: 'Clock-position capacity',
                    message: `${prefix}: Clock positions provide ${capacity} slots, but the gallery requires ${countOptions.gallerySize}.`,
                });
            }
        }
        catch (err) {
            issues.push({
                code: 'invalid_rotation_generation_config',
                field: 'generatedImage.rotationAlignment.maxImageOrientationRepeats',
                label: 'Rotation generation settings',
                message: `${prefix}: ${err.message}`,
            });
        }
    }

    return issues;
}

function isRotationAlignmentCorrect({
    clockPositionDegrees,
    centerRotationDegrees,
    outerRotationDegrees,
    centerDirections,
    outerDirections,
    alignmentRule,
}) {
    const requiredCenterWorldDirection = normalizeDegrees(clockPositionDegrees + alignmentRule.centerTargetOffsetDegrees);
    const requiredOuterWorldDirection = normalizeDegrees(clockPositionDegrees + alignmentRule.outerTargetOffsetDegrees);

    return hasDirection(getWorldDirections(centerDirections, centerRotationDegrees), requiredCenterWorldDirection)
        && hasDirection(getWorldDirections(outerDirections, outerRotationDegrees), requiredOuterWorldDirection);
}

function createCorrectRotationAlignmentRotations(clockPositionDegrees, centerDirections, outerDirections, alignmentRule) {
    const centerDirection = pickRandomItem(centerDirections);
    const outerDirection = pickRandomItem(outerDirections);

    return {
        centerRotationDegrees: normalizeDegrees(clockPositionDegrees + alignmentRule.centerTargetOffsetDegrees - centerDirection),
        outerRotationDegrees: normalizeDegrees(clockPositionDegrees + alignmentRule.outerTargetOffsetDegrees - outerDirection),
    };
}

function createIncorrectRotationAlignmentRotations(clockPositionDegrees, centerDirections, outerDirections, alignmentRule, rotationDegrees) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const rotations = {
            centerRotationDegrees: pickRandomItem(rotationDegrees),
            outerRotationDegrees: pickRandomItem(rotationDegrees),
        };

        if (!isRotationAlignmentCorrect({ clockPositionDegrees, ...rotations, centerDirections, outerDirections, alignmentRule })) {
            return rotations;
        }
    }

    const correct = createCorrectRotationAlignmentRotations(clockPositionDegrees, centerDirections, outerDirections, alignmentRule);

    for (const offset of DEFAULT_ROTATION_ALIGNMENT_DEGREES.slice(1)) {
        const rotations = {
            ...correct,
            outerRotationDegrees: normalizeDegrees(correct.outerRotationDegrees + offset),
        };

        if (!isRotationAlignmentCorrect({ clockPositionDegrees, ...rotations, centerDirections, outerDirections, alignmentRule })) {
            return rotations;
        }
    }

    throw new Error('Unable to generate an incorrect rotation-alignment control tile.');
}

function createGalleryState(question, context) {
    const generatedImage = getQuestionGeneratedImage(question);
    const { challengeId, verificationImages } = context;

    const { gallerySize, solutionCount } = resolveGalleryImageCounts(generatedImage, challengeId);
    const centerImageIds = getRoleImageIds(generatedImage, 'center');
    const outerImageIds = getRoleImageIds(generatedImage, 'outer');
    const rotationAlignment = generatedImage.rotationAlignment ?? {};
    const rotationDegrees = getDegreeList(rotationAlignment.rotationDegrees);
    const clockDegrees = getDegreeList(rotationAlignment.clockPositionDegrees);
    const alignmentRule = {
        centerTargetOffsetDegrees: normalizeDegrees(rotationAlignment.alignmentRule?.centerTargetOffsetDegrees ?? 0),
        outerTargetOffsetDegrees: normalizeDegrees(rotationAlignment.alignmentRule?.outerTargetOffsetDegrees ?? 180),
    };
    const imageDirections = generatedImage.imageDirections ?? {};
    const token = createGalleryToken();
    const solutionIndexes = new Set(pickRandomItems([...Array(gallerySize).keys()], solutionCount, 'solution tile indexes'));
    const clockPositions = pickClockPositionDegrees(clockDegrees, gallerySize, rotationAlignment.maxImageOrientationRepeats);
    const generatedImages = [];

    if (centerImageIds.length < 1) {
        throw new Error(`Verification challenge "${challengeId}" question "${question.id}" requires center image files for rotation-alignment galleries.`);
    }

    if (outerImageIds.length < 1) {
        throw new Error(`Verification challenge "${challengeId}" question "${question.id}" requires outer image files for rotation-alignment galleries.`);
    }

    const centerImages = getVerificationImagesByIds(verificationImages, centerImageIds, 'center', challengeId);
    const outerImages = getVerificationImagesByIds(verificationImages, outerImageIds, 'outer', challengeId);

    for (let index = 0; index < gallerySize; index += 1) {
        const centerImage = pickRandomItem(centerImages);
        const outerImage = pickRandomItem(outerImages);
        const centerImageId = centerImage.id;
        const outerImageId = outerImage.id;
        const centerDirections = getRotationAlignmentDirections(imageDirections, centerImageId, challengeId);
        const outerDirections = getRotationAlignmentDirections(imageDirections, outerImageId, challengeId);
        const clockPositionDegrees = clockPositions[index];
        const isSolution = solutionIndexes.has(index);
        const rotations = isSolution
            ? createCorrectRotationAlignmentRotations(clockPositionDegrees, centerDirections, outerDirections, alignmentRule)
            : createIncorrectRotationAlignmentRotations(clockPositionDegrees, centerDirections, outerDirections, alignmentRule, rotationDegrees);

        generatedImages.push({
            id: `rotation-alignment-${token}-${index}`,
            role: isSolution ? 'solution' : 'control',
            generatedTile: {
                type: 'rotationAlignment',
                centerImage,
                outerImage,
                clockPositionDegrees,
                centerRotationDegrees: rotations.centerRotationDegrees,
                outerRotationDegrees: rotations.outerRotationDegrees,
            },
        });
    }

    const selectedImages = shuffleArray(generatedImages).map((image, index) => ({
        ...image,
        position: index + 1,
    }));

    return {
        token,
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
    return buildPreparedGalleryAsset('gallery-rotation-alignment', galleryState, context.helpers);
}

module.exports = {
    type: 'gallery-rotation-alignment',
    label: 'Rotation Alignment',
    description: 'Generate aligned and control tiles',
    gallery: true,
    editorCapabilities: Object.freeze({
        galleryLimits: true,
        imageIds: true,
        directions: true,
        rotationSettings: true,
    }),
    imageRoleConfig: IMAGE_ROLE_CONFIG,
    retainedConfigFields: Object.freeze([
        'imageIds',
        'imageDirections',
        'gallerySize',
        'compositeImageGallery',
        'solutionImageCount',
        'rotationAlignment',
    ]),
    resetGroups: Object.freeze([
        Object.freeze({
            field: 'gallery-limits',
            label: 'Reset Gallery Limits',
            changedFields: Object.freeze([
                'gallerySize',
                'compositeImageGallery',
                'solutionImageCount',
            ]),
            paths: Object.freeze([
                'generatedImage.gallerySize',
                'generatedImage.compositeImageGallery',
                'generatedImage.solutionImageCount',
            ]),
        }),
        Object.freeze({
            field: 'directions',
            label: 'Reset Directions',
            changedFields: Object.freeze(['imageDirections']),
            paths: Object.freeze(['generatedImage.imageDirections']),
        }),
        Object.freeze({
            field: 'rotation-settings',
            label: 'Reset Rotation Settings',
            changedFields: Object.freeze(['rotationAlignment']),
            paths: Object.freeze(['generatedImage.rotationAlignment']),
        }),
    ]),
    providesPositionAnswers: true,
    providesGalleryCountAnswers: true,
    getAttachmentCount: getGalleryAttachmentCount,
    getRotationAlignmentConfig,
    getRotationAlignmentOffsets,
    getRotationClockPositionDegrees,
    getRotationGenerationDegrees,
    getRotationMaxPositionRepeats,
    resolveClockPositionCapacity,
    validatePendingImageIds,
    validateConfig,
    prepareAsset,
};
