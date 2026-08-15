const Discord = require("discord.js")
const { botLog } = require('../../../functions');
const { listAceBoard, listSpeedrunBoard } = require('../../../Warden/db/leaderboards/repository')
const { createConsoleReporter } = require('../../../logging/consoleReporting')
const { buildSpeedrunEmbed } = require('./leaderboardPresentation')
const { createPersonalSpeedrunHistory } = require('./personalLeaderboardPagination')
const report = createConsoleReporter('Leaderboard').forSubsystem('Commands')
function timeConvertTT(timetaken) {
	const hours = Math.floor(timetaken / 3600);
	const minutes = Math.floor((timetaken % 3600) / 60);
	const seconds = timetaken % 60;
	const formattedTime = `${String(hours).padStart(2, '0')}h:${String(minutes).padStart(2, '0')}m:${String(seconds).padStart(2, '0')}s`;

	return formattedTime
}
function timeConvertDS(timestamp) {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');

	const formattedDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	return formattedDate
}
async function sendLeaderboardEmbeds(interaction, embeds, content) {
	const chunks = []
	for (let index = 0; index < embeds.length; index += 10) chunks.push(embeds.slice(index, index + 10))
	await interaction.editReply({ content, embeds: chunks.shift() ?? [] })
	for (const chunk of chunks) await interaction.followUp({ embeds: chunk })
}
function logLeaderboardError(interaction, err) {
	try {
		Promise.resolve(botLog(interaction.guild, new Discord.EmbedBuilder()
			.setDescription('```' + String(err.stack ?? err) + '```')
			.setTitle('⛔ Fatal error experienced'), 2, 'error'))
			.catch(logError => report.error('Discord error report failed', logError))
	} catch (logError) {
		report.error('Discord error report failed', logError)
	}
}
module.exports = {
data: new Discord.SlashCommandBuilder()
	.setName('leaderboard')
	.setDescription('Review the Leaderboards')
	.addSubcommand(subcommand =>
		subcommand
			.setName('speedrun')
			.setDescription('Select a leaderboard')
			.addStringOption(option => option.setName('variant')
				.setDescription('Thargoid Variant')
				.setRequired(true)
				.addChoices(
					{ name:'Cyclops', value:'cyclops' },
					{ name:'Basilisk', value:'basilisk' },
					{ name:'Medusa', value:'medusa' },
					{ name:'Hydra', value:'hydra' }
				)
			)
			.addStringOption(option => option.setName('shipclass')
					.setDescription('Ship Class')
					.setRequired(true)
					.addChoices(
						{ name: 'Small', value: 'small' },
						{ name: 'Medium', value: 'medium' },
						{ name: 'Large', value: 'large' }
				)
			)
			.addBooleanOption(option => option.setName('by-me')
				.setDescription('Privately show all of your approved submissions in this division')
				.setRequired(false)
			)
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('ace')
			.setDescription('Select an Ace scoring')
			.addStringOption(option => option.setName('shipclass')
					.setDescription('Ship Class')
					.setRequired(true)
					.addChoices(
						{ name: 'Alliance Challenger', value: 'Challenger' },
						{ name: 'Alliance Chieftain', value: 'Chieftain' },
						{ name: 'Fer-de-Lance', value: 'Fdl' },
						{ name: 'Krait Mk II', value: 'Kraitmk2' }
				)
			)
	)
	.addSubcommand(subcommand =>
		subcommand
			.setName('website')
			.setDescription('View website Leaderboard')
	) 
	,
	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand()
		const byMe = subcommand === 'speedrun' && interaction.options.getBoolean('by-me') === true
		await interaction.deferReply(byMe ? { flags: Discord.MessageFlags.Ephemeral } : {});
		if (subcommand === 'website') {
			const embed = new Discord.EmbedBuilder()
				.setColor('#FF7100')
				.setTitle(`**Leaderboards**`)
				.setDescription(`Check out our famous group of Commanders that have taken the Thargoid culing to the next level!`)
				.addFields(
					{
						name: `Website Link:`, 
						value: `🏆 https://antixenoinitiative.com/?page_id=338`, inine: false 
					},
				)
				.setTimestamp()
			await interaction.editReply({ embeds: [embed] })
		}
		if (subcommand === 'speedrun') {
			const variant = interaction.options.getString('variant', true)
			const shipClass = interaction.options.getString('shipclass', true)
			try {
				const response = await listSpeedrunBoard(variant, shipClass)
				if (byMe) {
					return interaction.editReply(createPersonalSpeedrunHistory({
						guildId: interaction.guildId,
						ownerUserId: interaction.user.id,
						variant,
						shipClass,
						rows: response,
					}))
				}
				const topTen = response.slice(0, 10)
				if (topTen.length > 0) {
					const embeds = topTen.map((entry, index) => (
						buildSpeedrunEmbed(entry, index + 1, variant, shipClass)
					))
					await sendLeaderboardEmbeds(interaction, embeds)
				} else {
					await interaction.editReply({ content: 'No speedrun records were found for that variant and ship class.' })
				}
			}
			catch (err) {
				report.error('Speedrun board load failed', err, { variant, shipClass })
				await interaction.editReply({ content: 'Unable to load the speedrun leaderboard right now. Please try again later.' })
				logLeaderboardError(interaction, err)
			}
		}
		if (subcommand === 'ace') {
			const discordConvert = {
				"shipClass": interaction.options.getString('shipclass', true),
			}
			try {
				const response = await listAceBoard(discordConvert.shipClass)
				if (response.length > 0) {
					let embeds = []
					response.forEach((i,index) => {
						
						const embed = new Discord.EmbedBuilder()
							.setColor('#FF7100')
							.setTitle(`**Ace ${discordConvert.shipClass}**`)
							.setDescription(`**#${index + 1}** in Division`)
							.addFields(
								{
									name: `${i.name}`, 
									value: `
										**Score:**  ${i.score}\r
										**Time Taken:** ${timeConvertTT(i.timetaken)}\r
										**# Small Gauss (fired):**  ${i.sgauss} (${i.sgaussfired})\r
										**# Medium Gauss (fired):**  ${i.mgauss} (${i.mgaussfired})\r
										**% Hull Lost:**  ${i.percenthulllost}\r
										**Date Submitted:** ${timeConvertDS(i.date)}\r
										**Link:** ${i.link}
									`, inine: false 
								},
							)
							.setTimestamp()
						embeds.push(embed)
					})
					await sendLeaderboardEmbeds(interaction, embeds, "For those who go beyond. This rank is a true test of a pilot’s abilities, based on a composite score of *ammo usage*, *total damage taken*, and *time taken*. Use a one of the four ships below and any combination of Gauss cannons to defeat a Medusa. Learn more about this rank in the #rank-requirements channel.")
				} else {
					await interaction.editReply({ content: 'No ace records were found for that ship class.' })
				}
			}
			catch (err) {
				report.error('Ace board load failed', err, { shipClass: discordConvert.shipClass })
				await interaction.editReply({ content: 'Unable to load the ace leaderboard right now. Please try again later.' })
				logLeaderboardError(interaction, err)
			}

		}
	}
}
