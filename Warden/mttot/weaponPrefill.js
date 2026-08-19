'use strict';

const { weapons } = require('./catalog');

const MAX_UNIQUE_WEAPON_TYPES = 25;
const MAX_WEAPON_QUANTITY = 999_999;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_AUTOCOMPLETE_VALUE_LENGTH = 100;
const MIN_SEARCH_ALIAS_PREFIX_LENGTH = 3;

const SIZE_FILTERS = Object.freeze({ small: 's', medium: 'm', large: 'l' });
const MOUNT_FILTERS = Object.freeze({ fixed: 'f', gimballed: 'g', turreted: 't' });
const SEARCH_SYNONYMS = Object.freeze([
    Object.freeze({ alias: 'pre-engineered', target: 'modified' }),
    Object.freeze({ alias: 'preengineered', target: 'modified' }),
]);
const ALIAS_TARGETS = Object.freeze({
    m: Object.freeze(['mfgc']),
    mgauss: Object.freeze(['mfgc']),
    modgauss: Object.freeze(['mfmgc', 'sfmgc']),
    s: Object.freeze(['sfgc']),
    sgauss: Object.freeze(['sfgc']),
    modshard: Object.freeze(['mfmsc', 'sfmsc']),
    msc: Object.freeze(['mfmsc', 'sfmsc']),
    ms: Object.freeze(['mfmsc', 'sfmsc']),
    modplasma: Object.freeze(['mfmpc', 'sfmpc']),
    mpc: Object.freeze(['mfmpc', 'sfmpc']),
    mp: Object.freeze(['mfmpc', 'sfmpc']),
    sirius: Object.freeze(['lfmaxmr', 'mfmaxmr']),
    azis: Object.freeze(['lgmeaxmc', 'mgmeaxmc']),
    azimuths: Object.freeze(['lgmeaxmc', 'mgmeaxmc']),
});

function compact(value) {
    return String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/gu, '');
}

const ALIASES_BY_CODE = Object.freeze(Object.entries(ALIAS_TARGETS).reduce((index, [alias, targets]) => {
    for (const code of targets) (index[code] ??= []).push(alias);
    return index;
}, {}));
const SEARCH_INDEX = Object.freeze(Object.entries(weapons).map(([code, weapon]) => {
    const aliases = Object.freeze(ALIASES_BY_CODE[code] ?? []);
    return Object.freeze({
        aliases,
        aliasKeys: Object.freeze(aliases.map(compact)),
        code,
        codeKey: compact(code),
        name: weapon.name,
        searchKeys: Object.freeze([code, weapon.name, ...aliases].map(compact)),
    });
}));

function canonicalCode(code) {
    const normalized = String(code ?? '').trim().toLocaleLowerCase();
    return ALIAS_TARGETS[normalized]?.[0] ?? normalized;
}

function aliasesForCode(code) {
    return ALIASES_BY_CODE[code] ?? [];
}

function prefillError(message) {
    return new Error(`Invalid weapon_codes: ${message}`);
}

function tokenizeWeaponGroups(value, {
    allowAutocompleteDiscovery = false,
    allowIncompleteFinal = false,
} = {}) {
    const raw = String(value ?? '');
    const groups = [];
    let cursor = 0;
    let expectsGroup = true;
    let trailingComma = false;

    while (cursor < raw.length) {
        while (/\s/u.test(raw[cursor] ?? '')) cursor += 1;
        if (cursor >= raw.length) break;
        if (raw[cursor] === ',') {
            if (expectsGroup) throw prefillError('comma-separated weapon groups cannot be empty.');
            cursor += 1;
            expectsGroup = trailingComma = true;
            continue;
        }
        if (!/\d/u.test(raw[cursor])) {
            if (allowAutocompleteDiscovery && /^[a-z\s-]+$/iu.test(raw.slice(cursor))) {
                groups.push({ code: raw.slice(cursor).trim(), quantityText: '1', start: cursor, end: raw.length });
                cursor = raw.length;
                expectsGroup = trailingComma = false;
                break;
            }
            throw prefillError('each weapon group must start with a positive quantity, such as 2mfgc.');
        }

        const start = cursor;
        while (/\d/u.test(raw[cursor] ?? '')) cursor += 1;
        const quantityText = raw.slice(start, cursor);
        const codeStart = cursor;
        while (/[a-z]/iu.test(raw[cursor] ?? '')) cursor += 1;
        let code = raw.slice(codeStart, cursor);
        if (allowAutocompleteDiscovery) {
            const continuation = raw.slice(cursor);
            if (!code && /^\s+[a-z][a-z\s-]*$/iu.test(continuation)) {
                code = continuation.trim();
                cursor = raw.length;
            } else if (code && /^(?:\s+|-\s*)[a-z][a-z\s-]*$/iu.test(continuation)) {
                code += continuation;
                cursor = raw.length;
            }
        }
        if (!code && !allowIncompleteFinal) {
            throw prefillError(`weapon group \`${quantityText}\` is missing its code.`);
        }
        if (!code && cursor < raw.length) {
            throw prefillError('each weapon group must contain only a quantity followed by a weapon code.');
        }
        groups.push({ code, quantityText, start, end: cursor });
        expectsGroup = trailingComma = false;
    }

    if (expectsGroup && groups.length > 0 && !allowIncompleteFinal) {
        throw prefillError('comma-separated weapon groups cannot be empty.');
    }
    return { groups, raw, trailingComma };
}

