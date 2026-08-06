const Discord = require('discord.js');
const { createVerificationLogger } = require('../logging');
const { createInteractionRouter } = require('../../ux/interactions/router');
const {
    acknowledgePanelInteraction,
    deferEphemeralReply,
} = require('../../ux/interactions/acknowledgement');
const { reportVerificationError } = require('../errorLogging');
const {
    buildVerificationAdminNotice,
    buildVerificationAdminActionCompleted,
} = require('../presentation/adminNotices');
const { buildVerificationPostPayload } = require('../presentation/post');
const {
    scheduleVerificationPostReconciliation,
} = require('../runtime/postReconciler');
const {
    normalizeVerificationAdminGuildId,
    resolveVerificationAdminGuildId,
    VERIFICATION_MODES,
    getVerificationSnapshot,
    registerVerificationPost,
} = require('../service');
const {
    ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
    getActiveChallengeLockedActionChallengeId,
    isChallengeActive,
} = require('../domain/activeChallengePolicy');
const {
    handleAdminPaginationInteraction,
    parseVerificationAdminCustomId,
} = require('./panel');
const {
    respondAdminError,
    userErrorEmbed,
} = require('./feedback');
const {
    handleSettingsAutokickModalSubmit,
    handleSettingsChallengesModalSubmit,
    handleSettingsChallengeTimersModalSubmit,
    handleSettingsModeModalSubmit,
    handleSettingsRoleModalSubmit,
    handleVerificationSettingsCommand,
    showSettingsAutokickModal,
    showSettingsChallengesModal,
    showSettingsChallengeTimersModal,
    showSettingsModeModal,
    showSettingsRoleModal,
} = require('./settings');
const {
    handleCatalogDeleteModal,
    handleChallengeOverviewButton,
    handleChallengePreviewButton,
    handleChallengeSelectMenu,
    handleChallengesBackButton,
    handleChallengeEditModalSubmit,
    handleCreateChallengeModal,
    handleVerificationChallengesCommand,
    showCatalogDeleteModal,
    showChallengeEditModalFromButton,
    showCreateChallengeModal,
} = require('./challengeEditor');
const {
    handleCreateQuestionModal,
    handleQuestionClearModalSubmit,
    handleQuestionOptionsModalSubmit,
    handleQuestionPreviewButton,
    handleQuestionSelectMenu,
    showCreateQuestionModal,
    showQuestionClearSelectorModal,
    showQuestionOptionsModal,
} = require('./questionEditor');
const {
    handleQuestionAnswerPromptModalSubmit, handleQuestionAnswersModalSubmit,
    handleQuestionImageTextModalSubmit, handleQuestionTextModalSubmit,
    showQuestionAnswerPromptModal, showQuestionAnswersModal,
    showQuestionImageTextModal, showQuestionTextModal,
} = require('./questionFieldEditors');

const adminLog = createVerificationLogger('Admin UX');
const {
    handleQuestionControlImageLimitsModalSubmit, handleQuestionDirectionsModalSubmit,
    handleQuestionGalleryLimitsModalSubmit, handleQuestionRotationSettingsModalSubmit,
    handleQuestionSolutionImageLimitsModalSubmit, showQuestionControlImageLimitsModal,
    showQuestionDirectionsModal, showQuestionGalleryLimitsModal,
    showQuestionRotationSettingsModal, showQuestionSolutionImageLimitsModal,
} = require('./questionTaskEditors');
const {
    handleQuestionImagePickerBack,
    handleQuestionImagePickerClear,
    handleQuestionImagePickerNext,
    handleQuestionImagePickerPrevious,
    handleQuestionImagePickerRefresh,
    handleQuestionImagePickerSave,
    handleQuestionImagePickerSelect,
    showQuestionImagePicker,
} = require('./imagePicker');

const ADMIN_COMPONENT_ACTIONS = Object.freeze({
    adminPage: handleAdminPaginationInteraction,
    settingsEditRole: showSettingsRoleModal,
    settingsEditMode: showSettingsModeModal,
    settingsEditChallenges: showSettingsChallengesModal,
    settingsEditChallengeTimers: showSettingsChallengeTimersModal,
    settingsEditAutokick: showSettingsAutokickModal,
    challengeSelect: handleChallengeSelectMenu,
    challengeCreate: showCreateChallengeModal,
    questionCreate: showCreateQuestionModal,
    challengePreview: handleChallengePreviewButton,
    questionPreview: handleQuestionPreviewButton,
    challengeDelete: (interaction, parts, state) => showCatalogDeleteModal(interaction, parts, 'challenge', state),
    questionDelete: (interaction, parts, state) => showCatalogDeleteModal(interaction, parts, 'question', state),
    challengeOverview: handleChallengeOverviewButton,
    challengesBack: handleChallengesBackButton,
    questionSelect: handleQuestionSelectMenu,
    challengeEdit: showChallengeEditModalFromButton,
    questionEditOptions: showQuestionOptionsModal,
    questionEditText: showQuestionTextModal,
    questionEditImageText: showQuestionImageTextModal,
    questionEditAnswers: showQuestionAnswersModal,
    questionEditAnswerPrompt: showQuestionAnswerPromptModal,
    questionImagesOpen: showQuestionImagePicker,
    questionImagesBack: handleQuestionImagePickerBack,
    questionImagesPrevious: handleQuestionImagePickerPrevious,
    questionImagesNext: handleQuestionImagePickerNext,
    questionImagesSelect: handleQuestionImagePickerSelect,
    questionImagesClear: handleQuestionImagePickerClear,
    questionImagesSave: handleQuestionImagePickerSave,
    questionImagesRefresh: handleQuestionImagePickerRefresh,
    questionEditSolutionImageLimits: showQuestionSolutionImageLimitsModal,
    questionEditControlImageLimits: showQuestionControlImageLimitsModal,
    questionEditDirections: showQuestionDirectionsModal,
    questionEditGalleryLimits: showQuestionGalleryLimitsModal,
    questionEditRotationSettings: showQuestionRotationSettingsModal,
    questionClearSelector: showQuestionClearSelectorModal,
});

