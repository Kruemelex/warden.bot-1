const Discord = require("discord.js");
const {
    getIdentityBrandColor,
    getIdentityEmbedAuthor,
} = require('../../../functions');
module.exports = {
    data: new Discord.SlashCommandBuilder()
    .setName(`t10`)
    .setDescription(`Posts the T10 Infographic`),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions:0,
    execute (interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
        .setTitle('Type-10 Defender')
        .setColor(getIdentityBrandColor())
        .setAuthor(getIdentityEmbedAuthor())
        .setThumbnail('https://cdn.discordapp.com/attachments/865043404479791135/1063689199695429632/t10_crossout.png')
        .setDescription(`~~T10 is traaaaaaaaaaash~~
        T10 is generally considered one of the worst possible ships for Anti-Xeno combat, especially versus Interceptors, despite what its description might imply. Reasons for this are numerous and will take quite long to explain in detail. If you have specific questions, our Mentors will be glad to answer them.
        
        Some other bad ships are....
        - Crusader (Downgraded Chieftain/Challenger)
        - Python (Downgrade of Krait in combat)
        - Mamba (Terrible convergence)
        - Type-X ships (Obviously)
        
        Ask a <@&468153018899234816> if you would like to know more about why these ships are so terrible for AX.`)
        interaction.reply({embeds: [returnEmbed.setTimestamp()]})
    }
}
