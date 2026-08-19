'use strict';

class ExpectedInteractionError extends Error {
    constructor(message, options) {
        super(String(message || 'This action is not currently available.'), options);
        this.name = 'ExpectedInteractionError';
    }
}

function expectedInteractionError(message, options) {
    return new ExpectedInteractionError(message, options);
}

function isExpectedInteractionError(error) {
    return error instanceof ExpectedInteractionError;
}

function reportUnexpectedInteractionError(reporter, action, error, data) {
    if (isExpectedInteractionError(error)) return false;
    reporter.error(action, error, data);
    return true;
}

module.exports = {
    ExpectedInteractionError,
    expectedInteractionError,
    isExpectedInteractionError,
    reportUnexpectedInteractionError,
};
