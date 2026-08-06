const { getUnknownVerificationImageIds, getVerificationImage } = require('../../../assets/image-inventory');

const DEFAULT_GALLERY_SIZE = 6;

function createGalleryToken() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function getDefaultGallerySize() {
    return DEFAULT_GALLERY_SIZE;
}

function getGallerySize(question) {
    const gallerySize = Number(question?.generatedImage?.gallerySize ?? 0);
    return Number.isInteger(gallerySize) && gallerySize > 0 ? gallerySize : getDefaultGallerySize();
}

function getGalleryPresentation(question) {
    return question?.generatedImage?.compositeImageGallery === true ? 'composite' : 'individual';
}

function getMaximumSolutionImageCount(question) {
    const maximum = Number(question?.generatedImage?.solutionImageCount?.max ?? 1);
    return Number.isInteger(maximum) && maximum > 0 ? maximum : 1;
}

function getMinimumSolutionImageCount(question) {
    const minimum = Number(question?.generatedImage?.solutionImageCount?.min ?? 1);
    return Number.isInteger(minimum) && minimum > 0 ? minimum : 1;
}

function getMaxControlImageRepeats(question) {
    const repeatLimit = Number(question?.generatedImage?.maxControlImageRepeats ?? 1);
    return Number.isInteger(repeatLimit) && repeatLimit > 0 ? repeatLimit : 1;
}

function getMaxSolutionImageRepeats(question) {
    const fallback = getMaximumSolutionImageCount(question);
    const repeatLimit = Number(question?.generatedImage?.maxSolutionImageRepeats ?? fallback);
    return Number.isInteger(repeatLimit) && repeatLimit > 0 ? repeatLimit : fallback;
}

function getMaximumGallerySize(galleryConfigInput) {
    return galleryConfigInput?.compositeImageGallery === true ? 25 : 10;
}

function resolveGalleryImageCountOptions(galleryConfigInput, challengeId) {
    const gallerySize = Number(galleryConfigInput?.gallerySize ?? getDefaultGallerySize());
    const solutionRange = galleryConfigInput?.solutionImageCount ?? { min: 1, max: 1 };

    if (!Number.isInteger(gallerySize) || gallerySize < 1) {
        throw new Error(`Invalid gallery size for challenge ${challengeId}: ${gallerySize}`);
    }

    const maximumGallerySize = getMaximumGallerySize(galleryConfigInput);
    if (gallerySize > maximumGallerySize) {
        throw new Error(`Gallery size for challenge ${challengeId} cannot exceed ${maximumGallerySize} ${galleryConfigInput?.compositeImageGallery === true ? 'composite gallery images' : 'Discord attachments'}.`);
    }

    const solutionMin = Number(solutionRange.min ?? 1);
    const solutionMax = Number(solutionRange.max ?? 1);
    if (!Number.isInteger(solutionMin) || solutionMin < 1) {
        throw new Error(`Minimum solution image count for challenge ${challengeId} must be a positive integer.`);
    }
    if (!Number.isInteger(solutionMax) || solutionMax < solutionMin || solutionMax > gallerySize) {
        throw new Error(`Maximum solution image count for challenge ${challengeId} must be between the minimum (${solutionMin}) and gallery size (${gallerySize}).`);
    }
    const validSolutionCounts = [];

    for (let solutionCount = solutionMin; solutionCount <= solutionMax; solutionCount += 1) {
        validSolutionCounts.push(solutionCount);
    }

    if (validSolutionCounts.length < 1) {
        throw new Error(`No valid solution/control image count combination exists for challenge ${challengeId}.`);
    }

    return { gallerySize, validSolutionCounts };
}

function resolveGalleryImageCounts(galleryConfigInput, challengeId) {
    const { gallerySize, validSolutionCounts } = resolveGalleryImageCountOptions(galleryConfigInput, challengeId);

    const solutionCount = validSolutionCounts[Math.floor(Math.random() * validSolutionCounts.length)];
    const controlCount = gallerySize - solutionCount;

    return { gallerySize, solutionCount, controlCount };
}

