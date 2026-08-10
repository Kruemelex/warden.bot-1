'use strict';

const identity = (value) => value;
const strictEquals = (left, right) => left === right;

/**
 * @template T
 * @typedef {object} OptimisticEdit
 * @property {boolean} changed
 * @property {T} value
 */

function normalizeTrimmedText(value) {
    return String(value ?? '').trim();
}

function sameStringSet(leftValues = [], rightValues = []) {
    const left = [...new Set(leftValues.map(String))].sort();
    const right = [...new Set(rightValues.map(String))].sort();
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Resolve a field edit against its modal-opening value and freshly loaded
 * current value. This detects friendly field-level conflicts but does not
 * replace a transactional revision check in the commit operation.
 *
 * @template T
 * @returns {OptimisticEdit<T>}
 */
function resolveOptimisticEdit({
    label = 'value',
    opening,
    current,
    submitted,
    normalize = identity,
    equals = strictEquals,
    conflictMessage,
} = {}) {
    const openingValue = normalize(opening);
    const currentValue = normalize(current);
    const submittedValue = normalize(submitted);

    if (equals(submittedValue, openingValue) || equals(submittedValue, currentValue)) {
        return { changed: false, value: currentValue };
    }
    if (!equals(currentValue, openingValue)) {
        const message = typeof conflictMessage === 'function'
            ? conflictMessage({ label, opening: openingValue, current: currentValue, submitted: submittedValue })
            : conflictMessage;
        throw new Error(message || `The ${label} was changed by another administrator. Reopen the editor and apply your change again.`);
    }
    return { changed: true, value: submittedValue };
}

function resolveOptimisticEdits(definitions = {}) {
    return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [
        key,
        resolveOptimisticEdit({ label: definition.label ?? key, ...definition }),
    ]));
}

function optimisticEditsChanged(edits = {}) {
    return Object.values(edits).some((edit) => edit?.changed === true);
}

module.exports = {
    normalizeTrimmedText,
    optimisticEditsChanged,
    resolveOptimisticEdit,
    resolveOptimisticEdits,
    sameStringSet,
};
