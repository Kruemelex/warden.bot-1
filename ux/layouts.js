'use strict';

const LAYOUTS = Object.freeze({
    'notice': Object.freeze({
        areas: Object.freeze(['summary', 'controls']),
        separator: Object.freeze({ divider: true, spacing: 'Large' }),
        legacyOverflow: 'embed-pages',
    }),
    'ux-panel': Object.freeze({
        areas: Object.freeze(['summary', 'editor', 'controls']),
        separator: Object.freeze({ divider: true, spacing: 'Large' }),
        editorSeparator: Object.freeze({ divider: false, spacing: 'Large' }),
        legacyOverflow: 'embed-pages',
        paginationArea: 'editor',
    }),
    'challenge-screen': Object.freeze({
        areas: Object.freeze(['introduction', 'questions', 'expiry', 'controls']),
        separator: Object.freeze({ divider: true, spacing: 'Large' }),
        questionSeparator: Object.freeze({ divider: false, spacing: 'Large' }),
        legacyOverflow: 'single-message',
    }),
});

function getLayout(kind) {
    const layout = LAYOUTS[kind];
    if (!layout) throw new Error(`No shared UX layout exists for document kind: ${kind}`);
    return layout;
}

module.exports = {
    getLayout,
};
