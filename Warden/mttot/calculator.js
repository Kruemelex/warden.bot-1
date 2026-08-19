'use strict';

const Discord = require('discord.js');
const weapons = require('../../commands/Warden/math/data/weapons.json');
const interceptors = require('../../commands/Warden/math/data/interceptors.json');
const { resolveMttotEmbedAuthor } = require('./identity');

const WEAPON_CODE_PATTERN = /([0-9]+)([a-z]+)/g;
const MAX_ITERATION = 1_000_000;

function codeAlias(code) {
    switch (code) {
        case 'mgauss':
        case 'm':
            return 'mfgc';
        case 'sgauss':
        case 's':
            return 'sfgc';
        case 'modshard':
        case 'msc':
        case 'ms':
            return 'mfmsc';
        case 'modplasma':
        case 'mpc':
        case 'mp':
            return 'mfmpc';
        default:
            return code;
    }
}

function mttotFeedback(mttot) {
    if (mttot === Number.POSITIVE_INFINITY) return 'Insufficient DPS';
    if (mttot >= 120) return `☠️ ${mttot.toFixed(2)} s`;
    if (mttot >= 60) return `🟥 ${mttot.toFixed(2)} s`;
    if (mttot >= 45) return `🟧 ${mttot.toFixed(2)} s`;
    if (mttot >= 30) return `🟨 ${mttot.toFixed(2)} s`;
    return `🟩 ${mttot.toFixed(2)} s`;
}

function parseWeaponCodes(codeString) {
    const hardpoints = {};
    let outputString = '';
    let warningString = '';
    for (const match of String(codeString ?? '').matchAll(WEAPON_CODE_PATTERN)) {
        outputString += `\nWeapon code found: ${match[0]} -> ${match[1]} - ${match[2]}`;
        const code = codeAlias(match[2]);
        if (code in hardpoints) {
            hardpoints[code] += Number.parseInt(match[1], 10);
            warningString += `\nNOTE: Code _\`${code}\`_ used multiple times. Adding numbers.`;
        } else {
            hardpoints[code] = Number.parseInt(match[1], 10);
        }
    }
    return { hardpoints, outputString, warningString };
}

