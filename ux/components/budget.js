'use strict';

const DISCORD_MESSAGE_LIMITS = Object.freeze({
    actionRowComponents: 5,
    actionRows: 5,
    attachments: 10,
    componentsV2: 40,
    customIdLength: 100,
    embeds: 10,
    embedCharacters: 6000,
    embedFields: 25,
    galleryItems: 10,
    sectionTextDisplays: 3,
    selectOptions: 25,
});

function serializeComponent(component) {
    return component?.toJSON?.() ?? component;
}

function countComponents(components = []) {
    const stack = [...components].map(serializeComponent);
    let count = 0;
    while (stack.length > 0) {
        const component = stack.pop();
        if (!component || typeof component.type !== 'number') continue;
        count += 1;
        if (Array.isArray(component.components)) stack.push(...component.components);
        if (component.component) stack.push(component.component);
        if (component.accessory) stack.push(component.accessory);
    }
    return count;
}

function assertComponentBudget(components, limit = DISCORD_MESSAGE_LIMITS.componentsV2, label = 'UX message') {
    const count = countComponents(components);
    if (count > limit) throw new Error(`${label} contains ${count} Discord components; the limit is ${limit}.`);
    return count;
}

function countEmbedCharacters(embed) {
    const data = serializeComponent(embed) ?? {};
    return [
        data.title,
        data.description,
        data.author?.name,
        data.footer?.text,
        ...(data.fields ?? []).flatMap((field) => [field?.name, field?.value]),
    ].reduce((count, value) => count + String(value ?? '').length, 0);
}

function assertEmbedBudget(embeds = [], label = 'UX message') {
    const budget = {
        characters: embeds.reduce((count, embed) => count + countEmbedCharacters(embed), 0),
        count: embeds.length,
        fieldCounts: embeds.map((embed) => (serializeComponent(embed)?.fields ?? []).length),
    };
    if (budget.count > DISCORD_MESSAGE_LIMITS.embeds) {
        throw new Error(`${label} contains ${budget.count} embeds; Discord allows ${DISCORD_MESSAGE_LIMITS.embeds}.`);
    }
    if (budget.characters > DISCORD_MESSAGE_LIMITS.embedCharacters) {
        throw new Error(`${label} contains ${budget.characters} combined embed characters; Discord allows ${DISCORD_MESSAGE_LIMITS.embedCharacters}.`);
    }
    const oversizedFieldIndex = budget.fieldCounts.findIndex(
        (count) => count > DISCORD_MESSAGE_LIMITS.embedFields,
    );
    if (oversizedFieldIndex >= 0) {
        throw new Error(`${label} embed ${oversizedFieldIndex + 1} contains ${budget.fieldCounts[oversizedFieldIndex]} fields; Discord allows ${DISCORD_MESSAGE_LIMITS.embedFields}.`);
    }
    return budget;
}

/**
 * Partition atomic UI blocks without allowing any block to cross a component
 * budget boundary.
 *
 * @template T
 * @param {object} options
 * @param {T[]} options.blocks Atomic blocks in display order.
 * @param {(candidate: T[]) => boolean} options.fits Returns whether a candidate page fits.
 * @param {(block: T, index: number) => Error} [options.createOversizedBlockError]
 * @returns {T[][]}
 */
function partitionBlocksByBudget({
    blocks = [],
    fits,
    createOversizedBlockError = () => new Error('One admin UI block exceeds the component budget.'),
} = {}) {
    if (typeof fits !== 'function') throw new Error('Component-budget partitioning requires a fits function.');

    const pages = [];
    let current = [];
    for (const [index, block] of blocks.entries()) {
        const candidate = [...current, block];
        if (fits(candidate)) {
            current = candidate;
            continue;
        }
        if (current.length < 1) throw createOversizedBlockError(block, index);

        pages.push(current);
        current = [block];
        if (!fits(current)) throw createOversizedBlockError(block, index);
    }
    if (current.length > 0) pages.push(current);
    return pages;
}

module.exports = {
    DISCORD_MESSAGE_LIMITS,
    assertComponentBudget,
    assertEmbedBudget,
    countComponents,
    countEmbedCharacters,
    partitionBlocksByBudget,
};
