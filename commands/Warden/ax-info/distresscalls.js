const Discord = require("discord.js");
const {
    getAxiWikiEmbedAuthor,
    getIdentityBrandColor,
} = require('../../../functions.js');

module.exports = {
    data: new Discord.SlashCommandBuilder()
    .setName(`distresscalls`)
    .setDescription(`Posts the Distress Call Infographic`),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions: 0,
    execute (interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
        .setTitle('Distress Calls Point of Interest')
        .setColor(getIdentityBrandColor())
        .setAuthor(getAxiWikiEmbedAuthor())
        .setThumbnail('https://images-ext-2.discordapp.net/external/yEcAqIKpGHPAh7GPJKiMwTXXqjHaVOV4GAbe55nJ1Kg/https/cdn-longterm.mee6.xyz/plugins/commands/images/380246809076826112/154b822b23bcdb8fe17fcc74a924ee0fb703b04a58b0fa9c9ef7b80bf4f5a24d.png?width=625&height=625')
        .setDescription(`**Distress Call Points Of Interest** that contain megaships or capital ships attacked by thargoids are leftovers of the initial bubble invasion. They have been placed there manually by FDev, who forgot to remove them once the invasion was over. Deciat, for example, was attacked on July 5th 2018, and there are about 40+ more systems with the same type of POI all over the bubble and pleiades region.

        These POIs are not an indication of any actual thargoid activity by themselves, only Non-Human Signal Sources or AX Combat Zones are. Keep in mind though, that NHSS are naturally present in the Pleiades, Witch Heat, and Coalsack Nebulae, and do not necessarily mean those systems are in danger.`)
        .addFields({
            name: 'HR 1185',
            value: 'Permanent (Capital Ship) Distress call arround body **A 1**. Very useful to find multi-goid fights or solo Hydras.',
        });

        const actionRow = new Discord.ActionRowBuilder()
        .addComponents(
            new Discord.ButtonBuilder()
            .setLabel('Learn more about Distress Calls')
            .setStyle(Discord.ButtonStyle.Link)
            .setURL('https://wiki.antixenoinitiative.com/en/distress-call-analysis'),
        );

        interaction.reply({embeds: [returnEmbed.setTimestamp()], components: [actionRow]})
    }
}
