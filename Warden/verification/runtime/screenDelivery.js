const {
    COMPONENTS_V2_RENDERER,
    LEGACY_RENDERER,
    createVerificationChallengeScreenDocument,
} = require('../presentation/documents/challengeScreen');
const { renderComponentsV2 } = require('../../ux/renderers/componentsV2');
const { renderLegacy } = require('../../ux/renderers/legacy');
const { assertEmbedBudget } = require('../../ux/components/budget');
const {
    cloneSessionMessageHandles,
    replaceQuestionMessage,
} = require('./liveMessageRenderer');
const { getCurrentScreen } = require('./sessionFlow');
const { createVerificationLogger } = require('../logging');

const screenDeliveryLog = createVerificationLogger('Screen delivery');

const SCREEN_RENDERERS = Object.freeze({
    [COMPONENTS_V2_RENDERER]: (session, screen, options) => {
        const document = createVerificationChallengeScreenDocument(
            session.challenge,
            screen,
            session.screenAssets,
            { ...session, renderer: COMPONENTS_V2_RENDERER },
            options,
        );
        return renderComponentsV2(document);
    },
    [LEGACY_RENDERER]: (session, screen, options) => renderLegacy(createVerificationChallengeScreenDocument(
        session.challenge,
        screen,
        session.screenAssets,
        { ...session, renderer: LEGACY_RENDERER },
        options,
    )),
});

function buildSessionScreenDeliveryPlan(session, options = {}) {
    const renderScreen = Object.hasOwn(SCREEN_RENDERERS, session?.renderer)
        ? SCREEN_RENDERERS[session.renderer]
        : undefined;
    if (typeof renderScreen !== 'function') {
        throw new Error(`Unknown verification screen renderer: ${session?.renderer ?? 'none'}.`);
    }
    if (!session.challenge) {
        throw new Error('The verification session has no catalog challenge snapshot.');
    }
    const screen = getCurrentScreen(session);
    if (!screen) {
        throw new Error(`The verification session has no screen at index ${session.screenIndex}.`);
    }

    const rendered = renderScreen(session, screen, options);
    if (rendered?.pages?.length !== 1) {
        throw new Error(
            `Verification ${session.renderer} screen ${screen.index + 1} rendered to `
            + `${rendered?.pages?.length ?? 0} Discord messages; every verification screen must fit one message.`,
        );
    }
    const primaryOptions = rendered.payload;
    if (!primaryOptions) throw new Error('The verification renderer produced no primary screen payload.');
    if (session.renderer === LEGACY_RENDERER) {
        assertEmbedBudget(primaryOptions.embeds, `Verification legacy screen ${screen.index + 1}`);
    }
    return {
        renderer: session.renderer,
        primaryOptions,
    };
}

function createScreenDeliveryReceipt(plan, primaryMessage, primaryWasCreated = false) {
    const id = primaryMessage?.id ?? primaryMessage;
    if (!id) throw new Error('Discord did not return the verification screen message.');
    return {
        renderer: plan.renderer,
        primaryHandle: {
            id,
            role: 'challenge',
            renderer: plan.renderer,
        },
        primaryWasCreated,
    };
}

async function deliverScreenPlan(_interaction, session, plan, primaryMessage, options = {}) {
    const receipt = createScreenDeliveryReceipt(
        plan,
        primaryMessage,
        options.primaryWasCreated === true,
    );
    applyScreenDeliveryReceipt(session, receipt);
    return receipt;
}

function applyScreenDeliveryReceipt(session, receipt) {
    session.messageHandles ??= {};
    session.messageHandles.challenge = receipt.primaryHandle;
    return receipt;
}

async function deliverSessionScreen(interaction, currentSession, targetSession, options = {}) {
    targetSession.messageHandles = cloneSessionMessageHandles(currentSession);
    const plan = buildSessionScreenDeliveryPlan(targetSession, options.presentation);
    const primary = await replaceQuestionMessage(
        interaction,
        currentSession,
        plan.primaryOptions,
        { forceStoredMessage: options.forceStoredMessage === true },
    );
    return deliverScreenPlan(interaction, targetSession, plan, primary.id, {
        primaryWasCreated: primary.created,
    });
}

async function rollbackScreenDelivery(interaction, receipt) {
    if (!receipt) return;
    if (receipt.rollbackPromise) return receipt.rollbackPromise;
    receipt.rollbackPromise = (async () => {
        if (receipt.primaryWasCreated && receipt.primaryHandle?.id) {
            await interaction.webhook.deleteMessage(receipt.primaryHandle.id).catch((error) => {
                screenDeliveryLog.warn('Failed to delete uncommitted message:', error);
            });
        }
    })();
    return receipt.rollbackPromise;
}

module.exports = {
    buildSessionScreenDeliveryPlan,
    deliverScreenPlan,
    deliverSessionScreen,
    rollbackScreenDelivery,
};
