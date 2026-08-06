'use strict';

const {
    buildVerificationAdminNeutralNotice,
    buildVerificationAdminNotice,
} = require('../presentation/adminNotices');
const { buildVerificationErrorEmbed } = require('../presentation/public');
const {
    respondAfterAcknowledgement,
} = require('../../ux/interactions/acknowledgement');
const { createVerificationLogger } = require('../logging');

const adminUxLog = createVerificationLogger('Admin UX');

function buildAdminErrorPayload(payload = {}) {
    const sourceEmbed = payload.embeds?.[0];
    const embed = sourceEmbed?.toJSON?.() ?? sourceEmbed;
    const message = embed?.description ?? payload.content;
    if (!message) return payload;

    const adminPayload = buildVerificationAdminNotice(
        embed?.title ?? 'Verification Admin',
        message,
        'error',
        { fields: embed?.fields ?? [] },
    );
    return {
        ...payload,
        ...adminPayload,
        content: null,
    };
}

function respondAdminError(interaction, payload, options = {}) {
    return respondAfterAcknowledgement(
        interaction,
        options.acknowledgement,
        buildAdminErrorPayload(payload),
        { followUp: options.followUp === true, reporter: adminUxLog },
    );
}

function respondAdminModalError(interaction, acknowledgement, payload) {
    return respondAfterAcknowledgement(
        interaction,
        acknowledgement,
        buildAdminErrorPayload(payload),
        { reporter: adminUxLog },
    );
}

function userErrorEmbed(message) {
    return buildVerificationErrorEmbed(message, {
        footer: { enabled: false },
        timestamp: false,
    });
}

function respondAdminNoChanges(
    interaction,
    acknowledgement,
    message = 'The submitted values already match the current configuration.',
) {
    return respondAdminModalError(
        interaction,
        acknowledgement,
        buildVerificationAdminNeutralNotice('No changes made', message),
    );
}

module.exports = {
    respondAdminError,
    respondAdminModalError,
    respondAdminNoChanges,
    userErrorEmbed,
};
