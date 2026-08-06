'use strict';

const Discord = require('discord.js');
const {
    assertAttachmentExposure,
    assertReferencedAttachments,
    getAttachmentFileName,
    getAttachmentReferences,
} = require('../attachments');
const { DISCORD_MESSAGE_LIMITS } = require('../components/budget');
const { buildActionRow, resolveAccentColor, truncateText } = require('../components/primitives');
const { getLayout } = require('../layouts');

const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_FIELD_NAME_LIMIT = 256;
const EMBED_FIELD_VALUE_LIMIT = 1024;

function assertLegacyMessage(existingFlags = 0) {
    if ((Number(existingFlags) & Discord.MessageFlags.IsComponentsV2) !== 0) {
        throw new Error('A Components V2 message cannot be converted back to the legacy message format.');
    }
}

function selectPageFiles(documentFiles, embeds) {
    const references = getAttachmentReferences(embeds.map((embed) => embed.toJSON()));
    const files = documentFiles.filter((file) => references.has(getAttachmentFileName(file)));
    if (files.length > DISCORD_MESSAGE_LIMITS.attachments) {
        throw new Error(`Legacy message page requires ${files.length} files; Discord allows ${DISCORD_MESSAGE_LIMITS.attachments}.`);
    }
    assertReferencedAttachments(files, references);
    return files;
}

function applyColor(embed, color) {
    const accent = resolveAccentColor(color);
    if (accent !== undefined) embed.setColor(accent);
    return embed;
}

function fieldData(field) {
    return {
        name: truncateText(field.name || 'Information', EMBED_FIELD_NAME_LIMIT),
        value: truncateText(field.value || '\u200B', EMBED_FIELD_VALUE_LIMIT),
        inline: field.inline === true,
    };
}

function appendExpiry(description, expiryText) {
    const body = String(description ?? '').trim();
    return truncateText([body, expiryText].filter(Boolean).join('\n\n'), EMBED_DESCRIPTION_LIMIT);
}

function buildNoticeEmbeds(document) {
    const fieldPages = [];
    for (let index = 0; index < document.fields.length; index += DISCORD_MESSAGE_LIMITS.embedFields) {
        fieldPages.push(document.fields.slice(index, index + DISCORD_MESSAGE_LIMITS.embedFields));
    }
    if (fieldPages.length < 1) fieldPages.push([]);
    return fieldPages.map((fields, page) => {
        const embed = applyColor(new Discord.EmbedBuilder(), document.accentColor);
        if (document.title) embed.setTitle(truncateText(
            page === 0 ? document.title : `${document.title} (continued)`,
            256,
        ));
        if (page === 0 && document.message) embed.setDescription(truncateText(document.message, EMBED_DESCRIPTION_LIMIT));
        if (fields.length > 0) embed.addFields(...fields.map(fieldData));
        if (page === 0 && document.thumbnailUrl) embed.setThumbnail(document.thumbnailUrl);
        if (page === 0 && document.author?.name) embed.setAuthor(document.author);
        if (document.footer) embed.setFooter({ text: truncateText(document.footer, 2048) });
        if (document.timestamp) embed.setTimestamp();
        return embed;
    });
}

function editorBlockToEmbeds(block, document) {
    if (block.kind === 'group') return block.blocks.flatMap((child) => editorBlockToEmbeds(child, document));
    if (block.kind === 'actions') return [];
    if (block.kind === 'gallery') {
        return block.items.map((item) => {
            const embed = applyColor(new Discord.EmbedBuilder().setImage(item.url), document.accentColor);
            if (item.description) embed.setDescription(truncateText(item.description, EMBED_DESCRIPTION_LIMIT));
            return embed;
        });
    }
    const content = block.kind === 'section' ? block.content.join('\n') : block.content;
    return [applyColor(new Discord.EmbedBuilder().setDescription(truncateText(content, EMBED_DESCRIPTION_LIMIT)), document.accentColor)];
}