const ADMIN_MODAL_ACTIONS = Object.freeze({
    settingsRoleModal: handleSettingsRoleModalSubmit,
    settingsModeModal: handleSettingsModeModalSubmit,
    settingsChallengesModal: handleSettingsChallengesModalSubmit,
    settingsChallengeTimersModal: handleSettingsChallengeTimersModalSubmit,
    settingsAutokickModal: handleSettingsAutokickModalSubmit,
    challengeEditModal: handleChallengeEditModalSubmit,
    challengeCreateModal: handleCreateChallengeModal,
    questionCreateModal: handleCreateQuestionModal,
    challengeDeleteModal: (interaction, parts, state) => handleCatalogDeleteModal(interaction, parts, 'challenge', state),
    questionDeleteModal: (interaction, parts, state) => handleCatalogDeleteModal(interaction, parts, 'question', state),
    questionOptionsModal: handleQuestionOptionsModalSubmit,
    questionTextModal: handleQuestionTextModalSubmit,
    questionImageTextModal: handleQuestionImageTextModalSubmit,
    questionAnswersModal: handleQuestionAnswersModalSubmit,
    questionAnswerPromptModal: handleQuestionAnswerPromptModalSubmit,
    questionSolutionImageLimitsModal: handleQuestionSolutionImageLimitsModalSubmit,
    questionControlImageLimitsModal: handleQuestionControlImageLimitsModalSubmit,
    questionDirectionsModal: handleQuestionDirectionsModalSubmit,
    questionGalleryLimitsModal: handleQuestionGalleryLimitsModalSubmit,
    questionRotationSettingsModal: handleQuestionRotationSettingsModalSubmit,
    questionClearModal: handleQuestionClearModalSubmit,
});

function isExpectedAdminMutationError(error) {
    return [
        'VERIFICATION_ACTIVE_CHALLENGE_EDIT_LOCKED',
        'VERIFICATION_CATALOG_CONFLICT',
        'VERIFICATION_SETTINGS_CONFLICT',
        'VERIFICATION_RUNTIME_CONTEXT_INVALID',
    ].includes(error?.code);
}

const verificationAdminInteractionRouter = createInteractionRouter({
    parse: parseVerificationAdminCustomId,
    componentActions: ADMIN_COMPONENT_ACTIONS,
    modalActions: ADMIN_MODAL_ACTIONS,
    authorize: async ({ interaction, parsed }) => {
        const { guildId, ownerUserId } = parsed;
        if (String(interaction.user?.id) !== String(ownerUserId)) {
            await respondAdminError(interaction, { content: 'This admin panel belongs to another user.' });
            return false;
        }
        if (String(interaction.guild?.id ?? interaction.guildId ?? '') !== String(guildId)) {
            await respondAdminError(interaction, {
                embeds: [userErrorEmbed('This admin panel belongs to another server.')],
            });
            return false;
        }
        const lockedChallengeId = getActiveChallengeLockedActionChallengeId(parsed.action, parsed.parts);
        if (lockedChallengeId) {
            const snapshot = await getVerificationSnapshot(guildId);
            if (isChallengeActive(snapshot.activeChallengeIds, lockedChallengeId)) {
                await respondAdminError(interaction, {
                    embeds: [userErrorEmbed(ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE)],
                });
                return false;
            }
        }
        return true;
    },
    acknowledgeModal: ({ interaction, parsed }) => acknowledgePanelInteraction(interaction, {
        sourceCustomId: parsed.state?.sourceCustomId,
        panelSession: parsed.state?.panelSession,
        formGeneration: parsed.state?.formGeneration,
    }),
    onExpired: ({ interaction }) => respondAdminError(interaction, {
        content: 'This verification admin panel has expired. Please run `/verification-settings` or `/verification-challenges` again.',
    }),
    onComponentError: async ({ interaction, error }) => {
        if (isExpectedAdminMutationError(error)) {
            await respondAdminError(interaction, { embeds: [userErrorEmbed(error.message)] });
            return;
        }
        void reportVerificationError({
            interaction,
            title: '⛔ Verification Admin component failed',
            userId: interaction.user?.id,
        }, error);
        await respondAdminError(interaction, {
            embeds: [userErrorEmbed(error.message || 'Failed to handle verification admin button.')],
        }).catch((responseError) => {
            adminLog.error('Failed to send verification admin component error response:', responseError);
        });
    },
    onModalError: async ({ interaction, error }) => {
        if (isExpectedAdminMutationError(error)) {
            await respondAdminError(interaction, { embeds: [userErrorEmbed(error.message)] });
            return;
        }
        void reportVerificationError({
            interaction,
            title: '⛔ Verification Admin modal failed',
            userId: interaction.user?.id,
        }, error);
        await respondAdminError(interaction, {
            flags: Discord.MessageFlags.Ephemeral,
            embeds: [userErrorEmbed('Failed to update verification admin settings. Please try again later.')],
        }).catch((responseError) => {
            adminLog.error('Failed to send verification admin modal error response:', responseError);
        });
    },
});