function normalizeWeaponGroups(groups, {
    maxQuantity = MAX_WEAPON_QUANTITY,
    maxUniqueWeaponTypes = MAX_UNIQUE_WEAPON_TYPES,
} = {}) {
    const hardpoints = new Map();
    for (const [index, group] of groups.entries()) {
        const position = index + 1;
        const quantity = Number(group.quantityText);
        if (!Number.isSafeInteger(quantity) || quantity < 1) {
            throw prefillError(`weapon group ${position} must have a positive whole-number quantity.`);
        }
        if (quantity > maxQuantity) {
            throw prefillError(`weapon group ${position} exceeds the maximum quantity of ${maxQuantity.toLocaleString('en-US')}.`);
        }
        const code = canonicalCode(group.code);
        if (!weapons[code]) {
            throw prefillError(`weapon group ${position} has an unrecognized weapon code \`${group.code}\`.`);
        }
        const total = (hardpoints.get(code) ?? 0) + quantity;
        if (!Number.isSafeInteger(total) || total > maxQuantity) {
            throw prefillError(`the combined quantity for \`${code}\` exceeds ${maxQuantity.toLocaleString('en-US')}.`);
        }
        hardpoints.set(code, total);
    }
    if (hardpoints.size > maxUniqueWeaponTypes) {
        throw prefillError(`a loadout can contain at most ${maxUniqueWeaponTypes} unique weapon types.`);
    }
    return Array.from(hardpoints, ([code, quantity]) => ({ code, quantity }));
}

function parseWeaponPrefill(value, options) {
    const raw = String(value ?? '').trim();
    return raw ? normalizeWeaponGroups(tokenizeWeaponGroups(raw).groups, options) : [];
}

function canonicalWeaponCodes(prefill) {
    return prefill.map(({ code, quantity }) => `${quantity}${code}`).join(', ');
}

function truncateAutocompleteName(label) {
    const value = String(label ?? '');
    return value.length <= 100 ? value : `${value.slice(0, 98)}..`;
}

function weaponChoiceName(quantity, code) {
    const aliases = aliasesForCode(code);
    const suffix = aliases.length ? ` (${aliases.join(', ')})` : '';
    return truncateAutocompleteName(`${quantity}${code} — ${weapons[code].name}${suffix}`);
}

function normalizedPrefillChoice(prefill, latestCode = prefill.at(-1)?.code) {
    const value = canonicalWeaponCodes(prefill);
    if (value.length > MAX_AUTOCOMPLETE_VALUE_LENGTH) return null;
    const latest = prefill.find((weapon) => weapon.code === latestCode) ?? prefill.at(-1);
    const summary = `${prefill.length > 1 ? '.., ' : ''}${latest.quantity}× ${weapons[latest.code].name}`;
    return { name: truncateAutocompleteName(`${value} — ${summary}`), value };
}

function generatedLabels(prefill) {
    const labels = prefill.length === 1
        ? [weaponChoiceName(prefill[0].quantity, prefill[0].code)]
        : [];
    for (const weapon of prefill) labels.push(normalizedPrefillChoice(prefill, weapon.code)?.name);
    return labels.filter(Boolean).flatMap((label) => [label, label.replace(' — ', ' - ')]);
}

function normalizeAutocompleteLabel(value) {
    const raw = String(value ?? '');
    const leading = /^\s*/u.exec(raw)?.[0] ?? '';
    const input = raw.slice(leading.length);
    const separator = /\s+[—-]\s+/u.exec(input);
    if (!separator) return { hasContinuation: false, value: raw };
    const expression = input.slice(0, separator.index);
    let prefill;
    try {
        prefill = parseWeaponPrefill(expression);
    } catch (_error) {
        return { hasContinuation: false, value: raw };
    }
    for (const label of generatedLabels(prefill)) {
        if (!input.startsWith(label)) continue;
        const suffix = input.slice(label.length);
        if (suffix === '' || /^,\s*/u.test(suffix)) {
            return {
                hasContinuation: suffix !== '',
                value: `${leading}${canonicalWeaponCodes(prefill)}${suffix}`,
            };
        }
    }
    return { hasContinuation: false, value: raw };
}

