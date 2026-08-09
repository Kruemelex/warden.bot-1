const crypto = require('crypto');
const path = require('path');
const { normalizeDegrees } = require('../domain/questionTasks/shared/degrees');
const { getImageGenerationConfig, getBoundedNumber } = require('./config');
const {
    VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    createVerificationImageRenderError,
} = require('./errors');
const { readVerificationImageFile } = require('./image-inventory');

const GALLERY_IMAGE_ATTACHMENT_NAME_PREFIX = 'warden-gallery';
const GALLERY_COMPOSITE_ATTACHMENT_NAME_PREFIX = 'warden-gallery-grid';
const GALLERY_COMPOSITE_MAX_DIMENSION = 4_096;
const GALLERY_COMPOSITE_MAX_PIXELS = 16_777_216;
const GALLERY_SOURCE_MAX_DIMENSION = 8_192;
const GALLERY_SOURCE_MAX_PIXELS = 8_388_608;
const GALLERY_COMPOSITE_SOURCE_MAX_PIXELS = 4_194_304;
const GALLERY_COMPOSITE_RENDER_TIMEOUT_MS = 30_000;
const ROTATION_TILE_BATCH_RENDER_TIMEOUT_MS = 30_000;
const GALLERY_COMPOSITE_COLUMNS_BY_SIZE = Object.freeze([
    0,
    1, 2, 3, 2, 5,
    3, 3, 4, 3, 5,
    4, 4, 5, 5, 5,
    4, 5, 6, 5, 5,
    6, 6, 6, 6, 5,
]);

let canvasApi;
let discordApi;

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason ?? Object.assign(
        new Error('Verification image rendering was cancelled.'),
        { name: 'AbortError', code: 'VERIFICATION_RENDER_ABORTED' },
    );
}

function submitVerificationRenderJob(...args) {
    // Keep the pure native renderer loadable by the isolated child without
    // recursively constructing another parent-side render supervisor.
    return require('./render-supervisor').submitVerificationRenderJob(...args);
}

function getCanvasApi() {
    if (!canvasApi) {
        canvasApi = require('@napi-rs/canvas');
    }

    return canvasApi;
}

function getDiscordApi() {
    if (!discordApi) discordApi = require('discord.js');
    return discordApi;
}

function readUInt24LE(buffer, offset) {
    return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function getPngDimensions(buffer) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'PNG' };
}

function getGifDimensions(buffer) {
    const signature = buffer.toString('ascii', 0, 6);
    if (buffer.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) return undefined;
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'GIF' };
}

function getJpegDimensions(buffer) {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
    const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 1 < buffer.length) {
        while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
        if (offset >= buffer.length) break;
        const marker = buffer[offset];
        offset += 1;
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 1 >= buffer.length) break;
        const segmentLength = buffer.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
        if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
            return {
                width: buffer.readUInt16BE(offset + 5),
                height: buffer.readUInt16BE(offset + 3),
                format: 'JPEG',
            };
        }
        offset += segmentLength;
    }
    return undefined;
}

function getWebpDimensions(buffer) {
    if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return undefined;
    let offset = 12;
    while (offset + 8 <= buffer.length) {
        const chunkType = buffer.toString('ascii', offset, offset + 4);
        const chunkLength = buffer.readUInt32LE(offset + 4);
        const dataOffset = offset + 8;
        if (dataOffset + chunkLength > buffer.length) break;
        if (chunkType === 'VP8X' && chunkLength >= 10) {
            return {
                width: readUInt24LE(buffer, dataOffset + 4) + 1,
                height: readUInt24LE(buffer, dataOffset + 7) + 1,
                format: 'WebP',
            };
        }
        if (chunkType === 'VP8 ' && chunkLength >= 10
            && buffer[dataOffset + 3] === 0x9d && buffer[dataOffset + 4] === 0x01 && buffer[dataOffset + 5] === 0x2a) {
            return {
                width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
                height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
                format: 'WebP',
            };
        }
        if (chunkType === 'VP8L' && chunkLength >= 5 && buffer[dataOffset] === 0x2f) {
            const dimensions = buffer.readUInt32LE(dataOffset + 1);
            return {
                width: (dimensions & 0x3fff) + 1,
                height: ((dimensions >>> 14) & 0x3fff) + 1,
                format: 'WebP',
            };
        }
        offset = dataOffset + chunkLength + (chunkLength % 2);
    }
    return undefined;
}

