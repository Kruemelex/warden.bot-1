const crypto = require('crypto');
const Discord = require('discord.js');
const { createVerificationLogger } = require('../logging');
const { reportVerificationError } = require('../errorLogging');
const {
    evaluateVerificationConfig,
    getVerificationAdminChallenge,
    normalizeVerificationAdminGuildId,
} = require('../service');
const { buildQuestionScreens } = require('../domain/challenges');
const { refreshVerificationImageInventory } = require('../assets/image-inventory');
const {
    COMPONENTS_V2_RENDERER,
} = require('../presentation/documents/challengeScreen');
const {
    buildVerificationBusyResponse,
    buildVerificationErrorResponse,
    buildVerificationStateOptions,
} = require('../presentation/documents/notices');
const {
    deferEphemeralReply,
    deferSourceUpdate,
    deliverPanelUpdateOrFallback,
    sanitizeMessageEditOptions,
    sendEphemeralNotice,
} = require('./interactionResponses');
const {
    createVerificationSession,
    createVerificationSessionFlow,
    prepareSessionScreenAssets,
    releaseSessionScreenAssetDelivery,
} = require('./sessionFlow');
const {
    buildSessionScreenDeliveryPlan,
    deliverScreenPlan,
    deliverSessionScreen,
    rollbackScreenDelivery,
} = require('./screenDelivery');
const { getQuestionMessageHandle } = require('./liveMessageRenderer');
const { showScreenTransitionProcessing } = require('./transitionPresentation');
const previewLog = createVerificationLogger('Preview');

const PREVIEW_SESSION_LIFETIME_MS = 10 * 60 * 1000;
const PREVIEW_SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_ACTIVE_PREVIEW_SESSIONS = 100;
const PREVIEW_CONTROL_PREFIXES = Object.freeze({
    answer: 'wardenVerifyPreview-answer-',
    next: 'wardenVerifyPreview-next-',
    back: 'wardenVerifyPreview-back-',
    submit: 'wardenVerifyPreview-submit-',
});
const previewSessions = new Map();
const previewLifecycleGenerationByGuild = new Map();
let pendingPreviewStarts = 0;
let previewsShuttingDown = false;

function createOpaqueToken(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); }
function createControlToken(sessionId) { return `${sessionId}.${createOpaqueToken(8)}`; }

function getPreviewLifecycleGeneration(guildId) {
    return previewLifecycleGenerationByGuild.get(guildId) ?? 0;
}

function assertPreviewLifecycleCurrent(guildId, generation) {
    if (previewsShuttingDown || getPreviewLifecycleGeneration(guildId) !== generation) {
        throw createPreviewNoticeError(
            'Verification previews are shutting down. Start a new preview after Warden is ready again.',
            'VERIFICATION_PREVIEW_SHUTDOWN',
        );
    }
}

function releasePreviewSessionResources(session) {
    if (!session || session.previewResourcesReleased === true) return;
    session.previewResourcesReleased = true;
    const screenIndexes = new Set([
        session.screenIndex,
        ...(session.screenAssetCache?.keys?.() ?? []),
    ]);
    for (const screenIndex of screenIndexes) {
        try {
            releaseSessionScreenAssetDelivery(session, screenIndex);
        }
        catch (error) {
            previewLog.error('Failed to release preview screen assets:', error);
        }
    }
    session.screenAssets = {};
    session.screenAssetCache?.clear?.();
}

function removePreviewSession(sessionId, expectedSession) {
    const session = previewSessions.get(sessionId);
    if (expectedSession && session !== expectedSession) {
        releasePreviewSessionResources(expectedSession);
        return false;
    }
    if (!session) return false;
    previewSessions.delete(sessionId);
    releasePreviewSessionResources(session);
    return true;
}

function cleanupExpiredPreviewSessions() {
    const now = Date.now();
    for (const [sessionId, session] of previewSessions.entries()) {
        if (now >= session.expiresAt) removePreviewSession(sessionId, session);
    }
}

