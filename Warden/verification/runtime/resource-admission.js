const {
    VERIFICATION_IMAGE_OPERATION_BUSY,
    VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    createVerificationImageQueueError,
} = require('../assets/errors');
const { createPrioritySemaphore } = require('./priority-semaphore');

const PRIORITIES = Object.freeze({
    live: 'live',
    preview: 'admin',
    admin: 'admin',
    stock: 'background',
});

function createVerificationResourceAdmission({
    capacity,
    maxPending,
    defaultTimeoutMs,
    busyMessage,
    timeoutMessage,
}) {
    const semaphore = createPrioritySemaphore({ capacity, maxPending });

    function options({ priority = 'live', timeoutMs = defaultTimeoutMs, signal } = {}) {
        return { priority: PRIORITIES[priority] ?? PRIORITIES.admin, timeoutMs, signal };
    }

    function mapError(error, label, timeoutMs) {
        if (error?.code === 'PRIORITY_SEMAPHORE_QUEUE_FULL') {
            return createVerificationImageQueueError(
                busyMessage(maxPending),
                VERIFICATION_IMAGE_OPERATION_BUSY,
            );
        }
        if (error?.code === 'PRIORITY_SEMAPHORE_QUEUE_TIMEOUT') {
            return createVerificationImageQueueError(
                timeoutMessage(label, timeoutMs),
                VERIFICATION_IMAGE_OPERATION_TIMEOUT,
            );
        }
        return error;
    }

    async function acquire(settings = {}) {
        const timeoutMs = settings.timeoutMs ?? defaultTimeoutMs;
        try {
            return await semaphore.acquire(options(settings));
        }
        catch (error) {
            throw mapError(error, settings.label, timeoutMs);
        }
    }

    async function run(operation, settings = {}) {
        const timeoutMs = settings.timeoutMs ?? defaultTimeoutMs;
        try {
            return await semaphore.run(operation, options(settings));
        }
        catch (error) {
            throw mapError(error, settings.label, timeoutMs);
        }
    }

    return Object.freeze({
        acquire,
        getStats: semaphore.getStats.bind(semaphore),
        run,
    });
}

const attachmentAdmission = createVerificationResourceAdmission({
    capacity: 2,
    maxPending: 12,
    defaultTimeoutMs: 60_000,
    busyMessage: (limit) =>
        `Verification attachment delivery is temporarily busy (${limit} screens pending).`,
    timeoutMessage: (label = 'Preparing verification screen attachments', timeoutMs) =>
        `${label} timed out after ${timeoutMs}ms while waiting for attachment capacity.`,
});

const imageReadAdmission = createVerificationResourceAdmission({
    capacity: 2,
    maxPending: 16,
    defaultTimeoutMs: 10_000,
    busyMessage: (limit) =>
        `Verification image reads are temporarily busy (${limit} jobs pending).`,
    timeoutMessage: (label = 'Reading verification image', timeoutMs) =>
        `${label} timed out after ${timeoutMs}ms while waiting to start.`,
});

module.exports = {
    acquireVerificationAttachmentDelivery: attachmentAdmission.acquire,
    createVerificationResourceAdmission,
    getVerificationAttachmentDeliveryStats: attachmentAdmission.getStats,
    runVerificationImageRead: imageReadAdmission.run,
};
