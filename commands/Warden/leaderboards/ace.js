const { botLog } = require('../../../functions');
const Discord = require("discord.js");


/* eslint-disable no-bitwise */
const { testInputs } = require('../math/commons/testInput')
const { getChart } = require('../math/commons/getChart')
const { calculateAceScore, shipDataTable } = require('./aceScoreCalculator')
const { findAceApproved } = require('../../../Warden/db/leaderboards/repository')
const { createLeaderboardSubmission, publishLeaderboardSubmissionConfirmation } = require('./leaderboardSubmission')
const { assertLeaderboardSubmissionAllowed, isLeaderboardAvailabilityError } = require('../../../Warden/leaderboards/policy')
const { createConsoleReporter } = require('../../../logging/consoleReporting')

const report = createConsoleReporter('Leaderboard').forSubsystem('Commands')
/*
Damage threshold entry:
"Interceptor name" : {
	"basic" : double array - damage thresholds w/ basic ammo [#med][#small],
	"standard" : double array - damage thresholds w/ standard ammo [#med][#small],
	"premium" : double array - damage thresholds w/ premium ammo [#med][#small]
}
*/
/*
Ship data entry:
"ship_id" : {
	"name" : str - Ship name,
	"interceptor" : str - Target interceptor for ship,
	"small_hp" : int - # of small hardpoints,
	"total_hp" : int - # of total hardpoints,
	"scoring" : {
		"time" : float array [3] - time scoring [shape, 0 penalty time, "good", "entry level"],
		"hull" : float array [3] - hull scoring [shape, 0 penalty hull, "good", "entry level"],
		"ammo" : float array [3] - ammo scoring [shape, 0 penalty ammo, "good", "entry level"] (note 1/efficiency!)
	}
}
*/


let options = new Discord.SlashCommandBuilder()
.setName('ace')
.setDescription('Score your fight based on the revised Ace Scoring System')
.addStringOption(option => option.setName('shiptype')
    .setDescription('Ship you used')
    .setRequired(true)
)
.addIntegerOption(option => option.setName('gauss_medium_number')
    .setDescription('Number of MEDIUM gauss cannons outfitted')
    .setRequired(true))
.addIntegerOption(option => option.setName('shots_medium_fired')
    .setDescription('Total number of MEDIUM gauss ammo rounds fired')
    .setRequired(true))
.addIntegerOption(option => option.setName('gauss_small_number')
    .setDescription('Number of SMALL gauss cannons outfitted')
    .setRequired(true))
.addIntegerOption(option => option.setName('shots_small_fired')
    .setDescription('Total number of SMALL gauss ammo rounds fired')
    .setRequired(true))
.addStringOption(option => option.setName('ammo')
    .setDescription('Ammo type used - standard and premium will incur time and hull penalties')
    .setRequired(true)
    .addChoices(
	{ name: 'Basic', value: 'basic' },
	{ name: 'Standard', value: 'standard' },
	{ name: 'Premium', value: 'premium' },
     ))
.addIntegerOption(option => option.setName('time_in_seconds')
    .setDescription('Time taken in Seconds')
    .setRequired(true))
.addIntegerOption(option => option.setName('percenthulllost')
    .setDescription('Total percentage of hull lost in fight (incl. repaired with limpets)')
    .setRequired(true))
.addBooleanOption(option => option.setName('print_score_breakdown')
    .setDescription('Print a score breakdown, in addition to the overall score')
    .setRequired(false))
.addBooleanOption(option => option.setName('scorelegend')
    .setDescription('Print a description of how to interpret a score')
    .setRequired(false))
.addStringOption(option => option.setName('submit_url')
    .setDescription('Do you want to submit your score for formal evaluation? If so, please also include a video link')
    .setRequired(false))
	
// Add ship choices based on data read from shipData.json
for (let key of Object.keys(shipDataTable)){
	options.options[0].addChoices({name: `${shipDataTable[key].name} (vs ${shipDataTable[key].interceptor})`, value: key})
}
	
