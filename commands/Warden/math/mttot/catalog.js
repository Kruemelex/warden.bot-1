'use strict';

const weapons = require('../data/weapons.json');
const interceptors = require('../data/interceptors.json');

const SIZE_OPTIONS = Object.freeze([
    { label: 'Small', value: 's' },
    { label: 'Medium', value: 'm' },
    { label: 'Large', value: 'l' },
]);
const MOUNT_OPTIONS = Object.freeze([
    { label: 'Fixed', value: 'f' },
    { label: 'Gimballed', value: 'g' },
    { label: 'Turreted', value: 't' },
]);
const INTERCEPTOR_OPTIONS = Object.freeze(Object.keys(interceptors).map((value) => ({ label: value, value })));
const IDENTITY_EMOJIS = Object.freeze({
    Warden: Object.freeze({
        Cyclops: Object.freeze({ id: '1540531867961266257', name: 'Cyclops' }),
        Basilisk: Object.freeze({ id: '1540531869248913499', name: 'Basilisk' }),
        Medusa: Object.freeze({ id: '1540531872008769656', name: 'Medusa' }),
        Hydra: Object.freeze({ id: '1540531874739527781', name: 'Hydra' }),
        Fixed: Object.freeze({ id: '1540531863737868308', name: 'Fixed' }),
        Gimballed: Object.freeze({ id: '1540531865633431562', name: 'Gimballed' }),
        Turreted: Object.freeze({ id: '1540531866715689040', name: 'Turreted' }),
        Modified: Object.freeze({ id: '1540531861145522177', name: 'Modified' }),
        Guardian: Object.freeze({ id: '1540531862491893873', name: 'Guardian' }),
        Human: Object.freeze({ id: '1540531859681968198', name: 'Human' }),
    }),
    GuardianAI: Object.freeze({
        Cyclops: Object.freeze({ id: '1540539949718306846', name: 'Cyclops' }),
        Basilisk: Object.freeze({ id: '1540539948279668846', name: 'Basilisk' }),
        Medusa: Object.freeze({ id: '1540539946664988775', name: 'Medusa' }),
        Hydra: Object.freeze({ id: '1540539945507225751', name: 'Hydra' }),
        Fixed: Object.freeze({ id: '1540539954051026974', name: 'Fixed' }),
        Gimballed: Object.freeze({ id: '1540539952696397915', name: 'Gimballed' }),
        Turreted: Object.freeze({ id: '1540539950980792421', name: 'Turreted' }),
        Modified: Object.freeze({ id: '1540539944026640464', name: 'Modified' }),
        Guardian: Object.freeze({ id: '1540539955418234911', name: 'Guardian' }),
        Human: Object.freeze({ id: '1540539942718017566', name: 'Human' }),
    }),
});

function interceptorOptionsForIdentity(botName) {
    const emojis = IDENTITY_EMOJIS[botName] ?? IDENTITY_EMOJIS.Warden;
    return INTERCEPTOR_OPTIONS.map((option) => ({ ...option, emoji: emojis[option.label] }));
}

function mountOptionsForIdentity(options, botName) {
    const emojis = IDENTITY_EMOJIS[botName] ?? IDENTITY_EMOJIS.Warden;
    return options.map((option) => ({ ...option, emoji: emojis[option.label] }));
}

function weaponEmojiForName(name, botName = 'Warden') {
    const normalizedName = String(name).toLocaleLowerCase();
    const emojis = IDENTITY_EMOJIS[botName] ?? IDENTITY_EMOJIS.Warden;
    if (normalizedName.includes('modified')) return emojis.Modified;
    if (normalizedName.includes('guardian')
        || normalizedName.includes('gauss cannon')
        || normalizedName.includes('shard cannon')
        || normalizedName.includes('plasma charger')) {
        return emojis.Guardian;
    }
    return emojis.Human;
}

function weaponOptionsForIdentity(options, botName) {
    return options.map((option) => ({
        ...option,
        emoji: weaponEmojiForName(option.label, botName),
    }));
}

function optionsForMount(size) {
    const available = new Set(Object.keys(weapons)
        .filter((code) => code.startsWith(String(size ?? '')))
        .map((code) => code[1]));
    return MOUNT_OPTIONS.filter((option) => available.has(option.value));
}

function optionsForWeapon(size, mount) {
    const prefix = `${size ?? ''}${mount ?? ''}`;
    return Object.entries(weapons)
        .filter(([code]) => code.startsWith(prefix))
        .map(([value, weapon]) => ({ label: weapon.name, value }));
}

function labelFor(options, value, fallback = 'Not selected') {
    return options.find((option) => option.value === String(value))?.label ?? fallback;
}

module.exports = {
    INTERCEPTOR_OPTIONS,
    MOUNT_OPTIONS,
    SIZE_OPTIONS,
    labelFor,
    interceptorOptionsForIdentity,
    mountOptionsForIdentity,
    optionsForMount,
    optionsForWeapon,
    weaponEmojiForName,
    weaponOptionsForIdentity,
    weapons,
};
