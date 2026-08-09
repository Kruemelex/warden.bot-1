'use strict';

const Discord = require('discord.js');
const { createNoticeDocument } = require('../../../../ux/documents');
const { assertComponentsV2Support } = require('../../../../ux/components/primitives');
const { renderComponentsV2 } = require('../../../../ux/renderers/componentsV2');
const { renderLegacy } = require('../../../../ux/renderers/legacy');
const verificationEmbedConfig = require('../config.json');
const {
    createVerificationTemplateDocument,
    formatDuration,
    resolveEmbedColor,
} = require('../templates');
const {
    COMPONENTS_V2_RENDERER,
    LEGACY_RENDERER,
    buildExpiryLine,
    buildOldVersionActionRows,
    getOldVersionFallbackConfig,
    resolveScreenPresentationExpiresAt,
} = require('./challengeScreen');

function createVerificationTemplateNoticeDocument(templateKey, replacements = {}, options = {}) {
    const template = createVerificationTemplateDocument(templateKey, replacements, options);
    return createNoticeDocument({
        title: template.title,
        message: template.description,
        tone: options.tone ?? 'info',
        accentColor: template.color,
        fields: template.fields,
        actions: options.actions ?? options.components ?? [],
        files: options.files ?? [],
        footer: template.footer?.text,
        timestamp: template.timestamp === true,
        thumbnailUrl: template.thumbnailUrl,
        author: template.author,
        ephemeral: options.ephemeral === true,
    });
}

function canRenderComponentsV2() {
    try {
        assertComponentsV2Support();
        return true;
    }
    catch (_error) {
        return false;
    }
}

function renderVerificationDocument(document, renderer = LEGACY_RENDERER) {
    if (renderer === COMPONENTS_V2_RENDERER) return renderComponentsV2(document).payload;
    if (renderer === LEGACY_RENDERER) return renderLegacy(document).payload;
    throw new Error(`Unknown verification document renderer: ${renderer}.`);
}

function buildVerificationPublicResponse(templateKey, replacements = {}, options = {}) {
    const { flags = Discord.MessageFlags.Ephemeral, ...templateOptions } = options;
    const document = createVerificationTemplateNoticeDocument(templateKey, replacements, {
        ...templateOptions,
        ephemeral: (Number(flags) & Discord.MessageFlags.Ephemeral) !== 0,
    });
    return renderVerificationDocument(document, LEGACY_RENDERER);
}

function buildVerificationInProgressResponse(expiresAt, options = {}) {
    return buildVerificationPublicResponse('inProgressEmbed', {
        retryTime: `<t:${Math.floor(expiresAt / 1000)}:R>`,
    }, options);
}

function buildVerificationCooldownResponse(retryAt, options = {}) {
    return buildVerificationPublicResponse('cooldownEmbed', {
        retryTime: `<t:${Math.ceil(retryAt / 1000)}:R>`,
    }, options);
}

function buildVerificationBusyResponse(options = {}) {
    return buildVerificationPublicResponse('busyProcessingEmbed', {}, options);
}

function buildVerificationExpiredResponse(description, options = {}) {
    return buildVerificationPublicResponse('expiredChallengeEmbed', {}, {
        templateOverrides: description ? { description } : undefined,
        ...options,
    });
}

function buildVerificationErrorResponse(message, options = {}) {
    return buildVerificationPublicResponse('runtimeErrorEmbed', { message }, options);
}

function createVerificationAutoKickDocument(member, options = {}) {
    const autokickSeconds = options.autokickSeconds;
    const timer = Number.isFinite(autokickSeconds) ? formatDuration(autokickSeconds) : '';
    return createVerificationTemplateNoticeDocument('autoKickEmbed', {
        serverName: member.guild?.name ?? 'the server',
        user: member.user?.toString?.() ?? member.displayName ?? 'there',
        autokickTimer: timer,
    }, { ephemeral: false });
}

function buildVerificationAutoKickPayload(member, options = {}) {
    return renderVerificationDocument(createVerificationAutoKickDocument(member, options), LEGACY_RENDERER);
}

function createVerificationStateDocument(message = 'Verification step completed.', options = {}) {
    if (options.templateKey) {
        return createVerificationTemplateNoticeDocument(
            options.templateKey,
            options.replacements,
            { ...options, ephemeral: true },
        );
    }
    return createNoticeDocument({
        title: options.title ?? 'Verification',
        message,
        tone: options.tone ?? 'neutral',
        accentColor: resolveEmbedColor(
            verificationEmbedConfig.responseDefaults?.colors?.[options.tone ?? 'neutral'],
        ),
        ephemeral: true,
    });
}

function buildVerificationStateOptions(message = 'Verification step completed.', options = {}) {
    const document = createVerificationStateDocument(message, options);
    const renderer = options.renderer ?? COMPONENTS_V2_RENDERER;
    return renderVerificationDocument(
        document,
        renderer === COMPONENTS_V2_RENDERER && canRenderComponentsV2()
            ? COMPONENTS_V2_RENDERER
            : LEGACY_RENDERER,
    );
}

function buildOldVersionFallbackOptions(challenge, session, options = {}) {
    const fallback = getOldVersionFallbackConfig(challenge);
    const queued = options.queued === true;
    const retryEnabled = options.retry !== false;
    const errorMessage = String(options.errorMessage ?? '').trim();
    const expiryText = queued ? undefined : buildExpiryLine(resolveScreenPresentationExpiresAt(session, options));
    const document = errorMessage
        ? createVerificationTemplateNoticeDocument('runtimeErrorEmbed', {
            message: [errorMessage, expiryText].filter(Boolean).join('\n\n'),
        }, {
            ephemeral: true,
            actions: queued || !retryEnabled ? [] : buildOldVersionActionRows(session),
        })
        : createNoticeDocument({
            title: queued ? fallback.queuedTitle : fallback.title,
            message: [queued ? fallback.queuedDescription : fallback.description, expiryText]
                .filter(Boolean)
                .join('\n\n'),
            accentColor: resolveEmbedColor(fallback.accentColor),
            actions: queued || !retryEnabled ? [] : buildOldVersionActionRows(session),
            ephemeral: true,
        });
    return renderVerificationDocument(document, LEGACY_RENDERER);
}

module.exports = {
    buildOldVersionFallbackOptions,
    buildVerificationAutoKickPayload,
    buildVerificationBusyResponse,
    buildVerificationCooldownResponse,
    buildVerificationErrorResponse,
    buildVerificationExpiredResponse,
    buildVerificationInProgressResponse,
    buildVerificationPublicResponse,
    buildVerificationStateOptions,
    createVerificationTemplateNoticeDocument,
};
