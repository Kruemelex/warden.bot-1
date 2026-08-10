'use strict';

const Discord = require('discord.js');

function fieldValue(value, fallback = '-') {
    const text = String(value ?? '').trim() || fallback;
    return text.length <= 1024 ? text : `${text.slice(0, 1023)}…`;
}

function formatSpeedrunTime(seconds, milliseconds) {
    const totalMilliseconds = Number(seconds) * 1000 + Number(milliseconds);
    if (!Number.isFinite(totalMilliseconds) || totalMilliseconds < 0) return 'Invalid time';
    return new Date(totalMilliseconds).toISOString().slice(11, 19)
        + `.${String(Number(milliseconds)).padStart(3, '0')}`;
}

function buildApprovalButtons(leaderboard, submissionId) {
    return new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId(`submission-${leaderboard}-approve-${submissionId}`)
            .setLabel('Approve')
            .setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder()
            .setCustomId(`submission-${leaderboard}-deny-${submissionId}`)
            .setLabel('Delete')
            .setStyle(Discord.ButtonStyle.Danger),
        new Discord.ButtonBuilder()
            .setCustomId(`submission-${leaderboard}-edit-${submissionId}`)
            .setLabel('Edit')
            .setStyle(Discord.ButtonStyle.Secondary),
    );
}

function buildSpeedrunApprovalEmbed(submission) {
    return new Discord.EmbedBuilder()
        .setColor('#FF7100')
        .setTitle('**New Speedrun Submission**')
        .setDescription('Please select Approve, Delete, or Edit below after checking that the video is legitimate and matches the submitted details. This only controls the Leaderboard and does not assign ranks.')
        .addFields(
            { name: 'Submission ID', value: String(submission.id), inline: true },
            { name: 'Pilot', value: `<@${submission.user_id}>`, inline: true },
            { name: 'Ship', value: fieldValue(submission.ship), inline: true },
            { name: 'Variant', value: fieldValue(submission.variant), inline: true },
            { name: 'Time', value: formatSpeedrunTime(submission.time, submission.milliseconds), inline: true },
            { name: 'Class', value: fieldValue(submission.class), inline: true },
            { name: 'Link', value: fieldValue(submission.link), inline: true },
            { name: 'Comments', value: fieldValue(submission.comments), inline: true },
        );
}

function buildAceApprovalEmbed(submission) {
    return new Discord.EmbedBuilder()
        .setColor('#FF7100')
        .setTitle('**New Ace Submission**')
        .setDescription('Please select Approve, Delete, or Edit below after checking that the video is legitimate and matches the submitted details. This only controls the Leaderboard and does not assign ranks.')
        .addFields(
            { name: 'Submission ID', value: String(submission.id), inline: true },
            { name: 'Pilot', value: `<@${submission.user_id}>`, inline: true },
            { name: 'Ship', value: fieldValue(submission.shiptype), inline: true },
            { name: 'Score', value: Number(submission.score).toFixed(2), inline: true },
            { name: 'Link', value: fieldValue(submission.link), inline: true },
            { name: 'Time (sec)', value: String(submission.timetaken), inline: true },
            { name: 'Medium Gauss Modules', value: String(submission.mgauss), inline: true },
            { name: 'Small Gauss Modules', value: String(submission.sgauss), inline: true },
            { name: 'Medium Gauss Fired', value: String(submission.mgaussfired), inline: true },
            { name: 'Small Gauss Fired', value: String(submission.sgaussfired), inline: true },
            { name: 'Hull % Lost', value: String(submission.percenthulllost), inline: true },
        );
}

function buildApprovalMessage(leaderboard, submission) {
    const embed = leaderboard === 'ace'
        ? buildAceApprovalEmbed(submission)
        : buildSpeedrunApprovalEmbed(submission);
    return {
        content: null,
        embeds: [embed],
        components: [buildApprovalButtons(leaderboard, submission.id)],
    };
}

module.exports = {
    buildApprovalButtons,
    buildApprovalMessage,
    buildAceApprovalEmbed,
    buildSpeedrunApprovalEmbed,
    formatSpeedrunTime,
};
