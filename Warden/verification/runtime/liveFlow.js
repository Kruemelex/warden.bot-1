const { createVerificationLogger } = require('../logging');
const { reportVerificationError } = require('../errorLogging');
const {
    VERIFICATION_MODES,
} = require('../service');
const {
    buildQuestionScreens,
} = require('../domain/challenges');
const { getPublishedVerificationRuntimeContext } = require('./runtimeContext');
const {
    isVerificationRenderAvailabilityError,
    isVerificationRenderCapacityError,
} = require('../assets/errors');
const {
    COMPONENTS_V2_RENDERER,
    DEFAULT_VERIFICATION_CONTROL_PREFIXES,
    LEGACY_RENDERER,
    parseOldVersionCustomId,
} = require('../presentation/documents/challengeScreen');
const {
    buildVerificationPublicResponse,
    buildVerificationBusyResponse,
    buildVerificationCooldownResponse,
    buildVerificationInProgressResponse,
    buildVerificationExpiredResponse,
    buildVerificationErrorResponse,
    buildVerificationStateOptions,
    buildOldVersionFallbackOptions,
} = require('../presentation/documents/notices');
const {
    deferEphemeralReply,
    deferSourceUpdate,
    sendEphemeralNotice,
    sendInitialInteractionResponse,
} = require('./interactionResponses');
const {
    createVerificationSession,
    createVerificationSessionFlow,
    prepareSessionScreenAssets,
    releaseSessionScreenAssetDelivery,
} = require('./sessionFlow');
const {
    decideVerificationAssetDelivery,
    discardVerificationAssetStockReservation,
} = require('./assetStock');
const {
    assertPendingInitialLiveSessionCurrent,
    beginScreenProcessingIfCurrent,
    captureSessionAttempt,
    clearChallenge,
    clearChallengeIfCurrent,
    clearVerificationStateIfCurrent,
    commitPendingInitialLiveSession,
    createSessionToken,
    getActiveSession,
    getActiveSessionOrReplyFast,
    getChallenge,
    getCooldownRemaining,
    getInteractionStateKey,
    isStaleOldVersionComponent,
    resolveScreenExpiryMs,
    resolveCooldownSeconds,
    resolveVerificationMode,
    startScreenExpiryIfCurrent,
    selectVerificationChallenge,
    setChallenge,
    setCooldown,
} = require('./liveSessionState');
const {
    cloneSessionMessageHandles,
    createChallengeFingerprint,
    deactivateOldVersionPrompt,
    deactivateQuestionMessage,
    editOldVersionPrompt,
    editStoredVerificationMessage,
    getOldVersionPromptHandle,
    getQuestionMessageHandle,
    setSessionMessageHandle,
} = require('./liveMessageRenderer');
const {
    buildSessionScreenDeliveryPlan,
    deliverScreenPlan,
    deliverSessionScreen,
    rollbackScreenDelivery,
} = require('./screenDelivery');
const { showScreenTransitionProcessing } = require('./transitionPresentation');
const liveFlowLog = createVerificationLogger('Live flow');
const {
    completeVerification,
    fetchCurrentVerificationMember,
    getImageGenerationErrorMessage,
    logImageGenerationError,
    resolveManageableVerificationRole,
    validateLiveSessionConfiguration,
} = require('./liveCompletion');

async function handleVerifyHelp(interaction) {
    return interaction.reply(buildVerificationPublicResponse('verificationHelpEmbed'));
}

