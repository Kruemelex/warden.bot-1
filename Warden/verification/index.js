const { handleVerificationInteraction: handleRuntimeInteraction } = require('./runtime/liveFlow');
const { handleVerificationPreviewInteraction } = require('./runtime/previewFlow');
const { createVerificationLogger } = require('./logging');
const { reportVerificationError } = require('./errorLogging');
const { buildVerificationErrorResponse } = require('./presentation/documents/notices');
const { sendEphemeralNotice } = require('./runtime/interactionResponses');
const verificationAdmin = require('./admin/controller');

const ADMIN_CUSTOM_ID_PREFIX = 'wVA:';
const interactionLog = createVerificationLogger('Interaction');

function isAdminInteraction(interaction) {
    return String(interaction?.customId ?? '').startsWith(ADMIN_CUSTOM_ID_PREFIX);
}

async function dispatchAdminInteraction(interaction) {
    if (!isAdminInteraction(interaction)) return false;

    if (interaction.isModalSubmit?.()) {
        return Boolean(await verificationAdmin.handleModalSubmit(interaction));
    }

    if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
        return Boolean(await verificationAdmin.handleComponentInteraction(interaction));
    }

    return false;
}

async function handleInteraction(interaction) {
    try {
        if (await handleVerificationPreviewInteraction(interaction)) return true;
        if (await handleRuntimeInteraction(interaction)) return true;
        if (!isAdminInteraction(interaction)) return false;
        return await dispatchAdminInteraction(interaction);
    }
    catch (error) {
        void reportVerificationError({
            interaction,
            title: '⛔ Verification feature interaction failed',
            userId: interaction.user?.id,
        }, error);
        await sendEphemeralNotice(interaction, buildVerificationErrorResponse(
            'There was an error while handling this verification interaction. Please try again later. If the problem persists, contact staff.',
        ), {
            followUp: interaction.deferred || interaction.replied,
        }).catch((responseError) => {
            interactionLog.error('Failed to send error response:', responseError);
        });
        return true;
    }
}

module.exports = {
    handleInteraction,
};
