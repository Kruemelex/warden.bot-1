'use strict';

function getBoundedEnvironmentInteger(name, fallback, minimum, maximum) {
    const configured = Number(process.env[name]);
    return Number.isInteger(configured) && configured >= minimum && configured <= maximum
        ? configured
        : fallback;
}

module.exports = { getBoundedEnvironmentInteger };
