'use strict';

const { createNoticeDocument } = require('../../ux/documents');
const { renderComponentsV2 } = require('../../ux/renderers/componentsV2');
const {
    createVerificationTemplateDocument,
    resolveEmbedColor,
} = require('./templates');

function renderVerificationAdminNotice(document) {
    // Admin command replies have already selected their ephemeral visibility at
    // acknowledgement time. Preserve that Discord interaction contract rather
    // than attempting to set an immutable message flag during editReply.
    return renderComponentsV2(document).payload;
}

function createAdminNoticeDocument({
    title,
    message,
    tone = 'info',
    accentColor,
    fields = [],
    actions = [],
    footer,
    timestamp = false,
    thumbnailUrl,
    author,
} = {}) {
    return createNoticeDocument({
        title,
        message,
        tone,
        accentColor: accentColor ?? resolveEmbedColor(tone),
        fields,
        actions,
        footer,
        timestamp,
        thumbnailUrl,
        author,
        ephemeral: false,
    });
}

function buildVerificationAdminNotice(title, message, tone = 'info', options = {}) {
    return renderVerificationAdminNotice(createAdminNoticeDocument({
        title,
        message,
        tone,
        fields: options.fields ?? [],
        actions: options.components ?? [],
    }));
}

function buildVerificationAdminNeutralNotice(title, message, options = {}) {
    return buildVerificationAdminNotice(title, message, 'neutral', options);
}

function buildVerificationAdminTemplateNotice(templateKey, replacements = {}, options = {}) {
    const {
        components = [],
        tone = 'info',
        ...templateOptions
    } = options;
    const template = createVerificationTemplateDocument(templateKey, replacements, {
        footer: { enabled: false },
        timestamp: false,
        ...templateOptions,
    });
    return renderVerificationAdminNotice(createAdminNoticeDocument({
        title: template.title,
        message: template.description,
        tone,
        accentColor: template.color,
        fields: template.fields,
        actions: components,
        footer: template.footer?.text,
        timestamp: template.timestamp,
        thumbnailUrl: template.thumbnailUrl,
        author: template.author,
    }));
}

function buildVerificationAdminActionCompleted(label, message, options = {}) {
    return buildVerificationAdminTemplateNotice('actionCompleted', { label, message }, {
        tone: 'success',
        ...options,
    });
}

module.exports = {
    buildVerificationAdminActionCompleted,
    buildVerificationAdminNeutralNotice,
    buildVerificationAdminNotice,
};
