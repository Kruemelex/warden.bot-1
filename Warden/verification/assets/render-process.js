const {
    renderGalleryCompositeBuffer,
    renderRotationAlignmentTileBuffers,
} = require('./gallery-renderer');
const { renderPromptImageBuffer } = require('./prompt-renderer');
const {
    normalizeRenderBuffers,
    serializeVerificationRenderError,
    isVerificationRenderJobType,
} = require('./render-contract');
const { createVerificationLogger } = require('../logging');

const renderChildLog = createVerificationLogger('Render child');

if (typeof process.send !== 'function') {
    throw new Error('Verification render process requires an IPC channel.');
}

async function executeRenderJob(type, payload = {}) {
    if (!isVerificationRenderJobType(type)) {
        throw new Error(`Unknown verification render job type: ${type}`);
    }
    let buffers;
    if (type === 'prompt') {
        buffers = [await renderPromptImageBuffer(payload.prompt, payload.config)];
    }
    else if (type === 'gallery-grid') {
        buffers = [await renderGalleryCompositeBuffer(
            payload.images,
            payload.layout,
            payload.showPositionLabels !== false,
        )];
    }
    else if (type === 'rotation-tiles') {
        buffers = await renderRotationAlignmentTileBuffers(payload.images);
    }
    return {
        buffers: normalizeRenderBuffers(buffers, {
            type,
            payload,
            label: 'Verification render operation',
        }),
    };
}

let acceptedJob = false;
let normalDisconnect = false;

process.once('disconnect', () => {
    if (!normalDisconnect) process.exit(1);
});

process.once('message', async ({ jobId, type, payload } = {}) => {
    if (acceptedJob) return;
    acceptedJob = true;

    let response;
    try {
        response = {
            jobId,
            ok: true,
            result: await executeRenderJob(type, payload),
        };
    }
    catch (error) {
        response = {
            jobId,
            ok: false,
            error: serializeVerificationRenderError(error),
        };
    }

    process.send(response, (error) => {
        if (error) {
            renderChildLog.error('Failed to return native render result:', error);
            process.exit(1);
            return;
        }
        normalDisconnect = true;
        process.disconnect();
    });
});
