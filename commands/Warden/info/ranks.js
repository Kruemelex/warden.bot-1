const Discord = require("discord.js");
const config = require('../../../config.json');
const { botLog,botIdent } = require('../../../functions');

function getRanks(ranktype, roleCache, memberCounts) {
	if (!config[botIdent().activeBot.botName].ranksCommand[ranktype]) throw new Error(`Invalid rank type: ${ranktype}`);
	const ranks = config[botIdent().activeBot.botName].ranksCommand[ranktype];
		
	let rankData = [];
	for(const rank of ranks) {		
		const role = roleCache.find(role => role.name === rank);
		if (!role) continue;
		rankData.push({name: rank, value: String(memberCounts.get(role.id) ?? 0), inline: true});
	}

	return rankData;
}

module.exports = {
	data: new Discord.SlashCommandBuilder()
	.setName('ranks')
	.setDescription('Get rank statistics'),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions:0,
	async execute(message) {

		// Build the initial message
		const roleCache = message.guild.roles.cache;

		const row = new Discord.ActionRowBuilder()
			.addComponents(new Discord.ButtonBuilder().setCustomId('challenge').setLabel('Challenge Ranks').setStyle(Discord.ButtonStyle.Primary),)
			.addComponents(new Discord.ButtonBuilder().setCustomId('competitive').setLabel('Competitive Ranks').setStyle(Discord.ButtonStyle.Primary),)
			.addComponents(new Discord.ButtonBuilder().setCustomId('progression').setLabel('Progression Ranks').setStyle(Discord.ButtonStyle.Primary),)
			.addComponents(new Discord.ButtonBuilder().setCustomId('other').setLabel('Other Ranks').setStyle(Discord.ButtonStyle.Primary),)
		await message.reply({ content: "Select which ranks to list:", components: [row], flags: Discord.MessageFlags.Ephemeral });
		let memberCountsPromise;
		const getMemberCounts = () => {
			if (!memberCountsPromise) {
				memberCountsPromise = message.guild.roles.fetchMemberCounts()
					.catch((error) => {
						memberCountsPromise = undefined;
						throw error;
					});
			}
			return memberCountsPromise;
		};

		// Recieve the button response 
		const filter = i => i.user.id === message.member.id;
		const collector = message.channel.createMessageComponentCollector({ filter, time: 15000 });
		collector.on('collect', async i => {
			if (i.customId === 'challenge') {
				try {
					await i.deferUpdate();
					const rankData = getRanks("challenge_ranks", roleCache, await getMemberCounts());
					const returnEmbed = new Discord.EmbedBuilder()
						.setColor('#FF7100')
						.setTitle("**Challenge Ranks**")
						.setDescription(`Challenge Rank Statistics`)
						.addFields(rankData);
					i.channel.send({ embeds: [returnEmbed.setTimestamp()] });
				} catch (err) {
					console.error(err);
					i.channel.send({ content: `Something went wrong. Error: ${err}` });
					botLog(i.guild,new Discord.EmbedBuilder()
						.setDescription('```' + err.stack + '```')
						.setTitle(`⛔ Fatal error experienced`)
						,2
						,'error'
					)
				}
			}
			if (i.customId === 'competitive') {
				try {
					await i.deferUpdate();
					const rankData = getRanks("competitive_ranks", roleCache, await getMemberCounts());
					const returnEmbed = new Discord.EmbedBuilder()
						.setColor('#FF7100')
						.setTitle("**Competitive Ranks**")
						.setDescription(`Competitive a Statistics`)
						.addFields(rankData);
					i.channel.send({ embeds: [returnEmbed.setTimestamp()] });
				} catch (err) {
					console.error(err);
					i.channel.send({ content: `Something went wrong. Error: ${err}` });
					botLog(i.guild,new Discord.EmbedBuilder()
						.setDescription('```' + err.stack + '```')
						.setTitle(`⛔ Fatal error experienced`)
						,2
						,'error'
					)
				}
			}
			if (i.customId === 'progression') {
				try {
					await i.deferUpdate();
					const rankData = getRanks("progression_ranks", roleCache, await getMemberCounts());
					const returnEmbed = new Discord.EmbedBuilder()
						.setColor('#FF7100')
						.setTitle("**Progression Ranks**")
						.setDescription(`Progression Rank Statistics`)
						.addFields(rankData);
					i.channel.send({ embeds: [returnEmbed.setTimestamp()] });
				} catch (err) {
					console.error(err);
					i.channel.send(`Something went wrong. Error: ${err}`);
					botLog(i.guild,new Discord.EmbedBuilder()
						.setDescription('```' + err.stack + '```')
						.setTitle(`⛔ Fatal error experienced`)
						,2
						,'error'
					)
				}
			}
			if (i.customId === 'other') {
				try {
					await i.deferUpdate();
					const rankData = getRanks("other_ranks", roleCache, await getMemberCounts());
					const returnEmbed = new Discord.EmbedBuilder()
						.setColor('#FF7100')
						.setTitle("**Other Ranks**")
						.setDescription(`Other Rank Statistics`)
						.addFields(rankData);
					i.channel.send({ embeds: [returnEmbed.setTimestamp()] });
				} catch (err) {
					console.error(err);
					i.channel.send({ content: `Something went wrong. Error: ${err}` });
					botLog(i.guild,new Discord.EmbedBuilder()
						.setDescription('```' + err.stack + '```')
						.setTitle(`⛔ Fatal error experienced`)
						,2
						,'error'
					)
				}
			}
		});

		collector.on('end', collected => console.log(`Collected ${collected.size} items`));
	}
}
