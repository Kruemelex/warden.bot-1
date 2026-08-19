'use strict';

const { botIdent, getIdentityBrandColor, getIdentityEmbedAuthor } = require('../../../../functions');

const MTTOT_IDENTITY_BOTS = new Set(['Warden', 'GuardianAI']);

function supportsMttotIdentity(botName) {
    return MTTOT_IDENTITY_BOTS.has(String(botName ?? ''));
}

function resolveMttotBrandColor({
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
    if (!supportsMttotIdentity(activeBotName)) {
        throw new Error(`MTToT is unavailable for the active ${activeBotName} identity.`);
    }
    return getColor(activeBotName);
}

function resolveMttotEmbedAuthor({
    getBotIdentity = botIdent,
    getAuthor = getIdentityEmbedAuthor,
} = {}) {
    const activeBotName = String(getBotIdentity?.()?.activeBot?.botName ?? '').trim();
    if (!activeBotName) return getAuthor('Warden');
    if (!supportsMttotIdentity(activeBotName)) {
        throw new Error(`MTToT is unavailable for the active ${activeBotName} identity.`);
    }
    return getAuthor(activeBotName);
}

module.exports = {
    resolveMttotBrandColor,
    resolveMttotEmbedAuthor,
    supportsMttotIdentity,
};
