'use strict';

const {
    createConsoleReporter,
    logConsoleStartupStatus,
} = require('../../consoleReporting');

const verificationReporter = createConsoleReporter('Verification');

function createVerificationLogger(subsystem, options) {
    if (options) return createConsoleReporter('Verification', options).forSubsystem(subsystem);
    return verificationReporter.forSubsystem(subsystem);
}

module.exports = {
    createVerificationLogger,
    logVerificationStartupStatus: logConsoleStartupStatus,
};
