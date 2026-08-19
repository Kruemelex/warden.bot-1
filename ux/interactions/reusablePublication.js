'use strict';

const { expectedInteractionError } = require('./errors');

/**
 * Coordinate a reusable private panel that locks while publishing a public
 * result. The publication attempt remains available when delivery is
 * ambiguous, allowing the feature to expose an explicit confirmation action
 * without risking an automatic duplicate post.
 */
function createReusablePanelPublisher({
    cooldownMs,
    createAttempt,
    errors,
    getAttempt,
    getCooldownUntil,
    isBusy,
    isDefiniteFailure,
    isReady,
    markPublished,
    now = Date.now,
    publishAttempt,
    renderEditable,
    renderLocked,
    reporter,
    resetAttempt,
    setAttempt,
    setBusy,
    setCooldownUntil,
} = {}) {
    async function restore({ interaction, model, panelSession, sourceMessage }, viaWebhook = false) {
        const payload = renderEditable({ model, panelSession, sourceMessage });
        if (!viaWebhook) return interaction.editReply(payload);
        const messageId = String(interaction.message?.id ?? '').trim();
        if (!messageId || typeof interaction.webhook?.editMessage !== 'function') {
            throw new Error(errors.webhookUnavailable);
        }
        return interaction.webhook.editMessage(messageId, payload);
    }

    async function restoreWithRetry(details, viaWebhook = false) {
        let firstError;
        try {
            await restore(details, viaWebhook);
            return true;
        } catch (error) {
            firstError = error;
            reporter.warn('Private panel restoration failed; retrying once', error);
        }
        try {
            await restore(details, viaWebhook);
            return true;
        } catch (error) {
            reporter.error('Private panel restoration failed after retry', error, {
                firstError: firstError?.message,
            });
            return false;
        }
    }

    async function restoreAndUnlock(details, viaWebhook = false) {
        const restored = await restoreWithRetry(details, viaWebhook);
        setBusy(details.model, false);
        return restored;
    }

    async function publish(details) {
        const { interaction, model, panelSession } = details;
        if (!isReady(model)) throw expectedInteractionError(errors.notReady);
        if (isBusy(model)) throw expectedInteractionError(errors.alreadyPublishing);
        const attempt = getAttempt(model);
        const cooldownUntil = Number(getCooldownUntil(model));
        if (!attempt && cooldownUntil > now()) throw expectedInteractionError(errors.cooldown(cooldownUntil));

        setBusy(model, true);
        panelSession.invalidateForms();
        let lockMayHaveApplied = false;
        try {
            const lockedPayload = renderLocked(details);
            lockMayHaveApplied = true;
            await interaction.update(lockedPayload);
        } catch (error) {
            if (!lockMayHaveApplied) {
                setBusy(model, false);
                throw error;
            }
            const restored = await restoreAndUnlock(details, true);
            if (restored) reporter.warn('Panel lock acknowledgement failed; editable panel restored', error);
            else reporter.error('Panel lock acknowledgement failed; private panel recovery unavailable', error);
            return;
        }

        let sendStarted = false;
        try {
            const currentAttempt = getAttempt(model) ?? createAttempt({ interaction, model });
            setAttempt(model, currentAttempt);
            sendStarted = true;
            await publishAttempt({ attempt: currentAttempt, interaction, model });
        } catch (error) {
            const ambiguous = sendStarted && getAttempt(model) && !isDefiniteFailure(error);
            if (!ambiguous) resetAttempt(model);
            const restored = await restoreAndUnlock(details);
            if (!restored) {
                reporter.error('Publication failed and private panel recovery was unavailable', error);
                return;
            }
            throw error;
        }

        markPublished(model);
        resetAttempt(model);
        setCooldownUntil(model, now() + cooldownMs);
        await restoreAndUnlock(details);
    }

    return Object.freeze({ publish });
}

module.exports = {
    createReusablePanelPublisher,
};
