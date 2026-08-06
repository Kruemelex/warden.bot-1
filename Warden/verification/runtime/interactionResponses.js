'use strict';

const {
    deferEphemeralReply,
    deferSourceUpdate,
    deliverPanelUpdateOrFallback,
    respondAfterAcknowledgement,
    sanitizeMessageEditOptions,
    sendInitialInteractionResponse,
} = require('../../ux/interactions/acknowledgement');

// Verification interaction responses remain a feature adapter because live flows
// intentionally accept the historical `{ acknowledgement, followUp }` options
// shape while the shared UX kernel owns the Discord acknowledgement mechanics.
function sendEphemeralNotice(interaction, payload, options = {}) {
    return respondAfterAcknowledgement(
        interaction,
        options.acknowledgement,
        payload,
        { followUp: options.followUp === true },
    );
}

module.exports = {
    deferEphemeralReply,
    deferSourceUpdate,
    deliverPanelUpdateOrFallback,
    sanitizeMessageEditOptions,
    sendEphemeralNotice,
    sendInitialInteractionResponse,
};
