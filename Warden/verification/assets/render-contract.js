const MAX_RENDER_RESULT_BYTES = 24 * 1024 * 1024;
const MAX_RENDER_BUFFER_COUNT = 25;
const VERIFICATION_RENDER_JOB_TYPES = Object.freeze([
    'prompt',
    'gallery-grid',
    'rotation-tiles',
]);

function isVerificationRenderJobType(type) {
    return VERIFICATION_RENDER_JOB_TYPES.includes(type);
}

function getExpectedRenderBufferCount(typeOrJob, payloadOrJob = {}) {
    const type = typeof typeOrJob === 'string' ? typeOrJob : typeOrJob?.type;
    const payloadSource = typeof typeOrJob === 'string' ? payloadOrJob : typeOrJob;
    const payload = payloadSource && Object.prototype.hasOwnProperty.call(payloadSource, 'payload')
        ? payloadSource.payload
        : payloadSource;
    if (type === 'prompt' || type === 'gallery-grid') return 1;
    if (type === 'rotation-tiles') return payload?.images?.length;
    return undefined;
}

function normalizeRenderBuffer(buffer, label = 'Verification render operation') {
    if (!(buffer instanceof Uint8Array)) {
        throw new TypeError(`${label} returned a non-binary result.`);
    }
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

function normalizeRenderBuffers(buffers, {
    type,
    payload,
    label = 'Verification render operation',
} = {}) {
    if (!Array.isArray(buffers)) {
        throw new TypeError(`${label} returned an invalid buffer list.`);
    }
    const expectedCount = getExpectedRenderBufferCount(type, payload);
    if (
        !Number.isInteger(expectedCount)
        || expectedCount < 1
        || expectedCount > MAX_RENDER_BUFFER_COUNT
        || buffers.length !== expectedCount
    ) {
        throw new RangeError(
            `${label} returned ${buffers.length} buffer(s); `
            + `${expectedCount ?? 'an unknown number'} expected.`,
        );
    }
    let totalBytes = 0;
    return buffers.map((buffer) => {
        const normalized = normalizeRenderBuffer(buffer, label);
        totalBytes += normalized.length;
        if (totalBytes > MAX_RENDER_RESULT_BYTES) {
            throw new RangeError(
                `${label} returned more than ${MAX_RENDER_RESULT_BYTES} bytes.`,
            );
        }
        return normalized;
    });
}

function normalizeRenderResult(result, job, label = 'Verification image process') {
    const buffers = normalizeRenderBuffers(result?.buffers, {
        type: job?.type,
        payload: job?.payload,
        label,
    });
    return { ...result, buffers };
}

function serializeVerificationRenderError(error) {
    return {
        name: error?.name,
        message: error?.message ?? String(error),
        code: error?.code,
        phase: error?.phase,
        stack: error?.stack,
    };
}

function deserializeVerificationRenderError(serialized = {}) {
    const error = new Error(serialized.message ?? 'Verification image process failed.');
    if (serialized.name) error.name = serialized.name;
    if (serialized.code) error.code = serialized.code;
    if (serialized.phase) error.phase = serialized.phase;
    if (serialized.stack) error.stack = serialized.stack;
    return error;
}

module.exports = {
    deserializeVerificationRenderError,
    isVerificationRenderJobType,
    normalizeRenderBuffers,
    normalizeRenderResult,
    serializeVerificationRenderError,
};
