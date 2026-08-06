'use strict';

const { requireQuestionTaskModule } = require('../domain/questionTasks/taskRegistry');
const {
    getVerificationImageInventory,
    refreshVerificationImageInventory,
} = require('./image-inventory');
const { createPromptImageAttachment } = require('./prompt-renderer');
const {
    prepareGalleryImageAttachments,
    getGalleryDisplayImages,
} = require('./gallery-renderer');
const { getQuestionScreenPresentation } = require('../domain/screenPlan');

const QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES = 24 * 1024 * 1024;
const QUESTION_ASSET_DELIVERY_RELEASE = Symbol('verificationQuestionAssetDeliveryRelease');
let discordApi;

function getDiscordApi() {
    if (!discordApi) discordApi = require('discord.js');
    return discordApi;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason ?? Object.assign(
        new Error('Verification asset preparation was cancelled.'),
        { name: 'AbortError', code: 'VERIFICATION_ASSET_PREPARATION_ABORTED' },
    );
}

function createQuestionAssetByteBudget() {
    let usedBytes = 0;
    return {
        reserve(buffer, label = 'Verification screen attachments') {
            if (!Buffer.isBuffer(buffer)) return;
            const nextBytes = usedBytes + buffer.length;
            if (nextBytes > QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES) {
                throw new Error(
                    `${label} would bring this verification screen to ${nextBytes} bytes, `
                    + `exceeding the ${QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES}-byte safety limit.`,
                );
            }
            usedBytes = nextBytes;
        },
    };
}

function getQuestionAssetFiles(questionAsset) {
    if (!questionAsset) return [];
    if (Array.isArray(questionAsset.files) && questionAsset.files.length > 0) return questionAsset.files.filter(Boolean);
    if (questionAsset.promptImage?.attachment) return [questionAsset.promptImage.attachment];
    if (questionAsset.galleryState) {
        if (questionAsset.galleryState.compositeImage?.attachment) return [questionAsset.galleryState.compositeImage.attachment];
        return (questionAsset.galleryState.selectedImages ?? []).map((image) => image.attachment).filter(Boolean);
    }
    return [];
}

function getQuestionDisplayItems(questionAsset) {
    return questionAsset?.displayItems ?? [];
}

function assertQuestionAssetDeliverySize(questionAssets) {
    const attachmentBytes = Object.values(questionAssets)
        .flatMap(getQuestionAssetFiles)
        .reduce((total, attachment) => (
            total + (Buffer.isBuffer(attachment?.attachment) ? attachment.attachment.length : 0)
        ), 0);
    if (attachmentBytes > QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES) {
        throw new Error(`Verification screen attachments total ${attachmentBytes} bytes, exceeding the ${QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES}-byte safety limit.`);
    }
}

function questionAssetsNeedDelivery(questionAssets = {}) {
    return Object.values(questionAssets).some((asset) => asset?.deliveryReleased === true);
}

function questionAssetsHaveDelivery(questionAssets = {}) {
    return Object.values(questionAssets).some((asset) => getQuestionAssetFiles(asset).length > 0);
}

function screenNeedsQuestionAssetDelivery(screen) {
    return (screen?.questions ?? []).some(
        (question) => getQuestionScreenPresentation(question).rendersMedia,
    );
}

function retainQuestionAssetDelivery(questionAssets, release) {
    if (!questionAssets || typeof questionAssets !== 'object') {
        release?.();
        throw new TypeError('Verification question assets must be an object.');
    }
    if (typeof release !== 'function') {
        throw new TypeError('Verification question asset delivery requires a release function.');
    }
    if (!questionAssetsHaveDelivery(questionAssets)) {
        release();
        return questionAssets;
    }
    const existingRelease = questionAssets[QUESTION_ASSET_DELIVERY_RELEASE];
    if (existingRelease && existingRelease !== release) {
        release();
        throw new Error('Verification question assets already own attachment capacity.');
    }
    Object.defineProperty(questionAssets, QUESTION_ASSET_DELIVERY_RELEASE, {
        configurable: true,
        enumerable: false,
        value: release,
        writable: false,
    });
    return questionAssets;
}

