'use strict';

const Discord = require('discord.js');
const { getIdentityBrandColor } = require('../../functions');
const { createUXPanelDocument } = require('../../ux/documents');
const { renderComponentsV2 } = require('../../ux/renderers/componentsV2');
const { createPanelSessionRegistry } = require('../../ux/interactions/sessions');
const { createInteractionRouter } = require('../../ux/interactions/router');
const {
    acknowledgePanelInteraction,
    deferEphemeralReply,
    respondAfterAcknowledgement,
    sanitizeMessageEditOptions,
} = require('../../ux/interactions/acknowledgement');
const {
    buildModal,
    buildModalChannelSelectField,
    buildModalStringSelectField,
    getModalSelectedChannel,
    getRequiredModalSingleSelect,
} = require('../../ux/components/modalFields');
const settings = require('./settings');
const {
    assertUsableSubmissionChannel,
    SUBMISSION_CHANNEL_TYPES,
} = require('./submissionChannels');
const { requestWebsiteSync } = require('./websitePublisher');
const { reconcilePendingLeaderboardApprovals } = require('../../commands/Warden/leaderboards/staffApproval/reconciliation');

const MODE_OPTIONS = Object.freeze([
    { label: 'Open', value: 'open', description: 'Permit normal operation; submission-type settings still apply.' },
    { label: 'Maintenance', value: 'maintenance', description: 'Pause submissions and Staff changes.' },
]);
const WEBSITE_OPTIONS = Object.freeze([
    { label: 'Enabled', value: 'enabled', description: 'Publish approved board changes to the website.' },
    { label: 'Disabled', value: 'disabled', description: 'Keep website publishing paused.' },
]);
const SUBMISSION_OPTIONS = Object.freeze([
    { label: 'Open', value: 'open', description: 'Accept new submissions from all users.' },
    { label: 'Halted', value: 'halted', description: 'Reject all new submissions of this type.' },
]);
const sessions = createPanelSessionRegistry({
    prefix: 'lB',
    label: 'Leaderboard Settings',
    maxEntries: 100,
});

function errorEmbed(message) {
    return new Discord.EmbedBuilder()
        .setColor('#f55142')
        .setTitle('Leaderboard Settings')
        .setDescription(String(message || 'The Leaderboard settings action failed.'));
}

function editButton(session, action) {
    return new Discord.ButtonBuilder()
        .setCustomId(session.build(action))
        .setLabel('Edit')
        .setStyle(Discord.ButtonStyle.Secondary);
}

function formatUpdated(current, markSuccess = false) {
    if (!current.updatedAtMs) return undefined;
    const timestamp = `<t:${Math.floor(current.updatedAtMs / 1000)}:f>`;
    return `${markSuccess ? '✅ ' : ''}${timestamp}${current.updatedBy ? ` by <@${current.updatedBy}>` : ''}`;
}

function renderPanel(current, ownerUserId, { markSuccess = false } = {}) {
    const session = sessions.create({
        guildId: current.guildId,
        ownerUserId,
        state: { settings: current },
    });
    const updated = formatUpdated(current, markSuccess);
    const document = createUXPanelDocument({
        title: 'Leaderboard Settings',
        description: 'Configure Leaderboard availability and website publishing.',
        accentColor: getIdentityBrandColor(),
        ephemeral: true,
        fields: updated ? [{ name: 'Updated', value: updated }] : [],
        editorBlocks: [
            {
                kind: 'section',
                content: [
                    `### Mode\n${current.mode === 'maintenance' ? 'Maintenance' : 'Open'}\n-# Maintenance pauses new submissions and Staff changes while keeping boards readable.`,
                ],
                accessory: editButton(session, 'editMode'),
            },
            {
                kind: 'section',
                content: [
                    `### Website Publishing\n${current.websitePublishingEnabled ? 'Enabled' : 'Disabled'}\n-# Push approved public Leaderboard snapshots to the website plugin.`,
                ],
                accessory: editButton(session, 'editWebsite'),
            },
            {
                kind: 'actions',
                rows: [
                    new Discord.ActionRowBuilder().addComponents(
                        new Discord.ButtonBuilder()
                            .setCustomId(session.build('syncWebsite'))
                            .setLabel('Sync Website')
                            .setStyle(Discord.ButtonStyle.Primary),
                        new Discord.ButtonBuilder()
                            .setCustomId(session.build('reconcilePosts'))
                            .setLabel('Refresh Approval Posts')
                            .setStyle(Discord.ButtonStyle.Secondary),
                    ),
                ],
            },
            { kind: 'separator', divider: true, spacing: 'Large' },
            {
                kind: 'text',
                content: '## Submissions\nConfigure availability and the public destination for each Leaderboard submission type.',
            },
            {
                kind: 'section',
                content: [
                    `### Speedrun\nSubmissions: **${current.speedrunSubmissionMode === 'halted' ? 'Halted' : 'Open'}**\nChannel: ${current.speedrunSubmissionChannelId ? `<#${current.speedrunSubmissionChannelId}>` : '**Not configured**'}\n-# Completed \`/speedrun\` submissions are published in this channel.`,
                ],
                accessory: editButton(session, 'editSpeedrunSubmissions'),
            },
            {
                kind: 'section',
                content: [
                    `### Ace\nSubmissions: **${current.aceSubmissionMode === 'halted' ? 'Halted' : 'Open'}**\nChannel: ${current.aceSubmissionChannelId ? `<#${current.aceSubmissionChannelId}>` : '**Not configured**'}\n-# Completed \`/ace\` submissions are published in this channel; calculations remain available.`,
                ],
                accessory: editButton(session, 'editAceSubmissions'),
            },
        ],
    });
    return sanitizeMessageEditOptions(renderComponentsV2(document).payload);
}