async function handleVerifyStart(interaction) {
    if (!interaction.deferred && !interaction.replied) {
        await deferEphemeralReply(interaction);
    }

    let runtimeContext;
    try {
        runtimeContext = getPublishedVerificationRuntimeContext(interaction.guild?.id);
    }
    catch (error) {
        if (error?.code !== 'VERIFICATION_RUNTIME_NOT_READY') throw error;
        return sendInitialInteractionResponse(interaction, buildVerificationErrorResponse(
            'Verification is temporarily unavailable while it finishes starting. Please try again shortly.',
        ));
    }
    const runtime = runtimeContext.snapshot.runtime;
    const verificationMode = resolveVerificationMode(runtime);
    const stateKey = getInteractionStateKey(interaction);

    if (verificationMode === VERIFICATION_MODES.halt) {
        return sendInitialInteractionResponse(interaction, buildVerificationErrorResponse('Verification is currently halted.'));
    }

    try {
        await resolveManageableVerificationRole(interaction.guild, runtime);
    }
    catch (err) {
        liveFlowLog.warn('Start unavailable', err, {
            guildId: interaction.guild?.id ?? 'unknown',
        });
        return sendInitialInteractionResponse(interaction, buildVerificationErrorResponse(
            'Verification is temporarily unavailable. Please try again later. If the problem persists, contact staff.',
        ));
    }

    if (verificationMode === VERIFICATION_MODES.oneClick) {
        return completeVerification(interaction);
    }

    let membershipJoinedAtMs = interaction.member?.joinedTimestamp;
    if (!Number.isFinite(membershipJoinedAtMs)) {
        const startingMember = await interaction.guild.members.fetch({
            user: interaction.user.id,
            force: true,
        });
        membershipJoinedAtMs = startingMember.joinedTimestamp;
    }
    if (!Number.isFinite(membershipJoinedAtMs)) {
        throw new Error('Verification could not identify the current server membership generation.');
    }

    const screenExpiryMs = resolveScreenExpiryMs(runtime);
    let existingChallenge = getChallenge(stateKey, screenExpiryMs);
    if (
        existingChallenge
        && existingChallenge.membershipJoinedAtMs !== membershipJoinedAtMs
    ) {
        clearVerificationStateIfCurrent(stateKey, existingChallenge);
        existingChallenge = undefined;
    }

    const cooldownRemaining = getCooldownRemaining(stateKey);
    if (cooldownRemaining > 0) {
        return sendInitialInteractionResponse(
            interaction,
            buildVerificationCooldownResponse(Date.now() + cooldownRemaining),
        );
    }

    if (existingChallenge) {
        return sendInitialInteractionResponse(interaction, buildVerificationInProgressResponse(
            existingChallenge.expiresAt,
        ));
    }

    const challenge = selectVerificationChallenge(runtime);
    if (!challenge) {
        const error = new Error('Published Verification runtime has no selectable active challenge.');
        error.code = 'VERIFICATION_RUNTIME_CONTEXT_INVALID';
        throw error;
    }
    const screens = buildQuestionScreens(challenge);
    const screenIndex = 0;
    const token = createSessionToken();
    const fallbackToken = createSessionToken();
    const createdTimestamp = Date.now();
    const expiresAt = createdTimestamp + screenExpiryMs;
    const renderer = COMPONENTS_V2_RENDERER;
    const session = createVerificationSession({
        challenge,
        screens,
        screenIndex,
        token,
        renderPriority: 'live',
        allowBack: false,
        renderer,
        guildId: interaction.guildId ?? interaction.guild?.id,
        verificationRoleId: runtime.verificationRoleId,
        membershipJoinedAtMs,
        challengeFingerprint: createChallengeFingerprint(challenge),
        screenExpiryMs,
        cooldownSeconds: resolveCooldownSeconds(runtime),
        fallbackToken,
        messageHandles: {},
        createdTimestamp,
        expiresAt,
        phase: 'preparing',
        imageInventory: runtimeContext.imageInventory,
        imageInventoryRevision: runtimeContext.imageInventory.contentRevision,
    });

    if (!setChallenge(stateKey, session, screenExpiryMs)) {
        return sendInitialInteractionResponse(interaction, buildVerificationErrorResponse(
            'Verification is temporarily busy. Please try again later. If the problem persists, contact staff.',
        ));
    }
    const sessionAttempt = captureSessionAttempt(session);
    if (!beginScreenProcessingIfCurrent(stateKey, session, { attempt: sessionAttempt })) {
        return sendInitialInteractionResponse(interaction, buildVerificationExpiredResponse(
            'This verification attempt expired before screen preparation could begin. Please start again.',
        ));
    }

    const assetDelivery = decideVerificationAssetDelivery({
        guildId: session.guildId,
        screen: screens[0],
        imageInventory: session.imageInventory,
    });
    const presentInitialPreparation = async () => {
        try {
            const prompt = await sendInitialInteractionResponse(
                interaction,
                buildOldVersionFallbackOptions(challenge, session, { queued: true }),
            );
            if (!prompt?.id) return undefined;
            setSessionMessageHandle(session, 'fallback-prompt', prompt.id, LEGACY_RENDERER);
            return prompt;
        }
        catch (error) {
            liveFlowLog.warn('Preparation status unavailable; continuing live rendering', error, {
                guildId: interaction.guild?.id ?? 'unknown',
                userId: interaction.user?.id ?? 'unknown',
            });
            return undefined;
        }
    };
    const presentInitialFallback = async () => {
        const promptHandle = getOldVersionPromptHandle(session);
        const options = buildOldVersionFallbackOptions(challenge, session);
        if (promptHandle) return editOldVersionPrompt(interaction, session, options);
        const prompt = await sendInitialInteractionResponse(interaction, options);
        if (!prompt?.id) {
            throw new Error('Discord did not return the verification old-version fallback.');
        }
        setSessionMessageHandle(session, 'fallback-prompt', prompt.id, LEGACY_RENDERER);
        return prompt;
    };

    let initialPhase = 'preparation';
    let initialDeliveryReceipt;
    try {
        await presentInitialPreparation();
        initialPhase = 'session-check';
        await assertPendingInitialLiveSessionCurrent(
            interaction,
            stateKey,
            session,
            fetchCurrentVerificationMember,
            { attempt: sessionAttempt },
        );

        initialPhase = 'preparation';
        session.screenAssets = await prepareSessionScreenAssets(session, screenIndex, {
            stockDecisionMade: true,
            stockReservation: assetDelivery.reservation,
        });

        initialPhase = 'session-check';
        await assertPendingInitialLiveSessionCurrent(
            interaction,
            stateKey,
            session,
            fetchCurrentVerificationMember,
            { attempt: sessionAttempt },
        );

        initialPhase = 'delivery';
        const plan = buildSessionScreenDeliveryPlan(session, {
            includeIntro: true,
        });
        const questionMessage = await interaction.followUp(plan.primaryOptions);
        initialDeliveryReceipt = await deliverScreenPlan(interaction, session, plan, questionMessage, {
            primaryWasCreated: true,
        });
        await assertPendingInitialLiveSessionCurrent(
            interaction,
            stateKey,
            session,
            fetchCurrentVerificationMember,
            { attempt: sessionAttempt },
        );
        await presentInitialFallback();

        if (!commitPendingInitialLiveSession(
            stateKey,
            session,
            { attempt: sessionAttempt },
        )) {
            throw new Error('The active verification session changed before its first screen could be committed.');
        }
        return undefined;
    }
    catch (err) {
        clearChallengeIfCurrent(stateKey, session, { attempt: sessionAttempt });
        await rollbackScreenDelivery(
            interaction,
            initialDeliveryReceipt ?? err?.deliveryReceipt,
        );
        if (err?.code === 'VERIFICATION_INITIAL_SESSION_STALE') {
            return sendInitialInteractionResponse(interaction, buildVerificationExpiredResponse(err.message));
        }
        if (
            initialPhase === 'preparation'
            || isVerificationRenderCapacityError(err)
            || isVerificationRenderAvailabilityError(err)
        ) {
            void logImageGenerationError(
                interaction,
                'Failed to generate verification image challenge:',
                challenge.id,
                err,
                screenIndex,
            );
            return sendInitialInteractionResponse(
                interaction,
                buildVerificationErrorResponse(getImageGenerationErrorMessage(err)),
            );
        }

        let responseError;
        const responseDelivered = await sendInitialInteractionResponse(
            interaction,
            buildVerificationErrorResponse(
                'Verification could not be started. Please try again later. If the problem persists, contact staff.',
            ),
        ).then(() => true).catch((error) => {
            responseError = error;
            return false;
        });
        if (responseDelivered && err && typeof err === 'object') {
            err.wardenVerificationErrorResponseDelivered = true;
        }
        if (responseError) {
            throw new AggregateError(
                [err, responseError],
                'Verification startup and its queued error response both failed.',
                { cause: err },
            );
        }
        throw err;
    }
    finally {
        releaseSessionScreenAssetDelivery(session);
        await discardVerificationAssetStockReservation(assetDelivery.reservation);
    }
}

