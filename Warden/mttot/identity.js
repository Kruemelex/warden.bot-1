'use strict';

const { botIdent, getIdentityBrandColor, getIdentityEmbedAuthor } = require('../../functions');

const MTTOT2_IDENTITY_BOTS = new Set(['Warden', 'GuardianAI']);

function supportsMttot2Identity(botName) {
    return MTTOT2_IDENTITY_BOTS.has(String(botName ?? ''));
}

function resolveMttot2BrandColor({
    getBotIdentity = botIdent,
    getColor = getIdentityBrandColor,
} = {}) {
    const activeBotName = String(getBotIdentity?.()?.activeBot?.botName ?? '').trim();
    if (!activeBotName) {
        // Unit tests and isolated command loading do not necessarily select an
        // active identity. Warden is the legacy presentation default only in
        // that explicit no-identity state.
        return getColor('Warden');
    }
    if (!supportsMttot2Identity(activeBotName)) {
        throw new Error(`MTToT2 is unavailable for the active ${activeBotName} identity.`);
    }
    return getColor(activeBotName);
}

function resolveMttot2EmbedAuthor({
    getBotIdentity = botIdent,
    getAuthor = getIdentityEmbedAuthor,
} = {}) {
    const activeBotName = String(getBotIdentity?.()?.activeBot?.botName ?? '').trim();
    if (!activeBotName) return getAuthor('Warden');
    if (!supportsMttot2Identity(activeBotName)) {
        throw new Error(`MTToT2 is unavailable for the active ${activeBotName} identity.`);
    }
    return getAuthor(activeBotName);
}

module.exports = {
    resolveMttot2BrandColor,
    resolveMttot2EmbedAuthor,
    supportsMttot2Identity,
};
