const { botLog, botIdent  } = require('../../../functions');
const database = require(`../../../${botIdent().activeBot.botName}/db/database`)
const Discord = require("discord.js");
const ships = require('./ships.json')
const { buildApprovalMessage } = require('./leaderboardApprovalMessages')
const {
	isTransientDatabaseError,
	retryTransientDatabaseOperation,
} = require('../../../Warden/db/errorPolicy')
const { getLeaderboardApprovalChannelId } = require('../../../Warden/logging/service')

async function queryWithRetry(sql, values) {
	const result = await retryTransientDatabaseOperation(() => database.query(sql, values))
	return result.value
}

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
	.addUserOption(option => option.setName('user')
		.setDescription('Select a user to submit on behalf of')
		.setRequired(false))
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
		let args = {}
		let user = interaction.member.id
		let timestamp = Date.now()
		let staffChannel = getLeaderboardApprovalChannelId(interaction.guildId)
		let submissionId = null
		let insertAttempted = false

        for (let key of interaction.options.data) {
            args[key.name] = key.value
		}
		let digitsArray = args.milliseconds.toString().split('').map(Number)
		if (!args.link.startsWith('https://')) { return interaction.editReply({ content: `❌ Please enter a valid URL, eg: https://...` }) }
		if (digitsArray.length < 2) { return interaction.editReply({ content: `❌ Please enter the Milliseconds with 3 digits. ` }) }
		if (args.user !== undefined) { user = args.user }
		if (args.comments == undefined) { args.comments = '-' }
		let name
		if(!staffChannel || interaction.guild.channels.cache.get(staffChannel) === undefined)  { // Check for staff channel
			return interaction.editReply({ content: `Staff Channel not found` })
		}
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
			const values = [user,args.variant,args.shipclass]
			const sql = `
				SELECT time, milliseconds
				FROM \`speedrun\`
				WHERE user_id = (?) AND variant = (?) AND class = (?)
				ORDER BY time ASC, milliseconds ASC
				LIMIT 1;
			`;
			const response = await queryWithRetry(sql, values)
			if (response.length > 0) {
				const previousEntry = response[0]
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
			const submission_values = [user,name,timeStuff.seconds,args.shipclass,args.ship,args.variant,args.link,false,timestamp,args.comments,timeStuff.milliseconds]
			const submission_sql = `
				INSERT INTO speedrun (user_id,name,time,class,ship,variant,link,approval,date,comments,milliseconds) VALUES (?,?,?,?,?,?,?,?,?,?,?);
			`
			insertAttempted = true
			try {
				const insertResult = await database.query(submission_sql, submission_values)
				submissionId = insertResult.insertId
			}
			catch (error) {
				if (!isTransientDatabaseError(error)) throw error

				// A timed-out INSERT may already have reached MySQL. Recover its ID
				// instead of retrying the write and risking a duplicate submission.
				const recoveryRows = await queryWithRetry(
					`SELECT id FROM \`speedrun\`
					WHERE date = (?) AND user_id = (?) AND time = (?) AND milliseconds = (?)
						AND variant = (?) AND class = (?)
					ORDER BY id DESC LIMIT 1`,
					[timestamp, user, timeStuff.seconds, timeStuff.milliseconds, args.variant, args.shipclass],
				)
				if (recoveryRows.length === 0) throw error
				submissionId = recoveryRows[0].id
				console.warn(`Recovered Speedrun submission #${submissionId} after a timed-out INSERT response.`)
			}

			if (!Number.isSafeInteger(Number(submissionId)) || Number(submissionId) <= 0) {
				throw new Error('The Speedrun submission was inserted without a valid submission ID.')
			}

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
			let buttonResult = null;
			buttonResult = await interaction.guild.channels.cache.get(staffChannel).send(buildApprovalMessage('speedrun', {
				id: submissionId,
				user_id: user,
				name,
				time: timeStuff.seconds,
				milliseconds: timeStuff.milliseconds,
				class: args.shipclass,
				ship: args.ship,
				variant: args.variant,
				link: args.link,
				comments: args.comments,
			}))
			const embedId = buttonResult.id
			const submissionUpdate_values = [embedId,submissionId]
			const submissionUpdate_sql = `UPDATE speedrun SET embed_id = (?) WHERE id = (?);`
			await queryWithRetry(submissionUpdate_sql, submissionUpdate_values)

			await interaction.channel.send({ embeds: [returnEmbed.setTimestamp()] })
			await interaction.editReply({
				content: `✅ Submission #${submissionId} recorded. It is now up for review by Staff.`,
			})
		}
		catch (err) {
			console.log(err)
			botLog(interaction.guild,new Discord.EmbedBuilder()
				.setDescription('```' + err.stack + '```')
				.setTitle(`⛔ Speedrun submission failed`)
				,2
				,'error'
			)

			const content = submissionId
				? `⚠️ Submission #${submissionId} was recorded, but Warden could not finish posting all confirmation messages. Please do not resubmit it; contact Staff.`
				: insertAttempted
					? '⚠️ Warden could not confirm whether the submission was recorded. Please avoid resubmitting immediately and contact Staff.'
					: '❌ Warden could not create the submission. Please try again or contact Staff.'
			return interaction.editReply({ content }).catch((responseError) => {
				console.error('Failed to send the Speedrun submission error response:', responseError)
			})
		}
	    }
}