async function handleVerifyOldVersion(interaction) {
    const session = await getActiveSessionOrReplyFast(interaction);
    if (!session) return;

    const clicked = parseOldVersionCustomId(interaction.customId);
    if (session.renderer !== COMPONENTS_V2_RENDERER || isStaleOldVersionComponent(clicked, session)) {
        return interaction.reply(buildVerificationExpiredResponse('This old version button is no longer current. Please use the latest verification challenge message.'));
    }
    if (session.busy) {
        return interaction.reply(buildVerificationBusyResponse());
    }

    session.busy = true;
    let legacySession;
    let legacyDeliveryReceipt;
    let committedLegacySession;
    let screenProcessing = false;
    let promptQueued = false;
    const stateKey = getInteractionStateKey(interaction);
    try {
        await deferSourceUpdate(interaction);
        if (getActiveSession(stateKey) !== session) {
            throw new Error('The active verification session expired before the old version could open.');
        }
        await editOldVersionPrompt(
            interaction,
            session,
            buildOldVersionFallbackOptions(session.challenge, session, { queued: true }),
        );
        promptQueued = true;
        if (!beginScreenProcessingIfCurrent(stateKey, session)) {
            throw new Error('The active verification session expired before the old version could be prepared.');
        }
        screenProcessing = true;
        try {
            if (getActiveSession(stateKey) !== session) {
                throw new Error('The active verification session expired before the old version could open.');
            }
            const challenge = session.challenge;
            if (!challenge) throw new Error('The active verification session has no catalog challenge snapshot.');
            legacySession = createVerificationSession({
                challenge,
                screens: session.screens,
                screenIndex: 0,
                renderer: LEGACY_RENDERER,
                token: createSessionToken(),
                renderPriority: session.renderPriority,
                allowBack: false,
                guildId: session.guildId,
                verificationRoleId: session.verificationRoleId,
                membershipJoinedAtMs: session.membershipJoinedAtMs,
                challengeFingerprint: session.challengeFingerprint,
                screenExpiryMs: session.screenExpiryMs,
                cooldownSeconds: session.cooldownSeconds,
                fallbackToken: session.fallbackToken,
                messageHandles: cloneSessionMessageHandles(session),
                createdTimestamp: Date.now(),
                expiresAt: session.expiresAt,
                phase: 'preparing',
                imageInventory: session.imageInventory,
                imageInventoryRevision: session.imageInventoryRevision,
            });
            legacySession.screenAssets = await prepareSessionScreenAssets(legacySession);
            if (getActiveSession(stateKey) !== session) {
                throw new Error('The active verification session expired while the old version was preparing.');
            }
            const plan = buildSessionScreenDeliveryPlan(legacySession, { includeIntro: true });

            const promptHandle = getOldVersionPromptHandle(session);
            if (!promptHandle) {
                throw new Error('The verification Old Version prompt is no longer editable.');
            }
            delete legacySession.messageHandles['fallback-prompt'];
            legacyDeliveryReceipt = await deliverScreenPlan(
                interaction,
                legacySession,
                plan,
                promptHandle.id,
            );
            if (getActiveSession(stateKey) !== session) {
                throw new Error('The active verification session changed before the old version could be committed.');
            }

            // Make the legacy token authoritative but keep it locked before
            // Discord exposes its controls. A failed edit rolls back below.
            legacySession.busy = true;
            if (!setChallenge(stateKey, legacySession, session.screenExpiryMs)) {
                throw new Error('The legacy verification session could not be committed.');
            }
            committedLegacySession = getActiveSession(stateKey);
            if (!committedLegacySession || committedLegacySession.token !== legacySession.token) {
                throw new Error('The committed legacy verification session could not be confirmed.');
            }
            const legacyAttempt = captureSessionAttempt(committedLegacySession);

            // The stable Old Version prompt becomes the interactive legacy
            // challenge instead of creating another ephemeral message.
            const firstLegacyMessage = await editOldVersionPrompt(
                interaction,
                session,
                plan.primaryOptions,
            );
            if (
                firstLegacyMessage.id !== promptHandle.id
                || getActiveSession(stateKey) !== committedLegacySession
            ) {
                throw new Error('The active verification session changed while opening the old version.');
            }
            if (!commitPendingInitialLiveSession(
                stateKey,
                committedLegacySession,
                { attempt: legacyAttempt },
            )) {
                throw new Error('The legacy verification session expired before it could become active.');
            }

            committedLegacySession.busy = false;
            legacySession.busy = false;
            screenProcessing = false;
            await deactivateQuestionMessage(interaction, session, 'Continue with the legacy verification message.', { title: 'Old Version Opened' });
        }
        finally {
            if (legacySession) releaseSessionScreenAssetDelivery(legacySession);
        }
    }
    catch (error) {
        let retrySession = session;
        if (committedLegacySession && getActiveSession(stateKey) === committedLegacySession) {
            session.busy = false;
            if (setChallenge(stateKey, session, session.screenExpiryMs)) {
                startScreenExpiryIfCurrent(stateKey, session);
                retrySession = getActiveSession(stateKey) ?? session;
            }
        }
        else if (screenProcessing && getActiveSession(stateKey) === session) {
            startScreenExpiryIfCurrent(stateKey, session);
        }
        legacyDeliveryReceipt ??= error?.deliveryReceipt;
        await rollbackScreenDelivery(
            interaction,
            legacyDeliveryReceipt,
        );
        if (promptQueued) {
            const retryEnabled = getActiveSession(stateKey) === retrySession;
            const message = !retryEnabled
                ? 'This Old Version attempt is no longer current. Please press Verify to start again.'
                : isVerificationRenderCapacityError(error)
                    ? 'Old Version image processing is temporarily busy. Please press Old Version again shortly. If the problem persists, contact staff.'
                    : isVerificationRenderAvailabilityError(error)
                        ? 'Old Version image processing is temporarily unavailable. Please press Old Version again shortly. If the problem persists, contact staff.'
                        : 'The Old Version screen could not be prepared. Please press Old Version to try again. If the problem persists, contact staff.';
            let responseError;
            const responseDelivered = await editOldVersionPrompt(
                interaction,
                retrySession,
                buildOldVersionFallbackOptions(retrySession.challenge, retrySession, {
                    errorMessage: message,
                    retry: retryEnabled,
                }),
            ).then(() => true).catch((error) => {
                responseError = error;
                return false;
            });
            if (responseDelivered && error && typeof error === 'object') {
                error.wardenVerificationErrorResponseDelivered = true;
            }
            if (responseError) {
                throw new AggregateError(
                    [error, responseError],
                    'Old Version preparation and its recovery response both failed.',
                    { cause: error },
                );
            }
        }
        throw error;
    }
    finally {
        session.busy = false;
    }
}

