const {
    getScreenRequiredAnswerQuestions, screenAllowsBack, screenRequiresAnswer, validateScreenAnswers,
} = require('../domain/challenges');
const {
    prepareQuestionAssets,
    questionAssetsNeedDelivery,
    releaseQuestionAssetDelivery,
    retainQuestionAssetDelivery,
    restoreQuestionAssetDelivery,
    screenNeedsQuestionAssetDelivery,
} = require('../assets/screenAssets');
const {
    buildAnswerInputCustomId,
    buildAnswerModal,
    parseSessionComponentCustomId,
} = require('../presentation/answerModal');
const { runVerificationScreenWork } = require('./screen-work-limiter');
const { acquireVerificationAttachmentDelivery } = require('./resource-admission');
const {
    consumeVerificationAssetStockReservation,
    decideVerificationAssetDelivery,
    screenNeedsAssetStock,
} = require('./assetStock');
const DEFAULT_MAX_CACHED_SCREEN_ASSETS = 8;

async function prepareWithAttachmentAdmission(operation, {
    priority,
    signal,
    label,
} = {}) {
    const release = await acquireVerificationAttachmentDelivery({
        priority,
        signal,
        label,
    });
    try {
        const assets = await operation();
        if (!assets) {
            release();
            return assets;
        }
        return retainQuestionAssetDelivery(assets, release);
    }
    catch (error) {
        release();
        throw error;
    }
}