function assertSafeEncodedImage(buffer, label, maxPixels = GALLERY_SOURCE_MAX_PIXELS) {
    if (!Buffer.isBuffer(buffer)) throw new Error(`Verification image ${label} did not provide an encoded image buffer.`);
    const dimensions = getPngDimensions(buffer)
        ?? getGifDimensions(buffer)
        ?? getJpegDimensions(buffer)
        ?? getWebpDimensions(buffer);
    if (!dimensions) throw new Error(`Could not read safe encoded dimensions for verification image ${label}.`);
    if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)
        || dimensions.width < 1 || dimensions.height < 1
        || dimensions.width > GALLERY_SOURCE_MAX_DIMENSION
        || dimensions.height > GALLERY_SOURCE_MAX_DIMENSION
        || dimensions.width * dimensions.height > maxPixels) {
        throw new Error(
            `Verification image ${label} declares ${dimensions.width}x${dimensions.height}, `
            + `exceeding the safe ${maxPixels}-pixel source-image limit.`,
        );
    }
    return dimensions;
}

function assertSafeDecodedImage(image, label, maxPixels = GALLERY_SOURCE_MAX_PIXELS) {
    const width = Number(image?.width);
    const height = Number(image?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error(`Verification image ${label} decoded with invalid dimensions.`);
    }
    if (width > GALLERY_SOURCE_MAX_DIMENSION
        || height > GALLERY_SOURCE_MAX_DIMENSION
        || width * height > maxPixels) {
        throw new Error(
            `Verification image ${label} decoded to ${width}x${height}, `
            + `exceeding the safe ${maxPixels}-pixel source-image limit.`,
        );
    }
    return image;
}

async function loadGalleryImage(buffer, label, maxPixels = GALLERY_SOURCE_MAX_PIXELS) {
    const { loadImage } = getCanvasApi();
    assertSafeEncodedImage(buffer, label, maxPixels);
    try {
        return assertSafeDecodedImage(await loadImage(buffer), label, maxPixels);
    }
    catch (err) {
        throw new Error(`Could not decode verification image ${label}: ${err?.message ?? String(err)}`);
    }
}

function assertSafeCanvasDimensions(width, height, label) {
    if (width > GALLERY_COMPOSITE_MAX_DIMENSION
        || height > GALLERY_COMPOSITE_MAX_DIMENSION
        || width * height > GALLERY_COMPOSITE_MAX_PIXELS) {
        throw new Error(`${label} canvas ${width}x${height} exceeds the safe rendering limit.`);
    }
}

function assertGalleryDeadline(deadline, label) {
    if (Date.now() < deadline) return;
    throw createVerificationImageRenderError(
        `${label} exceeded its ${GALLERY_COMPOSITE_RENDER_TIMEOUT_MS}ms overall rendering deadline.`,
        VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    );
}

function getClockPositionPoint(centerX, centerY, radius, degrees) {
    const radians = normalizeDegrees(degrees) * Math.PI / 180;

    return {
        x: centerX + (Math.sin(radians) * radius),
        y: centerY - (Math.cos(radians) * radius),
    };
}

function createGalleryImageNonce() {
    return crypto.randomBytes(12).toString('hex');
}

function buildGalleryAttachmentName(image, extension) {
    return `${GALLERY_IMAGE_ATTACHMENT_NAME_PREFIX}-${createGalleryImageNonce()}-${image.position}.${extension}`;
}

function resolveLocalGalleryImagePath(image) {
    if (!image?.filePath || path.resolve(image.filePath) !== image.filePath) {
        throw new Error(`Invalid local verification image path for position ${image?.position ?? 'unknown'}.`);
    }
    return image.filePath;
}

function getGalleryImageExtensionFromPath(filePath) {
    const extension = path.extname(filePath).slice(1).toLowerCase();

    return /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'png';
}

async function readLocalImageBuffer(image, priority = 'live') {
    // The operating system already caches frequently read local files. Keeping
    // another process-wide Buffer copy retained every verification image for the
    // lifetime of the bot and could grow after files changed on disk.
    return readVerificationImageFile(image, { priority });
}

