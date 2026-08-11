'use strict';

const Discord = require('discord.js');

function capitalizeFirstLetter(value) {
    const text = String(value ?? '');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildSpeedrunEmbed(entry, divisionRank, variant, shipClass) {
    const hours = Math.floor(Number(entry.time) / 3600);
    const minutes = Math.floor((Number(entry.time) % 3600) / 60);
    const seconds = Number(entry.time) % 60;
    return new Discord.EmbedBuilder()
        .setColor('#FF7100')
        .setTitle(`**Speedrun ${capitalizeFirstLetter(shipClass)} ${capitalizeFirstLetter(variant)}**`)
        .setDescription(`#${divisionRank} in Division`)
        .addFields({
            name: '---------------------------------',
            value: `
                **Pilot:** ${entry.name}\r
                **Ship:**  ${entry.ship}\r
                **Time:** ${hours}h ${minutes}m ${seconds}s ${entry.milliseconds}ms\r
                **Seconds.Milliseconds:** ${entry.time}.${entry.milliseconds}\r
                **Date:** ${formatDate(entry.date)}\r
                **Link:** ${entry.link}
            `,
            inine: false,
        })
        .setTimestamp();
}

module.exports = { buildSpeedrunEmbed };