async function handleIncorrectLiveAnswer(interaction, session) {
    const cooldownSeconds = session.cooldownSeconds ?? 60;
    const retryAt = Date.now() + (cooldownSeconds * 1000);
    const stateKey = getInteractionStateKey(interaction);
    const questionHandle = getQuestionMessageHandle(session);
    const failureResponse = buildVerificationStateOptions(undefined, {
        renderer: questionHandle?.renderer ?? LEGACY_RENDERER,
        templateKey: 'failureEmbed',
        replacements: {
            cooldownSeconds,
            retryTime: `<t:${Math.floor(retryAt / 1000)}:R>`,
        },
    });

    clearChallenge(stateKey);
    setCooldown(stateKey, retryAt);
    await editStoredVerificationMessage(interaction, questionHandle, failureResponse);
}

async function handleNextScreenFailure(interaction, session, transitionContext, error) {
    const recoveryErrors = [];
    clearChallengeIfCurrent(
        getInteractionStateKey(interaction),
        session,
        { attempt: transitionContext.attempt },
    );
    const message = isVerificationRenderCapacityError(error)
        ? 'Verification image processing is temporarily busy. Please press Verify again shortly. If the problem persists, contact staff.'
        : isVerificationRenderAvailabilityError(error)
            ? 'Verification image processing is temporarily unavailable. Please press Verify again shortly. If the problem persists, contact staff.'
            : 'The next verification screen could not be prepared. Please press Verify again. If the problem persists, contact staff.';

    const errorOptions = buildVerificationStateOptions(undefined, {
        renderer: transitionContext.questionHandle.renderer,
        templateKey: 'runtimeErrorEmbed',
        replacements: { message },
    });
    const responseDelivered = await editStoredVerificationMessage(
        interaction,
        transitionContext.questionHandle,
        errorOptions,
    ).then(() => true).catch((responseError) => {
        recoveryErrors.push(responseError);
        return false;
    });

    const deliveryReceipt = transitionContext.deliveryReceipt;
    await rollbackScreenDelivery(
        interaction,
        deliveryReceipt,
    );
    await deactivateOldVersionPrompt(interaction, session, {
        title: 'Verification Restart Required',
        description: 'This verification attempt could not continue. Please press Verify again.',
    }).catch((promptError) => {
        recoveryErrors.push(promptError);
    });

    if (responseDelivered && error && typeof error === 'object') {
        error.wardenVerificationErrorResponseDelivered = true;
    }
    if (recoveryErrors.length > 0) {
        throw new AggregateError(
            recoveryErrors,
            'Verification transition recovery could not update every Discord message.',
            { cause: recoveryErrors[0] },
        );
    }
}