function releaseQuestionAssetDelivery(questionAssets = {}) {
    for (const asset of Object.values(questionAssets)) {
        if (!asset) continue;
        if (!asset.galleryState && !asset.promptImage) continue;
        const galleryHasDelivery = Boolean(asset.galleryState?.compositeImage?.attachment)
            || (asset.galleryState?.selectedImages ?? []).some(
                (image) => image?.attachment || image?.buffer || image?.displayUrl,
            );
        const hasDelivery = galleryHasDelivery
            || Boolean(asset.promptImage?.attachment)
            || (asset.files?.length ?? 0) > 0
            || (asset.displayItems?.length ?? 0) > 0;
        if (asset.deliveryReleased === true && !hasDelivery) continue;

        if (!asset.deliveryDescriptions) {
            asset.deliveryDescriptions = (asset.displayItems ?? []).map((item) => item?.description);
        }
        asset.files = [];
        asset.displayItems = [];
        if (asset.galleryState) {
            asset.galleryState = {
                ...asset.galleryState,
                selectedImages: (asset.galleryState.selectedImages ?? []).map(
                    ({ attachment, buffer, displayUrl, ...image }) => image,
                ),
                compositeImage: undefined,
            };
        }
        if (asset.promptImage) asset.promptImage = undefined;
        asset.deliveryReleased = true;
    }
    const release = questionAssets?.[QUESTION_ASSET_DELIVERY_RELEASE];
    if (release) {
        delete questionAssets[QUESTION_ASSET_DELIVERY_RELEASE];
        release();
    }
    return questionAssets;
}

async function restoreQuestionAssetDelivery(questionAssets = {}, { priority = 'live' } = {}) {
    const byteBudget = createQuestionAssetByteBudget();
    try {
        for (const asset of Object.values(questionAssets)) {
            if (!asset || asset.deliveryReleased !== true) continue;

            if (asset.galleryState) {
                asset.galleryState = await prepareGalleryImageAttachments(
                    asset.galleryState,
                    { priority, byteBudget },
                );
                asset.displayItems = getGalleryDisplayImages(asset.galleryState).map((item, index) => ({
                    ...item,
                    description: asset.deliveryDescriptions?.[index] ?? item.description,
                }));
                asset.files = getQuestionAssetFiles(asset);
            }
            else if (asset.type === 'prompt-text' && asset.promptText) {
                asset.promptImage = await createPromptImageAttachment(asset.promptText, { priority });
                byteBudget.reserve(
                    asset.promptImage.attachment?.attachment,
                    'Verification prompt image',
                );
                asset.files = [asset.promptImage.attachment];
                asset.displayItems = [{
                    type: 'image',
                    displayUrl: asset.promptImage.displayUrl,
                    description: asset.deliveryDescriptions?.[0],
                }];
            }
            else {
                throw new Error(`Verification asset type "${asset.type ?? 'unknown'}" cannot restore released delivery data.`);
            }
            asset.deliveryReleased = false;
        }
    }
    catch (error) {
        releaseQuestionAssetDelivery(questionAssets);
        throw error;
    }
    try {
        assertQuestionAssetDeliverySize(questionAssets);
    }
    catch (error) {
        releaseQuestionAssetDelivery(questionAssets);
        throw error;
    }
    return questionAssets;
}

async function prepareQuestionImageAsset(
    question,
    challengeId,
    {
        priority = 'live',
        byteBudget = createQuestionAssetByteBudget(),
        signal,
        imageInventory = getVerificationImageInventory(),
    } = {},
) {
    throwIfAborted(signal);
    const label = question.label ?? question.id;
    const taskModule = requireQuestionTaskModule(question, challengeId);

    return taskModule.prepareAsset(question, {
        challengeId,
        label,
        verificationImages: imageInventory,
        helpers: {
            createPromptImageAttachment: async (prompt) => {
                throwIfAborted(signal);
                const promptImage = await createPromptImageAttachment(prompt, { priority, signal });
                throwIfAborted(signal);
                byteBudget.reserve(
                    promptImage.attachment?.attachment,
                    'Verification prompt image',
                );
                return promptImage;
            },
            prepareGalleryImageAttachments: (galleryState) =>
                prepareGalleryImageAttachments(galleryState, { priority, byteBudget, signal }),
            getGalleryDisplayImages,
            getQuestionAssetFiles,
        },
    });
}

async function prepareQuestionAssets(screen, challengeId, {
    priority = 'live',
    signal,
    imageInventory,
} = {}) {
    const questionAssets = {};
    const byteBudget = createQuestionAssetByteBudget();
    throwIfAborted(signal);
    const verificationImages = imageInventory
        ?? await refreshVerificationImageInventory();
    throwIfAborted(signal);

    const questions = screen?.questions ?? [];
    try {
        // A screen is the admission unit. Keep its questions sequential so raw
        // attachments cannot accumulate while another question renders native
        // canvas work on the half-CPU production host.
        for (const question of questions) {
            throwIfAborted(signal);
            const asset = await prepareQuestionImageAsset(
                question,
                challengeId,
                { priority, byteBudget, signal, imageInventory: verificationImages },
            );
            if (asset) questionAssets[question.id] = asset;
        }
    }
    catch (error) {
        releaseQuestionAssetDelivery(questionAssets);
        throw error;
    }

    try {
        assertQuestionAssetDeliverySize(questionAssets);
    }
    catch (error) {
        releaseQuestionAssetDelivery(questionAssets);
        throw error;
    }

    return questionAssets;
}

