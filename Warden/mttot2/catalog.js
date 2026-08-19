'use strict';

const weapons = require('../../commands/Warden/math/data/weapons.json');
const interceptors = require('../../commands/Warden/math/data/interceptors.json');

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
    optionsForMount,
    optionsForWeapon,
    weapons,
};
