'use strict';

const Discord = require('discord.js');
const {
    assertAttachmentExposure,
    getAttachmentReferences,
} = require('../attachments');
const {
    DISCORD_MESSAGE_LIMITS,
    assertComponentBudget,
    countComponents,
    partitionBlocksByBudget,
} = require('../components/budget');
const {
    addBlocks,
    assertComponentsV2Support,
    buildActionRow,
    buildSection,
    buildSeparator,
    buildTextDisplay,
    resolveAccentColor,
} = require('../components/primitives');
const { getLayout } = require('../layouts');

function assertDocumentAttachmentExposure(document) {
    const files = document.files ?? [];
    if (files.length > DISCORD_MESSAGE_LIMITS.attachments) {
        throw new Error(`Components V2 messages support at most ${DISCORD_MESSAGE_LIMITS.attachments} files.`);
    }
    assertAttachmentExposure(files, getAttachmentReferences(document));
}

function createContainer(document) {
    const container = new Discord.ContainerBuilder();
    const accentColor = resolveAccentColor(document.accentColor);
    if (accentColor !== undefined) container.setAccentColor(accentColor);
    return container;
}

function addArea(container, state, add, separatorOptions) {
    if (state.count > 0) container.addSeparatorComponents(buildSeparator(separatorOptions));
    add();
    state.count += 1;
}

function addFields(container, fields = []) {
    for (const field of fields) {
        container.addTextDisplayComponents(buildTextDisplay(`### ${field.name}\n${field.value}`));
    }
}

function addRows(container, rows = []) {
    if (rows.length > 0) container.addActionRowComponents(...rows.map(buildActionRow));
}

function buildNoticeContainer(document) {
    const layout = getLayout(document.kind);
    const container = createContainer(document);
    const state = { count: 0 };
    addArea(container, state, () => {
        const summary = [
            document.title ? `# ${document.title}` : undefined,
            document.author?.name ? `-# ${document.author.name}` : undefined,
            document.message,
        ].filter(Boolean);
        if (document.thumbnailUrl) {
            const thumbnail = new Discord.ThumbnailBuilder().setURL(document.thumbnailUrl);
            container.addSectionComponents(buildSection({ content: summary.slice(0, 3), accessory: thumbnail }));
            for (const remaining of summary.slice(3)) container.addTextDisplayComponents(buildTextDisplay(remaining));
        }
        else {
            for (const content of summary) container.addTextDisplayComponents(buildTextDisplay(content));
        }
        addFields(container, document.fields);
        if (document.footer) container.addTextDisplayComponents(buildTextDisplay(`-# ${document.footer}`));
    }, layout.separator);
    if (document.actions.length > 0) {
        addArea(container, state, () => addRows(container, document.actions), layout.separator);
    }
    return container;
}

function buildUXPanelContainer(document, editorBlocks, paginationRow) {
    const layout = getLayout(document.kind);
    const container = createContainer(document);
    const state = { count: 0 };
    addArea(container, state, () => {
        container.addTextDisplayComponents(buildTextDisplay(`# ${document.title}`));
        if (document.description) container.addTextDisplayComponents(buildTextDisplay(document.description));
        addFields(container, document.fields);
        if (document.footer) container.addTextDisplayComponents(buildTextDisplay(`-# ${document.footer}`));
    }, layout.separator);
    if (editorBlocks.length > 0) {
        addArea(
            container,
            state,
            () => addBlocks(container, editorBlocks, { separator: layout.editorSeparator }),
            layout.separator,
        );
    }
    const controlRows = [
        ...(paginationRow ? [paginationRow] : []),
        ...document.actions,
        ...document.navigationActions,
    ];
    if (controlRows.length > 0) {
        addArea(container, state, () => addRows(container, controlRows), layout.separator);
    }
    return container;
}

function questionToBlocks(question) {
    const heading = [
        question.progressText ? `**${question.progressText}**` : undefined,
        `## ${question.label}`,
        question.text,
    ].filter(Boolean).join('\n');
    const blocks = [{ kind: 'text', content: heading }];
    if (question.media.length > 0) blocks.push({ kind: 'gallery', items: question.media });
    if (question.helpText) blocks.push({ kind: 'text', content: question.helpText });
    return blocks;
}

