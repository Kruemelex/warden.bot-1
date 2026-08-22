'use strict';

const { botIdent, getIdentityBrandColor, getIdentityEmbedAuthor } = require('../../../../functions');

const MTTOT_IDENTITY_BOTS = new Set(['Warden', 'GuardianAI']);

function supportsMttotIdentity(botName) {
    return MTTOT_IDENTITY_BOTS.has(String(botName ?? ''));
}

function resolveMttotIdentityName({ getBotIdentity = botIdent } = {}) {
    const activeBotName = String(getBotIdentity?.()?.activeBot?.botName ?? '').trim();
    if (!activeBotName) return 'Warden';
    if (!supportsMttotIdentity(activeBotName)) {
        throw new Error(`MTToT is unavailable for the active ${activeBotName} identity.`);
    }
    return activeBotName;
}

function resolveMttotBrandColor({
    getBotIdentity = botIdent,
    getColor = getIdentityBrandColor,
} = {}) {
    return getColor(resolveMttotIdentityName({ getBotIdentity }));
}

function resolveMttotEmbedAuthor({
    getBotIdentity = botIdent,
    getAuthor = getIdentityEmbedAuthor,
} = {}) {
    return getAuthor(resolveMttotIdentityName({ getBotIdentity }));
}

module.exports = {
    resolveMttotBrandColor,
    resolveMttotEmbedAuthor,
    resolveMttotIdentityName,
    supportsMttotIdentity,
};
