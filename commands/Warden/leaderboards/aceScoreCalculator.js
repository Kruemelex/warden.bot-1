'use strict';

const Score = require('../math/commons/scoring');
const damageThresholds = require('../math/data/dmgThresholds.json');
const shipDataTable = require('../math/data/shipData.json');

const ACE_AMMO_TYPES = Object.freeze(['basic', 'standard', 'premium']);

function calculateAceScore(args) {
    const shipData = shipDataTable[args.shiptype];
    if (!shipData) throw new Error('Please select a valid Ace ship.');
    if (!ACE_AMMO_TYPES.includes(args.ammo)) throw new Error('Please select a valid ammunition type.');

    args.targetRun = 100;
    args.interceptor = shipData.interceptor;
    args.scoring = shipData.scoring;

    const damageThreshold = damageThresholds[args.interceptor]?.[args.ammo]
        ?.[args.gauss_medium_number]?.[args.gauss_small_number];
    const damageThresholdBasic = damageThresholds[args.interceptor]?.basic
        ?.[args.gauss_medium_number]?.[args.gauss_small_number];
    if (!Number.isFinite(damageThreshold) || !Number.isFinite(damageThresholdBasic)) {
        throw new Error('That Gauss configuration is not supported by the Ace calculator.');
    }
    args.damage_threshold = damageThreshold;

    let damageMultiplier = 1.01;
    let ammoDamageMultiplier = 1;
    if (args.interceptor === 'Medusa') damageMultiplier *= 140 / 175;
    if (args.interceptor === 'Hydra') damageMultiplier *= 140 / 220;
    if (args.ammo === 'standard') {
        damageMultiplier *= 1.15;
        ammoDamageMultiplier *= 1.15;
    }
    if (args.ammo === 'premium') {
        damageMultiplier *= 1.3;
        ammoDamageMultiplier *= 1.3;
    }

    const shotDamageFired = (
        args.shots_medium_fired * 35
        + args.shots_small_fired * 20
    ) * damageMultiplier;
    args.shot_damage_fired = shotDamageFired;

    const salvoDamage = 1.01 * (
        args.gauss_medium_number * 35
        + args.gauss_small_number * 20
    );
    args.extraTime = 1.5 * (2.05 / salvoDamage)
        * (damageThresholdBasic - damageThreshold / ammoDamageMultiplier);
    args.hullLossMultiplier = damageThresholdBasic * ammoDamageMultiplier / damageThreshold;

    return {
        args,
        shipData,
        damageThreshold,
        damageThresholdBasic,
        damageMultiplier,
        ammoDamageMultiplier,
        shotDamageFired,
        result: Score.score_this(args),
    };
}

module.exports = {
    ACE_AMMO_TYPES,
    calculateAceScore,
    shipDataTable,
};
