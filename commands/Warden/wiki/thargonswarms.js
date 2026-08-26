const Discord = require('discord.js');
const {
    getAxiWikiEmbedAuthor,
    getIdentityBrandColor,
} = require('../../../functions');

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('thargonswarms')
        .setDescription('Information and guidance for managing Thargon swarms'),
    permissions: 0,
    execute(interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
            .setColor(getIdentityBrandColor())
            .setTitle('Thargon Swarms')
            .setAuthor(getAxiWikiEmbedAuthor())
            .setDescription('Each Interceptor can deploy and control a Thargon swarm, consisting of 32, 64, 96 and 128 Thargons for Cyclops, Basilisk, Medusa and Hydra variants respectively. Detailed behavior and mechanics are layed out in our wiki.')
            .addFields({
                name: 'Swarm Management',
                value: 'The Thargon Swarm is a major component of AX combat and knowing how to deal with it is important to fight interceptors effectively. There are two main methods in this regard; using the **remote release flak launcher** to destroy the swarm, and flying **flakless** while avoiding the swarm entirely. Detailed techniques and counters can be found in our wiki guide.',
            });

        const buttonRow = new Discord.ActionRowBuilder()
            .addComponents(
                new Discord.ButtonBuilder()
                    .setLabel('Thargon Swarms')
                    .setStyle(Discord.ButtonStyle.Link)
                    .setURL('https://wiki.antixenoinitiative.com/en/thargon-swarms'),
                new Discord.ButtonBuilder()
                    .setLabel('Swarm Management')
                    .setStyle(Discord.ButtonStyle.Link)
                    .setURL('https://wiki.antixenoinitiative.com/en/dealing-with-swarm'),
            );

        interaction.reply({
            embeds: [returnEmbed.setTimestamp()],
            components: [buttonRow],
        });
    },
};