function resolveSearchSynonym(term) {
    const key = compact(term);
    if (key.length < MIN_SEARCH_ALIAS_PREFIX_LENGTH) return term;
    const targets = new Set(SEARCH_SYNONYMS
        .filter(({ alias }) => compact(alias).startsWith(key))
        .map(({ target }) => target));
    return targets.size === 1 ? [...targets][0] : term;
}

function parseSemanticQuery(query) {
    const search = [];
    const sizes = new Set();
    const mounts = new Set();
    for (const term of String(query ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)) {
        if (SIZE_FILTERS[term]) sizes.add(SIZE_FILTERS[term]);
        else if (MOUNT_FILTERS[term]) mounts.add(MOUNT_FILTERS[term]);
        else search.push(resolveSearchSynonym(term));
    }
    if (sizes.size > 1 || mounts.size > 1) return null;
    return { mount: [...mounts][0], query: compact(search.join(' ')), size: [...sizes][0] };
}

function rankedCandidates(query) {
    const semantic = parseSemanticQuery(query);
    if (!semantic) return [];
    const matches = SEARCH_INDEX
        .filter(({ code }) => !semantic.size || code.startsWith(semantic.size))
        .filter(({ code }) => !semantic.mount || code[1] === semantic.mount)
        .filter(({ searchKeys }) => !semantic.query || searchKeys.some((key) => key.includes(semantic.query)))
        .map((weapon) => ({
            ...weapon,
            aliasPrefix: weapon.aliasKeys.some((key) => key.startsWith(semantic.query)),
            codePrefix: weapon.codeKey.startsWith(semantic.query),
        }));
    const preferred = semantic.query && matches.some(({ codePrefix }) => codePrefix)
        ? matches.filter(({ codePrefix }) => codePrefix)
        : semantic.query && matches.some(({ aliasPrefix }) => aliasPrefix)
            ? matches.filter(({ aliasPrefix }) => aliasPrefix)
            : matches;
    return preferred.sort((left, right) => right.codePrefix - left.codePrefix || left.name.localeCompare(right.name));
}

function autocompleteCandidates({ prefix = '', quantity = '1', query = '' } = {}) {
    const numericQuantity = Number(quantity);
    if (!Number.isSafeInteger(numericQuantity) || numericQuantity < 1 || numericQuantity > MAX_WEAPON_QUANTITY) return [];
    const emittedQuantity = String(numericQuantity);
    return rankedCandidates(query).map((weapon) => {
        const value = `${prefix}${emittedQuantity}${weapon.code}`;
        try {
            const prefill = parseWeaponPrefill(value);
            const name = String(prefix).trim()
                ? normalizedPrefillChoice(prefill, weapon.code)?.name
                : weaponChoiceName(emittedQuantity, weapon.code);
            return name && name.length <= 100 && value.length <= MAX_AUTOCOMPLETE_VALUE_LENGTH
                ? { name, value }
                : null;
        } catch (_error) {
            return null;
        }
    }).filter(Boolean).slice(0, MAX_AUTOCOMPLETE_CHOICES);
}

function autocompleteWeaponCodes(focusedValue) {
    let tokenized;
    let hasContinuation;
    try {
        const normalized = normalizeAutocompleteLabel(focusedValue);
        hasContinuation = normalized.hasContinuation;
        tokenized = tokenizeWeaponGroups(normalized.value, {
            allowAutocompleteDiscovery: true,
            allowIncompleteFinal: true,
        });
    } catch (_error) {
        return [];
    }
    const { groups, raw, trailingComma } = tokenized;
    const final = groups.at(-1);
    const aliasTargets = ALIAS_TARGETS[String(final?.code ?? '').trim().toLocaleLowerCase()] ?? [];
    const finalIsKnown = final && weapons[canonicalCode(final.code)] && aliasTargets.length <= 1;
    const partial = final && (!finalIsKnown || hasContinuation);
    try {
        if (trailingComma || partial) {
            normalizeWeaponGroups(trailingComma ? groups : groups.slice(0, -1));
            return autocompleteCandidates({
                prefix: trailingComma ? raw : raw.slice(0, final.start),
                quantity: trailingComma ? '1' : final.quantityText,
                query: trailingComma ? '' : final.code,
            });
        }
        if (!groups.length) return autocompleteCandidates();
        const choice = normalizedPrefillChoice(normalizeWeaponGroups(groups), canonicalCode(final?.code));
        return choice ? [choice] : [];
    } catch (_error) {
        return [];
    }
}

module.exports = {
    MAX_AUTOCOMPLETE_CHOICES,
    MAX_AUTOCOMPLETE_VALUE_LENGTH,
    MAX_UNIQUE_WEAPON_TYPES,
    MAX_WEAPON_QUANTITY,
    aliasesForCode,
    autocompleteWeaponCodes,
    canonicalCode,
    canonicalWeaponCodes,
    normalizeWeaponGroups,
    parseWeaponPrefill,
    tokenizeWeaponGroups,
    truncateAutocompleteName,
};
