'use strict';

const {
    normalizeTrimmedText,
    optimisticEditsChanged,
    resolveOptimisticEdit,
    sameStringSet,
} = require('../../ux/interactions/optimisticEdits');

function parseAnswerOverrideList(input) {
    return String(input ?? '')
        .split(/[\n,]+/)
        .map((answer) => answer.trim())
        .filter(Boolean);
}

function resolveBaselineEdit(field, baseline, current, submitted) {
    return resolveOptimisticEdit({
        label: field,
        opening: baseline?.[field],
        current,
        submitted,
        normalize: normalizeTrimmedText,
    });
}

function resolveBaselineAnswersEdit(baseline, currentAnswers, submittedAnswers) {
    return resolveOptimisticEdit({
        label: 'accepted answers',
        opening: parseAnswerOverrideList(baseline?.answers ?? ''),
        current: currentAnswers ?? [],
        submitted: submittedAnswers ?? [],
        equals: sameStringSet,
        conflictMessage: 'Accepted answers were changed by another administrator. Reopen the editor and apply your change again.',
    });
}

function resolveBaselineStringSetEdit(field, openingValues, currentValues, submittedValues) {
    return resolveOptimisticEdit({
        label: field,
        opening: openingValues ?? [],
        current: currentValues ?? [],
        submitted: submittedValues ?? [],
        equals: sameStringSet,
        conflictMessage: `The ${field} were changed by another administrator. Reopen the editor and apply your change again.`,
    });
}

function resolveBaselineEdits(baseline, definitions = {}) {
    return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => {
        const field = definition.field ?? key;
        const edit = definition.kind === 'string-set'
            ? resolveBaselineStringSetEdit(
                field,
                definition.opening ?? baseline?.[definition.baselineKey ?? field],
                definition.current,
                definition.submitted,
            )
            : resolveBaselineEdit(
                definition.baselineKey ?? field,
                baseline,
                definition.current,
                definition.submitted,
            );
        return [key, edit];
    }));
}

function baselineEditsChanged(edits = {}) {
    return optimisticEditsChanged(edits);
}

module.exports = {
    parseAnswerOverrideList,
    baselineEditsChanged,
    resolveBaselineAnswersEdit,
    resolveBaselineEdit,
    resolveBaselineEdits,
    resolveBaselineStringSetEdit,
    sameStringSet,
};
