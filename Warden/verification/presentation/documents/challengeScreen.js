'use strict';

const Discord = require('discord.js');
const { createChallengeScreenDocument } = require('../../../../ux/documents');
const verificationEmbedConfig = require('../config.json');
const {
    applyChallengeTextReplacements,
    buildExpiryLine,
    resolveChallengeDescription,
    resolveChallengeTitle,
} = require('../challengeContent');
const { screenAllowsBack, screenRequiresAnswer } = require('../../domain/challenges');
const { VERIFICATION_UI_LIMITS } = require('../../domain/limits');
const {
    POSITION_ANSWER_HELP_TEXT,
    getQuestionScreenPresentation,
    getQuestionScreenProgressText,
} = require('../../domain/screenPlan');
const { getQuestionAssetFiles, getQuestionDisplayItems } = require('../../assets/screenAssets');
const { resolveEmbedColor } = require('../templates');

const COMPONENTS_V2_RENDERER = 'components-v2';
const LEGACY_RENDERER = 'legacy';
const DEFAULT_VERIFICATION_CONTROL_PREFIXES = Object.freeze({
    answer: 'wardenVerify-answer-',
    next: 'wardenVerify-next-',
    back: 'wardenVerify-back-',
    submit: 'wardenVerify-submit-',
});

function buildSessionComponentCustomId(prefix, screenIndex = 0, token) {
    const customId = `${prefix}${screenIndex}${token ? `-${token}` : ''}`;
    if (customId.length > VERIFICATION_UI_LIMITS.customIdLength) {
        throw new Error(`Verification component custom ID exceeds Discord's ${VERIFICATION_UI_LIMITS.customIdLength}-character limit.`);
    }
    return customId;
}

function parseSessionComponentCustomId(customId, prefix) {
    if (!String(customId ?? '').startsWith(prefix)) return undefined;
    const payload = String(customId).slice(prefix.length);
    const tokenSeparatorIndex = payload.lastIndexOf('-');
    if (tokenSeparatorIndex < 1) return undefined;
    const token = payload.slice(tokenSeparatorIndex + 1);
    const screenIndex = Number(payload.slice(0, tokenSeparatorIndex));
    if (!Number.isInteger(screenIndex) || screenIndex < 0 || !token) return undefined;
    return { screenIndex, token };
}

function parseOldVersionCustomId(customId) {
    const prefix = 'wardenVerify-oldVersion-';
    const value = String(customId ?? '');
    if (!value.startsWith(prefix)) return undefined;
    const fallbackToken = value.slice(prefix.length);
    return fallbackToken ? { fallbackToken } : undefined;
}

function getCurrentScreen(session) {
    return session?.screens?.[session.screenIndex];
}

function hasNextScreen(session) {
    return session.screenIndex + 1 < session.screens.length;
}

function canGoBack(session) {
    return screenAllowsBack(session, session.screenIndex - 1);
}

function resolveVerificationControlPrefixes(session, options = {}) {
    return {
        ...DEFAULT_VERIFICATION_CONTROL_PREFIXES,
        ...(session?.controlPrefixes ?? {}),
        ...(options.controlPrefixes ?? {}),
    };
}

function buildScreenActionRows(session, options = {}) {
    const screen = getCurrentScreen(session);
    if (!screen) throw new Error('The verification session has no current screen.');
    const controlPrefixes = resolveVerificationControlPrefixes(session, options);
    const row = new Discord.ActionRowBuilder();
    if (canGoBack(session)) {
        row.addComponents(new Discord.ButtonBuilder()
            .setCustomId(buildSessionComponentCustomId(controlPrefixes.back, session.screenIndex, session.token))
            .setLabel('Back')
            .setStyle(Discord.ButtonStyle.Secondary));
    }
    if (screenRequiresAnswer(screen)) {
        row.addComponents(new Discord.ButtonBuilder()
            .setCustomId(buildSessionComponentCustomId(controlPrefixes.answer, session.screenIndex, session.token))
            .setLabel('Give Answer')
            .setStyle(Discord.ButtonStyle.Primary));
    }
    else {
        row.addComponents(new Discord.ButtonBuilder()
            .setCustomId(buildSessionComponentCustomId(controlPrefixes.next, session.screenIndex, session.token))
            .setLabel(hasNextScreen(session) ? 'Next' : 'Complete')
            .setStyle(Discord.ButtonStyle.Primary));
    }
    return row.components.length > 0 ? [row] : [];
}

function resolveChallengeAccentColor(challenge) {
    return resolveEmbedColor(challenge?.color
        ?? verificationEmbedConfig.challengeEmbed?.color
        ?? verificationEmbedConfig.responseDefaults?.colors?.info);
}

function resolveScreenPresentationExpiresAt(session, options = {}) {
    const explicitExpiresAt = Number(options.expiresAt);
    if (Number.isFinite(explicitExpiresAt) && explicitExpiresAt > 0) return explicitExpiresAt;
    const screenExpiryMs = Number(session?.screenExpiryMs);
    if (
        ['preparing', 'transitioning'].includes(session?.phase)
        && Number.isFinite(screenExpiryMs)
        && screenExpiryMs > 0
    ) return Date.now() + screenExpiryMs;
    return session?.expiresAt;
}

