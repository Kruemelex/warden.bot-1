'use strict';

const Discord = require('discord.js');
const { buildLoadingComponents, snapshotMessageComponents } = require('../components/state');

const ACKNOWLEDGEMENT_MODES = Object.freeze({
    reply: 'reply',
    sourceUpdate: 'source-update',
});

const ACKNOWLEDGEMENT = Symbol('wardenUxAcknowledgement');

function isFromMessage(interaction) {
    return typeof interaction?.isFromMessage === 'function'
        ? interaction.isFromMessage()
        : Boolean(interaction?.message);
}

function markAcknowledgement(interaction, mode, details = {}) {
    const acknowledgement = { mode, ...details };
    interaction[ACKNOWLEDGEMENT] = acknowledgement;
    return acknowledgement;
}

function getAcknowledgement(interaction, acknowledgement) {
    return acknowledgement ?? interaction?.[ACKNOWLEDGEMENT];
}

function withEphemeralFlag(payload = {}) {
    return {
        ...payload,
        flags: Number(payload.flags ?? 0) | Discord.MessageFlags.Ephemeral,
    };
}

function sanitizeMessageEditOptions(payload = {}) {
    const response = { ...payload };
    if (typeof response.flags === 'number') {
        response.flags &= ~Discord.MessageFlags.Ephemeral;
        if (response.flags === 0) delete response.flags;
    }
    delete response.ephemeral;
    return response;
}

async function deferSourceUpdate(interaction) {
    await interaction.deferUpdate();
    return markAcknowledgement(interaction, ACKNOWLEDGEMENT_MODES.sourceUpdate);
}

async function deferEphemeralReply(interaction) {
    await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
    return markAcknowledgement(interaction, ACKNOWLEDGEMENT_MODES.reply);
}

async function acknowledgePanelInteraction(interaction, {
    sourceCustomId,
    panelSession,
    formGeneration,
} = {}) {
    const existing = getAcknowledgement(interaction);
    if (existing) return existing;

    if (typeof interaction.deferUpdate === 'function' && isFromMessage(interaction)) {
        if (panelSession && !panelSession.isFormGenerationCurrent(formGeneration)) {
            return deferSourceUpdate(interaction);
        }
        const originalComponents = snapshotMessageComponents(interaction.message);
        if (sourceCustomId && originalComponents.length > 0 && typeof interaction.update === 'function') {
            await interaction.update({
                components: buildLoadingComponents(originalComponents, sourceCustomId),
            });
            return markAcknowledgement(interaction, ACKNOWLEDGEMENT_MODES.sourceUpdate, {
                formGeneration,
                originalComponents,
                panelSession,
            });
        }
        return deferSourceUpdate(interaction);
    }
    return deferEphemeralReply(interaction);
}

function completePanelInteraction(interaction, acknowledgement) {
    const resolved = getAcknowledgement(interaction, acknowledgement);
    if (!resolved || resolved.completed) return resolved;
    resolved.completed = true;
    resolved.panelSession?.invalidateForms();
    return resolved;
}

async function restorePanelInteraction(interaction, acknowledgement, {
    onError,
    reporter,
} = {}) {
    const resolved = getAcknowledgement(interaction, acknowledgement);
    if (
        resolved?.completed
        || resolved?.mode !== ACKNOWLEDGEMENT_MODES.sourceUpdate
        || !resolved?.originalComponents
        || (resolved.panelSession && !resolved.panelSession.isFormGenerationCurrent(resolved.formGeneration))
    ) return false;

    try {
        await interaction.editReply({ components: resolved.originalComponents });
        resolved.completed = true;
        return true;
    }
    catch (error) {
        if (onError) onError(error);
        else if (reporter?.warn) reporter.warn('Failed to restore panel controls', error);
        else console.warn('Failed to restore panel controls:', error);
        return false;
    }
}

async function respondAfterAcknowledgement(interaction, acknowledgement, payload, {
    followUp = false,
    reporter,
} = {}) {
    const resolved = getAcknowledgement(interaction, acknowledgement);
    await restorePanelInteraction(interaction, resolved, { reporter });
    const response = withEphemeralFlag(payload);
    if (followUp || resolved?.mode === ACKNOWLEDGEMENT_MODES.sourceUpdate || interaction.replied) {
        return interaction.followUp(response);
    }
    if (interaction.deferred) return interaction.editReply(sanitizeMessageEditOptions(response));
    return interaction.reply(response);
}

async function sendInitialInteractionResponse(interaction, payload) {
    if (interaction.deferred) return interaction.editReply(sanitizeMessageEditOptions(payload));
    if (interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

async function deliverPanelUpdateOrFallback(interaction, editPanel, fallbackPayload) {
    try {
        return await Promise.resolve().then(editPanel);
    }
    catch (panelError) {
        try {
            return await respondAfterAcknowledgement(interaction, undefined, fallbackPayload);
        }
        catch (fallbackError) {
            throw new AggregateError(
                [panelError, fallbackError],
                'State changed, but neither the panel nor fallback response could be delivered.',
            );
        }
    }
}

module.exports = {
    ACKNOWLEDGEMENT_MODES,
    acknowledgePanelInteraction,
    completePanelInteraction,
    deferEphemeralReply,
    deferSourceUpdate,
    deliverPanelUpdateOrFallback,
    respondAfterAcknowledgement,
    restorePanelInteraction,
    sanitizeMessageEditOptions,
    sendInitialInteractionResponse,
};
