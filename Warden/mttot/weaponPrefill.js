'use strict';

const { weapons } = require('./catalog');

const MAX_UNIQUE_WEAPON_TYPES = 25;
const MAX_WEAPON_QUANTITY = 999_999;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_AUTOCOMPLETE_VALUE_LENGTH = 100;
const MIN_AUTOCOMPLETE_SEARCH_ALIAS_PREFIX_LENGTH = 3;

const AUTOCOMPLETE_SIZE_FILTERS = Object.freeze({
    small: 's',
    medium: 'm',
    large: 'l',
});
const AUTOCOMPLETE_MOUNT_FILTERS = Object.freeze({
    fixed: 'f',
    gimballed: 'g',
    turreted: 't',
});
const AUTOCOMPLETE_SEARCH_ALIASES = Object.freeze([
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

function canonicalCode(code) {
    const normalized = String(code ?? '').trim().toLocaleLowerCase();
    return ALIAS_TARGETS[normalized]?.[0] ?? normalized;
}

function aliasesForCode(code) {
    return Object.entries(ALIAS_TARGETS)
        .filter(([, targets]) => targets.includes(code))
        .map(([alias]) => alias);
}

function autocompleteAliasTargets(code) {
    return ALIAS_TARGETS[String(code ?? '').trim().toLocaleLowerCase()] ?? [];
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
            expectsGroup = true;
            trailingComma = true;
            continue;
        }
        if (!/\d/u.test(raw[cursor])) {
            if (allowAutocompleteDiscovery && /^[a-z\s-]+$/iu.test(raw.slice(cursor))) {
                groups.push({
                    code: raw.slice(cursor).trim(),
                    quantityText: '1',
                    start: cursor,
                    end: raw.length,
                });
                cursor = raw.length;
                expectsGroup = false;
                trailingComma = false;
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
        if (allowAutocompleteDiscovery && !code) {
            const spacedName = raw.slice(cursor);
            if (/^\s+[a-z][a-z\s-]*$/iu.test(spacedName)) {
                code = spacedName.trim();
                cursor = raw.length;
            }
        }
        if (allowAutocompleteDiscovery && code) {
            const continuation = raw.slice(cursor);
            if (/^(?:\s+|-\s*)[a-z][a-z\s-]*$/iu.test(continuation)) {
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
        expectsGroup = false;
        trailingComma = false;
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
    if (!raw) return [];
    const { groups } = tokenizeWeaponGroups(raw);
    return normalizeWeaponGroups(groups, options);
}

function canonicalWeaponCodes(prefill) {
    return prefill.map((weapon) => `${weapon.quantity}${weapon.code}`).join(', ');
}

function compactSearchText(value) {
    return String(value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isStrictlyValidAutocompleteValue(value) {
    try {
        parseWeaponPrefill(value);
        return true;
    } catch (_error) {
        return false;
    }
}

function truncateAutocompleteName(label) {
    const value = String(label ?? '');
    return value.length <= 100 ? value : `${value.slice(0, 98)}..`;
}

function weaponAutocompleteChoiceLabel(quantity, code) {
    const aliasSuffix = aliasesForCode(code).length > 0 ? ` (${aliasesForCode(code).join(', ')})` : '';
    return `${quantity}${code} — ${weapons[code].name}${aliasSuffix}`;
}

function weaponAutocompleteChoiceName(quantity, code) {
    return truncateAutocompleteName(weaponAutocompleteChoiceLabel(quantity, code));
}

function autocompleteSearchTerm(term) {
    const normalizedTerm = compactSearchText(term);
    if (normalizedTerm.length < MIN_AUTOCOMPLETE_SEARCH_ALIAS_PREFIX_LENGTH) return term;
    const matchingTargets = new Set(AUTOCOMPLETE_SEARCH_ALIASES
        .filter(({ alias }) => compactSearchText(alias).startsWith(normalizedTerm))
        .map(({ target }) => target));
    return matchingTargets.size === 1 ? [...matchingTargets][0] : term;
}

function semanticAutocompleteQuery(query) {
    const searchTerms = [];
    const sizeFilters = new Set();
    const mountFilters = new Set();
    for (const term of String(query ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)) {
        if (AUTOCOMPLETE_SIZE_FILTERS[term]) {
            sizeFilters.add(AUTOCOMPLETE_SIZE_FILTERS[term]);
        } else if (AUTOCOMPLETE_MOUNT_FILTERS[term]) {
            mountFilters.add(AUTOCOMPLETE_MOUNT_FILTERS[term]);
        } else {
            searchTerms.push(autocompleteSearchTerm(term));
        }
    }
    if (sizeFilters.size > 1 || mountFilters.size > 1) return null;
    return {
        mount: [...mountFilters][0] ?? null,
        query: searchTerms.join(' '),
        size: [...sizeFilters][0] ?? null,
    };
}

function autocompleteCandidates({ prefix = '', quantity = '1', query = '' } = {}) {
    const semanticQuery = semanticAutocompleteQuery(query);
    if (!semanticQuery) return [];
    const normalizedQuery = compactSearchText(semanticQuery.query);
    const numericQuantity = Number(quantity);
    if (!Number.isSafeInteger(numericQuantity) || numericQuantity < 1 || numericQuantity > MAX_WEAPON_QUANTITY) {
        return [];
    }
    const emittedQuantity = String(numericQuantity);
    const candidates = Object.entries(weapons)
        .map(([code, weapon]) => ({
            aliases: aliasesForCode(code),
            code,
            name: weapon.name,
        }))
        .filter((weapon) => !semanticQuery.size || weapon.code.startsWith(semanticQuery.size))
        .filter((weapon) => !semanticQuery.mount || weapon.code[1] === semanticQuery.mount)
        .filter((weapon) => {
            if (!normalizedQuery) return true;
            const terms = [weapon.code, weapon.name, ...weapon.aliases].map(compactSearchText);
            return terms.some((term) => term.includes(normalizedQuery));
        })
        .sort((left, right) => {
            const leftTerms = [left.code, ...left.aliases].map(compactSearchText);
            const rightTerms = [right.code, ...right.aliases].map(compactSearchText);
            const leftPrefix = leftTerms.some((term) => term.startsWith(normalizedQuery));
            const rightPrefix = rightTerms.some((term) => term.startsWith(normalizedQuery));
            if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
            return left.name.localeCompare(right.name);
        });
    const codePrefixMatches = normalizedQuery
        ? candidates.filter((weapon) => compactSearchText(weapon.code).startsWith(normalizedQuery))
        : candidates;
    const aliasPrefixMatches = normalizedQuery
        ? candidates.filter((weapon) => weapon.aliases
            .map(compactSearchText)
            .some((term) => term.startsWith(normalizedQuery)))
        : candidates;
    const preferredCandidates = codePrefixMatches.length > 0
        ? codePrefixMatches
        : (aliasPrefixMatches.length > 0 ? aliasPrefixMatches : candidates);
    return preferredCandidates
        .map((weapon) => {
            const value = `${prefix}${emittedQuantity}${weapon.code}`;
            let name = weaponAutocompleteChoiceName(emittedQuantity, weapon.code);
            if (String(prefix).trim()) {
                let normalizedChoice;
                try {
                    normalizedChoice = normalizedPrefillChoice(parseWeaponPrefill(value), {
                        latestCode: weapon.code,
                    });
                } catch (_error) {
                    return null;
                }
                if (normalizedChoice) name = normalizedChoice.name;
            }
            return {
                name,
                value,
            };
        })
        .filter((choice) => choice
            && choice.name.length <= 100
            && choice.value.length <= MAX_AUTOCOMPLETE_VALUE_LENGTH
            && isStrictlyValidAutocompleteValue(choice.value))
        .slice(0, MAX_AUTOCOMPLETE_CHOICES);
}

function normalizedPrefillChoice(prefill, { latestCode = prefill.at(-1)?.code } = {}) {
    const value = canonicalWeaponCodes(prefill);
    if (value.length > MAX_AUTOCOMPLETE_VALUE_LENGTH) return null;
    const latestWeapon = prefill.find((weapon) => weapon.code === latestCode) ?? prefill.at(-1);
    const latestSummary = `${latestWeapon.quantity}× ${weapons[latestWeapon.code].name}`;
    const summary = prefill.length > 1 ? `.., ${latestSummary}` : latestSummary;
    return {
        name: truncateAutocompleteName(`${value} — ${summary}`),
        value,
    };
}

function labelVariants(label) {
    return [label, label.replace(' — ', ' - ')];
}

function labelSuffix(value, label) {
    if (!value.startsWith(label)) return null;
    const suffix = value.slice(label.length);
    return suffix === '' || /^,\s*/u.test(suffix) ? suffix : null;
}

function normalizeSingleWeaponLabel(value) {
    const match = /^(\d+)([a-z]+)\s+[—-]\s+/iu.exec(value);
    if (!match) return null;
    const quantityText = match[1];
    const quantity = Number(quantityText);
    const code = canonicalCode(match[2]);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || !weapons[code]) return null;
    const label = weaponAutocompleteChoiceName(String(quantity), code);
    for (const variant of labelVariants(label)) {
        const suffix = labelSuffix(value, variant);
        if (suffix !== null) {
            return {
                hasOwnLabelContinuation: suffix !== '',
                value: `${quantity}${code}${suffix}`,
            };
        }
    }
    return null;
}

function normalizeMultiWeaponLabel(value) {
    const separator = value.indexOf(' — ');
    const hyphenSeparator = value.indexOf(' - ');
    const separatorIndex = separator >= 0 ? separator : hyphenSeparator;
    if (separatorIndex < 0) return null;
    const expression = value.slice(0, separatorIndex);
    let prefill;
    try {
        const tokenized = tokenizeWeaponGroups(expression);
        prefill = normalizeWeaponGroups(tokenized.groups);
    } catch (_error) {
        return null;
    }
    for (const latestWeapon of prefill) {
        const choice = normalizedPrefillChoice(prefill, { latestCode: latestWeapon.code });
        if (!choice) continue;
        for (const variant of labelVariants(choice.name)) {
            const suffix = labelSuffix(value, variant);
            if (suffix !== null) {
                return {
                    hasOwnLabelContinuation: suffix !== '',
                    value: `${canonicalWeaponCodes(prefill)}${suffix}`,
                };
            }
        }
    }
    return null;
}

function normalizeAutocompleteDisplayLabel(value) {
    const raw = String(value ?? '');
    const leadingWhitespace = /^\s*/u.exec(raw)?.[0] ?? '';
    const label = raw.slice(leadingWhitespace.length);
    const normalized = normalizeSingleWeaponLabel(label) ?? normalizeMultiWeaponLabel(label);
    return {
        hasOwnLabelContinuation: normalized?.hasOwnLabelContinuation ?? false,
        value: normalized === null ? raw : `${leadingWhitespace}${normalized.value}`,
    };
}

function autocompleteWeaponCodes(focusedValue) {
    let tokenized;
    let hasOwnLabelContinuation = false;
    try {
        const normalizedInput = normalizeAutocompleteDisplayLabel(focusedValue);
        tokenized = tokenizeWeaponGroups(normalizedInput.value, {
            allowAutocompleteDiscovery: true,
            allowIncompleteFinal: true,
        });
        hasOwnLabelContinuation = normalizedInput.hasOwnLabelContinuation;
    } catch (_error) {
        return [];
    }
    const { groups, raw, trailingComma } = tokenized;
    const finalGroup = groups.at(-1);
    const finalAliasTargets = finalGroup ? autocompleteAliasTargets(finalGroup.code) : [];
    const finalIsKnown = finalGroup
        && Boolean(weapons[canonicalCode(finalGroup.code)])
        && finalAliasTargets.length <= 1;
    const hasPartialFinalGroup = Boolean(finalGroup && (!finalIsKnown || hasOwnLabelContinuation));

    try {
        if (trailingComma || hasPartialFinalGroup) {
            const completedGroups = trailingComma ? groups : groups.slice(0, -1);
            normalizeWeaponGroups(completedGroups);
            const partial = trailingComma ? null : finalGroup;
            const quantity = partial?.quantityText || '1';
            const numericQuantity = Number(quantity);
            if (!Number.isSafeInteger(numericQuantity) || numericQuantity < 1 || numericQuantity > MAX_WEAPON_QUANTITY) {
                return [];
            }
            return autocompleteCandidates({
                prefix: trailingComma ? raw : raw.slice(0, partial.start),
                quantity,
                query: partial?.code ?? '',
            });
        }

        if (groups.length === 0) return autocompleteCandidates();
        const choice = normalizedPrefillChoice(normalizeWeaponGroups(groups), {
            latestCode: canonicalCode(groups.at(-1)?.code),
        });
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
