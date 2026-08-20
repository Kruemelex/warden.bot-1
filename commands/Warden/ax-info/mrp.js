const Discord = require("discord.js");
const {
    getAxiWikiEmbedAuthor,
    getIdentityBrandColor,
} = require('../../../functions');
module.exports = {
    data: new Discord.SlashCommandBuilder()
    .setName(`mrp`)
    .setDescription(`Info about the usage of MRPs`),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions:0,
    execute (interaction) {
        const returnEmbed = new Discord.EmbedBuilder()
        .setTitle('Using Module Reinforcement Packages')
        .setColor(getIdentityBrandColor())
        .setAuthor(getAxiWikiEmbedAuthor())
        .setThumbnail('https://static.wikia.nocookie.net/elite-dangerous/images/9/96/MRP.png/revision/latest?cb=20170114223512')
        .setDescription(`Multiple MRPs will combine their module protection %, but always take damage in a set order:

        - MRPs are critically important, you will want at least 3 on shieldless ships and 2 on shielded ships.
        - Modules around the largest MRP take damage first, which is why it is generally reccomended to have one large and two small MRPs.
        - Military slots should be used for HRPs (Hull Reinceforcement Packages), and not for MRPs
        - The guardian version of the MRP (GMRP) offers a bit more integrity than the normal one, albeit at the cost of power, so you should choose what suits you best.
        
        The GMRP can be engineered with Anti-Guardian Zone Resistance at the engineer Ram Tah in Meene
        
        - Always ensure your largest MRP is in an optional slot (and not a military one) or your module protection will be compromised much sooner.`);

        const actionRow = new Discord.ActionRowBuilder()
        .addComponents(
            new Discord.ButtonBuilder()
            .setLabel('Optional Modules')
            .setStyle(Discord.ButtonStyle.Link)
            .setURL('https://wiki.antixenoinitiative.com/en/optionals'),
            new Discord.ButtonBuilder()
            .setLabel('Ship Build Theory')
            .setStyle(Discord.ButtonStyle.Link)
            .setURL('https://wiki.antixenoinitiative.com/en/shipbuildtheory'),
        );

        interaction.reply({embeds: [returnEmbed.setTimestamp()], components: [actionRow]})
    }
}