function simulateMttot({ interceptorName, weaponCodes, range = 0, accuracy = 100, verbose = false }) {
    const interceptor = interceptors[interceptorName];
    if (!interceptor) throw new Error('Please select a valid Interceptor variant.');
    if (accuracy > 100 || accuracy < 0) {
        throw new Error(`${accuracy}% is not a valid accuracy. Value must be in range 0-100.`);
    }
    if (range < 0) throw new Error(`Range cannot be negative (inserted value: ${range} m).`);

    const parsed = parseWeaponCodes(weaponCodes);
    const hardpoints = parsed.hardpoints;
    let outputString = parsed.outputString;
    let warningString = parsed.warningString;
    let weaponsString = '';
    const hardpointState = {};
    let dpsb = 0.0;
    let dpss = 0.0;
    let dpsp = 0.0;
    const accuracyMult = accuracy / 100.0;

    // This simulation is intentionally the legacy /mttot algorithm copied
    // into the experimental command. Do not tune or restructure its math.
    for (const key of Object.keys(hardpoints)) {
        if (key in weapons) {
            const number = hardpoints[key];
            weaponsString += `\n${number}x ${weapons[key].name} (**\`${number}${key}\`**)`;
            hardpointState[key] = { ...weapons[key] };
            const rangeMultPre = (hardpointState[key].maxrange - range)
                / (hardpointState[key].maxrange - hardpointState[key].falloff);
            const rangeMult = rangeMultPre > 1.0 ? 1.0 : (rangeMultPre < 0.0 ? 0.0 : rangeMultPre);
            const armorMitigation = interceptor.armor < hardpointState[key].ap
                ? 1.0
                : hardpointState[key].ap / interceptor.armor;
            hardpointState[key].number = number;
            hardpointState[key].nextFire = 0.0;
            hardpointState[key].Nsequence = 0;
            hardpointState[key].Msequence = 0;
            hardpointState[key].Nfired = 0;
            hardpointState[key].sequenceLength = weapons[key].pattern.length;
            hardpointState[key].damage_bsc = number * accuracyMult * rangeMult * armorMitigation
                * (weapons[key].axdamage + 0.01 * weapons[key].humdamage);
            hardpointState[key].damage_std = hardpointState[key].damage_bsc * weapons[key].stdmult;
            hardpointState[key].damage_prm = hardpointState[key].damage_bsc * weapons[key].premult;

            let cycle = 0.0;
            let cycleShots = 0;
            for (const point of hardpointState[key].pattern) {
                cycle += point[0] * point[1];
                cycleShots += point[0];
            }
            dpsb += cycleShots * hardpointState[key].damage_bsc / cycle;
            dpss += cycleShots * hardpointState[key].damage_std / cycle;
            dpsp += cycleShots * hardpointState[key].damage_prm / cycle;
        } else {
            warningString += `\nWARNING: Hardpoint type _\`${key}\`_ unrecognized -- Ignored (type _\`/codes\`_ for help)`;
        }
    }

    let mttotBsc;
    let mttotStd;
    let mttotPre;
    let exertBsc = false;
    let exertStd = false;
    let exertPre = false;
    let damageBsc = 0.0;
    let damageStd = 0.0;
    let damagePre = 0.0;
    let iterations = 0;

    if (dpsb < interceptor.regen) {
        mttotBsc = Number.POSITIVE_INFINITY;
        exertBsc = true;
    }
    if (dpss < interceptor.regen) {
        mttotStd = Number.POSITIVE_INFINITY;
        exertStd = true;
    }
    if (dpsp < interceptor.regen) {
        mttotPre = Number.POSITIVE_INFINITY;
        exertPre = true;
    }
    outputString += `\nDPS values:\n Basics: ${dpsb}\n Standard: ${dpss}\n Premium: ${dpsp}\nRegen: ${interceptor.regen}`;

    const hardpointKeys = Object.keys(hardpointState);
    while ((!exertBsc || !exertStd || !exertPre) && iterations < MAX_ITERATION) {
        iterations += 1;
        let minTime = Number.POSITIVE_INFINITY;
        let firing;
        for (const hardpoint of hardpointKeys) {
            if (minTime > hardpointState[hardpoint].nextFire) {
                minTime = hardpointState[hardpoint].nextFire;
                firing = hardpoint;
            }
        }
        const current = hardpointState[firing];
        damageBsc += current.damage_bsc;
        damageStd += current.damage_std;
        damagePre += current.damage_prm;
        hardpointState[firing].nextFire = minTime + current.pattern[current.Nsequence][1];
        hardpointState[firing].Msequence = (current.Msequence + 1) % current.pattern[current.Nsequence][0];
        if (hardpointState[firing].Msequence === 0) {
            hardpointState[firing].Nsequence = (current.Nsequence + 1) % current.sequenceLength;
        }
        hardpointState[firing].Nfired += 1;

        const toExert = minTime * interceptor.regen + interceptor.exert_hull;
        if (!exertPre && damagePre >= toExert) {
            exertPre = true;
            mttotPre = minTime;
        }
        if (exertPre && !exertStd && damageStd >= toExert) {
            exertStd = true;
            mttotStd = minTime;
        }
        if (exertStd && !exertBsc && damageBsc >= toExert) {
            exertBsc = true;
            mttotBsc = minTime;
        }
    }

    if (warningString.length > 0) warningString = `_${warningString}_`;
    const rangeString = range === 0 ? 'point blank' : `${range} m`;
    return {
        accuracy,
        diagnosticOutputString: outputString,
        interceptor,
        iterations,
        limitReached: iterations === MAX_ITERATION,
        outputString: verbose ? outputString : '',
        rangeString,
        results: { basic: mttotBsc, standard: mttotStd, premium: mttotPre },
        warningString,
        weaponsString,
    };
}

function buildMttotEmbed(simulation, member, user, color = '#FF7100') {
    const identity = resolveMttotEmbedAuthor();
    return new Discord.EmbedBuilder()
        .setColor(color)
        .setTitle('**MTTOT Simulator**')
        .setDescription(
            `Minimum simulated time on target for **${simulation.interceptor.name}** variant, `
            + `**${simulation.accuracy}%** accuracy, **${simulation.rangeString}** range, `
            + `using:**${simulation.weaponsString}**${simulation.warningString}${simulation.outputString}`
        )
        .addFields(
            { name: 'Basic', value: mttotFeedback(simulation.results.basic), inline: true },
            { name: 'Standard', value: mttotFeedback(simulation.results.standard), inline: true },
            { name: 'Premium', value: mttotFeedback(simulation.results.premium), inline: true },
        )
        .setAuthor({
            name: member?.nickname ?? member?.displayName ?? user?.displayName ?? user?.username ?? 'Commander',
            iconURL: user?.displayAvatarURL?.({ dynamic: true }),
        })
        .setFooter({ text: identity.name, iconURL: identity.iconURL })
        .setTimestamp();
}

module.exports = {
    MAX_ITERATION,
    buildMttotEmbed,
    codeAlias,
    mttotFeedback,
    parseWeaponCodes,
    simulateMttot,
};
