'use strict';

const Discord = require('discord.js');
const {
    buildExistingTextField,
    buildModalStringSelectField,
    buildModalUserSelectField,
    getModalSelectedUser,
    getModalTextInput,
    getRequiredModalSingleSelect,
} = require('../../../../Warden/ux/components/modalFields');
const { resolveOptimisticEdits } = require('../../../../Warden/ux/interactions/optimisticEdits');
const {
    ACE_AMMO_TYPES,
    calculateAceScore,
    shipDataTable,
} = require('../aceScoreCalculator');

const SPEEDRUN_VARIANTS = Object.freeze(['cyclops', 'basilisk', 'medusa', 'hydra']);
const SPEEDRUN_CLASSES = Object.freeze(['small', 'medium', 'large']);

function selectOptions(values, labels = {}) {
    return values.map((value) => ({ value, label: labels[value] ?? value }));
}

const ACE_SHIP_OPTIONS = Object.freeze(Object.entries(shipDataTable).map(([value, ship]) => ({
    value,
    label: ship.name,
    description: `vs ${ship.interceptor}`,
})));
const ACE_AMMO_OPTIONS = Object.freeze(selectOptions(ACE_AMMO_TYPES, {
    basic: 'Basic',
    standard: 'Standard',
    premium: 'Premium',
}));
const SPEEDRUN_VARIANT_OPTIONS = Object.freeze(selectOptions(SPEEDRUN_VARIANTS, {
    cyclops: 'Cyclops',
    basilisk: 'Basilisk',
    medusa: 'Medusa',
    hydra: 'Hydra',
}));
const SPEEDRUN_CLASS_OPTIONS = Object.freeze(selectOptions(SPEEDRUN_CLASSES, {
    small: 'Small',
    medium: 'Medium',
    large: 'Large',
}));

function textEdit(label, opening, current, submitted, normalize = (value) => String(value ?? '').trim()) {
    return { label, opening, current, submitted, normalize };
}

function numericEdit(label, opening, current, submitted) {
    return textEdit(label, opening, current, submitted, Number);
}

function integer(input, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!/^-?\d+$/.test(String(input).trim())) throw new Error(`${label} must be a whole number.`);
    const value = Number(input);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be between ${min} and ${max}.`);
    }
    return value;
}

function integerPair(input, firstLabel, secondLabel, limits = {}) {
    const match = String(input).match(/^\s*(-?\d+)\s*[/,]\s*(-?\d+)\s*$/);
    if (!match) throw new Error(`Enter ${firstLabel} / ${secondLabel}, for example \`120 / 15\`.`);
    return [
        integer(match[1], firstLabel, limits.first),
        integer(match[2], secondLabel, limits.second),
    ];
}

function validateText(value, label, maxLength) {
    const text = String(value ?? '').trim();
    if (!text) throw new Error(`${label} cannot be empty.`);
    if (text.length > maxLength) throw new Error(`${label} cannot exceed ${maxLength} characters.`);
    return text;
}

function validateLink(value) {
    const link = validateText(value, 'Link', 1000);
    if (!link.startsWith('https://')) throw new Error('Link must start with https://.');
    return link;
}

