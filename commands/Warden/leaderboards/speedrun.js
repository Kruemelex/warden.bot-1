const { botLog } = require('../../../functions');
const Discord = require("discord.js");
const ships = require('./ships.json')
const { findSpeedrunBest } = require('../../../Warden/db/leaderboards/repository')
const { createLeaderboardSubmission, publishLeaderboardSubmissionConfirmation } = require('./leaderboardSubmission')
const { assertLeaderboardSubmissionAllowed, isLeaderboardAvailabilityError } = require('../../../Warden/leaderboards/policy')
const { createConsoleReporter } = require('../../../logging/consoleReporting')

const report = createConsoleReporter('Leaderboard').forSubsystem('Commands')

module.exports = {
    data: new Discord.SlashCommandBuilder()
	.setName('speedrun')
	.setDescription('Submit your speedrun attempt')
	.addStringOption(option => option.setName('variant')
		.setDescription('Thargoid Variant')
		.setRequired(true)
		.addChoices(
			{ name:'Cyclops', value:'cyclops' },
			{ name:'Basilisk', value:'basilisk' },
			{ name:'Medusa', value:'medusa' },
			{ name:'Hydra', value:'hydra' }
		))
    .addStringOption(option => option.setName('shipclass')
		.setDescription('Thargoid Variant')
		.setRequired(true)
        .addChoices(
			{ name: 'Small', value: 'small' },
			{ name: 'Medium', value: 'medium' },
			{ name: 'Large', value: 'large' }
		))
	.addStringOption(option => option.setName('ship')
			.setDescription('Ship Model eg: Anaconda, Krait Mk.II, etc')
			.setRequired(true)
			.setAutocomplete(true)
	)
    .addIntegerOption(option => option.setName('time')
		.setDescription('Time achieved in Seconds. Milliseconds will be the next question.')
		.setRequired(true))
	.addStringOption(option => option.setName('milliseconds')
		.setDescription('Must be 3 digits. 000 if None.')
		.setRequired(true))
	.addStringOption(option => option.setName('link')
		.setDescription('Include video link for proof (Please use shortened links)')
		.setRequired(true))
	.addStringOption(option => option.setName('comments')
		.setDescription('Comment, banter, whatever')
		.setRequired(false)),
	async autocomplete(interaction) {
		const focusedOption = interaction.options.getFocused(true);
        let choices; //array
        if (focusedOption.name === 'ship') {
			const selectionValues = interaction.options._hoistedOptions
			const shipClass = selectionValues.find(i => i.name === 'shipclass').value
			choices = ships[shipClass]
        }
        const filtered = choices.filter(choice => choice.startsWith(focusedOption.value));
        await interaction.respond(
            filtered.map(choice => ({ name: choice, value: choice })),
        )
    },
	async execute(interaction) {
		await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
		try { await assertLeaderboardSubmissionAllowed(interaction.guildId, 'speedrun') }
		catch (error) { return interaction.editReply({ content: `⏳ ${error.message}` }) }
		let args = {}
		let user = interaction.member.id
		let timestamp = Date.now()
		let submissionId = null

        for (let key of interaction.options.data) {
            args[key.name] = key.value
		}
		let digitsArray = args.milliseconds.toString().split('').map(Number)
		if (!args.link.startsWith('https://')) { return interaction.editReply({ content: `❌ Please enter a valid URL, eg: https://...` }) }
		if (digitsArray.length < 2) { return interaction.editReply({ content: `❌ Please enter the Milliseconds with 3 digits. ` }) }
		if (args.comments == undefined) { args.comments = '-' }
		let name
		// const timewithmilliseconds = Number(`${args.time}` + `${args.milliseconds}`)
		let timeStuff = {
			seconds: Number(args.time),
			milliseconds: Number(args.milliseconds)
		}
		let totalMilliseconds = timeStuff.seconds * 1000 + timeStuff.milliseconds
		let date = new Date(totalMilliseconds)
		const timeString = date.toISOString().substr(11, 8) + '.' + String(timeStuff.milliseconds).padStart(3, '0')

		try {
			const submissionMember = interaction.guild.members.cache.get(user)
				?? await interaction.guild.members.fetch(user)
			name = submissionMember.nickname ?? submissionMember.displayName

			// user = '677514454262480896'
			const previousEntry = await findSpeedrunBest(user, args.variant, args.shipclass)
			if (previousEntry) {
				const previousMilliseconds = Number(previousEntry.time) * 1000 + Number(previousEntry.milliseconds)
				if (previousMilliseconds <= totalMilliseconds) {
					const abortEmbed = new Discord.EmbedBuilder()
						.setColor('#f20505')
						.setTitle(`**Speedrun Submission Aborted**`)
						.setDescription(`You have a previous entry of **${args.shipclass.toUpperCase()}** **${args.variant.toUpperCase()}** which is faster than or equal to this entry. Submission aborted.`)
						.addFields(
							{ name: "Your Previous Entry:", value: `${previousEntry.time}.${String(previousEntry.milliseconds).padStart(3, '0')}`, inline: false },
							{ name: "Your Submitted Entry", value: "==============================================================", inline: false },
							{ name: "Pilot", value: `<@${user}>`, inline: true },
							{ name: "Ship", value: `${args.ship}`, inline: true },
							{ name: "Variant", value: `${args.variant}`, inline: true },
							{ name: "Time Series", value: `${timeString}`, inline: true },
							{ name: "Time Seconds.Milliseconds", value: `${timeStuff.seconds}.${timeStuff.milliseconds}`, inline: true },
							{ name: "Class", value: `${args.shipclass}`, inline: true }
						)

					await interaction.editReply({ embeds: [abortEmbed] })
					return
				}
			}

			const created = await createLeaderboardSubmission(interaction, 'speedrun', {
				user_id: user, name, time: timeStuff.seconds, milliseconds: timeStuff.milliseconds,
				class: args.shipclass, ship: args.ship, variant: args.variant, link: args.link,
				approval: 0, date: timestamp, comments: args.comments,
			})
			const stored = created.submission
			submissionId = stored.id

			// Print out data
			const returnEmbed = new Discord.EmbedBuilder()
				.setColor('#FF7100')
				.setTitle(`**Speedrun Submission Complete**`)
				.setDescription(`Congratulations <@${interaction.member.id}>, your submission is complete. Please be patient while our staff approve your submission. Submission ID: #${submissionId}`)
				.addFields(
					{name: "Pilot", value: `<@${user}>`, inline: true},
					{name: "Ship", value: `${args.ship}`, inline: true},
					{name: "Variant", value: `${args.variant}`, inline: true},
					{name: "Time", value: `${timeString}`, inline: true},
					{name: "Class", value: `${args.shipclass}`, inline: true},
					{name: "link", value: `${args.link}`, inline: true},
					{name: "Comments", value: `${args.comments}`, inline: true})
			await publishLeaderboardSubmissionConfirmation(interaction, created, returnEmbed.setTimestamp())
		}
		catch (err) {
			if (isLeaderboardAvailabilityError(err)) {
				return interaction.editReply({ content: `⏳ ${err.message}` })
			}
			report.error('Speedrun submission failed', err, { submissionId })
			botLog(interaction.guild,new Discord.EmbedBuilder()
				.setDescription('```' + err.stack + '```')
				.setTitle(`⛔ Speedrun submission failed`)
				,2
				,'error'
			)

			const recordedId = submissionId ?? err.submissionId
			const content = recordedId
				? `⚠️ Submission #${recordedId} was recorded, but Warden could not finish posting all confirmation messages. Please do not resubmit it; contact Staff.`
				: '❌ Warden could not create the submission. Please try again or contact Staff.'
			return interaction.editReply({ content }).catch((responseError) => {
				report.error('Speedrun error response failed', responseError, { submissionId: recordedId })
			})
		}
	    }
}
