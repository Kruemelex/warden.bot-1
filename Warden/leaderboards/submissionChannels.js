'use strict';

const Discord = require('discord.js');

const SUBMISSION_CHANNEL_TYPES = Object.freeze([
    Discord.ChannelType.GuildText,
    Discord.ChannelType.GuildAnnouncement,
]);

function unavailableError(message) {
    const error = new Error(message);
    error.code = 'LEADERBOARD_SUBMISSION_CHANNEL_UNAVAILABLE';
    return error;
}

function assertUsableSubmissionChannel(channel, { guildId, botMember, label = 'Leaderboard' } = {}) {
    if (
        !channel
        || String(channel.guildId) !== String(guildId)
        || !SUBMISSION_CHANNEL_TYPES.includes(channel.type)
        || typeof channel.send !== 'function'
    ) {
        throw unavailableError(`The configured ${label} submission channel is unavailable.`);
    }
    const permissions = typeof channel.permissionsFor === 'function'
        ? channel.permissionsFor(botMember)
        : undefined;
    if (permissions && !permissions.has([
        Discord.PermissionFlagsBits.ViewChannel,
        Discord.PermissionFlagsBits.SendMessages,
        Discord.PermissionFlagsBits.EmbedLinks,
    ])) {
        throw unavailableError(`Warden cannot view, send messages, and embed links in the configured ${label} submission channel.`);
    }
    return channel;
}

module.exports = {
    assertUsableSubmissionChannel,
    SUBMISSION_CHANNEL_TYPES,
};
