'use strict';

const { botIdent } = require('../../functions');
const admin = require('./admin');
const {
    initializeGuild,
    registerDestinationResolver,
} = require('./service');

async function initializeWardenLogging({ guild, guildId } = {}) {
    if (botIdent().activeBot.botName !== 'Warden') return undefined;
    if (!guild || String(guild.id) !== String(guildId)) {
        throw new Error('Warden logging startup requires the configured guild.');
    }
    const settings = await initializeGuild(guildId);
    registerDestinationResolver();
    return settings;
}

async function handleInteraction(interaction) {
    if (interaction.isButton?.()) return admin.handleComponent(interaction);
    if (interaction.isModalSubmit?.()) return admin.handleModal(interaction);
    return false;
}

module.exports = {
    handleInteraction,
    initializeWardenLogging,
};
