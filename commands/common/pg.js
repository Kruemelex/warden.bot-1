const Discord = require("discord.js");
const {
    botIdent,
    botLog,
    getCommunityEmbedAuthor,
    getIdentityBrandColor,
} = require('../../functions');
const config = require('../../config.json');
module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName(`pg`)
        .setDescription(`Posts info on how to join the ${botIdent().activeBot.communityName} Private Group`),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions: 0,
    async execute(interaction) {
        
        try {
            let rulesChannelId = null;
            if (config[botIdent().activeBot.botName]?.channels?.privateGroupRules !== undefined) { 
                rulesChannelId = await interaction.guild.channels.fetch(config[botIdent().activeBot.botName].channels.privateGroupRules)
            }
    
            let returnEmbed = new Discord.EmbedBuilder()
                .setTitle(`${botIdent().activeBot.communityName} Private Group`)
                .setColor(getIdentityBrandColor())
                .setAuthor(getCommunityEmbedAuthor())
                .setThumbnail(botIdent().activeBot.icon)
                .setDescription(
                    `**How to join the Private Group**\n` +
                    `1. Open the Social Menu (Menu > Social)\n` +
                    `2. On the Friends tab, use the search box to find "${botIdent().activeBot.communityName}".\n` +
                    `3. Select the "${botIdent().activeBot.communityName}" and click "Request to join private group"\n` +
                    `4. The Request will be automatically approved\n` +
                    `5. Return to the menu, select Start > Private Group > ${botIdent().activeBot.communityName} > Join Group\n`
                )
            if (rulesChannelId) {
                returnEmbed.addFields({ name: "Rules:", value: `Please read the Private Group Rules before joining: <#${rulesChannelId.id}>`, inline: false })
            }
            interaction.reply({ embeds: [returnEmbed.setTimestamp()] })
        }
        catch (err) {
            console.log(err)
            botLog(interaction.guild,new Discord.EmbedBuilder()
                .setDescription('```' + err.stack + '```')
                .setTitle(`⛔ Fatal error experienced`)
                ,2
                ,'error'
            )
        }

    }
}
