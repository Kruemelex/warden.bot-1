'use strict';

const Discord = require('discord.js');
const { createAdminPanelDocument } = require('../ux/documents');
const { renderComponentsV2 } = require('../ux/renderers/componentsV2');
const { createPanelSessionRegistry } = require('../ux/interactions/sessions');
const { createInteractionRouter } = require('../ux/interactions/router');
const {
    acknowledgePanelInteraction,
    deferEphemeralReply,
    respondAfterAcknowledgement,
    sanitizeMessageEditOptions,
} = require('../ux/interactions/acknowledgement');
const {
    buildModal,
    buildModalChannelSelectField,
    getModalSelectedChannel,
} = require('../ux/components/modalFields');
const {
    assertConfiguredGuild,
    getCached,
    refreshGuild,
    registerDestinationResolver,
    updateGuild,
} = require('./service');

const CHANNEL_EDITORS = Object.freeze({
    general: {
        label: 'General Logs',
        description: 'General Warden and info botlogs.',
    },
    error: {
        label: 'Error Logs',
        description: 'Warden error botlogs.',
    },
    staff: {
        label: 'Staff Logs',
        description: 'Warden staff-only logs.',
    },
    approvals: {
        label: 'Leaderboard Approvals',
        description: 'Pending leaderboard approval posts.',
    },
    users: {
        label: 'User Logs',
        description: 'Member leave/kick and New-Account join logs.',
    },
    messages: {
        label: 'Message Logs',
        description: 'Message edited/deleted logs.',
    },
});
const sessions = createPanelSessionRegistry({
    prefix: 'wLS',
    label: 'Warden Logging Settings',
    maxEntries: 100,
});

function errorEmbed(message) {
    return new Discord.EmbedBuilder()
        .setColor('#f55142')
        .setTitle('Warden Logging Settings')
        .setDescription(String(message || 'The logging settings action failed.'));
}

function editButton(session, key) {
    return new Discord.ButtonBuilder()
        .setCustomId(session.buildState('editChannel', [key], { key }))
        .setLabel('Edit')
        .setStyle(Discord.ButtonStyle.Secondary);
}

function formatUpdated(settings, markSuccess = false) {
    if (!settings.updatedAt) return undefined;
    const timestamp = new Date(settings.updatedAt).getTime();
    const localTime = Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:f>` : 'Unknown time';
    return `${markSuccess ? '✅ ' : ''}${localTime}${settings.updatedBy ? ` by <@${settings.updatedBy}>` : ''}`;
}

function assertUsableDestination(interaction, channel, key) {
    if (!channel) return;
    if (
        channel.type !== Discord.ChannelType.GuildText
        && channel.type !== Discord.ChannelType.GuildAnnouncement
    ) throw new Error('Choose a server text or announcement channel.');
    const permissions = channel.permissionsFor?.(interaction.guild?.members?.me);
    const required = [
        Discord.PermissionFlagsBits.ViewChannel,
        Discord.PermissionFlagsBits.EmbedLinks,
        Discord.PermissionFlagsBits.SendMessages,
    ];
    const needsHistory = key === 'approvals';
    if (needsHistory) required.push(Discord.PermissionFlagsBits.ReadMessageHistory);
    if (!permissions || required.some((permission) => !permissions.has(permission))) {
        const names = needsHistory
            ? 'View Channel, Read Message History, Send Messages, and Embed Links'
            : 'View Channel, Send Messages, and Embed Links';
        throw new Error(`Warden needs ${names} in that destination.`);
    }
}

function renderPanel(settings, ownerUserId, { markSuccess = false } = {}) {
    const session = sessions.create({
        guildId: settings.guildId,
        ownerUserId,
    });
    const blocks = Object.entries(CHANNEL_EDITORS).map(([key, editor]) => ({
        kind: 'section',
        content: [
            `### ${editor.label}\n${settings.channels[key] ? `<#${settings.channels[key]}>` : 'Disabled'}`
                + `\n-# ${editor.description}`,
        ],
        accessory: editButton(session, key),
    }));

    const updated = formatUpdated(settings, markSuccess);
    const document = createAdminPanelDocument({
        title: 'Warden Logging Settings',
        description: 'Configure Warden-owned logging channels per category.',
        fields: updated ? [{ name: 'Updated', value: updated }] : [],
        editorBlocks: blocks,
        ephemeral: true,
    });
    const rendered = renderComponentsV2(document);
    return sanitizeMessageEditOptions(rendered.payload);
}