function validateAceScoreInputs(values) {
    if (values.mgauss + values.sgauss < 1 || values.mgauss + values.sgauss > 6) {
        throw new Error('Ace submissions require between 1 and 6 total Gauss modules.');
    }
    if (values.mgaussfired + values.sgaussfired > 1000) {
        throw new Error('Ace submissions cannot exceed 1,000 total Gauss rounds.');
    }
    if (values.mgaussfired > 0 && values.mgauss === 0) {
        throw new Error('Medium rounds cannot be entered with zero medium Gauss modules.');
    }
    if (values.sgaussfired > 0 && values.sgauss === 0) {
        throw new Error('Small rounds cannot be entered with zero small Gauss modules.');
    }
    const ship = shipDataTable[values.shiptype];
    if (!ship) throw new Error('Please select a valid Ace ship.');
    const mediumHardpoints = ship.total_hp - ship.small_hp;
    if (values.mgauss > mediumHardpoints || values.mgauss + values.sgauss > ship.total_hp) {
        throw new Error(`That Gauss configuration cannot fit on ${ship.name}.`);
    }
    const calculation = calculateAceScore({
        shiptype: values.shiptype,
        ammo: values.ammo,
        time_in_seconds: values.timetaken,
        percenthulllost: values.percenthulllost,
        gauss_medium_number: values.mgauss,
        gauss_small_number: values.sgauss,
        shots_medium_fired: values.mgaussfired,
        shots_small_fired: values.sgaussfired,
    });
    if (calculation.shotDamageFired.toFixed(2) < calculation.damageThreshold) {
        throw new Error('The entered rounds imply greater than 100% accuracy. Check the Gauss and ammo values.');
    }
    if (!Number.isFinite(calculation.result.score)) throw new Error('The Ace score could not be calculated from those values.');
    return calculation;
}

function editValues(edits) {
    return Object.fromEntries(Object.entries(edits).map(([column, edit]) => [column, edit.value]));
}

function selectedValue(interaction, customId, options, label) {
    return getRequiredModalSingleSelect(interaction, customId, options, label);
}