async function readLocalGalleryImageAttachment(image, priority) {
    const filePath = resolveLocalGalleryImagePath(image);
    const extension = getGalleryImageExtensionFromPath(filePath);
    const name = buildGalleryAttachmentName(image, extension);
    const buffer = await readLocalImageBuffer(image, priority);

    return {
        ...image,
        displayUrl: `attachment://${name}`,
        attachment: new (getDiscordApi().AttachmentBuilder)(buffer, { name }),
        buffer,
    };
}

function buildGalleryCompositeAttachmentName() {
    return `${GALLERY_COMPOSITE_ATTACHMENT_NAME_PREFIX}-${createGalleryImageNonce()}.png`;
}

function drawRotationAlignmentTileBackground(context, canvasConfig) {
    context.fillStyle = canvasConfig.background;
    context.fillRect(0, 0, canvasConfig.width, canvasConfig.height);

    const centerX = canvasConfig.width / 2;
    const centerY = canvasConfig.height / 2;

    context.save();
    context.globalAlpha = 0.22;
    context.strokeStyle = 'rgba(255, 113, 0, 0.45)';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(centerX, centerY, canvasConfig.outerRadius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
}

function drawRotationAlignmentImage(context, loadedImage, centerX, centerY, maxSize, rotationDegrees, glowColor) {
    const scale = Math.min(maxSize / loadedImage.width, maxSize / loadedImage.height);
    const width = loadedImage.width * scale;
    const height = loadedImage.height * scale;

    context.save();
    context.translate(centerX, centerY);
    context.rotate(normalizeDegrees(rotationDegrees) * Math.PI / 180);

    if (glowColor) {
        context.shadowColor = glowColor;
        context.shadowBlur = 18;
    }

    context.drawImage(loadedImage, -width / 2, -height / 2, width, height);
    context.restore();
}

async function readGallerySourceImageBuffer(sourceImage, position) {
    const image = { ...sourceImage, position };
    resolveLocalGalleryImagePath(image);
    return readLocalImageBuffer(image);
}

async function renderRotationAlignmentTileCanvas(
    image,
    sourceMaxPixels = GALLERY_SOURCE_MAX_PIXELS,
) {
    const { createCanvas } = getCanvasApi();
    const tile = image.generatedTile;
    const centerSource = tile.centerImage;
    const outerSource = tile.outerImage;

    if (!centerSource || !outerSource) {
        throw new Error(`Unknown rotation-alignment tile source for position ${image.position}.`);
    }

    const canvasConfig = getImageGenerationConfig().gallery.rotationAlignmentTile;
    assertSafeCanvasDimensions(canvasConfig.width, canvasConfig.height, 'Rotation-alignment tile');
    const canvas = createCanvas(canvasConfig.width, canvasConfig.height);
    const context = canvas.getContext('2d');
    const centerX = canvasConfig.width / 2;
    const centerY = canvasConfig.height / 2;
    const outerPoint = getClockPositionPoint(centerX, centerY, canvasConfig.outerRadius, tile.clockPositionDegrees);

    drawRotationAlignmentTileBackground(context, canvasConfig);
    await loadAndDrawRotationAlignmentSource(
        context,
        centerSource,
        image.position,
        sourceMaxPixels,
        centerX,
        centerY,
        Math.min(canvasConfig.width, canvasConfig.height) * canvasConfig.centerScale,
        tile.centerRotationDegrees,
        canvasConfig.glow ? 'rgba(118, 215, 255, 0.75)' : undefined,
    );
    await loadAndDrawRotationAlignmentSource(
        context,
        outerSource,
        image.position,
        sourceMaxPixels,
        outerPoint.x,
        outerPoint.y,
        Math.min(canvasConfig.width, canvasConfig.height) * canvasConfig.outerScale,
        tile.outerRotationDegrees,
        canvasConfig.glow ? 'rgba(255, 113, 0, 0.75)' : undefined,
    );

    return canvas;
}

async function loadAndDrawRotationAlignmentSource(
    context,
    source,
    position,
    sourceMaxPixels,
    centerX,
    centerY,
    maxSize,
    rotationDegrees,
    glowColor,
) {
    let sourceBuffer;
    let loadedImage;
    try {
        sourceBuffer = await readGallerySourceImageBuffer(source, position);
        loadedImage = await loadGalleryImage(
            sourceBuffer,
            source.id ?? `source at position ${position}`,
            sourceMaxPixels,
        );
        drawRotationAlignmentImage(
            context,
            loadedImage,
            centerX,
            centerY,
            maxSize,
            rotationDegrees,
            glowColor,
        );
    }
    finally {
        // Only the completed canvas survives this step. The disposable child
        // can reclaim each encoded/decoded source before loading the next one.
        sourceBuffer = undefined;
        loadedImage = undefined;
        global.gc?.();
    }
}

async function renderRotationAlignmentTileBuffer(image) {
    return (await renderRotationAlignmentTileCanvas(image)).encode('png');
}

async function renderRotationAlignmentTileBuffers(images) {
    const buffers = [];
    for (const image of images ?? []) {
        buffers.push(await renderRotationAlignmentTileBuffer(image));
        // The disposable renderer exposes GC so decoded native Image/canvas
        // allocations from one tile are returned before the next tile.
        global.gc?.();
    }
    return buffers;
}

function drawImageCover(context, image, x, y, width, height) {
    const sourceRatio = image.width / image.height;
    const targetRatio = width / height;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = image.width;
    let sourceHeight = image.height;

    if (sourceRatio > targetRatio) {
        sourceWidth = image.height * targetRatio;
        sourceX = (image.width - sourceWidth) / 2;
    }
    else {
        sourceHeight = image.width / targetRatio;
        sourceY = (image.height - sourceHeight) / 2;
    }

    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawGalleryCompositeLabel(context, label, x, y, compositeConfig) {
    context.save();
    context.font = `700 ${compositeConfig.labelSize}px Arial, Helvetica, sans-serif`;
    context.textBaseline = 'top';
    context.textAlign = 'left';

    const frameInset = 8;
    const frameX = x + frameInset;
    const frameY = y + frameInset;
    const labelEdge = Math.ceil(compositeConfig.labelSize + (compositeConfig.labelPadding * 5.62));

    context.beginPath();
    context.moveTo(frameX, frameY);
    context.lineTo(frameX + labelEdge, frameY);
    context.lineTo(frameX, frameY + labelEdge);
    context.closePath();

    context.fillStyle = '#ff7100';
    context.fill();

    const labelInsetX = Math.max(2, compositeConfig.labelPadding - 2);
    const labelInsetY = Math.max(1, compositeConfig.labelPadding / 3);

    context.fillStyle = 'rgba(255, 255, 255, 0.9)';
    context.fillText(label, frameX + labelInsetX, frameY + labelInsetY);
    context.restore();
}

function resolveGalleryCompositeConfig(overrides) {
    const configured = getImageGenerationConfig().gallery.composite;
    if (!overrides) return configured;
    return {
        tileSize: Math.floor(getBoundedNumber(overrides.tileSize, configured.tileSize, 32, 1_024)),
        labelPadding: getBoundedNumber(overrides.labelPadding, configured.labelPadding, 0, 64),
        labelSize: Math.floor(getBoundedNumber(overrides.labelSize, configured.labelSize, 8, 256)),
    };
}

function resolveGalleryCompositeGrid(itemCount) {
    const count = Number(itemCount);
    const columns = GALLERY_COMPOSITE_COLUMNS_BY_SIZE[count];
    if (!Number.isInteger(count) || !columns) {
        throw new Error(`Gallery composite requires between 1 and ${GALLERY_COMPOSITE_COLUMNS_BY_SIZE.length - 1} images.`);
    }

    const rows = Math.ceil(count / columns);
    if (rows > columns) {
        throw new Error(`Gallery composite layout ${columns}x${rows} would be taller than it is wide.`);
    }
    return { columns, rows };
}

async function loadGalleryCompositeSourceImage(image) {
    if (image?.generatedTile?.type === 'rotationAlignment') {
        // The generated tile is already a drawable canvas in this child.
        // Avoid encoding it to PNG only to decode it again into the composite.
        return renderRotationAlignmentTileCanvas(image, GALLERY_COMPOSITE_SOURCE_MAX_PIXELS);
    }
    resolveLocalGalleryImagePath(image);
    const buffer = await readLocalImageBuffer(image);
    return loadGalleryImage(
        buffer,
        image.id ?? `position ${image.position}`,
        GALLERY_COMPOSITE_SOURCE_MAX_PIXELS,
    );
}

async function renderGalleryCompositeBuffer(images, compositeLayout, showPositionLabels = true) {
    if (!Array.isArray(images)) {
        throw new TypeError('Gallery composite rendering requires an image list.');
    }
    const { createCanvas } = getCanvasApi();
    const compositeConfig = resolveGalleryCompositeConfig(compositeLayout);
    const { columns, rows } = resolveGalleryCompositeGrid(images.length);
    const width = columns * compositeConfig.tileSize;
    const height = rows * compositeConfig.tileSize;
    assertSafeCanvasDimensions(width, height, 'Gallery composite');
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    const renderDeadline = Date.now() + GALLERY_COMPOSITE_RENDER_TIMEOUT_MS;

    //context.fillStyle = '#05070d';
    //context.fillRect(0, 0, width, height);

    for (let index = 0; index < images.length; index += 1) {
        assertGalleryDeadline(renderDeadline, 'Gallery composite');
        let loadedImage;
        try {
            const image = images[index];
            loadedImage = await loadGalleryCompositeSourceImage(image);
            assertGalleryDeadline(renderDeadline, 'Gallery composite');
            const column = index % columns;
            const row = Math.floor(index / columns);
            const rowItemCount = Math.min(columns, images.length - (row * columns));
            const rowOffset = ((columns - rowItemCount) * compositeConfig.tileSize) / 2;
            const x = rowOffset + (column * compositeConfig.tileSize);
            const y = row * compositeConfig.tileSize;

            drawImageCover(
                context,
                loadedImage,
                x,
                y,
                compositeConfig.tileSize,
                compositeConfig.tileSize,
            );
            if (showPositionLabels) {
                drawGalleryCompositeLabel(
                    context,
                    String(image.position),
                    x,
                    y,
                    compositeConfig,
                );
            }
        }
        finally {
            loadedImage = undefined;
            global.gc?.();
        }
    }

    assertGalleryDeadline(renderDeadline, 'Gallery composite');
    return canvas.encode('png');
}

async function createGalleryCompositeBuffer(
    selectedImages,
    compositeLayout,
    priority,
    showPositionLabels = true,
    signal,
) {
    throwIfAborted(signal);
    const result = await submitVerificationRenderJob(
        'gallery-grid',
        {
            images: selectedImages.map(getGalleryRenderSource),
            layout: compositeLayout,
            showPositionLabels,
        },
        {
            priority,
            signal,
            timeoutMs: GALLERY_COMPOSITE_RENDER_TIMEOUT_MS,
            label: 'Rendering verification composite gallery',
        },
    );
    const buffer = result.buffers[0];
    if (!buffer) throw new Error('Verification gallery process returned no composite image.');
    return buffer;
}

function getGalleryRenderSource(image) {
    const source = {
        id: image?.id,
        filePath: image?.filePath,
        rootDirectory: image?.rootDirectory,
        size: image?.size,
        modifiedAtMs: image?.modifiedAtMs,
        changedAtMs: image?.changedAtMs,
        inode: image?.inode,
        contentSha256: image?.contentSha256,
        position: image?.position,
    };
    if (image?.generatedTile?.type === 'rotationAlignment') {
        const tile = image.generatedTile;
        source.generatedTile = {
            type: tile.type,
            centerImage: tile.centerImage ? getGalleryRenderSource(tile.centerImage) : undefined,
            outerImage: tile.outerImage ? getGalleryRenderSource(tile.outerImage) : undefined,
            clockPositionDegrees: tile.clockPositionDegrees,
            centerRotationDegrees: tile.centerRotationDegrees,
            outerRotationDegrees: tile.outerRotationDegrees,
        };
    }
    return source;
}

function buildPngGalleryAttachment(image, buffer) {
    const name = buildGalleryAttachmentName(image, 'png');
    return {
        ...image,
        displayUrl: `attachment://${name}`,
        attachment: new (getDiscordApi().AttachmentBuilder)(buffer, { name }),
        buffer,
    };
}

function reserveGalleryBuffer(byteBudget, buffer, label) {
    byteBudget?.reserve(buffer, label);
    return buffer;
}

async function prepareIndividualGalleryAttachments(selectedImages, priority, byteBudget, signal) {
    const generatedIndexes = [];
    const generatedImages = [];
    selectedImages.forEach((image, index) => {
        if (image?.generatedTile?.type !== 'rotationAlignment') return;
        generatedIndexes.push(index);
        generatedImages.push(getGalleryRenderSource(image));
    });

    let generatedBuffers = [];
    if (generatedImages.length > 0) {
        throwIfAborted(signal);
        if (priority === 'stock') {
            for (const [index, image] of generatedImages.entries()) {
                throwIfAborted(signal);
                const result = await submitVerificationRenderJob(
                    'rotation-tiles',
                    { images: [image] },
                    {
                        priority,
                        signal,
                        timeoutMs: ROTATION_TILE_BATCH_RENDER_TIMEOUT_MS,
                        label: `Pre-generating verification rotation tile ${index + 1}/${generatedImages.length}`,
                    },
                );
                generatedBuffers.push(result.buffers[0]);
            }
        }
        else {
            const result = await submitVerificationRenderJob(
                'rotation-tiles',
                { images: generatedImages },
                {
                    priority,
                    signal,
                    timeoutMs: ROTATION_TILE_BATCH_RENDER_TIMEOUT_MS,
                    label: 'Rendering verification rotation gallery',
                },
            );
            generatedBuffers = result.buffers;
        }
        if (generatedBuffers.length !== generatedImages.length) {
            throw new Error('Verification rotation process returned an incomplete image batch.');
        }
        generatedBuffers.forEach((buffer) =>
            reserveGalleryBuffer(byteBudget, buffer, 'Verification rotation gallery'));
    }

    const buffersByIndex = new Map(generatedIndexes.map((index, bufferIndex) =>
        [index, generatedBuffers[bufferIndex]]));
    const attachments = [];
    for (let index = 0; index < selectedImages.length; index += 1) {
        throwIfAborted(signal);
        const image = selectedImages[index];
        const generatedBuffer = buffersByIndex.get(index);
        if (generatedBuffer) {
            attachments.push(buildPngGalleryAttachment(image, generatedBuffer));
            continue;
        }
        const attachment = await readLocalGalleryImageAttachment(image, priority);
        reserveGalleryBuffer(
            byteBudget,
            attachment.buffer,
            `Verification gallery image ${image.id ?? index + 1}`,
        );
        attachments.push(attachment);
    }
    return attachments;
}

async function prepareGalleryImageAttachments(
    galleryState,
    { priority = 'live', byteBudget, signal } = {},
) {
    throwIfAborted(signal);
    if (!galleryState?.selectedImages?.length) {
        return galleryState;
    }

    if (galleryState.useCompositeImage) {
        const buffer = await createGalleryCompositeBuffer(
            galleryState.selectedImages,
            galleryState.compositeLayout,
            priority,
            galleryState.showPositionLabels !== false,
            signal,
        );
        reserveGalleryBuffer(byteBudget, buffer, 'Verification composite gallery');
        const name = buildGalleryCompositeAttachmentName();
        const compositeImage = {
            displayUrl: `attachment://${name}`,
            attachment: new (getDiscordApi().AttachmentBuilder)(buffer, { name }),
        };
        const selectedImages = galleryState.selectedImages.map(({ attachment, buffer, ...image }) => image);
        return {
            ...galleryState,
            selectedImages,
            compositeImage,
        };
    }

    const selectedImages = await prepareIndividualGalleryAttachments(
        galleryState.selectedImages,
        priority,
        byteBudget,
        signal,
    );

    return {
        ...galleryState,
        selectedImages,
    };
}

function getGalleryDisplayImages(galleryState) {
    if (galleryState?.compositeImage?.displayUrl) {
        return [{
            type: 'image',
            displayUrl: galleryState.compositeImage.displayUrl,
            description: `Positions 1-${galleryState.selectedImages?.length ?? 9} in a labeled grid`,
        }];
    }

    return (galleryState?.selectedImages ?? []).map((image) => ({
        type: 'image',
        displayUrl: image.displayUrl,
        description: image.description ?? `Position ${image.position}`,
    }));
}

module.exports = {
    getGalleryDisplayImages,
    prepareGalleryImageAttachments,
    renderGalleryCompositeBuffer,
    renderRotationAlignmentTileBuffers,
};