function getVerificationImagesByIds(inventory, imageIds, roleName, challengeId) {
    const images = [];

    for (const imageId of [...new Set((imageIds ?? []).map(String))]) {
        const image = getVerificationImage(imageId, inventory);
        if (!image) {
            throw new Error(`Verification challenge "${challengeId}" references unavailable ${roleName} image "${imageId}".`);
        }

        images.push({
            ...image,
            role: roleName,
        });
    }

    return images;
}

function validateImageReferences(generatedImage, context, roles) {
    const {
        challengeId,
        questionId,
        verificationImages,
        taskLabel = 'Gallery',
    } = context;
    const prefix = `${challengeId}/${questionId}`;
    const normalizedRoles = roles.map((role) => ({
        ...role,
        role: role.role ?? role.key,
        label: role.validationLabel ?? role.label,
    }));
    const roleIds = Object.fromEntries(normalizedRoles
        .map(({ role }) => [role, getRoleImageIds(generatedImage, role).map(String)]));
    const issues = [];

    for (const { role, label, missingCode, maxValues } of normalizedRoles) {
        const imageIds = roleIds[role];
        if (imageIds.length < 1) {
            issues.push({
                code: missingCode,
                field: `generatedImage.imageIds.${role}`,
                label,
                message: `${prefix}: ${taskLabel} task requires ${label.toLowerCase()}.`,
            });
            continue;
        }

        const unknownImageIds = getUnknownVerificationImageIds(imageIds, verificationImages);
        if (unknownImageIds.length > 0) {
            issues.push({
                code: `unknown_${role}_image_ids`,
                field: `generatedImage.imageIds.${role}`,
                label,
                message: `${prefix}: Configured ${role} image file${unknownImageIds.length === 1 ? ' is' : 's are'} unavailable in /verificationImages: ${unknownImageIds.join(', ')}.`,
            });
        }
        if (maxValues && imageIds.length > maxValues) {
            issues.push({
                code: `too_many_${role}_image_ids`,
                field: `generatedImage.imageIds.${role}`,
                label,
                message: `${prefix}: ${taskLabel} task accepts at most ${maxValues} ${label.toLowerCase()}.`,
            });
        }
    }

    return { issues, inventory: verificationImages, roleIds };
}

function getQuestionGeneratedImage(question) {
    return question?.generatedImage ?? {};
}

function getGalleryAttachmentCount(question) {
    const generatedImage = getQuestionGeneratedImage(question);
    try {
        const { gallerySize } = resolveGalleryImageCountOptions(generatedImage, question?.id ?? 'unknown');
        return generatedImage.compositeImageGallery === true ? 1 : gallerySize;
    }
    catch (err) {
        return 0;
    }
}

function getRoleImageIds(generatedImage, role) {
    return Array.isArray(generatedImage?.imageIds?.[role])
        ? [...new Set(generatedImage.imageIds[role].map(String))]
        : [];
}

function getImageRoleOverlap(imageIds = {}, firstRole, secondRole) {
    const secondSet = new Set((imageIds[secondRole] ?? []).map(String));
    const ids = [...new Set((imageIds[firstRole] ?? []).map(String))]
        .filter((imageId) => secondSet.has(imageId));
    if (ids.length < 1) return undefined;
    return {
        ids,
        message: `Image file${ids.length === 1 ? '' : 's'} cannot be both ${firstRole} and ${secondRole}: ${ids.join(', ')}`,
    };
}

function buildPreparedGalleryAsset(type, galleryState, helpers) {
    const asset = {
        type,
        galleryState,
        displayItems: helpers.getGalleryDisplayImages(galleryState),
    };
    asset.files = helpers.getQuestionAssetFiles(asset);
    return asset;
}

module.exports = {
    createGalleryToken,
    getDefaultGallerySize,
    getGalleryPresentation,
    getGallerySize,
    getMaxControlImageRepeats,
    getMaxSolutionImageRepeats,
    getMaximumSolutionImageCount,
    getMinimumSolutionImageCount,
    getMaximumGallerySize,
    resolveGalleryImageCountOptions,
    resolveGalleryImageCounts,
    getVerificationImagesByIds,
    validateImageReferences,
    getQuestionGeneratedImage,
    getGalleryAttachmentCount,
    getImageRoleOverlap,
    getRoleImageIds,
    buildPreparedGalleryAsset,
};
