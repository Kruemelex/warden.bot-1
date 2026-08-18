const Discord = require('discord.js');
const { getCommunityEmbedAuthor, getIdentityBrandColor } = require('../../../functions');

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('arxchief')
        .setDescription('Information about the AX Combat Jumpstart Chieftain'),
    permissions: 0,
    execute(interaction) {
        const embed = new Discord.EmbedBuilder()
            .setColor(getIdentityBrandColor())
            .setTitle('Prebuilt AX Chieftain')
            .setAuthor(getCommunityEmbedAuthor())
            .setThumbnail('https://cdn.discordapp.com/emojis/1538679230102110298.webp?size=256')
            .setDescription(
                'The AX Combat Jumpstart Chieftain from the ARX-Store tries to cover too many AX roles at once, making it perform poorly in any one role.\n\n'
                + 'The weapons loadout and optional internals are counter productive. Especially the torpedo launcher, and shield are obsolete and actively detrimental.'
            )
            .addFields(
                {
                    name: '⚠️ Verdict: Not recommended',
                    value: 'The jumpstart prebuild is fundamentally flawed, and the effort required to fix it largely negates the intended shortcut for all but the newest Commanders. **There are better ways to spend your ARX.**',
                },
                {
                    name: 'How to fix the Prebuild',
                    value: 'Okay, you already have it, what now? You can follow our complete step-by-step Guide on how to fix it, by clicking the button below...',
                },
            )
            .setTimestamp();

        const buttonRow = new Discord.ActionRowBuilder().addComponents(
            new Discord.ButtonBuilder()
                .setLabel('Full Guide')
                .setStyle(Discord.ButtonStyle.Link)
                .setURL('https://wiki.antixenoinitiative.com/en/fixing-jumpstart-chieftain'),
        );

        return interaction.reply({ embeds: [embed], components: [buttonRow] });
    },
};
