'use strict';

const { botIdent } = require('../../../functions');
const verificationEmbedConfig = require('./config.json');

const DESCRIPTION_LIMIT = 4096;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const MAX_FIELDS = 25;
const TITLE_LIMIT = 256;

function applyTextReplacements(text, replacements = {}) {
    let resolvedText = String(text ?? '');
    for (const [key, value] of Object.entries(replacements)) {
        resolvedText = resolvedText.replaceAll(`{${key}}`, String(value ?? ''));
    }
    return resolvedText;
}

function truncateText(value, limit = DESCRIPTION_LIMIT) {
    const text = String(value ?? '');
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 17))}\n... [truncated]`;
}

function formatDuration(seconds) {
    if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function resolveColorAlias(color) {
    if (typeof color !== 'string') return color;
    const colors = verificationEmbedConfig.responseDefaults?.colors ?? {};
    return Object.hasOwn(colors, color) ? colors[color] : color;
}

function resolveEmbedColor(color, fallbackColor = '#3498DB') {
    const resolvedColor = resolveColorAlias(color);
    if (resolvedColor === null) return null;
    const resolvedFallback = resolveColorAlias(fallbackColor);
    const selectedColor = resolvedColor ?? resolvedFallback ?? '#3498DB';
    if (typeof selectedColor === 'string' && /^#[0-9a-fA-F]{3}$/.test(selectedColor)) {
        return `#${selectedColor.slice(1).split('').map((character) => character + character).join('')}`;
    }
    return selectedColor;
}

function resolveTemplate(templateKey) {
    return verificationEmbedConfig.adminResponseTemplates?.[templateKey]
        ?? verificationEmbedConfig[templateKey]
        ?? verificationEmbedConfig.adminResponseTemplates?.genericError
        ?? {};
}

function resolveTemplateColor(template, options = {}, replacements = {}) {
    const colors = verificationEmbedConfig.responseDefaults?.colors ?? {};
    const rawColor = options.color ?? template.color;
    const color = typeof rawColor === 'string'
        ? applyTextReplacements(rawColor, replacements)
        : rawColor;
    const fallback = colors.info ?? '#3498DB';
    return resolveEmbedColor(color, fallback);
}

function resolveActiveBotIconURL() {
    try {
        return botIdent().activeBot?.icon;
    }
    catch (_error) {
        return undefined;
    }
}

function createTemplateField(field, replacements = {}) {
    if (!field) return undefined;
    const rawValue = field.content ?? field.value ?? field.description;
    if (rawValue === undefined || rawValue === null || rawValue === '') return undefined;
    const name = truncateText(
        applyTextReplacements(field.title ?? field.name ?? '\u200B', replacements),
        FIELD_NAME_LIMIT,
    );
    const value = truncateText(applyTextReplacements(rawValue, replacements), FIELD_VALUE_LIMIT);
    if (!value) return undefined;
    return Object.freeze({
        name: name || '\u200B',
        value,
        inline: field.inline === true,
    });
}

function createTemplateFooter(template, replacements, options) {
    const defaults = verificationEmbedConfig.responseDefaults ?? {};
    const defaultFooter = defaults.footer ?? {};
    const footer = options.footer ?? template.footer;
    const useDefaultFooter = footer === undefined && defaultFooter.enabled;
    const useTemplateFooter = footer?.enabled !== false && footer?.text;
    if (!useDefaultFooter && !useTemplateFooter) return undefined;
    return Object.freeze({
        text: applyTextReplacements(footer?.text ?? defaultFooter.text ?? 'Warden Verification', replacements),
        iconURL: footer?.iconURL ?? defaultFooter.iconURL ?? resolveActiveBotIconURL(),
    });
}

/**
 * Resolve one configured Verification template into renderer-neutral content.
 * This is deliberately free of Discord builders so a template is traversed
 * exactly once before a legacy or Components V2 renderer is selected.
 */
function createVerificationTemplateDocument(templateKey, replacements = {}, options = {}) {
    const template = { ...resolveTemplate(templateKey), ...options.templateOverrides };
    const fields = [
        ...(template.fields ?? []),
        ...(options.fields ?? []),
    ]
        .slice(0, MAX_FIELDS)
        .map((field) => createTemplateField(field, replacements))
        .filter(Boolean);
    const title = template.title
        ? truncateText(applyTextReplacements(template.title, replacements), TITLE_LIMIT)
        : undefined;
    const description = template.description
        ? truncateText(applyTextReplacements(template.description, replacements), DESCRIPTION_LIMIT)
        : undefined;
    const thumbnailUrl = template.thumbnail?.enabled && template.thumbnail.url
        ? applyTextReplacements(template.thumbnail.url, replacements)
        : undefined;
    const author = template.icon?.enabled && template.icon.url
        ? Object.freeze({
            name: applyTextReplacements(template.title ?? 'Warden Verification', replacements),
            iconURL: applyTextReplacements(template.icon.url, replacements),
        })
        : undefined;

    return Object.freeze({
        color: resolveTemplateColor(template, options, replacements),
        title,
        description,
        fields: Object.freeze(fields),
        footer: createTemplateFooter(template, replacements, options),
        timestamp: (options.timestamp ?? template.timestamp
            ?? verificationEmbedConfig.responseDefaults?.timestamp) === true,
        thumbnailUrl,
        author,
    });
}

module.exports = {
    applyTextReplacements,
    createTemplateField,
    createVerificationTemplateDocument,
    formatDuration,
    resolveEmbedColor,
};
