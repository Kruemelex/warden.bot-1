'use strict';

const { renderLegacy } = require('../../ux/renderers/legacy');
const {
    createVerificationTemplateNoticeDocument,
} = require('./documents/notices');

// Public post and Admin helpers still need individual legacy EmbedBuilders.
// Resolve their content semantically before selecting that transport shape.
function buildVerificationPublicEmbed(templateKey, replacements = {}, options = {}) {
    const document = createVerificationTemplateNoticeDocument(templateKey, replacements, {
        ...options,
        ephemeral: false,
    });
    return renderLegacy(document).payload.embeds[0];
}

function buildVerificationErrorEmbed(message, options = {}) {
    return buildVerificationPublicEmbed('genericError', { message }, { color: 'error', ...options });
}

module.exports = {
    buildVerificationErrorEmbed,
    buildVerificationPublicEmbed,
};
