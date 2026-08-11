'use strict';

const Discord = require('discord.js');
const { execute } = require('../../../Warden/leaderboards');

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('leaderboard-settings')
        .setDescription('Show and edit Warden Leaderboard settings')
        .setDMPermission(false)
        .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator),
    execute,
};
