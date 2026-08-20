'use strict';

const DOCUMENT_KINDS = Object.freeze({
    uxPanel: 'ux-panel',
    challengeScreen: 'challenge-screen',
    notice: 'notice',
});

const BLOCK_KINDS = Object.freeze({
    actions: 'actions',
    gallery: 'gallery',
    group: 'group',
    separator: 'separator',
    section: 'section',
    text: 'text',
});

function cloneComponent(component) {
    const data = component?.toJSON?.() ?? component;
    if (!data || typeof data !== 'object') throw new Error('UX actions and accessories must be Discord components.');
    return JSON.parse(JSON.stringify(data));
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    // Attachments and buffers are transport resources, not semantic document data.
    if (Buffer.isBuffer(value) || typeof value.pipe === 'function' || value.constructor?.name === 'AttachmentBuilder') return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function text(value) {
    return String(value ?? '').trim();
}

function normalizeFiles(files = []) {
    if (!Array.isArray(files)) throw new Error('UX document files must be an array.');
    return Object.freeze([...files]);
}

function normalizeActionRows(rows = []) {
    if (!Array.isArray(rows)) throw new Error('UX document actions must be an array.');
    return rows.filter(Boolean).map(cloneComponent);
}

function normalizeFields(fields = []) {
    if (!Array.isArray(fields)) throw new Error('UX document fields must be an array.');
    return fields.filter(Boolean).map((field) => ({
        name: text(field.name ?? field.title) || 'Information',
        value: text(field.value ?? field.content ?? field.description),
        inline: field.inline === true,
    })).filter((field) => field.value);
}

function normalizeMediaItems(items = []) {
    if (!Array.isArray(items)) throw new Error('UX gallery items must be an array.');
    return items.filter(Boolean).map((item) => {
        const url = text(item.url ?? item.displayUrl);
        if (!url) throw new Error('Every UX gallery item requires a URL.');
        return {
            url,
            description: text(item.description) || undefined,
            spoiler: item.spoiler === true,
        };
    });
}

function normalizeEditorBlock(block) {
    const kind = text(block?.kind);
    if (!Object.values(BLOCK_KINDS).includes(kind)) {
        throw new Error(`Unknown UX editor block kind: ${kind || '(missing)'}`);
    }

    if (kind === BLOCK_KINDS.text) {
        const content = text(block.content);
        if (!content) throw new Error('UX text blocks require content.');
        return { kind, content };
    }
    if (kind === BLOCK_KINDS.group) {
        if (!Array.isArray(block.blocks) || block.blocks.length < 1) {
            throw new Error('UX group blocks require at least one child block.');
        }
        return { kind, blocks: block.blocks.map(normalizeEditorBlock) };
    }
    if (kind === BLOCK_KINDS.separator) {
        return {
            kind,
            divider: block.divider !== false,
            spacing: block.spacing ?? 'Large',
        };
    }
    if (kind === BLOCK_KINDS.gallery) {
        const items = normalizeMediaItems(block.items);
        if (items.length < 1) throw new Error('UX gallery blocks require at least one item.');
        return { kind, items };
    }
    if (kind === BLOCK_KINDS.actions) {
        const rows = normalizeActionRows(block.rows ?? (block.row ? [block.row] : []));
        if (rows.length < 1) throw new Error('UX action blocks require at least one action row.');
        return { kind, rows };
    }

    const content = [].concat(block.content ?? block.text ?? [])
        .map(text)
        .filter(Boolean);
    if (block.title) content.unshift(`### ${text(block.title)}`);
    if (content.length < 1) throw new Error('UX section blocks require text.');
    return {
        kind,
        content,
        accessory: block.accessory ? cloneComponent(block.accessory) : undefined,
    };
}

function finishDocument(document) {
    return deepFreeze(document);
}

function createNoticeDocument({
    title,
    message,
    tone = 'info',
    accentColor,
    fields = [],
    actions = [],
    files = [],
    footer,
    thumbnailUrl,
    author,
    timestamp = false,
    ephemeral = false,
} = {}) {
    const normalizedTitle = text(title);
    const normalizedMessage = text(message);
    if (!normalizedTitle && !normalizedMessage) throw new Error('A notice requires a title or message.');
    return finishDocument({
        kind: DOCUMENT_KINDS.notice,
        tone: text(tone) || 'info',
        accentColor,
        title: normalizedTitle,
        message: normalizedMessage,
        fields: normalizeFields(fields),
        actions: normalizeActionRows(actions),
        files: normalizeFiles(files),
        footer: text(footer) || undefined,
        thumbnailUrl: text(thumbnailUrl) || undefined,
        author: author?.name ? {
            name: text(author.name),
            iconURL: text(author.iconURL ?? author.iconUrl) || undefined,
            url: text(author.url) || undefined,
        } : undefined,
        timestamp: timestamp === true,
        ephemeral: ephemeral === true,
    });
}

function createUXPanelDocument({
    title,
    description,
    accentColor,
    thumbnailUrl,
    fields = [],
    editorBlocks = [],
    actions = [],
    navigationActions = [],
    files = [],
    footer,
    ephemeral = true,
    pagination,
} = {}) {
    const normalizedTitle = text(title);
    if (!normalizedTitle) throw new Error('A UX panel requires a title.');
    if (!Array.isArray(editorBlocks)) throw new Error('UX panel editorBlocks must be an array.');
    return finishDocument({
        kind: DOCUMENT_KINDS.uxPanel,
        accentColor,
        title: normalizedTitle,
        description: text(description),
        thumbnailUrl: text(thumbnailUrl) || undefined,
        fields: normalizeFields(fields),
        editorBlocks: editorBlocks.filter(Boolean).map(normalizeEditorBlock),
        actions: normalizeActionRows(actions),
        navigationActions: normalizeActionRows(navigationActions),
        files: normalizeFiles(files),
        footer: text(footer) || undefined,
        ephemeral: ephemeral !== false,
        pagination: pagination ? { ...pagination } : undefined,
    });
}

function createChallengeScreenDocument({
    title,
    description,
    accentColor,
    includeIntro = true,
    fields = [],
    questions = [],
    expiryText,
    actions = [],
    files = [],
    ephemeral = true,
} = {}) {
    const normalizedTitle = text(title);
    if (!normalizedTitle) throw new Error('A challenge screen requires a title.');
    if (!Array.isArray(questions)) throw new Error('Challenge screen questions must be an array.');
    return finishDocument({
        kind: DOCUMENT_KINDS.challengeScreen,
        accentColor,
        includeIntro: includeIntro !== false,
        title: normalizedTitle,
        description: text(description),
        fields: normalizeFields(fields),
        questions: questions.filter(Boolean).map((question, index) => ({
            id: text(question.id) || `question-${index + 1}`,
            label: text(question.label ?? question.title ?? question.id) || `Question ${index + 1}`,
            text: text(question.text ?? question.description),
            media: normalizeMediaItems(question.media ?? question.items ?? []),
            inlineMedia: question.inlineMedia !== false,
            helpText: text(question.helpText ?? question.instructions) || undefined,
            progressText: text(question.progressText) || undefined,
        })),
        expiryText: text(expiryText) || undefined,
        actions: normalizeActionRows(actions),
        files: normalizeFiles(files),
        ephemeral: ephemeral !== false,
    });
}

module.exports = {
    createUXPanelDocument,
    createChallengeScreenDocument,
    createNoticeDocument,
};
