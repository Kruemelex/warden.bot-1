const VERIFICATION_IMAGE_OPERATION_TIMEOUT = 'VERIFICATION_IMAGE_OPERATION_TIMEOUT';
const VERIFICATION_IMAGE_OPERATION_BUSY = 'VERIFICATION_IMAGE_OPERATION_BUSY';
const VERIFICATION_IMAGE_PROCESS_START_FAILED = 'VERIFICATION_IMAGE_PROCESS_START_FAILED';
const VERIFICATION_IMAGE_PROCESS_FAILED = 'VERIFICATION_IMAGE_PROCESS_FAILED';
const VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED = 'VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED';

const VERIFICATION_IMAGE_PHASE_QUEUE = 'queue';
const VERIFICATION_IMAGE_PHASE_RENDER = 'render';
const VERIFICATION_IMAGE_PHASE_PROCESS = 'process';
const VERIFICATION_IMAGE_PHASE_CONTRACT = 'contract';

function createVerificationImageError(
    message,
    code,
    phase = VERIFICATION_IMAGE_PHASE_CONTRACT,
    cause,
) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    error.phase = phase;
    return error;
}

function createVerificationImageQueueError(message, code, cause) {
    return createVerificationImageError(message, code, VERIFICATION_IMAGE_PHASE_QUEUE, cause);
}

function createVerificationImageRenderError(message, code, cause) {
    return createVerificationImageError(message, code, VERIFICATION_IMAGE_PHASE_RENDER, cause);
}

function createVerificationImageProcessError(message, code, cause) {
    return createVerificationImageError(message, code, VERIFICATION_IMAGE_PHASE_PROCESS, cause);
}

function createVerificationImageContractError(message, code, cause) {
    return createVerificationImageError(message, code, VERIFICATION_IMAGE_PHASE_CONTRACT, cause);
}

function isVerificationRenderCapacityError(error) {
    return (
        error?.code === VERIFICATION_IMAGE_OPERATION_BUSY
        || error?.code === VERIFICATION_IMAGE_OPERATION_TIMEOUT
    ) && error?.phase === VERIFICATION_IMAGE_PHASE_QUEUE;
}

function isVerificationRenderAvailabilityError(error) {
    return error?.code === VERIFICATION_IMAGE_PROCESS_START_FAILED
        || error?.code === VERIFICATION_IMAGE_PROCESS_FAILED
        || error?.code === VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED;
}

module.exports = {
    VERIFICATION_IMAGE_OPERATION_BUSY,
    VERIFICATION_IMAGE_OPERATION_TIMEOUT,
    VERIFICATION_IMAGE_PROCESS_FAILED,
    VERIFICATION_IMAGE_PROCESS_MESSAGE_FAILED,
    VERIFICATION_IMAGE_PROCESS_START_FAILED,
    createVerificationImageContractError,
    createVerificationImageProcessError,
    createVerificationImageQueueError,
    createVerificationImageRenderError,
    isVerificationRenderAvailabilityError,
    isVerificationRenderCapacityError,
};