function getAssetDisplayItems(asset) {
    return getQuestionDisplayItems(asset).filter((item) => item.type === 'image' && item.displayUrl);
}

function getQuestionAssetDisplayItems(question, asset) {
    const displayItems = getAssetDisplayItems(asset);
    if (!asset?.galleryState || getQuestionScreenPresentation(question).positionAnswer) return displayItems;
    return displayItems.map((item) => ({ ...item, description: 'Verification image' }));
}

function getScreenFiles(screenAssets = {}) {
    return Object.values(screenAssets).flatMap(getQuestionAssetFiles);
}

function assertDiscordAttachmentBudget(files) {
    if (files.length > VERIFICATION_UI_LIMITS.attachmentsPerMessage) {
        throw new Error(`Verification screen contains ${files.length} Discord attachments; the current limit is ${VERIFICATION_UI_LIMITS.attachmentsPerMessage}.`);
    }
    return files.length;
}

function createQuestionDocument(question, asset, session, screen, questionIndex, options) {
    const presentation = getQuestionScreenPresentation(question);
    const positionAnswer = presentation.positionAnswer;
    const displayItems = getQuestionAssetDisplayItems(question, asset);
    const helpLines = [];
    const progressText = options.showScreenProgress !== false
        ? getQuestionScreenProgressText(session?.screens, screen, questionIndex)
        : undefined;
    if (positionAnswer && asset?.galleryState?.selectedImages?.length) {
        helpLines.push(POSITION_ANSWER_HELP_TEXT);
    }
    return {
        id: question.id,
        label: question.label ?? question.id,
        text: question.text,
        media: displayItems.map((item) => ({
            url: item.displayUrl,
            description: item.description,
        })),
        inlineMedia: !asset?.galleryState || asset.galleryState.compositeImage === true,
        helpText: helpLines.join('\n\n'),
        progressText,
    };
}

/**
 * Build the semantic content for one verification screen. Renderers select the
 * Component V2 or legacy transport later; this factory intentionally owns the
 * only challenge/question traversal.
 */
function createVerificationChallengeScreenDocument(challenge, screen, screenAssets = {}, session, options = {}) {
    const files = getScreenFiles(screenAssets);
    if (session?.renderer === COMPONENTS_V2_RENDERER) assertDiscordAttachmentBudget(files);
    const includeIntro = options.includeIntro === true;
    return createChallengeScreenDocument({
        title: resolveChallengeTitle(challenge),
        description: includeIntro ? resolveChallengeDescription(challenge) : undefined,
        accentColor: resolveChallengeAccentColor(challenge),
        fields: includeIntro ? challenge?.fields ?? [] : [],
        questions: (screen?.questions ?? []).map((question, questionIndex) => createQuestionDocument(
            question,
            screenAssets[question.id],
            session,
            screen,
            questionIndex,
            options,
        )),
        expiryText: buildExpiryLine(resolveScreenPresentationExpiresAt(session, options)),
        actions: options.completed ? [] : buildScreenActionRows(session, options),
        files,
        ephemeral: true,
        includeIntro,
    });
}

function getOldVersionFallbackConfig(challenge) {
    const fallbackConfig = verificationEmbedConfig.oldVersionFallbackEmbed ?? {};
    return Object.freeze({
        title: applyChallengeTextReplacements(fallbackConfig.title ?? 'Not working?', challenge),
        description: applyChallengeTextReplacements(
            fallbackConfig.description ?? 'If you cannot see the Verification Challenge, please update your client or click the Old Version button below.',
            challenge,
        ),
        queuedTitle: applyChallengeTextReplacements(fallbackConfig.queuedTitle ?? 'Verification Queued', challenge),
        queuedDescription: applyChallengeTextReplacements(
            fallbackConfig.queuedDescription ?? 'Please wait a moment while Warden prepares your verification screen.',
            challenge,
        ),
        accentColor: fallbackConfig.color ?? verificationEmbedConfig.challengeEmbed?.color,
    });
}

function buildOldVersionActionRows(session) {
    const fallbackToken = session?.fallbackToken ?? session?.token;
    if (!fallbackToken) throw new Error('Verification fallback controls require a session fallback token.');
    return [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId(`wardenVerify-oldVersion-${fallbackToken}`)
            .setLabel(verificationEmbedConfig.oldVersionFallbackEmbed?.buttonLabel ?? 'Old Version')
            .setStyle(Discord.ButtonStyle.Secondary),
    )];
}

module.exports = {
    COMPONENTS_V2_RENDERER,
    DEFAULT_VERIFICATION_CONTROL_PREFIXES,
    LEGACY_RENDERER,
    buildExpiryLine,
    buildOldVersionActionRows,
    buildSessionComponentCustomId,
    createVerificationChallengeScreenDocument,
    getOldVersionFallbackConfig,
    parseOldVersionCustomId,
    parseSessionComponentCustomId,
    resolveVerificationControlPrefixes,
    resolveScreenPresentationExpiresAt,
};
