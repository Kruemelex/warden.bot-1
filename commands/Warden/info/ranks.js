'use strict';

const Discord = require('discord.js');

const RANKS_VIDEO_URL = 'https://youtu.be/L9LFVyXLna4';

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('ranks')
        .setDescription('Learn about AXI ranks'),
    permissions: 0,
    execute(interaction) {
        return interaction.reply({ content: RANKS_VIDEO_URL });
    },
};
