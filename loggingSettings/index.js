'use strict';

const admin = require('./admin');
const {
    getProfile,
    initializeGuild,
    registerDestinationResolver,
} = require('./service');

async function initializeLoggingSettings({ guild, guildId } = {}) {
    const { botName } = getProfile();
    // Install authority before any validation or storage access. Every startup
    // failure therefore remains fail-closed instead of restoring bootstrap IDs.
    registerDestinationResolver();
    if (!guild || String(guild.id) !== String(guildId)) {
        throw new Error(`${botName} logging startup requires the configured guild.`);
    }
    const settings = await initializeGuild(guildId);
    return settings;
}

async function handleInteraction(interaction) {
    if (interaction.isButton?.()) return admin.handleComponent(interaction);
    if (interaction.isModalSubmit?.()) return admin.handleModal(interaction);
    return false;
}

module.exports = {
    execute: admin.execute,
    handleInteraction,
    initializeLoggingSettings,
};