async function assertLiveSessionCurrent(interaction, session, transitionContext = {}) {
    const stateKey = getInteractionStateKey(interaction);
    if (
        getActiveSession(stateKey) !== session
        || (
            transitionContext.attempt
            && captureSessionAttempt(session) !== transitionContext.attempt
        )
    ) {
        throw new Error('The active verification session changed while preparing the next screen.');
    }
}

const LIVE_SESSION_POLICY = Object.freeze({
    controlPrefixes: DEFAULT_VERIFICATION_CONTROL_PREFIXES,
    messages: Object.freeze({
        staleAnswer: 'This challenge button is no longer current. Please use the latest verification challenge message.',
        inactiveAnswer: 'This answer screen is no longer active. Please use the latest verification challenge message.',
        staleNavigation: 'This navigation button is no longer current. Please use the latest verification challenge message.',
        answerRequired: 'This screen requires an answer. Please use the latest verification challenge message.',
        backDisallowed: 'You cannot go back to that verification screen.',
        staleSubmit: 'This answer modal is no longer current. Please use the latest verification challenge message.',
        inactiveSubmit: 'This answer modal is no longer current. Please use the latest verification challenge message.',
        busy: 'This verification session is already processing another action.',
    }),
    createToken: createSessionToken,
    resolveSession: (interaction) => getActiveSessionOrReplyFast(interaction),
    validateSession: validateLiveSessionConfiguration,
    busyNotice: (interaction) => sendEphemeralNotice(interaction, buildVerificationBusyResponse()),
    notice: (interaction, message) => sendEphemeralNotice(
        interaction,
        buildVerificationExpiredResponse(message),
    ),
    async beginSubmit(interaction) {
        if (!interaction.deferred && !interaction.replied) await deferSourceUpdate(interaction);
    },
    createTransitionContext(_interaction, _source, session) {
        return {
            attempt: captureSessionAttempt(session),
            questionHandle: getQuestionMessageHandle(session),
        };
    },
    async beginTransition(interaction, source, session, _targetScreenIndex, transitionContext) {
        if (source === 'button' && !interaction.deferred && !interaction.replied) {
            await deferSourceUpdate(interaction);
        }
        await assertLiveSessionCurrent(interaction, session, transitionContext);
        const stateKey = getInteractionStateKey(interaction);
        if (!beginScreenProcessingIfCurrent(
            stateKey,
            session,
            { attempt: transitionContext.attempt },
        )) {
            throw new Error('The active verification session expired before its next screen could be prepared.');
        }
    },
    failTransition: handleNextScreenFailure,
    assertSessionCurrent: assertLiveSessionCurrent,
    async prepareTransitionDelivery(interaction, session, transitionContext) {
        await showScreenTransitionProcessing(interaction, session, transitionContext);
    },
    async commitTransition(interaction, session, transitionContext) {
        if (!startScreenExpiryIfCurrent(
            getInteractionStateKey(interaction),
            session,
            { attempt: transitionContext.attempt },
        )) {
            throw new Error('The active verification session expired while committing its next screen.');
        }
    },
    deliverScreen: (interaction, session, nextSession, source) =>
        deliverSessionScreen(interaction, session, nextSession, {
            forceStoredMessage: source === 'button',
            presentation: { includeIntro: false },
        }),
    incorrect: handleIncorrectLiveAnswer,
    async complete(interaction, session, _progress, source) {
        if (source === 'button') await deferSourceUpdate(interaction);
        await assertLiveSessionCurrent(interaction, session);
        const stateKey = getInteractionStateKey(interaction);
        if (!beginScreenProcessingIfCurrent(stateKey, session)) {
            throw new Error('The active verification session expired before completion could begin.');
        }
        try {
            return await completeVerification(interaction, session);
        }
        catch (error) {
            startScreenExpiryIfCurrent(stateKey, session);
            throw error;
        }
    },
});
const liveSessionFlow = createVerificationSessionFlow(LIVE_SESSION_POLICY);

