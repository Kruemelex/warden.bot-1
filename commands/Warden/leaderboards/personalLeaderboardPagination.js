'use strict';

const Discord = require('discord.js');
const { createPanelSessionRegistry } = require('../../../ux/interactions/sessions');
const { createInteractionRouter } = require('../../../ux/interactions/router');
const { listSpeedrunBoard } = require('../../../Warden/db/leaderboards/repository');
const { createConsoleReporter } = require('../../../logging/consoleReporting');
const { buildSpeedrunEmbed } = require('./leaderboardPresentation');

const PAGE_SIZE = 10;
const report = createConsoleReporter('Leaderboard').forSubsystem('Commands');
const sessions = createPanelSessionRegistry({
    prefix: 'lH',
    label: 'Personal Leaderboard history',
    ttlMs: 15 * 60 * 1000,
    maxEntries: 100,
});

function personalEntries(rows, ownerUserId) {
    return rows
        .map((entry, index) => ({ entry, divisionRank: index + 1 }))
        .filter(({ entry }) => String(entry.user_id) === String(ownerUserId));
}

function pagePayload(session, entries, page, variant, shipClass) {
    const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    const pageIndex = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
    const visible = entries.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
    if (visible.length === 0) {
        return {
            content: 'You have no approved speedrun submissions in that variant and ship class.',
            embeds: [],
            components: [],
        };
    }
    const components = pageCount > 1
        ? [new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setCustomId(session.buildState('page', [], { page: pageIndex - 1 }))
                .setLabel('Previous')
                .setStyle(Discord.ButtonStyle.Secondary)
                .setDisabled(pageIndex === 0),
            new Discord.ButtonBuilder()
                .setCustomId(session.buildState('page', [], { page: pageIndex }))
                .setLabel(`Page ${pageIndex + 1}/${pageCount}`)
                .setStyle(Discord.ButtonStyle.Secondary)
                .setDisabled(true),
            new Discord.ButtonBuilder()
                .setCustomId(session.buildState('page', [], { page: pageIndex + 1 }))
                .setLabel('Next')
                .setStyle(Discord.ButtonStyle.Secondary)
                .setDisabled(pageIndex === pageCount - 1),
        )]
        : [];
    return {
        content: 'Your approved Speedrun submissions in this division:',
        embeds: visible.map(({ entry, divisionRank }) => (
            buildSpeedrunEmbed(entry, divisionRank, variant, shipClass)
        )),
        components,
    };
}

function createPersonalSpeedrunHistory({ guildId, ownerUserId, variant, shipClass, rows }) {
    const entries = personalEntries(rows, ownerUserId);
    if (entries.length <= PAGE_SIZE) {
        return pagePayload(undefined, entries, 0, variant, shipClass);
    }
    const session = sessions.create({
        guildId,
        ownerUserId,
        state: { variant: String(variant), shipClass: String(shipClass) },
    });
    return pagePayload(session, entries, 0, variant, shipClass);
}

async function showPage(interaction, _parts, state) {
    await interaction.deferUpdate();
    const rows = await listSpeedrunBoard(state.variant, state.shipClass);
    const entries = personalEntries(rows, state.ownerUserId);
    return interaction.editReply(pagePayload(
        state.panelSession, entries, state.page, state.variant, state.shipClass,
    ));
}

async function privateResponse(interaction, content) {
    const payload = { content, flags: Discord.MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

const router = createInteractionRouter({
    parse: sessions.parse,
    componentActions: { page: showPage },
    authorize: async ({ interaction, parsed }) => {
        if (String(interaction.user?.id) !== String(parsed.ownerUserId)) {
            await privateResponse(interaction, 'This private Leaderboard history belongs to another user.');
            return false;
        }
        if (String(interaction.guildId) !== String(parsed.guildId)) {
            await privateResponse(interaction, 'This private Leaderboard history belongs to another server.');
            return false;
        }
        return true;
    },
    onExpired: ({ interaction }) => privateResponse(
        interaction, 'This private Leaderboard history expired. Run `/leaderboard speedrun` again.',
    ),
    onComponentError: async ({ interaction, error }) => {
        report.error('Personal history page refresh failed', error);
        return privateResponse(interaction, 'Unable to load that Leaderboard page right now. Please try again later.');
    },
    onModalError: async ({ interaction }) => privateResponse(interaction, 'That action is not available.'),
});

function handleInteraction(interaction) {
    if (!interaction.isButton?.()) return false;
    return router.handleComponent(interaction);
}

module.exports = {
    createPersonalSpeedrunHistory,
    handleInteraction,
};
