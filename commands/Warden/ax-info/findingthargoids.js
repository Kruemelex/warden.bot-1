'use strict';

const Discord = require('discord.js');
const {
    getAxiWikiEmbedAuthor,
    getIdentityBrandColor,
} = require('../../../functions');

const GUIDE_URL = 'https://wiki.antixenoinitiative.com/en/finding-thargoids';

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('findingthargoids')
        .setDescription('Learn where to find Thargoids'),
    permissions: 0,
    execute(interaction) {
        const embed = new Discord.EmbedBuilder()
            .setTitle('Finding Thargoids')
            .setColor(getIdentityBrandColor())
            .setAuthor(getAxiWikiEmbedAuthor())
            .setDescription(
                'The most reliable Thargoid encounters are found through Non-Human Signal Sources in the Pleiades, Coalsack, and partially California Nebulae. AX Conflict Zones, hyperdictions, and permanent signal sources offer other ways to find them.',
            )
            .addFields(
                {
                    name: 'Pleiades Nebula',
                    value: '```Asterope```\nA reliable hunting ground for Non-Human Signal Sources. Sterope II, HR 1185, and The Zoo are other locations of note throughout the region.',
                },
                {
                    name: 'California Nebula',
                    value: '```California Sector BA-A e6```\nThis system hosts functional High- and Medium-intensity AX Conflict Zones near body 4 and is a known gathering point for AX pilots.',
                },
            )
            .setTimestamp();

        const actions = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setLabel('Finding Thargoids')
                .setStyle(Discord.ButtonStyle.Link)
                .setURL(GUIDE_URL),
        );

        return interaction.reply({ embeds: [embed], components: [actions] });
    },
};
