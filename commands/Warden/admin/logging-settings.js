'use strict';

const Discord = require('discord.js');
const { execute } = require('../../../loggingSettings');

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('logging-settings')
        .setDescription('Show and edit Warden logging settings')
        .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator),
    execute,
};
