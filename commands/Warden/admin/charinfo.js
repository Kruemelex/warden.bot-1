const Discord = require("discord.js");
const { botLog } = require('../../../functions')
// const config = require('../../../config.json')

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('charinfo')
        .setDescription('Checks join dates and account creation')
        .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator)
        .addUserOption(option => 
            option.setName('character')
                .setDescription('Use a @mentionable name')
                .setRequired(true)
        )
        ,
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true })

        const { options } = interaction
        const member = options.getMember('character')
        if (!member) {
            return interaction.editReply({ content: "User not found or invalid mention." })
        }

        let roles = ``;
        member.roles.cache.each(role => roles += `${role}\n`)
        const accountCreationDate = new Date(member.user.createdAt)
        const joinDate = new Date(member.joinedTimestamp)
        const accountAge = joinDate - accountCreationDate
        const oneDay = 24 * 60 * 60 * 1000
        let violator = `\`\`\`No\`\`\``;
        if (accountAge <= oneDay) {
            violator = `\`\`\`Yes\`\`\``
        }
        const onion = await guild.members.fetch('346415786505666560') // Mr Onion
        const embed = new Discord.EmbedBuilder()
            .setDescription(`User ${member.user.tag} (${member.displayName})`)
            .setTitle(`Charcter Information`)
            .addFields(
                { name: `User`, value: `${member.user}` },
                { name: `Within 24 hour?`, value: `${violator}`},
                { name: `ID`, value: `\`\`\`${member.id}\`\`\`` },
                { name: `Date Account Created`, value: `<t:${Math.floor(accountCreationDate.getTime() / 1000)}:F>` },
                { name: `Date Joined`, value: `<t:${Math.floor(joinDate.getTime() / 1000)}:F>` },
            )
        await onion.send({ embeds: [embed] })
        // botLog(guild, new Discord.EmbedBuilder()
        //     .setDescription(`User ${member.user.tag} (${member.displayName})`)
        //     .setTitle(`Charcter Information`)
        //     .addFields(
        //         { name: `User`, value: `${member.user}` },
        //         { name: `Within 24 hour?`, value: `${violator}`},
        //         { name: `ID`, value: `${member.id}` },
        //         { name: `Date Account Created`, value: `<t:${Math.floor(accountCreationDate.getTime() / 1000)}:F>` },
        //         { name: `Date Joined`, value: `<t:${Math.floor(joinDate.getTime() / 1000)}:F>` },
        //         { name: `Roles`, value: roles || "No roles" },
        //     ), 2, "staff"
        // )

        interaction.editReply({ content: "Data sent to Mr Onion" })
    }
}

