const Discord = require('discord.js');
const { getCommunityEmbedAuthor, getIdentityBrandColor } = require('../../../functions');


module.exports = {
    data: new Discord.SlashCommandBuilder()
    .setName(`rankrequirements`)
    .setDescription(`Create the Rank Requirement buttons`),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions:0,
    async execute (interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
		.setColor(getIdentityBrandColor())
		.setTitle("**Rank Requirements**")
		.setAuthor(getCommunityEmbedAuthor())
		.setThumbnail('https://cdn.discordapp.com/emojis/1539310145362993263.png?size=4096&quality=lossless')
		.setDescription(`The Anti-Xeno Initiative uses ranks to encourage CMDRs to develop and prove their skills as an AX Pilot. Learn all about the various challenges and competitive ranks you can earn in the AXI. 

Please click the link below to view our Ranks website to find all the up-to-date information on how to earn your first AX combat rank. This can also be found by visiting our website at www.antixenoinitiative.com.`)

        const row = new Discord.ActionRowBuilder()
        .addComponents(new Discord.ButtonBuilder().setLabel('View Rank Requirements').setStyle(Discord.ButtonStyle.Link).setURL('https://antixenoinitiative.com/ranks'),)

        interaction.reply({ embeds: [returnEmbed.setTimestamp()], components: [row] });
    }
}