module.exports = {
    data: options,
	permissions: 0,
    async execute(interaction) {

        // Arg Handling
        let args = {}
        for (let key of interaction.options.data) {
            args[key.name] = key.value
        }

        const submissionRequested = args.submit_url !== undefined
        if (submissionRequested) {
            await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral })
			try { await assertLeaderboardSubmissionAllowed(interaction.guildId, 'ace') }
			catch (error) { return interaction.editReply({ content: `⏳ ${error.message}` }) }
        }
        const replyPrivately = (content) => submissionRequested
            ? interaction.editReply({ content })
            : interaction.reply({ content, flags: Discord.MessageFlags.Ephemeral })

        // Set Globals
        args.targetRun = 100;

        // Set Defaults
        if (args.scorelegend === undefined) { args.scorelegend = false }
        if (args.print_score_breakdown === undefined) { args.print_score_breakdown = false }

        // Test Inputs
        let testPassed = testInputs(args, interaction)
        if (testPassed != true) {
            await replyPrivately(testPassed)
            return
        }
	    
        // Get ship related data
        let shipData = shipDataTable[args.shiptype];
        args.interceptor = shipData.interceptor;
        args.scoring = shipData.scoring;

        // Construct weapons string
        let weaponsString = ``;
        if (args.gauss_medium_number > 0)
            weaponsString += `${args.gauss_medium_number.toFixed(0)} medium gauss`;
        if (args.gauss_medium_number > 0 && args.gauss_small_number > 0)
            weaponsString += ` and `;
        if (args.gauss_small_number > 0)
            weaponsString += `${args.gauss_small_number.toFixed(0)} small gauss`;

        // Ship related checks

        // Check that gauss configuration can be fitted
        let totalfit = shipDataTable[args.shiptype].total_hp;
        let medfit = totalfit - shipDataTable[args.shiptype].small_hp;
        // Mediums can be fitted
        if (args.gauss_medium_number > medfit){
            await replyPrivately(`Your poor ${shipDataTable[args.shiptype].name} cannot fit ${args.gauss_medium_number} medium gauss.`);
            return
        }
        if (args.gauss_medium_number + args.gauss_small_number > totalfit){
            await replyPrivately(`Howerver hard you may try, it is impossible to fit ${weaponsString} in that ${shipDataTable[args.shiptype].name} ...`);
            return
        }

        const calculation = calculateAceScore(args)
        const damageThreshold = calculation.damageThreshold
        const shot_damage_fired = calculation.shotDamageFired

        // Avoid funnies with >100% accuracy fake submissions
        // Allow funnies if Aran is involved
        if (shot_damage_fired.toFixed(2) < damageThreshold) {
            if(interaction.member.id === "346415786505666560"){ // 346415786505666560 - Aran
                await replyPrivately(`Thank you ${interaction.member} for breaking my accuracy calculations again! Please let me know where I have failed, and I will fix it - CMDR Mechan`);
            } else {
                await replyPrivately(`Comrade ${interaction.member} ... It appears your entry results (${shot_damage_fired}) vs (${damageThreshold}) in greater than 100% accuracy. Unfortunately [PC] CMDR Aranionros Stormrage is the only one allowed to achieve >100% accuracy. Since you are not [PC] CMDR Aranionros Stormrage, please check your inputs and try again.`);
            }
            return(-1);
        }

        const result = calculation.result
        const goidType = args.interceptor
        const targetRun = args.targetRun
        const extraTime = args.extraTime
        const hullLossMultiplier = args.hullLossMultiplier


        // Create Chart
        let url = getChart(result)
        
        // Print Results


        let outputString = `**__Thank you for requesting a Score calculation!__**

        This score has been calculated for ${interaction.member}'s solo fight of a ${args.shiptype} against a ${goidType}, taking a total of ${args.percenthulllost.toFixed(0)}% hull damage (including damage repaired with limpets, if any), in ${~~(args.time_in_seconds / 60)} minutes and ${args.time_in_seconds % 60} seconds.
        
        With ${weaponsString}, and using ${args.ammo} ammo, the minimum required damage done would have been ${damageThreshold.toFixed(0)}hp.
        
        ${interaction.member}'s use of ${shot_damage_fired.toFixed(0)}hp damage-of-shots-fired (${args.shots_medium_fired.toFixed(0)} medium rounds @ 28.28hp each and ${args.shots_small_fired.toFixed(0)} small rounds @ 16.16hp each) represents a **__${((damageThreshold / shot_damage_fired ).toFixed(4)*(100)).toFixed(2)}%__** ammo usage efficiency.\n`

        if (args.shots_medium_fired === 0 && args.gauss_medium_number > 0) {
                outputString += `\n\n**__WARNING__**: It appears you have medium gauss outfitted, but no medium gauss shots fired. Please make sure this is intended.`
        }

        if (args.shots_small_fired === 0 && args.gauss_small_number > 0) {
            outputString += `\n\n**__WARNING__**: It appears you have small gauss outfitted, but no small gauss shots fired. Please make sure this is intended.`
        }
            
        if(args.print_score_breakdown == true) {
                outputString += `---
                    **Base Score:** ${targetRun} Ace points
                    ---
                    **Time Taken Penalty:** ${(result.timePenalty/3).toFixed(2)} Ace points
                    **Ammo Used Penalty:** ${(result.ammoPenalty/3).toFixed(2)} Ace points
                    **Damage Taken Penalty:** ${(result.damagePenalty/3).toFixed(2)} Ace points
                    ---
					**Ammo time penalty:** ${extraTime.toFixed(2)} seconds
					**Ammo hull multiplier:** x ${hullLossMultiplier.toFixed(2)}
					---`
        }

        outputString += `\n**Your Fight Score:** **__${result.score.toFixed(2)}__** Ace points.`
        
        if(args.scorelegend == true) {
            outputString += `
                ---
                *Interpret as follows:*
                *- CMDRs at their first Medusa fight will typically score 0-10 pts (and will occasionally score well into the negative for fights that go sideways);*
                *- A collector-level CMDR will typically score about 25-45 pts;*
                *- A Herculean Conqueror / early-challenge-rank CMDR will typically score about 45-65 (on a good run);* 
                *- An advanced challenge-level CMDR will typically score about 65-85 (on a good run);*
                *- Please note that scores of different ships cannot be compared with each other!*`
        }

        const returnEmbed = new Discord.EmbedBuilder()
        .setColor('#FF7100')
        .setTitle("**Ace Score Calculation**")
        .setDescription(`${outputString}`)
        .setImage(url)

        const buttonRow = new Discord.ActionRowBuilder()
        .addComponents(new Discord.ButtonBuilder().setLabel('Learn more about the Ace Score Calculator').setStyle(Discord.ButtonStyle.Link).setURL('https://wiki.antixenoinitiative.com/en/Ace-Rank-Rework'),)

        if (!submissionRequested) {
            await interaction.reply({ embeds: [returnEmbed.setTimestamp()], components: [buttonRow] });
        } else {
            await ace_submit(args, result, interaction)
            // console.log("Submission triggered");
            async function ace_submit(args, result, interaction) {
                let userID = interaction.member.id
                let name = interaction.member.displayName
                let timestamp = Date.now()
                let submissionId = null
        
                // Checks
                // console.log(staffChannel);
                if (!args.submit_url.startsWith('https://')) {
                    return interaction.editReply({ content: `❌ Please enter a valid URL, eg: https://...` })
                }
        
                // Submit
                try {
                    const previousEntry = await findAceApproved(userID)
                    if (previousEntry) {
                        if (parseFloat(previousEntry.score) > parseFloat(result.score.toFixed(2))) {
                            return interaction.editReply({ content: `⛔ Error: Your existing entry has a higher score, submission denied.` })
                        }
                    }

                    const created = await createLeaderboardSubmission(interaction, 'ace', {
                        user_id: userID, name, timetaken: args.time_in_seconds,
                        mgauss: args.gauss_medium_number, sgauss: args.gauss_small_number,
                        mgaussfired: args.shots_medium_fired, sgaussfired: args.shots_small_fired,
                        percenthulllost: args.percenthulllost, score: result.score.toFixed(2),
                        link: args.submit_url, approval: 0, date: timestamp, shiptype: args.shiptype,
                    })
                    const stored = created.submission
                    submissionId = stored.id

                    const submissionEmbed = new Discord.EmbedBuilder()
                        .setColor('#FF7100')
                        .setTitle(`**Ace Submission Complete**`)
                        .setDescription(`Congratulations <@${interaction.member.id}>, your submission is complete. Please be patient while our staff approve your submission. Submission ID: #${submissionId}`)
                        .addFields(
                            {name: "Pilot", value: `<@${userID}>`, inline: true},
                            {name: "Ship", value: `${args.shiptype}`, inline: true},
                            {name: "Score", value: `${result.score.toFixed(2)}`, inline: true},
                            {name: "link", value: `${args.submit_url}`, inline: true}
                        )

                    await publishLeaderboardSubmissionConfirmation(
                        interaction,
                        created,
                        submissionEmbed.setTimestamp(),
                    )
                }
                catch (err) {
					if (isLeaderboardAvailabilityError(err)) {
						return interaction.editReply({ content: `⏳ ${err.message}` })
					}
					report.error('Ace submission failed', err, { submissionId })
                    void Promise.resolve().then(() => botLog(
                        interaction.guild,
                        new Discord.EmbedBuilder()
                            .setDescription('```' + err.stack + '```')
                            .setTitle(`⛔ Ace submission failed`),
                        2,
                        'error',
                    )).catch((logError) => report.error('Discord error report failed', logError, { submissionId }))

                    const recordedId = submissionId ?? err.submissionId
                    const content = recordedId
                        ? `⚠️ Submission #${recordedId} was recorded, but Warden could not finish posting all confirmation messages. Please do not resubmit it; contact Staff.`
                        : '❌ Warden could not create the submission. Please try again or contact Staff.'
                    return interaction.editReply({ content }).catch((responseError) => {
                        report.error('Ace error response failed', responseError, { submissionId: recordedId })
                    })
                }
            }
        }
    }
}
