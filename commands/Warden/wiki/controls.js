const Discord = require('discord.js');
const {
    getAxiWikiEmbedAuthor,
    getIdentityBrandColor,
} = require('../../../functions');

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('controls')
        .setDescription('Recommended control bindings for Anti-Xeno combat'),
    permissions: 0,
    execute(interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
            .setColor(getIdentityBrandColor())
            .setTitle('Recommended Controls')
            .setAuthor(getAxiWikiEmbedAuthor())
            .setDescription("The controls scheme is a fundamental and often overlooked part of any pilots toolkit. This is especially the case for pilots new to AX combat and Flight-Assist OFF flying in general. The default controls scheme in Elite is, to be frank; awful for FaOFF. The ability to decouple your flight vector from your attack vector is paramount for most AX tactics.")
            .addFields({
                name: 'Binds',
                value: 'For those new to anti-xeno or combat in general, there are a number of binds which are necessary for Thargoid combat that may not be easily accessible or bound at all without doing it manually. These binds will be used regularly and should be comfortable to reach from a neutral hand position over thrust controls and without messing with your aim during combat!\n\nSee our detailed guide on recommended controls.',
            });

        const buttonRow = new Discord.ActionRowBuilder()
            .addComponents(
                new Discord.ButtonBuilder()
                    .setLabel('Recommended Controls')
                    .setStyle(Discord.ButtonStyle.Link)
                    .setURL('https://wiki.antixenoinitiative.com/en/recommended-controls'),
            );

        interaction.reply({
            embeds: [returnEmbed.setTimestamp()],
            components: [buttonRow],
        });
    },
};
