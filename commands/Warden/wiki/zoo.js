const Discord = require("discord.js");
const { getCommunityEmbedAuthor, getIdentityBrandColor } = require('../../../functions');

module.exports = {
    data: new Discord.SlashCommandBuilder()
	.setName('zoo')
	.setDescription('Learn about the zoo'),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions: 0,
    hidden: false,
    execute (interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
	    .setColor(getIdentityBrandColor())
	    .setTitle('**The Zoo**')
	    .setAuthor(getCommunityEmbedAuthor())
	    .setDescription(
	        `The Zoo is a System in the Pleiades Nebula. Today it houses the symbolic in-game HQ of the AXI community. It was extensively developed during the advent of colonization, and now offers excellent outfitting for all commanders.`
	    )
	    .addFields(
	        {
	            name: 'System Name',
	            value: '```Pleiades Sector MI-S B4-0```',
	            inline: false,
	        },
	        {
	            name: 'History',
	            value: `The Zoo was once known as the only system to spawn solo (no-scout) Hydras, in both “guaranteed” (triple icon / debris field) and non-guaranteed (single icon / green cloud) instances.

	However, this was several iterations of AX system-spawn mechanics ago, and has not been the case for a long time.`,
	            inline: false,
	        },
	    );
        const buttonRow = new Discord.ActionRowBuilder()
        .addComponents(new Discord.ButtonBuilder().setLabel('Learn more about the Zoo').setStyle(Discord.ButtonStyle.Link).setURL('https://wiki.antixenoinitiative.com/en/nhss'),)

        interaction.reply({ embeds: [returnEmbed.setTimestamp()], components: [buttonRow] });
    }
}
