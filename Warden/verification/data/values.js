function parseStoredJson(value, fallback, context = 'verification persistence', expectedType) {
    if (value === null || value === undefined || value === '') return fallback;
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (err) {
        const error = new Error(`Stored ${context} JSON is invalid.`, { cause: err });
        error.code = 'VERIFICATION_INVALID_STORED_JSON';
        throw error;
    }
    const hasExpectedType = expectedType === undefined
        || (expectedType === 'array' && Array.isArray(parsed))
        || (expectedType === 'object' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
    if (!hasExpectedType) {
        const error = new Error(`Stored ${context} JSON must contain ${expectedType === 'array' ? 'an array' : 'an object'}.`);
        error.code = 'VERIFICATION_INVALID_STORED_JSON_SHAPE';
        throw error;
    }
    return parsed;
}

function stringifyJsonOrNull(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value) && value.length < 1) return null;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length < 1) return null;
    return JSON.stringify(value);
}

function cloneCatalogValue(value) {
    if (Array.isArray(value)) return value.map(cloneCatalogValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneCatalogValue(entry)]));
    }
    return value;
}

function normalizeComparableValue(value) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
        if (value.length < 1) return undefined;
        return value.map(normalizeComparableValue);
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, normalizeComparableValue(entry)])
            .filter(([, entry]) => entry !== undefined);
        return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    return value;
}

function comparableValuesEqual(left, right) {
    return JSON.stringify(normalizeComparableValue(left)) === JSON.stringify(normalizeComparableValue(right));
}

function normalizeBoolean(value) {
    return value === true || value === 1 || value === '1';
}

function normalizeDatabaseTimestamp(value, epochSeconds) {
    if (epochSeconds !== null && epochSeconds !== undefined && epochSeconds !== '') {
        const milliseconds = Number(epochSeconds) * 1000;
        const date = new Date(milliseconds);
        if (Number.isFinite(date.getTime())) return date.toISOString();
    }
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value?.toISOString === 'function') return value.toISOString();
    return String(value);
}

module.exports = {
    parseStoredJson,
    stringifyJsonOrNull,
    cloneCatalogValue,
    comparableValuesEqual,
    normalizeBoolean,
    normalizeDatabaseTimestamp,
};