const cleanupInterval = setInterval(cleanupExpiredPreviewSessions, PREVIEW_SESSION_CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

function resolveInteractionGuildId(interaction) { return String(interaction.guildId ?? interaction.guild?.id ?? ''); }
function replyWithPreviewNotice(interaction, content) { return sendEphemeralNotice(interaction, { content }); }
function createPreviewNoticeError(message, code = 'VERIFICATION_PREVIEW_NOTICE') {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function createStartResponder(interaction) {
    let initialReplyAvailable = false;
    if (!interaction.deferred && !interaction.replied) {
        await deferEphemeralReply(interaction);
        initialReplyAvailable = true;
    }

    return {
        async send(payload) {
            if (initialReplyAvailable) {
                initialReplyAvailable = false;
                return interaction.editReply(sanitizeMessageEditOptions(payload));
            }
            return interaction.followUp({
                ...payload,
                flags: Number(payload.flags ?? 0) | Discord.MessageFlags.Ephemeral,
            });
        },
    };
}

function requirePreviewStartAuthorization(interaction, guildId) {
    let normalizedGuildId;
    try {
        normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    }
    catch (error) {
        throw createPreviewNoticeError(error.message);
    }
    if (resolveInteractionGuildId(interaction) !== normalizedGuildId) {
        throw createPreviewNoticeError('Verification previews must be started in the guild being previewed.');
    }
    if (!interaction.user?.id) {
        throw createPreviewNoticeError('Verification preview owner could not be resolved.');
    }
    return normalizedGuildId;
}

function assertPreviewConfiguration(challenge, screens, { includeIntro = true } = {}) {
    if (!challenge) {
        throw createPreviewNoticeError('That verification challenge no longer exists in the authoritative catalog.');
    }
    const questions = Array.isArray(challenge.questions) ? challenge.questions : [];
    const report = evaluateVerificationConfig({
        challenges: [challenge],
        activeChallengeIds: challenge.id ? [challenge.id] : [],
    }, {
        changedChallengeId: challenge.id,
        includeIntro,
    });
    const issues = [
        ...(!challenge.id ? ['The catalog challenge has no ID.'] : []),
        ...(questions.length < 1 || screens.length < 1 ? ['The catalog challenge has no question screens.'] : []),
        ...report.blockingIssues.map((issue) => issue.message),
    ];
    if (issues.length > 0) {
        throw createPreviewNoticeError(`This verification challenge cannot be previewed:\n${[...new Set(issues)].slice(0, 5).join('\n')}`);
    }
}

function reservePreviewCapacity() {
    cleanupExpiredPreviewSessions();
    if (previewSessions.size + pendingPreviewStarts >= MAX_ACTIVE_PREVIEW_SESSIONS) {
        throw createPreviewNoticeError(
            'Verification previews are temporarily busy. Please let an existing preview expire and try again.',
            'VERIFICATION_PREVIEW_CAPACITY',
        );
    }
    pendingPreviewStarts += 1;
}

function createPreviewSession(
    interaction,
    guildId,
    challenge,
    screens,
    mode,
    includeIntroOnFirstScreen,
    imageInventory,
) {
    const id = createOpaqueToken();
    const createdTimestamp = Date.now();
    return createVerificationSession({
        id,
        ownerUserId: String(interaction.user.id),
        guildId,
        mode,
        includeIntroOnFirstScreen,
        challenge,
        screens,
        renderPriority: 'preview',
        renderer: COMPONENTS_V2_RENDERER,
        controlPrefixes: PREVIEW_CONTROL_PREFIXES,
        token: createControlToken(id),
        messageHandles: {},
        createdTimestamp,
        expiresAt: createdTimestamp + PREVIEW_SESSION_LIFETIME_MS,
        imageInventory,
        imageInventoryRevision: imageInventory.contentRevision,
    });
}

function previewScreenIncludesIntro(session) {
    return session.screenIndex === 0 && session.includeIntroOnFirstScreen !== false;
}

async function sendInitialPreview(interaction, responder, session, lifecycleGeneration) {
    assertPreviewLifecycleCurrent(session.guildId, lifecycleGeneration);
    previewSessions.set(session.id, session);
    try {
        const plan = buildSessionScreenDeliveryPlan(session, {
            includeIntro: previewScreenIncludesIntro(session),
        });
        const message = await responder.send(plan.primaryOptions);
        assertPreviewLifecycleCurrent(session.guildId, lifecycleGeneration);
        await deliverScreenPlan(interaction, session, plan, message);
        assertPreviewLifecycleCurrent(session.guildId, lifecycleGeneration);
        return message;
    }
    catch (err) {
        removePreviewSession(session.id, session);
        throw err;
    }
}

async function startPreview(interaction, { guildId, challengeId, questionId }) {
    const responder = await createStartResponder(interaction);
    let capacityReserved = false;
    try {
        const normalizedGuildId = requirePreviewStartAuthorization(interaction, guildId);
        const lifecycleGeneration = getPreviewLifecycleGeneration(normalizedGuildId);
        assertPreviewLifecycleCurrent(normalizedGuildId, lifecycleGeneration);
        reservePreviewCapacity();
        capacityReserved = true;

        const imageInventory = await refreshVerificationImageInventory();
        const challenge = await getVerificationAdminChallenge(normalizedGuildId, challengeId, { fresh: true });
        if (!challenge) {
            throw createPreviewNoticeError('That verification challenge no longer exists in the authoritative catalog.');
        }
        const productionScreens = buildQuestionScreens(challenge);

        let screens = productionScreens;
        let mode = 'challenge';
        let includeIntro = true;
        if (questionId !== undefined) {
            const selectedId = String(questionId ?? '').trim();
            const containingScreen = productionScreens.find((screen) =>
                screen.questions.some((question) => String(question.id) === selectedId));
            if (!containingScreen) {
                throw createPreviewNoticeError('That verification question no longer exists in the selected catalog challenge.');
            }
            screens = [{
                ...containingScreen,
                id: 'screen-0',
                index: 0,
                questions: [...containingScreen.questions],
            }];
            mode = 'question';
            includeIntro = containingScreen.index === 0;
            assertPreviewConfiguration(
                { ...challenge, questions: screens[0].questions },
                screens,
                { includeIntro },
            );
        }
        else {
            assertPreviewConfiguration(challenge, screens);
        }

        const session = createPreviewSession(
            interaction,
            normalizedGuildId,
            challenge,
            screens,
            mode,
            includeIntro,
            imageInventory,
        );
        session.screenAssets = await prepareSessionScreenAssets(session);
        assertPreviewLifecycleCurrent(normalizedGuildId, lifecycleGeneration);
        try {
            return await sendInitialPreview(interaction, responder, session, lifecycleGeneration);
        }
        finally {
            releaseSessionScreenAssetDelivery(session);
        }
    }
    catch (err) {
        void reportVerificationError({
            interaction,
            title: '⛔ Verification preview start failed',
            userId: interaction.user?.id,
        }, err);
        await responder.send(buildVerificationErrorResponse(
            String(err.message || 'The verification preview could not be started.').slice(0, 1900),
        )).catch((responseErr) => previewLog.error('Failed to send verification preview start error:', responseErr));
        return undefined;
    }
    finally {
        if (capacityReserved) pendingPreviewStarts -= 1;
    }
}

function startVerificationChallengePreview(interaction, { guildId, challengeId }) {
    return startPreview(interaction, { guildId, challengeId });
}
function startVerificationQuestionPreview(interaction, { guildId, challengeId, questionId }) {
    return startPreview(interaction, { guildId, challengeId, questionId: questionId === undefined ? null : questionId });
}

function getSessionIdFromControlToken(controlToken) {
    const separatorIndex = String(controlToken ?? '').indexOf('.');
    return separatorIndex > 0 ? controlToken.slice(0, separatorIndex) : undefined;
}

const PREVIEW_SESSION_POLICY = Object.freeze({
    controlPrefixes: PREVIEW_CONTROL_PREFIXES,
    messages: Object.freeze({
        staleAnswer: 'This preview control is no longer current. Use the latest preview message.',
        inactiveAnswer: 'This preview screen does not currently accept an answer.',
        staleNavigation: 'This preview control is no longer current. Use the latest preview message.',
        answerRequired: 'This preview screen requires an answer.',
        backDisallowed: 'You cannot go back to that preview screen.',
        staleSubmit: 'This preview control is no longer current. Use the latest preview message.',
        inactiveSubmit: 'This preview answer modal is no longer current.',
        busy: 'This verification preview is already processing another action.',
    }),
    createToken: (session) => createControlToken(session.id),
    busyNotice: (interaction) => sendEphemeralNotice(interaction, buildVerificationBusyResponse()),
    notice: replyWithPreviewNotice,
    async resolveSession(interaction, parsed) {
        const sessionId = getSessionIdFromControlToken(parsed.token);
        const session = sessionId ? previewSessions.get(sessionId) : undefined;
        if (!session || Date.now() >= session.expiresAt) {
            if (sessionId) removePreviewSession(sessionId, session);
            await replyWithPreviewNotice(interaction, 'This verification preview has expired. Start a new preview from the Admin panel.');
            return undefined;
        }
        if (String(interaction.user?.id ?? '') !== session.ownerUserId
            || resolveInteractionGuildId(interaction) !== session.guildId) {
            await replyWithPreviewNotice(interaction, 'This verification preview belongs to a different administrator or guild.');
            return undefined;
        }
        return session;
    },
    async assertSessionCurrent(_interaction, session) {
        if (previewSessions.get(session.id) !== session || Date.now() >= session.expiresAt) {
            removePreviewSession(session.id, session);
            throw new Error('This verification preview expired while preparing the next screen.');
        }
    },
    createTransitionContext(_interaction, _source, session) {
        return { questionHandle: getQuestionMessageHandle(session) };
    },
    async beginTransition(interaction) {
        await deferSourceUpdate(interaction);
    },
    async prepareTransitionDelivery(interaction, session, transitionContext) {
        await showScreenTransitionProcessing(interaction, session, transitionContext);
    },
    async failTransition(interaction, session, transitionContext) {
        const recoveryErrors = [];
        if (transitionContext.deliveryReceipt) {
            await rollbackScreenDelivery(
                interaction,
                transitionContext.deliveryReceipt,
                'This uncommitted verification preview screen is no longer active.',
            ).catch((error) => recoveryErrors.push(error));
        }
        if (transitionContext.transitionProcessingPresented !== true) return;

        removePreviewSession(session.id, session);
        const errorOptions = buildVerificationStateOptions(undefined, {
            renderer: transitionContext.questionHandle.renderer,
            templateKey: 'runtimeErrorEmbed',
            replacements: {
                message: 'The next preview screen could not be delivered. Start a new preview from the Admin UX.',
            },
        });
        await interaction.webhook.editMessage(
            transitionContext.questionHandle.id,
            sanitizeMessageEditOptions(errorOptions),
        ).catch((error) => recoveryErrors.push(error));
        if (recoveryErrors.length === 1) throw recoveryErrors[0];
        if (recoveryErrors.length > 1) {
            throw new AggregateError(
                recoveryErrors,
                'Verification preview transition recovery failed.',
                { cause: recoveryErrors[0] },
            );
        }
    },
    async deliverScreen(interaction, session, nextSession) {
        return deliverSessionScreen(interaction, session, nextSession, {
            forceStoredMessage: true,
            presentation: {
                includeIntro: previewScreenIncludesIntro(nextSession),
            },
        });
    },
    incorrect: (interaction) => replyWithPreviewNotice(
        interaction,
        'That answer is incorrect. The preview remains active, with no cooldown or verification state change.',
    ),
    async complete(interaction, session) {
        await deferSourceUpdate(interaction);
        const completeOptions = buildVerificationStateOptions(undefined, {
            renderer: COMPONENTS_V2_RENDERER,
            templateKey: 'previewSuccessEmbed',
        });
        await deliverPanelUpdateOrFallback(
            interaction,
            () => interaction.webhook.editMessage(
                getQuestionMessageHandle(session).id,
                sanitizeMessageEditOptions(completeOptions),
            ),
            completeOptions,
        );
        removePreviewSession(session.id, session);
    },
});
const previewSessionFlow = createVerificationSessionFlow(PREVIEW_SESSION_POLICY);

function shutdownVerificationPreviews(guildId) {
    const targetGuildId = guildId === undefined || guildId === null
        ? undefined
        : String(typeof guildId === 'string' ? guildId : guildId.id ?? '');
    if (targetGuildId === undefined) previewsShuttingDown = true;
    else previewLifecycleGenerationByGuild.set(
        targetGuildId,
        getPreviewLifecycleGeneration(targetGuildId) + 1,
    );
    let removed = 0;
    for (const [sessionId, session] of previewSessions.entries()) {
        if (targetGuildId !== undefined && session.guildId !== targetGuildId) continue;
        if (removePreviewSession(sessionId, session)) removed += 1;
    }
    if (targetGuildId === undefined) {
        clearInterval(cleanupInterval);
        previewLifecycleGenerationByGuild.clear();
    }
    return removed;
}

async function handleVerificationPreviewInteraction(interaction) {
    const route = previewSessionFlow.parseRoute(interaction);
    if (!route) return false;
    try {
        await previewSessionFlow.handleRoute(interaction, route);
    }
    catch (err) {
        void reportVerificationError({
            interaction,
            title: '⛔ Verification preview interaction failed',
            userId: interaction.user?.id,
        }, err);
        await replyWithPreviewNotice(
            interaction,
            err.message || 'There was an error while handling this verification preview.',
        ).catch((responseErr) => previewLog.error('Failed to send verification preview error response:', responseErr));
    }
    return true;
}

module.exports = {
    startVerificationChallengePreview,
    startVerificationQuestionPreview,
    handleVerificationPreviewInteraction,
    shutdownVerificationPreviews,
};