function showModeModal(interaction, _parts, state) {
    const current = state.settings;
    const customId = state.panelSession.buildForm('saveMode', [], { revision: current.settingsRevision }, interaction.customId);
    return interaction.showModal(buildModal(customId, 'Leaderboard Mode', buildModalStringSelectField({
        label: 'Mode',
        description: 'Maintenance pauses new submissions and Staff changes.',
        customId: 'mode',
        placeholder: 'Choose Leaderboard mode...',
        options: MODE_OPTIONS,
        selectedValues: [current.mode],
    })));
}

function showWebsiteModal(interaction, _parts, state) {
    const current = state.settings;
    const customId = state.panelSession.buildForm('saveWebsite', [], { revision: current.settingsRevision }, interaction.customId);
    return interaction.showModal(buildModal(customId, 'Website Publishing', buildModalStringSelectField({
        label: 'Website Publishing',
        description: 'Controls automatic approved-board and daily website pushes.',
        customId: 'website',
        placeholder: 'Choose website publishing...',
        options: WEBSITE_OPTIONS,
        selectedValues: [current.websitePublishingEnabled ? 'enabled' : 'disabled'],
    })));
}

function showSubmissionModal(interaction, state, type) {
    const current = state.settings;
    const isSpeedrun = type === 'speedrun';
    const label = isSpeedrun ? 'Speedrun' : 'Ace';
    const modeKey = `${type}SubmissionMode`;
    const channelKey = `${type}SubmissionChannelId`;
    const customId = state.panelSession.buildForm(
        isSpeedrun ? 'saveSpeedrunSubmissions' : 'saveAceSubmissions',
        [],
        { revision: current.settingsRevision },
        interaction.customId,
    );
    return interaction.showModal(buildModal(
        customId,
        `${label} Submissions`,
        buildModalStringSelectField({
            label: `${label} Submissions`,
            description: isSpeedrun
                ? 'Controls all new /speedrun submissions.'
                : 'Controls new /ace submissions; score calculation remains available.',
            customId: modeKey,
            placeholder: `Choose ${label} availability...`,
            options: SUBMISSION_OPTIONS,
            selectedValues: [current[modeKey]],
        }),
        buildModalChannelSelectField({
            label: 'Submission Channel',
            description: `Posts completed ${label} submission embeds in this channel.`,
            customId: channelKey,
            placeholder: `Choose the ${label} submission channel...`,
            selectedChannelId: current[channelKey],
            channelTypes: SUBMISSION_CHANNEL_TYPES,
        }),
    ));
}

function showSpeedrunSubmissionsModal(interaction, _parts, state) {
    return showSubmissionModal(interaction, state, 'speedrun');
}

function showAceSubmissionsModal(interaction, _parts, state) {
    return showSubmissionModal(interaction, state, 'ace');
}

async function replacePanel(interaction, current, state) {
    state.panelSession.dispose();
    return interaction.editReply(renderPanel(current, interaction.user.id, { markSuccess: true }));
}

async function saveMode(interaction, _parts, state) {
    const mode = getRequiredModalSingleSelect(interaction, 'mode', MODE_OPTIONS, 'mode');
    const current = await settings.update(interaction.guildId, { mode }, state.baseline.revision, interaction.user.id);
    return replacePanel(interaction, current, state);
}

async function saveWebsite(interaction, _parts, state) {
    const selection = getRequiredModalSingleSelect(interaction, 'website', WEBSITE_OPTIONS, 'website publishing setting');
    const current = await settings.update(
        interaction.guildId,
        { websitePublishingEnabled: selection === 'enabled' },
        state.baseline.revision,
        interaction.user.id,
    );
    return replacePanel(interaction, current, state);
}

