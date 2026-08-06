'use strict';

const Discord = require('discord.js');
const verificationEmbedConfig = require('./config.json');
const { buildVerificationPublicEmbed } = require('./public');
const { createTemplateField, formatDuration } = require('./templates');

function buildVerificationWelcomeEmbed(verificationSettings) {
    const embed = buildVerificationPublicEmbed('welcomeEmbed');
    if (!verificationSettings?.autokickEnabled) return embed;

    const field = createTemplateField(verificationEmbedConfig.autoKickWelcomeField ?? {}, {
        autokickTimer: formatDuration(verificationSettings.autokickSeconds),
    });
    if (field) embed.addFields(field);
    return embed;
}

function buildVerificationPostComponents() {
    return [new Discord.ActionRowBuilder()
        .addComponents(
            new Discord.ButtonBuilder()
                .setCustomId('wardenVerify-start')
                .setLabel('Verify')
                .setStyle(Discord.ButtonStyle.Success),
            new Discord.ButtonBuilder()
                .setCustomId('wardenVerify-help')
                .setLabel('Help')
                .setStyle(Discord.ButtonStyle.Secondary),
        )];
}

function buildVerificationPostPayload(verificationSettings) {
    return {
        embeds: [buildVerificationWelcomeEmbed(verificationSettings)],
        components: buildVerificationPostComponents(),
    };
}

module.exports = {
    buildVerificationPostPayload,
};