async function handleVerificationPostCommand(interaction, guildId) {
    const verificationSettings = (await getVerificationSnapshot(guildId)).guildSettings;
    if (verificationSettings.mode === VERIFICATION_MODES.halt) {
        return interaction.editReply(buildVerificationAdminNotice('Verification Admin', 'Verification is halted in the Warden settings.', 'error'));
    }

    const targetChannel = interaction.options.getChannel('channel', true);

    if (!targetChannel?.isTextBased?.()) {
        return interaction.editReply(buildVerificationAdminNotice('Verification Admin', 'Please provide a valid text channel or thread.', 'error'));
    }

    let message;
    try {
        message = await targetChannel.send(buildVerificationPostPayload(verificationSettings));
        await registerVerificationPost(guildId, {
            channelId: targetChannel.id,
            messageId: message.id,
        });
    }
    catch (error) {
        if (!message) throw error;
        try {
            await message.delete();
        }
        catch (deleteError) {
            throw new AggregateError(
                [error, deleteError],
                'The verification post was sent but could not be registered or removed cleanly.',
                { cause: error },
            );
        }
        throw error;
    }

    try {
        const latestSettings = (await getVerificationSnapshot(guildId)).guildSettings;
        void scheduleVerificationPostReconciliation(
            guildId,
            latestSettings,
            'verification post registered',
        );
    }
    catch (error) {
        void reportVerificationError({
            interaction,
            title: '⛔ Verification post synchronization failed',
            userId: interaction.user?.id,
        }, error);
    }

    return interaction.editReply(buildVerificationAdminActionCompleted(
        'Post Posted',
        `Verification post posted successfully in ${String(targetChannel)}. ${message.url}`,
    ));
}

// Keep these as top-level commands so Discord Integrations can override each surface independently.
function buildVerificationCommandData(name, description) {
    return new Discord.SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator);
}

function buildVerificationPostCommandData() {
    return buildVerificationCommandData('verification-post', 'Post a new public verification message')
        .addChannelOption(option => option
            .setName('channel')
            .setDescription('Text channel or thread for the verification post')
            .addChannelTypes(
                Discord.ChannelType.GuildText,
                Discord.ChannelType.GuildAnnouncement,
                Discord.ChannelType.PublicThread,
                Discord.ChannelType.PrivateThread,
                Discord.ChannelType.AnnouncementThread,
            )
            .setRequired(true));
}

async function executeVerificationAdminCommand(interaction, command) {
    try {
        let guildId;
        await deferEphemeralReply(interaction);

        try {
            guildId = normalizeVerificationAdminGuildId(resolveVerificationAdminGuildId(interaction));
        }
        catch (_err) {
            return interaction.editReply(buildVerificationAdminNotice('Verification Admin', 'Verification settings require a real guild context.', 'error'));
        }

        if (command === 'post') return handleVerificationPostCommand(interaction, guildId);
        if (command === 'settings') return handleVerificationSettingsCommand(interaction, guildId);
        if (command === 'challenges') return handleVerificationChallengesCommand(interaction, guildId);
        return interaction.editReply(buildVerificationAdminNotice('Verification Admin', 'Unknown verification command.', 'error'));
    }
    catch (err) {
        void reportVerificationError({
            interaction,
            title: '⛔ Verification command failed',
            userId: interaction.user?.id,
        }, err);

        const errorResponse = buildVerificationAdminNotice('Verification Admin', 'Failed to run the verification command. Please try again later.', 'error');
        try {
            if (interaction.deferred) await interaction.editReply(errorResponse);
            else if (interaction.replied) await interaction.followUp({ ...errorResponse, flags: errorResponse.flags | Discord.MessageFlags.Ephemeral });
            else await interaction.reply({ ...errorResponse, flags: errorResponse.flags | Discord.MessageFlags.Ephemeral });
        }
        catch (responseErr) {
            adminLog.error('Failed to send verification command error response:', responseErr);
        }

        return undefined;
    }
}

module.exports = {
    buildVerificationCommandData,
    buildVerificationPostCommandData,
    executeVerificationAdminCommand,
    handleComponentInteraction: verificationAdminInteractionRouter.handleComponent,
    handleModalSubmit: verificationAdminInteractionRouter.handleModal,
};