async function saveSubmissionSettings(interaction, state, type) {
    const label = type === 'speedrun' ? 'Speedrun' : 'Ace';
    const modeKey = `${type}SubmissionMode`;
    const channelKey = `${type}SubmissionChannelId`;
    const submissionMode = getRequiredModalSingleSelect(
        interaction, modeKey, SUBMISSION_OPTIONS, `${label} submission setting`,
    );
    const channel = getModalSelectedChannel(interaction, channelKey);
    assertUsableSubmissionChannel(channel, {
        guildId: interaction.guildId,
        botMember: interaction.guild?.members?.me,
        label,
    });
    const current = await settings.update(
        interaction.guildId,
        { [modeKey]: submissionMode, [channelKey]: channel.id },
        state.baseline.revision,
        interaction.user.id,
    );
    return replacePanel(interaction, current, state);
}

function saveSpeedrunSubmissions(interaction, _parts, state) {
    return saveSubmissionSettings(interaction, state, 'speedrun');
}

function saveAceSubmissions(interaction, _parts, state) {
    return saveSubmissionSettings(interaction, state, 'ace');
}

async function syncWebsite(interaction) {
    await interaction.deferUpdate();
    const result = await requestWebsiteSync(interaction.guildId, { full: true }, { reason: 'manual' });
    if (result.skipped === 'disabled') {
        return interaction.followUp({
            content: 'Website publishing is disabled. Enable it first to sync.',
            flags: Discord.MessageFlags.Ephemeral,
        });
    }
    return interaction.followUp({
        content: `✅ Website Leaderboards synced (revision ${result.snapshot.revision}).`,
        flags: Discord.MessageFlags.Ephemeral,
    });
}

async function reconcilePosts(interaction) {
    await interaction.deferUpdate();
    const result = await reconcilePendingLeaderboardApprovals(interaction.guild, { reason: 'manual' });
    return interaction.followUp({
        content: `✅ Approval-post refresh completed${result.reconciled ? ` (${result.reconciled} pending post${result.reconciled === 1 ? '' : 's'})` : ''}.`,
        flags: Discord.MessageFlags.Ephemeral,
    });
}

async function respondError(interaction, message, acknowledgement) {
    return respondAfterAcknowledgement(interaction, acknowledgement, {
        embeds: [errorEmbed(message)],
    }, { followUp: true });
}

const router = createInteractionRouter({
    parse: sessions.parse,
    componentActions: {
        editMode: showModeModal,
        editSpeedrunSubmissions: showSpeedrunSubmissionsModal,
        editAceSubmissions: showAceSubmissionsModal,
        editWebsite: showWebsiteModal,
        syncWebsite,
        reconcilePosts,
    },
    modalActions: { saveMode, saveSpeedrunSubmissions, saveAceSubmissions, saveWebsite },
    authorize: async ({ interaction, parsed }) => {
        if (String(interaction.user?.id) !== String(parsed.ownerUserId)) {
            await interaction.reply({ embeds: [errorEmbed('This panel belongs to another administrator.')], flags: Discord.MessageFlags.Ephemeral });
            return false;
        }
        if (String(interaction.guildId) !== String(parsed.guildId)) {
            await interaction.reply({ embeds: [errorEmbed('This panel belongs to another server.')], flags: Discord.MessageFlags.Ephemeral });
            return false;
        }
        return true;
    },
    acknowledgeModal: ({ interaction, parsed }) => acknowledgePanelInteraction(interaction, {
        sourceCustomId: parsed.state.sourceCustomId,
        panelSession: parsed.state.panelSession,
        formGeneration: parsed.state.formGeneration,
    }),
    onExpired: ({ interaction }) => interaction.reply({
        embeds: [errorEmbed('This panel expired. Run `/leaderboard-settings` again.')],
        flags: Discord.MessageFlags.Ephemeral,
    }),
    onComponentError: ({ interaction, error }) => respondError(interaction, error.message),
    onModalError: ({ interaction, error }) => respondError(interaction, error.message),
});

async function execute(interaction) {
    await deferEphemeralReply(interaction);
    try {
        const current = await settings.get(interaction.guildId);
        return interaction.editReply(renderPanel(current, interaction.user.id));
    }
    catch (error) {
        return interaction.editReply({ embeds: [errorEmbed(error.message)] });
    }
}

function handleInteraction(interaction) {
    if (interaction.isButton?.()) return router.handleComponent(interaction);
    if (interaction.isModalSubmit?.()) return router.handleModal(interaction);
    return false;
}

module.exports = { execute, handleInteraction, renderPanel };