async function loadSettings(guildId) {
    return getCached(guildId) ?? refreshGuild(guildId);
}

async function showChannelModal(interaction, parts, state) {
    const key = state.key ?? parts[0];
    const editor = CHANNEL_EDITORS[key];
    if (!editor) throw new Error('Unknown logging channel setting.');
    const settings = await loadSettings(interaction.guildId);
    const customId = state.panelSession.buildForm(
        'saveChannel',
        [key],
        { revision: settings.settingsRevision },
        interaction.customId,
    );
    const fields = [buildModalChannelSelectField({
        label: editor.label,
        description: 'Choose one channel or clear to disable this destination.',
        customId: 'channel',
        placeholder: 'Choose a Warden destination...',
        selectedChannelId: interaction.guild?.channels.cache.has(settings.channels[key])
            ? settings.channels[key]
            : undefined,
        channelTypes: [
            Discord.ChannelType.GuildText,
            Discord.ChannelType.GuildAnnouncement,
        ],
        required: false,
    })];
    return interaction.showModal(buildModal(customId, `Edit ${editor.label}`, fields));
}

async function replacePanel(interaction, settings, state) {
    state.panelSession.dispose();
    return interaction.editReply(renderPanel(settings, interaction.user.id, { markSuccess: true }));
}


async function saveChannel(interaction, parts, state) {
    const key = parts[0];
    if (!CHANNEL_EDITORS[key]) throw new Error('Unknown logging channel setting.');
    const channel = getModalSelectedChannel(interaction, 'channel');
    assertUsableDestination(interaction, channel, key);
    const currentSettings = await loadSettings(interaction.guildId);
    const submittedChannelId = channel?.id ?? null;
    const channelChanged = submittedChannelId !== currentSettings.channels[key];
    if (!channelChanged) return replacePanel(interaction, currentSettings, state);
    const settings = await updateGuild(
        interaction.guildId,
        { channels: { [key]: submittedChannelId } },
        state.baseline.revision,
        interaction.user.id,
    );
    return replacePanel(interaction, settings, state);
}

async function respondError(interaction, message, acknowledgement) {
    return respondAfterAcknowledgement(interaction, acknowledgement, {
        embeds: [errorEmbed(message)],
    }, { followUp: true });
}

const router = createInteractionRouter({
    parse: sessions.parse,
    componentActions: {
        editChannel: showChannelModal,
    },
    modalActions: {
        saveChannel,
    },
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
    acknowledgeModal: async ({ interaction, parsed }) => acknowledgePanelInteraction(interaction, {
        sourceCustomId: parsed.state.sourceCustomId,
        panelSession: parsed.state.panelSession,
        formGeneration: parsed.state.formGeneration,
    }),
    onExpired: ({ interaction }) => interaction.reply({
        embeds: [errorEmbed('This panel expired. Run `/logging-settings` again.')],
        flags: Discord.MessageFlags.Ephemeral,
    }),
    onComponentError: ({ interaction, error }) => interaction.reply({
        embeds: [errorEmbed(error.message)],
        flags: Discord.MessageFlags.Ephemeral,
    }),
    onModalError: ({ interaction, error }) => respondError(interaction, error.message),
});

async function execute(interaction) {
    await deferEphemeralReply(interaction);
    if (!interaction.guildId) {
        return interaction.editReply({ embeds: [errorEmbed('Logging settings require a server context.')] });
    }
    try {
        assertConfiguredGuild(interaction.guildId);
    }
    catch (error) {
        return interaction.editReply({ embeds: [errorEmbed(error.message)] });
    }
    const settings = await loadSettings(interaction.guildId);
    registerDestinationResolver();
    return interaction.editReply(renderPanel(settings, interaction.user.id));
}

module.exports = {
    execute,
    handleComponent: router.handleComponent,
    handleModal: router.handleModal,
    renderPanel,
};