function createLeaderboardEditorDescriptors({ commitPendingEdits }) {
    if (typeof commitPendingEdits !== 'function') {
        throw new Error('Leaderboard editor descriptors require a pending-edit repository.');
    }

    return Object.freeze({
        identity: {
            action: 'identityModal',
            title: 'Edit Pilot',
            build: ({ object }) => ({
                fields: [
                    buildModalUserSelectField({
                        customId: 'user_id',
                        label: 'Discord User',
                        selectedUserId: object.user_id,
                    }),
                    buildExistingTextField({
                        customId: 'name',
                        label: 'Stored Leaderboard Name',
                        currentValue: object.name,
                        required: true,
                        maxLength: 100,
                    }),
                ],
                baseline: { user_id: String(object.user_id), name: String(object.name ?? '') },
            }),
            read: ({ interaction }) => {
                const user = getModalSelectedUser(interaction, 'user_id');
                if (!user?.id) throw new Error('Please select a valid Discord user.');
                return {
                    user_id: String(user.id),
                    name: validateText(getModalTextInput(interaction, 'name'), 'Stored Leaderboard Name', 100),
                };
            },
            resolve: ({ object, state, values }) => resolveOptimisticEdits({
                user_id: textEdit('Discord user', state.baseline.user_id, object.user_id, values.user_id),
                name: textEdit('stored name', state.baseline.name, object.name, values.name),
            }),
            commit: ({ context, object, edits }) => commitPendingEdits({ context, object, edits }),
        },
        speedrunRun: {
            action: 'speedrunRunModal',
            title: 'Edit Run Details',
            available: ({ context }) => context.leaderboard === 'speedrun' ? undefined : 'This editor is only available for Speedrun submissions.',
            build: ({ object }) => ({
                fields: [
                    buildExistingTextField({ customId: 'ship', label: 'Ship', currentValue: object.ship, required: true, maxLength: 100 }),
                    buildModalStringSelectField({ customId: 'variant', label: 'Thargoid Variant', options: SPEEDRUN_VARIANT_OPTIONS, selectedValues: [object.variant] }),
                    buildModalStringSelectField({ customId: 'class', label: 'Ship Class', options: SPEEDRUN_CLASS_OPTIONS, selectedValues: [object.class] }),
                ],
                baseline: { ship: object.ship, variant: object.variant, class: object.class },
            }),
            read: ({ interaction }) => ({
                ship: validateText(getModalTextInput(interaction, 'ship'), 'Ship', 100),
                variant: selectedValue(interaction, 'variant', SPEEDRUN_VARIANT_OPTIONS, 'Thargoid Variant'),
                class: selectedValue(interaction, 'class', SPEEDRUN_CLASS_OPTIONS, 'Ship Class'),
            }),
            resolve: ({ object, state, values }) => resolveOptimisticEdits({
                ship: textEdit('ship', state.baseline.ship, object.ship, values.ship),
                variant: textEdit('variant', state.baseline.variant, object.variant, values.variant),
                class: textEdit('class', state.baseline.class, object.class, values.class),
            }),
            commit: ({ context, object, edits }) => commitPendingEdits({ context, object, edits }),
        },
        speedrunTime: {
            action: 'speedrunTimeModal',
            title: 'Edit Speedrun Time',
            available: ({ context }) => context.leaderboard === 'speedrun' ? undefined : 'This editor is only available for Speedrun submissions.',
            build: ({ object }) => ({
                fields: [
                    buildExistingTextField({ customId: 'time', label: 'Whole Seconds', currentValue: object.time, required: true, maxLength: 8 }),
                    buildExistingTextField({ customId: 'milliseconds', label: 'Milliseconds (000–999)', currentValue: String(object.milliseconds).padStart(3, '0'), required: true, maxLength: 3 }),
                ],
                baseline: { time: Number(object.time), milliseconds: Number(object.milliseconds) },
            }),
            read: ({ interaction }) => ({
                time: integer(getModalTextInput(interaction, 'time'), 'Whole Seconds', { min: 0, max: 604800 }),
                milliseconds: integer(getModalTextInput(interaction, 'milliseconds'), 'Milliseconds', { min: 0, max: 999 }),
            }),
            resolve: ({ object, state, values }) => resolveOptimisticEdits({
                time: numericEdit('time', state.baseline.time, object.time, values.time),
                milliseconds: numericEdit('milliseconds', state.baseline.milliseconds, object.milliseconds, values.milliseconds),
            }),
            commit: ({ context, object, edits }) => commitPendingEdits({ context, object, edits }),
        },
        evidence: {
            action: 'evidenceModal',
            title: 'Edit Evidence',
            build: ({ context, object }) => ({
                fields: [
                    buildExistingTextField({ customId: 'link', label: 'Evidence Link', currentValue: object.link, required: true, maxLength: 1000 }),
                    context.leaderboard === 'speedrun' && buildExistingTextField({
                        customId: 'comments',
                        label: 'Comment',
                        currentValue: object.comments ?? '-',
                        style: Discord.TextInputStyle.Paragraph,
                        required: true,
                        maxLength: 1000,
                    }),
                ].filter(Boolean),
                baseline: {
                    link: object.link,
                    ...(context.leaderboard === 'speedrun' ? { comments: object.comments ?? '-' } : {}),
                },
            }),
            read: ({ context, interaction }) => ({
                link: validateLink(getModalTextInput(interaction, 'link')),
                ...(context.leaderboard === 'speedrun'
                    ? { comments: validateText(getModalTextInput(interaction, 'comments'), 'Comment', 1000) }
                    : {}),
            }),
            resolve: ({ context, object, state, values }) => resolveOptimisticEdits({
                link: textEdit('evidence link', state.baseline.link, object.link, values.link),
                ...(context.leaderboard === 'speedrun' ? {
                    comments: textEdit('comment', state.baseline.comments, object.comments ?? '-', values.comments),
                } : {}),
            }),
            commit: ({ context, object, edits }) => commitPendingEdits({ context, object, edits }),
        },
        aceScore: {
            action: 'aceScoreModal',
            title: 'Edit Ace Score Details',
            available: ({ context }) => context.leaderboard === 'ace' ? undefined : 'This editor is only available for Ace submissions.',
            build: ({ object }) => ({
                fields: [
                    buildModalStringSelectField({ customId: 'shiptype', label: 'Ship', options: ACE_SHIP_OPTIONS, selectedValues: [object.shiptype] }),
                    buildExistingTextField({ customId: 'time_hull', label: 'Time Seconds / Hull % Lost', currentValue: `${object.timetaken} / ${object.percenthulllost}`, required: true, maxLength: 32 }),
                    buildExistingTextField({ customId: 'modules', label: 'Medium / Small Gauss Modules', currentValue: `${object.mgauss} / ${object.sgauss}`, required: true, maxLength: 16 }),
                    buildExistingTextField({ customId: 'rounds', label: 'Medium / Small Rounds Fired', currentValue: `${object.mgaussfired} / ${object.sgaussfired}`, required: true, maxLength: 32 }),
                    buildModalStringSelectField({ customId: 'ammo', label: 'Ammo Used for Recalculation', options: ACE_AMMO_OPTIONS, placeholder: 'Choose the ammo used...' }),
                ],
                baseline: {
                    shiptype: object.shiptype,
                    timetaken: Number(object.timetaken),
                    percenthulllost: Number(object.percenthulllost),
                    mgauss: Number(object.mgauss),
                    sgauss: Number(object.sgauss),
                    mgaussfired: Number(object.mgaussfired),
                    sgaussfired: Number(object.sgaussfired),
                },
            }),
            read: ({ interaction }) => {
                const [timetaken, percenthulllost] = integerPair(
                    getModalTextInput(interaction, 'time_hull'),
                    'Time', 'Hull Loss',
                    { first: { min: 1, max: 7200 }, second: { min: 0, max: 500 } },
                );
                const [mgauss, sgauss] = integerPair(
                    getModalTextInput(interaction, 'modules'),
                    'Medium Modules', 'Small Modules',
                    { first: { min: 0, max: 6 }, second: { min: 0, max: 6 } },
                );
                const [mgaussfired, sgaussfired] = integerPair(
                    getModalTextInput(interaction, 'rounds'),
                    'Medium Rounds', 'Small Rounds',
                    { first: { min: 0, max: 1000 }, second: { min: 0, max: 1000 } },
                );
                return {
                    shiptype: selectedValue(interaction, 'shiptype', ACE_SHIP_OPTIONS, 'Ship'),
                    timetaken,
                    percenthulllost,
                    mgauss,
                    sgauss,
                    mgaussfired,
                    sgaussfired,
                    ammo: selectedValue(interaction, 'ammo', ACE_AMMO_OPTIONS, 'Ammo Used'),
                };
            },
            resolve: ({ object, state, values }) => resolveOptimisticEdits({
                shiptype: textEdit('ship', state.baseline.shiptype, object.shiptype, values.shiptype),
                timetaken: numericEdit('time', state.baseline.timetaken, object.timetaken, values.timetaken),
                percenthulllost: numericEdit('hull loss', state.baseline.percenthulllost, object.percenthulllost, values.percenthulllost),
                mgauss: numericEdit('medium Gauss modules', state.baseline.mgauss, object.mgauss, values.mgauss),
                sgauss: numericEdit('small Gauss modules', state.baseline.sgauss, object.sgauss, values.sgauss),
                mgaussfired: numericEdit('medium rounds', state.baseline.mgaussfired, object.mgaussfired, values.mgaussfired),
                sgaussfired: numericEdit('small rounds', state.baseline.sgaussfired, object.sgaussfired, values.sgaussfired),
            }),
            validate: ({ edits, values }) => {
                validateAceScoreInputs({ ...editValues(edits), ammo: values.ammo });
            },
            commit: ({ context, object, edits, values }) => {
                const calculation = validateAceScoreInputs({ ...editValues(edits), ammo: values.ammo });
                return commitPendingEdits({
                    context,
                    object,
                    edits,
                    extraValues: { score: calculation.result.score.toFixed(2) },
                });
            },
        },
    });
}

module.exports = {
    ACE_AMMO_OPTIONS,
    ACE_SHIP_OPTIONS,
    SPEEDRUN_CLASS_OPTIONS,
    SPEEDRUN_VARIANT_OPTIONS,
    createLeaderboardEditorDescriptors,
    integer,
    integerPair,
    validateAceScoreInputs,
    validateLink,
    validateText,
};