function getVerificationRoute(interaction) {
    const customId = interaction.customId;

    if (interaction.isButton() && customId === 'wardenVerify-start') return { handler: handleVerifyStart, errorTitle: '⛔ Verification start error', userError: 'Verification could not be started. Please try again later. If the problem persists, contact staff.', deferImmediately: true };
    if (interaction.isButton() && customId === 'wardenVerify-help') return { handler: handleVerifyHelp, errorTitle: '⛔ Verification help error', userError: 'Verification help could not be shown. Please try again later. If the problem persists, contact staff.' };
    if (interaction.isButton() && customId.startsWith('wardenVerify-oldVersion-')) return { handler: handleVerifyOldVersion, errorTitle: '⛔ Verification old version error', userError: 'Verification old version could not be shown. Please try again later. If the problem persists, contact staff.' };

    const sessionRoute = liveSessionFlow.parseRoute(interaction);
    if (sessionRoute) {
        const errors = {
            answer: ['⛔ Verification answer modal error', 'Verification answer modal could not be opened. Please try again later. If the problem persists, contact staff.'],
            next: ['⛔ Verification next error', 'Verification could not continue. Please try again later. If the problem persists, contact staff.'],
            back: ['⛔ Verification back error', 'Verification could not go back. Please try again later. If the problem persists, contact staff.'],
            submit: ['⛔ Verification submission error', 'Verification could not be submitted. Please try again later. If the problem persists, contact staff.'],
        };
        return {
            handler: (routedInteraction) => liveSessionFlow.handleRoute(routedInteraction, sessionRoute),
            errorTitle: errors[sessionRoute.action][0],
            userError: errors[sessionRoute.action][1],
        };
    }

    return null;
}

async function sendVerificationErrorResponse(interaction, content) {
    return sendEphemeralNotice(interaction, buildVerificationErrorResponse(content));
}

async function handleVerificationInteraction(interaction) {
    const route = getVerificationRoute(interaction);
    if (!route) return false;

    try {
        if (route.deferImmediately && !interaction.deferred && !interaction.replied) {
            await deferEphemeralReply(interaction);
        }

        await route.handler(interaction);
    }
    catch (err) {
        const isCapacityError = isVerificationRenderCapacityError(err);
        const isAvailabilityError = isVerificationRenderAvailabilityError(err);
        void reportVerificationError({
            interaction,
            title: route.errorTitle,
            userId: interaction.user?.id,
        }, err);
        if (err?.wardenVerificationErrorResponseDelivered !== true) {
            await sendVerificationErrorResponse(
                interaction,
                isCapacityError || isAvailabilityError
                    ? getImageGenerationErrorMessage(err)
                    : route.userError,
            ).catch((replyErr) => liveFlowLog.error('Failed to send error response:', replyErr));
        }
    }

    return true;
}

module.exports = {
    handleVerificationInteraction,
};