function getAttachmentDeliveryRecord(attachment, questionIndex, fileIndex) {
    const buffer = attachment?.attachment;
    if (!Buffer.isBuffer(buffer)) {
        throw new Error(
            `Verification stock attachment ${questionIndex + 1}/${fileIndex + 1} `
            + 'did not contain an encoded buffer.',
        );
    }
    const name = String(attachment.name ?? `verification-asset-${questionIndex + 1}-${fileIndex + 1}.png`);
    return { questionIndex, fileIndex, name, buffer };
}

function extractQuestionAssetsForStock(screen, questionAssets = {}) {
    const assets = [];
    const deliveries = [];
    for (const [questionIndex, question] of (screen?.questions ?? []).entries()) {
        const asset = questionAssets[question.id];
        assets.push(asset);
        if (!asset) continue;
        for (const [fileIndex, attachment] of getQuestionAssetFiles(asset).entries()) {
            deliveries.push(getAttachmentDeliveryRecord(attachment, questionIndex, fileIndex));
        }
    }
    releaseQuestionAssetDelivery(questionAssets);
    return { assets, deliveries };
}

function buildStockAttachment(record) {
    const attachment = new (getDiscordApi().AttachmentBuilder)(record.buffer, { name: record.name });
    return {
        attachment,
        buffer: record.buffer,
        displayUrl: `attachment://${record.name}`,
    };
}

function restoreQuestionAssetsFromStock(screen, stockedAssets = [], deliveries = []) {
    const byQuestionIndex = new Map();
    let totalBytes = 0;
    for (const record of deliveries) {
        if (!Buffer.isBuffer(record?.buffer)) {
            throw new Error('Verification asset stock returned an invalid attachment buffer.');
        }
        totalBytes += record.buffer.length;
        if (totalBytes > QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES) {
            throw new Error(
                `Verification asset stock delivery exceeds the `
                + `${QUESTION_SCREEN_ATTACHMENTS_MAX_BYTES}-byte screen safety limit.`,
            );
        }
        if (!byQuestionIndex.has(record.questionIndex)) byQuestionIndex.set(record.questionIndex, []);
        byQuestionIndex.get(record.questionIndex).push(record);
    }

    const questionAssets = {};
    for (const [questionIndex, question] of (screen?.questions ?? []).entries()) {
        const asset = stockedAssets[questionIndex];
        if (!asset) continue;
        const records = (byQuestionIndex.get(questionIndex) ?? [])
            .sort((left, right) => left.fileIndex - right.fileIndex);
        const attachments = records.map(buildStockAttachment);

        if (asset.promptText !== undefined) {
            if (attachments.length !== 1) {
                throw new Error('Verification prompt stock requires exactly one attachment.');
            }
            asset.promptImage = attachments[0];
        }
        else if (asset.galleryState?.useCompositeImage === true) {
            if (attachments.length !== 1) {
                throw new Error('Verification composite stock requires exactly one attachment.');
            }
            asset.galleryState.compositeImage = {
                attachment: attachments[0].attachment,
                displayUrl: attachments[0].displayUrl,
            };
        }
        else if (asset.galleryState) {
            if (attachments.length !== (asset.galleryState.selectedImages ?? []).length) {
                throw new Error('Verification gallery stock attachment count no longer matches its metadata.');
            }
            asset.galleryState.selectedImages = asset.galleryState.selectedImages.map((image, index) => ({
                ...image,
                ...attachments[index],
            }));
        }

        asset.files = getQuestionAssetFiles(asset);
        if (asset.galleryState) {
            asset.displayItems = getGalleryDisplayImages(asset.galleryState).map((item, index) => ({
                ...item,
                description: asset.type === 'static-image'
                    ? (question.label ?? question.id)
                    : asset.deliveryDescriptions?.[index] ?? item.description,
            }));
        }
        else if (asset.promptImage) {
            asset.displayItems = [{
                type: 'image',
                displayUrl: asset.promptImage.displayUrl,
                description: `${question.label ?? question.id} prompt`,
            }];
        }
        asset.deliveryReleased = false;
        questionAssets[question.id] = asset;
    }
    assertQuestionAssetDeliverySize(questionAssets);
    return questionAssets;
}

module.exports = {
    extractQuestionAssetsForStock,
    prepareGalleryImageAttachments,
    prepareQuestionAssets,
    getQuestionAssetFiles,
    getQuestionDisplayItems,
    questionAssetsNeedDelivery,
    releaseQuestionAssetDelivery,
    retainQuestionAssetDelivery,
    restoreQuestionAssetsFromStock,
    restoreQuestionAssetDelivery,
    screenNeedsQuestionAssetDelivery,
};
