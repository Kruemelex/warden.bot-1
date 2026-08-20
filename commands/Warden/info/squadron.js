'use strict';

const Discord = require('discord.js');
const {
    getCommunityEmbedAuthor,
    getIdentityBrandColor,
} = require('../../../functions');

const SQUADRON_GUIDANCE = `We have an in-game squadron on PC, called **Anti Xeno Initiative** with the tag **AXIN**. Due to game limitations, we ask that you follow these steps:

1️⃣ Join this Discord server, pass the verification and comply with Rule #3 of <#410089988852547614>. If you don't, we cannot find you and verify your ranks. If somebody you know wants to join us, please send them here (invite link is in <#410089988852547614>).

2️⃣ Obtain the <@&380254463170183180> Rank. Learn more about how to obtain ranks in <#642837372228075549>. We require it for several reasons, one of them being the limit on the total squadron size (500 people total). If you are having trouble contact a <@&468153018899234816> for advice or help.

3️⃣ Submit an application to our [Inara Squadron](https://inara.cz/squadron/4358/). Please read the instructions carefully and provide all the requested information in the application form. You can apply to the Inara Squadron even if you don't have any ranks (as it is not limited in size), but you need the <@&380254463170183180> rank to be accepted into the in-game squadron. We only accept CMDRs with verified Inara accounts.

4️⃣ Submit an in-game squadron application. Note that you do not need to wait for processing of each step before proceeding to the next, as long as you do them at the same time. If you apply for the rank and submit two application at once, it will be easier for us to process them all at once. Just make sure each application is done correctly.

Be careful to provide the correct information, applications with incorrect or incomplete information will be rejected. If your request was not processed within 7 days, you are free to contact a staff member for clarification.`;

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('squadron')
        .setDescription('Learn how to join the Anti-Xeno Initiative squadron'),
    permissions: 0,
    execute(interaction) {
        const embed = new Discord.EmbedBuilder()
            .setColor(getIdentityBrandColor())
            .setAuthor(getCommunityEmbedAuthor())
            .setTitle('How to Join the Squadron')
            .setDescription(SQUADRON_GUIDANCE)
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            flags: Discord.MessageFlags.Ephemeral,
        });
    },
};
