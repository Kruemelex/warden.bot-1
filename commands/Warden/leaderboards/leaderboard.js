const Discord = require("discord.js")
const { botLog } = require('../../../functions');
const { listAceBoard, listSpeedrunBoard } = require('../../../Warden/db/leaderboards/repository')
const { isLeaderboardMigrationMode } = require('../../../Warden/db/leaderboards/migrationGuard')
function capitalizeFirstLetter(str) {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
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
			.catch(logError => console.log(logError))
	} catch (logError) {
		console.log(logError)
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
		await interaction.deferReply({ ephemeral: false });
		if (interaction.options.getSubcommand() !== 'website' && isLeaderboardMigrationMode()) {
			return interaction.editReply({ content: '⏳ Leaderboards are temporarily unavailable during maintenance.' })
		}
		if (interaction.options.getSubcommand() === 'website') { 
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
		if (interaction.options.getSubcommand() === 'speedrun') {
			const variant = interaction.options.getString('variant', true)
			const shipClass = interaction.options.getString('shipclass', true)
			const discordConvert = { 
				"thargoid": capitalizeFirstLetter(variant),
				"shipClass": capitalizeFirstLetter(shipClass),
			}
			try {
				const response = await listSpeedrunBoard(variant, shipClass)
				if (response.length > 0) {
					let embeds = []
					response.forEach((i,index) => {
						const hours = Math.floor(Number(i.time) / 3600)
						const minutes = Math.floor((Number(i.time) % 3600) / 60)
						const seconds = Number(i.time) % 60
						const embed = new Discord.EmbedBuilder()
							.setColor('#FF7100')
							.setTitle(`**Speedrun ${discordConvert.shipClass} ${discordConvert.thargoid}**`)
							.setDescription(`#${index + 1} in Division`)
							.addFields(
								// **Pilot:** <@${i.user_id}>\r
								{
									name: `---------------------------------`, 
									value: `
										**Pilot:** ${i.name}\r
										**Ship:**  ${i.ship}\r
										**Time:** ${hours}h ${minutes}m ${seconds}s ${i.milliseconds}ms\r
										**Seconds.Milliseconds:** ${i.time}.${i.milliseconds}\r
										**Date:** ${timeConvertDS(i.date)}\r
										**Link:** ${i.link}
									`, inine: false 
								},
							)
							.setTimestamp()
						embeds.push(embed)
					})
					await sendLeaderboardEmbeds(interaction, embeds)
				} else {
					await interaction.editReply({ content: 'No speedrun records were found for that variant and ship class.' })
				}
			}
			catch (err) {
				console.log(err)
				await interaction.editReply({ content: 'Unable to load the speedrun leaderboard right now. Please try again later.' })
				logLeaderboardError(interaction, err)
			}
		}
		if (interaction.options.getSubcommand() === 'ace') {
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
				console.log(err)
				await interaction.editReply({ content: 'Unable to load the ace leaderboard right now. Please try again later.' })
				logLeaderboardError(interaction, err)
			}

		}
	}
}