function buildChallengeContainer(document) {
    const layout = getLayout(document.kind);
    const container = createContainer(document);
    const state = { count: 0 };
    if (document.includeIntro) {
        addArea(container, state, () => {
            container.addTextDisplayComponents(buildTextDisplay(`# ${document.title}`));
            if (document.description) container.addTextDisplayComponents(buildTextDisplay(document.description));
            for (const field of document.fields) {
                container.addTextDisplayComponents(buildTextDisplay(`**${field.name}**\n${field.value}`));
            }
        }, layout.separator);
    }
    for (const question of document.questions) {
        addArea(container, state, () => {
            addBlocks(container, questionToBlocks(question), { separator: layout.questionSeparator });
        }, layout.separator);
    }
    if (document.expiryText) {
        // Expiry is footer-like context for the current screen, not another
        // major content area. Keep it attached to the preceding content so
        // the single divider below it continues to introduce the controls.
        container.addTextDisplayComponents(buildTextDisplay(document.expiryText));
        if (state.count === 0) state.count = 1;
    }
    if (document.actions.length > 0) {
        addArea(container, state, () => addRows(container, document.actions), layout.separator);
    }
    return container;
}

function buildPaginationBudgetRow(componentCount = 3) {
    const buttons = Array.from({ length: Math.max(1, Math.min(componentCount, 5)) }, (_, index) =>
        new Discord.ButtonBuilder()
            .setCustomId(`ux-budget-${index}`)
            .setLabel(index === 1 ? 'Page 1/2' : String(index + 1))
            .setStyle(Discord.ButtonStyle.Secondary)
            .setDisabled(index === 1));
    return new Discord.ActionRowBuilder().addComponents(...buttons);
}

function buildComponentPages(document, options) {
    if (document.kind === 'notice') return [[buildNoticeContainer(document)]];
    if (document.kind === 'challenge-screen') return [[buildChallengeContainer(document)]];
    if (document.kind !== 'ux-panel') throw new Error(`Unsupported Components V2 UX document: ${document.kind}`);

    const full = [buildUXPanelContainer(document, document.editorBlocks)];
    if (countComponents(full) <= DISCORD_MESSAGE_LIMITS.componentsV2) return [full];
    if (document.editorBlocks.length < 2) {
        throw new Error('One UX editor area exceeds Discord\'s 40-component limit and cannot be split safely.');
    }
    if (typeof options.paginationRowFactory !== 'function') {
        throw new Error('UX panel pagination requires a paginationRowFactory.');
    }

    // The inert budget row is intentionally route-free. Only final rows may
    // allocate session routes through paginationRowFactory.
    const budgetRow = buildPaginationBudgetRow(options.paginationButtonCount ?? 3);
    const pageBlocks = partitionBlocksByBudget({
        blocks: document.editorBlocks,
        fits: (blocks) => {
            const candidate = [buildUXPanelContainer(document, blocks, budgetRow)];
            return countComponents(candidate) <= DISCORD_MESSAGE_LIMITS.componentsV2;
        },
        createOversizedBlockError: () => new Error(
            'One UX editor block exceeds Discord\'s 40-component limit and cannot be split safely.',
        ),
    });
    return pageBlocks.map((blocks, page) => {
        const row = options.paginationRowFactory({ page, pageCount: pageBlocks.length, document });
        const components = [buildUXPanelContainer(document, blocks, row)];
        assertComponentBudget(components);
        return components;
    });
}

function renderComponentsV2(document, options = {}) {
    assertComponentsV2Support();
    getLayout(document?.kind);
    assertDocumentAttachmentExposure(document);
    const pages = buildComponentPages(document, options);
    for (const components of pages) assertComponentBudget(components);

    const flags = Discord.MessageFlags.IsComponentsV2
        | (document.ephemeral ? Discord.MessageFlags.Ephemeral : 0);
    return {
        payload: {
            content: null,
            embeds: [],
            components: pages[0],
            files: document.files,
            allowedMentions: { parse: [] },
            flags,
        },
        pages,
    };
}

module.exports = {
    renderComponentsV2,
};
