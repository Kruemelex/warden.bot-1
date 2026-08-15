'use strict';

const Discord = require('discord.js');
const config = require('../../../config.json');
const { botIdent, getIdentityBrandColor } = require('../../../functions');
const { createConsoleReporter } = require('../../../logging/consoleReporting');
const { createRankStatsChartUrl } = require('./rankStatsChart');

const chartReport = createConsoleReporter('Rank statistics').forSubsystem('Chart');

const RANK_CATEGORY_MODAL_CUSTOM_ID = 'warden:ranks:category';
const RANK_CATEGORY_FIELD_CUSTOM_ID = 'rankCategory';
const RANK_CHART_FIELD_CUSTOM_ID = 'showRankChart';
const RANK_CATEGORY_OPTIONS = Object.freeze([
    { label: 'Challenge', value: 'challenge_ranks', description: 'Ranks earned through AXI challenges.' },
    { label: 'Competitive', value: 'competitive_ranks', description: 'Ranks for competitive achievements.' },
    { label: 'Progression', value: 'progression_ranks', description: 'Ranks that mark your AX journey.' },
    { label: 'Other', value: 'other_ranks', description: 'All other AXI ranks.' },
]);

function getRankCategory(rankType) {
    const ranks = config[botIdent().activeBot.botName]?.ranksCommand?.[rankType];
    if (!Array.isArray(ranks)) throw new Error('The requested rank category is unavailable.');
    return ranks;
}

function getRankEntries(rankType, roleCache, memberCounts) {
    return getRankCategory(rankType).flatMap((rank) => {
        const role = roleCache.find((candidate) => candidate.name === rank);
        if (!role) return [];
        return [{ name: rank, memberCount: memberCounts.get(role.id) ?? 0 }];
    });
}

function getRanks(rankType, roleCache, memberCounts) {
    return getRankEntries(rankType, roleCache, memberCounts).map((entry) => ({
        name: entry.name,
        value: String(entry.memberCount),
        inline: true,
    }));
}

function getCategoryOption(rankType) {
    return RANK_CATEGORY_OPTIONS.find((option) => option.value === rankType);
}

function buildRankCategoryModal() {
    const select = new Discord.StringSelectMenuBuilder()
        .setCustomId(RANK_CATEGORY_FIELD_CUSTOM_ID)
        .setPlaceholder('Choose a rank category...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true)
        .addOptions(RANK_CATEGORY_OPTIONS);
    const label = new Discord.LabelBuilder()
        .setLabel('Rank category')
        .setStringSelectMenuComponent(select);
    const chartCheckbox = new Discord.CheckboxBuilder()
        .setCustomId(RANK_CHART_FIELD_CUSTOM_ID)
        .setDefault(true);
    const chartLabel = new Discord.LabelBuilder()
        .setLabel('Show chart graphic?')
        .setCheckboxComponent(chartCheckbox);

    return new Discord.ModalBuilder()
        .setCustomId(RANK_CATEGORY_MODAL_CUSTOM_ID)
        .setTitle('Rank Statistics')
        .addTextDisplayComponents(
            new Discord.TextDisplayBuilder().setContent(
                'Choose a rank category to post its current statistics in this channel.\n\n'
                + '**Statistics show how many current AXI members hold each rank in that category.**',
            ),
        )
        .addLabelComponents(label, chartLabel);
}

function buildRankEmbed(rankType, roleCache, memberCounts, chartUrl) {
    const category = getCategoryOption(rankType);
    if (!category) throw new Error('The requested rank category is unavailable.');
    const embed = new Discord.EmbedBuilder()
        .setColor(getIdentityBrandColor())
        .setTitle(`${category.label} Ranks`)
        .setDescription(`${category.label} rank statistics`)
        .addFields(getRanks(rankType, roleCache, memberCounts))
        .setTimestamp();
    if (chartUrl) embed.setImage(chartUrl);
    return embed;
}

function getSelectedRankCategory(interaction) {
    const selected = interaction.fields?.getStringSelectValues?.(RANK_CATEGORY_FIELD_CUSTOM_ID);
    const rankType = Array.isArray(selected) && selected.length === 1 ? selected[0] : undefined;
    if (!getCategoryOption(rankType)) throw new Error('Please select a valid rank category.');
    return rankType;
}

function getShowChart(interaction) {
    const showChart = interaction.fields?.getCheckbox?.(RANK_CHART_FIELD_CUSTOM_ID);
    if (typeof showChart !== 'boolean') throw new Error('Please select a valid chart option.');
    return showChart;
}

async function handleModalSubmit(interaction) {
    await interaction.deferReply();
    try {
        const rankType = getSelectedRankCategory(interaction);
        const showChart = getShowChart(interaction);
        const guild = interaction.guild;
        if (!guild?.roles?.cache || typeof guild.roles.fetchMemberCounts !== 'function') {
            throw new Error('Rank statistics are only available in a server.');
        }
        const memberCounts = await guild.roles.fetchMemberCounts();
        let chartUrl;
        if (showChart) {
            try {
                chartUrl = createRankStatsChartUrl(
                    getRankEntries(rankType, guild.roles.cache, memberCounts),
                    getIdentityBrandColor(),
                );
            }
            catch (error) {
                chartReport.warn('generation failed; publishing text statistics', error);
            }
        }
        await interaction.editReply({
            embeds: [buildRankEmbed(rankType, guild.roles.cache, memberCounts, chartUrl)],
        });
    }
    catch (error) {
        console.error('Failed to publish rank statistics:', error);
        await interaction.editReply({
            content: 'Unable to retrieve rank statistics right now. Please try again shortly.',
        });
    }
}

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('rankstats')
        .setDescription('Get rank statistics'),
    permissions: 0,
    execute(interaction) {
        return interaction.showModal(buildRankCategoryModal());
    },
    handleInteraction(interaction) {
        if (
            !interaction.isModalSubmit?.()
            || interaction.customId !== RANK_CATEGORY_MODAL_CUSTOM_ID
        ) return false;
        return handleModalSubmit(interaction).then(() => true);
    },
    RANK_CATEGORY_FIELD_CUSTOM_ID,
    RANK_CHART_FIELD_CUSTOM_ID,
    RANK_CATEGORY_MODAL_CUSTOM_ID,
    RANK_CATEGORY_OPTIONS,
    buildRankCategoryModal,
    buildRankEmbed,
    getRankEntries,
    getRanks,
    getShowChart,
};
