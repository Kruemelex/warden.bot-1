const { botLog, botIdent  } = require('../../../functions');
const database = require(`../../../${botIdent().activeBot.botName}/db/database`)
const Discord = require("discord.js");


/* eslint-disable no-bitwise */
const { testInputs } = require('../math/commons/testInput')
const { getChart } = require('../math/commons/getChart')
const { calculateAceScore, shipDataTable } = require('./aceScoreCalculator')
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
                let staffChannel = getLeaderboardApprovalChannelId(interaction.guildId)
                let submissionId = null
                let insertAttempted = false
        
                // Checks
                // console.log(staffChannel);
                if (!args.submit_url.startsWith('https://')) {
                    return interaction.editReply({ content: `❌ Please enter a valid URL, eg: https://...` })
                }
        
                // Submit
                if(!staffChannel || interaction.guild.channels.cache.get(staffChannel) === undefined)  { // Check for staff channel
                    return interaction.editReply({ content: `Staff Channel not found` })
                }
                try {
                    const values = [userID]
                    const sql = 'SELECT * FROM `ace` WHERE user_id = (?) AND approval = 1';
                    const response = await queryWithRetry(sql, values)
                    if (response.length > 0) {
                        if (parseFloat(response[0].score) > parseFloat(result.score.toFixed(2))) {
                            return interaction.editReply({ content: `⛔ Error: Your existing entry has a higher score, submission denied.` })
                        }
                    }

                    const submission_values = [
                        userID,
                        name,
                        args.time_in_seconds,
                        args.gauss_medium_number,
                        args.gauss_small_number,
                        args.shots_medium_fired,
                        args.shots_small_fired,
                        args.percenthulllost,
                        result.score.toFixed(2),
                        args.submit_url,
                        false,
                        timestamp,
                        args.shiptype
                    ]
                    const submission_sql = `
                        INSERT INTO ace (user_id, name, timetaken, mgauss, sgauss, mgaussfired, sgaussfired, percenthulllost,score, link, approval, date, shiptype) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?);
                    `;
                    insertAttempted = true
                    try {
                        const insertResult = await database.query(submission_sql, submission_values)
                        submissionId = insertResult.insertId
                    }
                    catch (error) {
                        if (!isTransientDatabaseError(error)) throw error

                        const recoveryRows = await queryWithRetry(
                            `SELECT id FROM \`ace\`
                            WHERE user_id = (?) AND approval = 0 AND date = (?)
                                AND score = (?) AND link = (?) AND shiptype = (?)
                            ORDER BY id DESC LIMIT 1`,
                            [userID, timestamp, result.score.toFixed(2), args.submit_url, args.shiptype],
                        )
                        if (recoveryRows.length === 0) throw error
                        submissionId = recoveryRows[0].id
                        console.warn(`Recovered Ace submission #${submissionId} after a timed-out INSERT response.`)
                    }

                    if (!Number.isSafeInteger(Number(submissionId)) || Number(submissionId) <= 0) {
                        throw new Error('The Ace submission was inserted without a valid submission ID.')
                    }

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

                    let buttonResult = null;
                    buttonResult = await interaction.guild.channels.cache.get(staffChannel).send(buildApprovalMessage('ace', {
                        id: submissionId,
                        user_id: userID,
                        name,
                        timetaken: args.time_in_seconds,
                        mgauss: args.gauss_medium_number,
                        sgauss: args.gauss_small_number,
                        mgaussfired: args.shots_medium_fired,
                        sgaussfired: args.shots_small_fired,
                        percenthulllost: args.percenthulllost,
                        score: result.score,
                        link: args.submit_url,
                        shiptype: args.shiptype,
                    }));
                    const embedId = buttonResult.id
                    const submissionUpdate_values = [embedId,submissionId]
                    const submissionUpdate_sql = `UPDATE ace SET embed_id = (?) WHERE id = (?);`
                    await queryWithRetry(submissionUpdate_sql, submissionUpdate_values)

                    await interaction.channel.send({ embeds: [submissionEmbed.setTimestamp()] })
                    await interaction.editReply({
                        content: `✅ Submission #${submissionId} recorded. It is now up for review by Staff.`,
                    }).catch((responseError) => {
                        console.error('Failed to send the Ace submission acknowledgement:', responseError)
                    })
                }
                catch (err) {
                    console.log(err)
                    void Promise.resolve().then(() => botLog(
                        interaction.guild,
                        new Discord.EmbedBuilder()
                            .setDescription('```' + err.stack + '```')
                            .setTitle(`⛔ Ace submission failed`),
                        2,
                        'error',
                    )).catch((logError) => console.error('Failed to log Ace submission error:', logError))

                    const content = submissionId
                        ? `⚠️ Submission #${submissionId} was recorded, but Warden could not finish posting all confirmation messages. Please do not resubmit it; contact Staff.`
                        : insertAttempted
                            ? '⚠️ Warden could not confirm whether the submission was recorded. Please avoid resubmitting immediately and contact Staff.'
                            : '❌ Warden could not create the submission. Please try again or contact Staff.'
                    return interaction.editReply({ content }).catch((responseError) => {
                        console.error('Failed to send the Ace submission error response:', responseError)
                    })
                }
            }
        }
    }
}
