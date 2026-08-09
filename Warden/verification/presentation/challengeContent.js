'use strict';

const verificationEmbedConfig = require('./config.json');

const MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000;

function buildChallengeReplacements(challenge) {
    return {
        challenge: challenge?.description ?? challenge?.title ?? challenge?.id ?? '',
        challengeId: challenge?.id ?? '',
        challengeTitle: challenge?.title ?? '',
        challengeDescription: challenge?.description ?? '',
    };
}

function applyChallengeTextReplacements(text, challenge) {
    let resolvedText = String(text ?? '');
    for (const [key, value] of Object.entries(buildChallengeReplacements(challenge))) {
        resolvedText = resolvedText.replaceAll(`{${key}}`, String(value ?? ''));
    }
    return resolvedText;
}

function resolveChallengeTitle(challenge) {
    const configuredTitle = verificationEmbedConfig.challengeEmbed?.title ?? 'Verification Challenge';
    const challengeTitle = String(challenge?.title ?? '').trim();
    return challengeTitle && challengeTitle !== 'Verification Challenge' ? challengeTitle : configuredTitle;
}

function resolveChallengeDescription(challenge) {
    const configuredDescription = verificationEmbedConfig.challengeEmbed?.description;
    return configuredDescription
        ? applyChallengeTextReplacements(configuredDescription, challenge)
        : challenge?.description ?? 'Complete the verification questions to continue.';
}

function buildExpiryLine(expiresAt) {
    if (!expiresAt) return undefined;
    return `This verification screen expires <t:${Math.floor(expiresAt / 1000)}:R>.`;
}

const MAX_SCREEN_EXPIRY_TEXT = buildExpiryLine(MAX_JAVASCRIPT_DATE_MS);

module.exports = {
    MAX_SCREEN_EXPIRY_TEXT,
    applyChallengeTextReplacements,
    buildExpiryLine,
    resolveChallengeDescription,
    resolveChallengeTitle,
};