function buildAdminEmbeds(document) {
    const summary = applyColor(new Discord.EmbedBuilder()
        .setTitle(truncateText(document.title, 256)), document.accentColor);
    if (document.description) summary.setDescription(truncateText(document.description, EMBED_DESCRIPTION_LIMIT));
    if (document.fields.length > 0) {
        summary.addFields(...document.fields.slice(0, DISCORD_MESSAGE_LIMITS.embedFields).map(fieldData));
    }
    if (document.footer) summary.setFooter({ text: truncateText(document.footer, 2048) });

    const extraFieldEmbeds = [];
    for (let index = DISCORD_MESSAGE_LIMITS.embedFields; index < document.fields.length; index += DISCORD_MESSAGE_LIMITS.embedFields) {
        extraFieldEmbeds.push(applyColor(new Discord.EmbedBuilder()
            .setTitle(`${truncateText(document.title, 240)} (continued)`)
            .addFields(...document.fields.slice(index, index + DISCORD_MESSAGE_LIMITS.embedFields).map(fieldData)), document.accentColor));
    }
    return [summary, ...extraFieldEmbeds, ...document.editorBlocks.flatMap((block) => editorBlockToEmbeds(block, document))];
}

function buildChallengeEmbeds(document) {
    const embeds = [];
    if (document.includeIntro) {
        const intro = applyColor(new Discord.EmbedBuilder()
            .setTitle(truncateText(document.title, 256)), document.accentColor);
        if (document.description || document.expiryText) {
            intro.setDescription(appendExpiry(document.description, document.expiryText));
        }
        if (document.fields.length > 0) {
            intro.addFields(...document.fields.slice(0, DISCORD_MESSAGE_LIMITS.embedFields).map(fieldData));
        }
        embeds.push(intro);
    }

    for (const question of document.questions) {
        const description = [question.text, question.helpText, question.progressText]
            .filter(Boolean)
            .join('\n\n');
        const embed = applyColor(new Discord.EmbedBuilder()
            .setTitle(truncateText(question.label, 256))
            .setDescription(appendExpiry(description, document.expiryText) || '\u200B'), document.accentColor);
        if (question.inlineMedia && question.media[0]) embed.setImage(question.media[0].url);
        embeds.push(embed);
        for (const item of question.media.slice(question.inlineMedia ? 1 : 0)) {
            const mediaEmbed = applyColor(new Discord.EmbedBuilder().setImage(item.url), document.accentColor);
            if (item.description) mediaEmbed.setTitle(truncateText(item.description, 256));
            embeds.push(mediaEmbed);
        }
    }
    if (embeds.length < 1) {
        embeds.push(applyColor(new Discord.EmbedBuilder()
            .setTitle(truncateText(document.title, 256))
            .setDescription(appendExpiry(document.description, document.expiryText) || '\u200B'), document.accentColor));
    }
    return embeds;
}

function collectActionRows(document) {
    const editorRows = document.kind === 'admin-panel'
        ? document.editorBlocks.flatMap(function rows(block) {
            if (block.kind === 'actions') return block.rows;
            if (block.kind === 'group') return block.blocks.flatMap(rows);
            return [];
        })
        : [];
    return [...editorRows, ...(document.actions ?? []), ...(document.navigationActions ?? [])].map(buildActionRow);
}

function renderLegacy(document, { existingFlags = 0 } = {}) {
    assertLegacyMessage(existingFlags);
    getLayout(document?.kind);
    let embeds;
    if (document.kind === 'notice') embeds = buildNoticeEmbeds(document);
    else if (document.kind === 'admin-panel') embeds = buildAdminEmbeds(document);
    else if (document.kind === 'challenge-screen') embeds = buildChallengeEmbeds(document);
    else throw new Error(`Unsupported legacy UX document: ${document.kind}`);

    const rows = collectActionRows(document);
    if (rows.length > DISCORD_MESSAGE_LIMITS.actionRows) {
        throw new Error(`Legacy messages support at most ${DISCORD_MESSAGE_LIMITS.actionRows} action rows.`);
    }
    const pages = [];
    for (let index = 0; index < embeds.length; index += DISCORD_MESSAGE_LIMITS.embeds) {
        const pageEmbeds = embeds.slice(index, index + DISCORD_MESSAGE_LIMITS.embeds);
        pages.push({
            embeds: pageEmbeds,
            components: index === 0 ? rows : [],
            files: selectPageFiles(document.files, pageEmbeds),
            allowedMentions: { parse: [] },
            flags: document.ephemeral ? Discord.MessageFlags.Ephemeral : undefined,
        });
    }

    const referencedFiles = new Set(pages.flatMap((page) => page.files.map(getAttachmentFileName)));
    assertAttachmentExposure(document.files, referencedFiles);
    return { payload: pages[0], pages };
}

module.exports = {
    renderLegacy,
};