function createVerificationSession({ challenge, screens, token, screenIndex = 0, ...session }) {
    return {
        ...session,
        challengeId: challenge.id,
        challenge,
        screens,
        screenIndex,
        screenAssets: {},
        screenAssetCache: new Map(),
        completedScreens: [],
        answeredScreenIndexes: [],
        token,
        busy: false,
    };
}
function getCurrentScreen(session) {
    return session.screens[session.screenIndex];
}
function hasNextScreen(session) {
    return session.screenIndex + 1 < session.screens.length;
}
function isCurrentScreenControl(parsed, session) {
    return Boolean(parsed)
        && parsed.screenIndex === session.screenIndex
        && parsed.token === session.token;
}
function addScreenProgress(indexes, screenIndex) {
    return [...new Set([...(indexes ?? []), screenIndex])];
}
function getSubmittedScreenValues(screen, interaction) {
    return getScreenRequiredAnswerQuestions(screen).reduce((values, question, index) => {
        try {
            values[question.id] = interaction.fields.getTextInputValue(buildAnswerInputCustomId(index));
        }
        catch (err) {
            if (err?.code !== 'ModalSubmitInteractionFieldNotFound') throw err;
            values[question.id] = '';
        }
        return values;
    }, {});
}
function getScreenValidationAssets(screenAssets = {}) {
    return Object.entries(screenAssets).reduce((assets, [questionId, questionAsset]) => {
        if (questionAsset?.galleryState) assets[questionId] = questionAsset.galleryState;
        return assets;
    }, {});
}
function validateSubmittedScreen(session, interaction) {
    const screen = getCurrentScreen(session);
    return validateScreenAnswers(
        screen,
        getSubmittedScreenValues(screen, interaction),
        getScreenValidationAssets(session.screenAssets),
    );
}
async function prepareUncachedSessionScreenAssets(session, screenIndex, priority, options) {
    const screen = session.screens[screenIndex];
    let stockedAssets;
    if (options.stockReservation) {
        stockedAssets = await prepareWithAttachmentAdmission(
            () => consumeVerificationAssetStockReservation(options.stockReservation),
            {
                priority,
                label: 'Restoring prepared verification screen attachments',
            },
        );
    }
    else if (
        priority === 'live'
        && options.stockDecisionMade !== true
        && screenNeedsAssetStock(screen)
    ) {
        const reservation = decideVerificationAssetDelivery({
            guildId: session.guildId,
            screen,
            imageInventory: session.imageInventory,
        }).reservation;
        if (reservation) {
            stockedAssets = await prepareWithAttachmentAdmission(
                () => consumeVerificationAssetStockReservation(reservation),
                {
                    priority,
                    label: 'Checking out prepared verification screen attachments',
                },
            );
        }
    }
    if (stockedAssets) return stockedAssets;

    const prepare = ({ signal } = {}) => {
        const operation = () => prepareQuestionAssets(
            screen,
            session.challengeId,
            { priority, signal, imageInventory: session.imageInventory },
        );
        if (!screenNeedsQuestionAssetDelivery(screen)) return operation();
        return prepareWithAttachmentAdmission(operation, {
            priority,
            signal,
            label: 'Preparing verification screen attachments',
        });
    };
    if (!screenNeedsAssetStock(screen)) return prepare();
    return runVerificationScreenWork(prepare, {
        priority,
        label: 'Preparing verification screen assets',
    });
}
async function prepareSessionScreenAssets(session, screenIndex = session.screenIndex, options = {}) {
    const maxCached = options.maxCached
        ?? (session.allowBack === false ? 1 : DEFAULT_MAX_CACHED_SCREEN_ASSETS);
    session.screenAssetCache ??= new Map();

    if (session.screenAssetCache.has(screenIndex)) {
        const cachedAssets = session.screenAssetCache.get(screenIndex);
        if (!questionAssetsNeedDelivery(cachedAssets)) {
            session.screenAssetCache.delete(screenIndex);
            session.screenAssetCache.set(screenIndex, cachedAssets);
            return cachedAssets;
        }
    }
    const priority = session.renderPriority ?? 'live';
    const cachedAssets = session.screenAssetCache.get(screenIndex);
    const restore = ({ signal } = {}) => prepareWithAttachmentAdmission(
        () => restoreQuestionAssetDelivery(cachedAssets, { priority }),
        {
            priority,
            signal,
            label: 'Restoring verification screen attachments',
        },
    );
    const assets = await (cachedAssets
        ? (screenNeedsAssetStock(session.screens[screenIndex])
            ? runVerificationScreenWork(
                restore,
                { priority, label: 'Restoring verification screen assets' },
            )
            : restore())
        : prepareUncachedSessionScreenAssets(session, screenIndex, priority, options));
    session.screenAssetCache.delete(screenIndex);
    session.screenAssetCache.set(screenIndex, assets);
    while (session.screenAssetCache.size > maxCached) {
        const oldestScreenIndex = session.screenAssetCache.keys().next().value;
        releaseQuestionAssetDelivery(session.screenAssetCache.get(oldestScreenIndex));
        session.screenAssetCache.delete(oldestScreenIndex);
    }
    return assets;
}
function releaseSessionScreenAssetDelivery(session, screenIndex = session.screenIndex) {
    const assets = screenIndex === session.screenIndex
        ? session.screenAssets
        : session.screenAssetCache?.get(screenIndex);
    if (!assets) return;
    releaseQuestionAssetDelivery(assets);
    session.screenAssetCache?.set(screenIndex, assets);
}
function parseSessionAction(interaction, controlPrefixes) {
    const customId = String(interaction.customId ?? '');
    const routes = interaction.isModalSubmit?.()
        ? [['submit', controlPrefixes.submit]]
        : interaction.isButton?.()
            ? [
                ['answer', controlPrefixes.answer],
                ['next', controlPrefixes.next],
                ['back', controlPrefixes.back],
            ]
            : [];

    for (const [action, prefix] of routes) {
        const parsed = parseSessionComponentCustomId(customId, prefix);
        if (parsed) return { action, parsed };
    }
    return undefined;
}
function createVerificationSessionFlow(policy) {
    async function resolveCurrentSession(interaction, parsed, staleMessage, lock = false) {
        const session = await policy.resolveSession(interaction, parsed);
        if (!session) return undefined;
        if (!isCurrentScreenControl(parsed, session)) {
            await policy.notice(interaction, staleMessage);
            return undefined;
        }
        if (session.busy) {
            await (policy.busyNotice ?? policy.notice)(interaction, policy.messages.busy);
            return undefined;
        }
        if (lock) session.busy = true;
        try {
            if (await policy.validateSession?.(interaction, session) === false) {
                if (lock) session.busy = false;
                return undefined;
            }
        }
        catch (error) {
            if (lock) session.busy = false;
            throw error;
        }
        return session;
    }
    async function transition(interaction, session, targetScreenIndex, progress, source) {
        const transitionContext = policy.createTransitionContext?.(
            interaction,
            source,
            session,
            targetScreenIndex,
        ) ?? {};
        let screenAssets;
        let transitionError;
        try {
            await policy.beginTransition?.(
                interaction,
                source,
                session,
                targetScreenIndex,
                transitionContext,
            );
            // A queued interaction may have expired or been superseded.
            // Check before exposing the processing state, then expose it before
            // any queue wait or native rendering so the member receives prompt
            // feedback for the entire transition rather than a last-moment flash.
            await policy.assertSessionCurrent?.(interaction, session, transitionContext);
            await policy.prepareTransitionDelivery?.(
                interaction,
                session,
                transitionContext,
            );
            await policy.assertSessionCurrent?.(
                interaction,
                session,
                transitionContext,
            );

            screenAssets = await prepareSessionScreenAssets(
                session,
                targetScreenIndex,
                policy.assetCache,
            );
            await policy.assertSessionCurrent?.(interaction, session, transitionContext);

            const nextSession = {
                ...session,
                ...progress,
                screenIndex: targetScreenIndex,
                screenAssets,
                token: policy.createToken(session),
            };
            const deliveryReceipt = await policy.deliverScreen(
                interaction,
                session,
                nextSession,
                source,
            );
            if (deliveryReceipt) transitionContext.deliveryReceipt = deliveryReceipt;
            await policy.assertSessionCurrent?.(
                interaction,
                session,
                transitionContext,
            );
            Object.assign(session, nextSession);
            await policy.commitTransition?.(
                interaction,
                session,
                transitionContext,
            );
        }
        catch (error) {
            transitionError = error;
        }
        finally {
            if (screenAssets) releaseQuestionAssetDelivery(screenAssets);
        }

        if (transitionError) {
            if (transitionError?.deliveryReceipt) {
                transitionContext.deliveryReceipt = transitionError.deliveryReceipt;
            }
            if (policy.failTransition) {
                try {
                    await policy.failTransition(
                        interaction,
                        session,
                        transitionContext,
                        transitionError,
                    );
                }
                catch (recoveryError) {
                    const aggregateError = new AggregateError(
                        [transitionError, recoveryError],
                        'Verification screen transition and its recovery both failed.',
                        { cause: transitionError },
                    );
                    if (transitionError?.deliveryReceipt) {
                        aggregateError.deliveryReceipt = transitionError.deliveryReceipt;
                    }
                    if (transitionError?.wardenVerificationErrorResponseDelivered === true) {
                        aggregateError.wardenVerificationErrorResponseDelivered = true;
                    }
                    throw aggregateError;
                }
            }
            throw transitionError;
        }
    }
    async function withSessionLock(session, action) {
        try {
            return await action();
        }
        finally {
            session.busy = false;
        }
    }
    async function answer(interaction, parsed) {
        const session = await resolveCurrentSession(interaction, parsed, policy.messages.staleAnswer);
        if (!session) return;
        const screen = getCurrentScreen(session);
        if (!screenRequiresAnswer(screen) || session.answeredScreenIndexes.includes(screen.index)) {
            return policy.notice(interaction, policy.messages.inactiveAnswer);
        }
        return interaction.showModal(buildAnswerModal(session, {
            controlPrefixes: policy.controlPrefixes,
        }));
    }
    async function next(interaction, parsed) {
        const session = await resolveCurrentSession(interaction, parsed, policy.messages.staleNavigation, true);
        if (!session) return;
        return withSessionLock(session, async () => {
            const screen = getCurrentScreen(session);
            if (screenRequiresAnswer(screen)) {
                return policy.notice(interaction, policy.messages.answerRequired);
            }

            const progress = {
                completedScreens: addScreenProgress(session.completedScreens, screen.index),
            };
            if (!hasNextScreen(session)) return policy.complete(interaction, session, progress, 'button');
            return transition(interaction, session, session.screenIndex + 1, progress, 'button');
        });
    }

    async function back(interaction, parsed) {
        const session = await resolveCurrentSession(interaction, parsed, policy.messages.staleNavigation, true);
        if (!session) return;
        return withSessionLock(session, async () => {
            const targetScreenIndex = session.screenIndex - 1;
            if (!screenAllowsBack(session, targetScreenIndex)) {
                return policy.notice(interaction, policy.messages.backDisallowed);
            }
            return transition(interaction, session, targetScreenIndex, {}, 'button');
        });
    }

    async function submit(interaction, parsed) {
        await policy.beginSubmit?.(interaction);
        const session = await resolveCurrentSession(interaction, parsed, policy.messages.staleSubmit, true);
        if (!session) return;
        return withSessionLock(session, async () => {
            const screen = getCurrentScreen(session);
            if (!screenRequiresAnswer(screen) || session.answeredScreenIndexes.includes(screen.index)) {
                return policy.notice(interaction, policy.messages.inactiveSubmit);
            }
            if (!validateSubmittedScreen(session, interaction).ok) {
                return policy.incorrect(interaction, session);
            }

            const progress = {
                completedScreens: addScreenProgress(session.completedScreens, screen.index),
                answeredScreenIndexes: addScreenProgress(session.answeredScreenIndexes, screen.index),
            };
            if (!hasNextScreen(session)) return policy.complete(interaction, session, progress, 'modal');
            return transition(interaction, session, session.screenIndex + 1, progress, 'modal');
        });
    }

    const handlers = { answer, next, back, submit };
    return {
        parseRoute: (interaction) => parseSessionAction(interaction, policy.controlPrefixes),
        handleRoute: (interaction, route) => handlers[route.action](interaction, route.parsed),
    };
}

module.exports = {
    createVerificationSession,
    createVerificationSessionFlow,
    getCurrentScreen,
    prepareSessionScreenAssets,
    releaseSessionScreenAssetDelivery,
};
