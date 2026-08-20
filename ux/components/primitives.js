'use strict';

const Discord = require('discord.js');
const { DISCORD_MESSAGE_LIMITS } = require('./budget');

const TEXT_DISPLAY_LIMIT = 4000;

function assertComponentsV2Support() {
    const required = [
        'ActionRowBuilder',
        'ContainerBuilder',
        'MediaGalleryBuilder',
        'MediaGalleryItemBuilder',
        'SectionBuilder',
        'SeparatorBuilder',
        'TextDisplayBuilder',
    ];
    if (required.some((name) => typeof Discord[name] !== 'function') || !Discord.MessageFlags?.IsComponentsV2) {
        throw new Error('Discord Components V2 are not available in this discord.js version.');
    }
}

function truncateText(value, limit = TEXT_DISPLAY_LIMIT) {
    const content = String(value ?? '');
    if (content.length <= limit) return content;
    const suffix = '\n… [truncated]';
    return `${content.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function resolveAccentColor(color) {
    if (color === undefined || color === null || color === '') return undefined;
    if (Number.isInteger(color) && color >= 0 && color <= 0xFFFFFF) return color;
    const match = /^#?([\da-f]{6})$/i.exec(String(color));
    if (!match) throw new Error(`Invalid UX accent color: ${color}`);
    return Number.parseInt(match[1], 16);
}

function buildTextDisplay(content) {
    const normalized = String(content ?? '').trim();
    if (!normalized) throw new Error('Discord text displays cannot be empty.');
    return new Discord.TextDisplayBuilder().setContent(truncateText(normalized));
}

function buildSeparator({ divider = true, spacing = 'Large' } = {}) {
    const spacingValue = typeof spacing === 'number'
        ? spacing
        : Discord.SeparatorSpacingSize?.[spacing] ?? Discord.SeparatorSpacingSize.Large;
    return new Discord.SeparatorBuilder().setDivider(divider).setSpacing(spacingValue);
}

function buildActionRow(row) {
    const data = row?.toJSON?.() ?? row;
    if (data?.type !== Discord.ComponentType.ActionRow) throw new Error('UX action entries must be Discord action rows.');
    const components = data.components ?? [];
    if (components.length < 1 || components.length > DISCORD_MESSAGE_LIMITS.actionRowComponents) {
        throw new Error(`Discord action rows require 1-${DISCORD_MESSAGE_LIMITS.actionRowComponents} components.`);
    }
    if (components.some((component) => component.type !== Discord.ComponentType.Button) && components.length !== 1) {
        throw new Error('Discord select menus must be the only component in their action row.');
    }
    for (const component of components) {
        if (component.custom_id && String(component.custom_id).length > DISCORD_MESSAGE_LIMITS.customIdLength) {
            throw new Error(`Discord component custom IDs cannot exceed ${DISCORD_MESSAGE_LIMITS.customIdLength} characters.`);
        }
        if (component.options?.length > DISCORD_MESSAGE_LIMITS.selectOptions) {
            throw new Error(`Discord select menus support at most ${DISCORD_MESSAGE_LIMITS.selectOptions} options.`);
        }
    }
    return new Discord.ActionRowBuilder(data);
}

function buildSection({ content = [], accessory } = {}) {
    const displays = [].concat(content).map((value) => String(value ?? '').trim()).filter(Boolean);
    if (displays.length < 1 || displays.length > DISCORD_MESSAGE_LIMITS.sectionTextDisplays) {
        throw new Error(`Discord sections require 1-${DISCORD_MESSAGE_LIMITS.sectionTextDisplays} text displays.`);
    }
    if (!accessory) throw new Error('Discord sections require a button or thumbnail accessory.');

    const section = new Discord.SectionBuilder().addTextDisplayComponents(...displays.map(buildTextDisplay));
    const accessoryData = accessory?.toJSON?.() ?? accessory;
    if (accessoryData?.type === Discord.ComponentType.Button) {
        section.setButtonAccessory(new Discord.ButtonBuilder(accessoryData));
    }
    else if (accessoryData?.type === Discord.ComponentType.Thumbnail) {
        section.setThumbnailAccessory(new Discord.ThumbnailBuilder(accessoryData));
    }
    else {
        throw new Error('Discord section accessories must be buttons or thumbnails.');
    }
    return section;
}

function buildGallery(items = []) {
    if (items.length < 1 || items.length > DISCORD_MESSAGE_LIMITS.galleryItems) {
        throw new Error(`Discord media galleries require 1-${DISCORD_MESSAGE_LIMITS.galleryItems} items.`);
    }
    const gallery = new Discord.MediaGalleryBuilder();
    for (const item of items) {
        const media = new Discord.MediaGalleryItemBuilder().setURL(item.url);
        if (item.description) media.setDescription(truncateText(item.description, 256));
        if (item.spoiler) media.setSpoiler(true);
        gallery.addItems(media);
    }
    return gallery;
}

function addBlocks(container, blocks = [], { separator } = {}) {
    let count = 0;
    let previousKind;
    for (const block of blocks) {
        if (count > 0 && separator && block.kind !== 'separator' && previousKind !== 'separator') {
            container.addSeparatorComponents(buildSeparator(separator));
        }
        if (block.kind === 'text') container.addTextDisplayComponents(buildTextDisplay(block.content));
        else if (block.kind === 'separator') {
            container.addSeparatorComponents(buildSeparator({ divider: block.divider, spacing: block.spacing }));
        }
        else if (block.kind === 'section') {
            if (block.accessory) container.addSectionComponents(buildSection(block));
            else container.addTextDisplayComponents(...block.content.map(buildTextDisplay));
        }
        else if (block.kind === 'gallery') container.addMediaGalleryComponents(buildGallery(block.items));
        else if (block.kind === 'actions') container.addActionRowComponents(...block.rows.map(buildActionRow));
        else if (block.kind === 'group') addBlocks(container, block.blocks);
        else throw new Error(`Unsupported UX block kind: ${block.kind}`);
        count += 1;
        previousKind = block.kind;
    }
    return count;
}

module.exports = {
    addBlocks,
    assertComponentsV2Support,
    buildActionRow,
    buildSection,
    buildSeparator,
    buildTextDisplay,
    resolveAccentColor,
    truncateText,
};
