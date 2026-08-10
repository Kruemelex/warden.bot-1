'use strict';

const Discord = require('discord.js');
const {
    buildLoadingComponents,
    snapshotMessageComponents,
} = require('../components/state');

const DEFAULT_LABELS = Object.freeze({ previous: '<', next: '>' });
const DEFAULT_COPY = Object.freeze({
    expired: 'This panel page has expired. Reopen the panel and try again.',
    wrongOwner: 'This panel belongs to another user.',
    wrongGuild: 'This panel belongs to another server.',
    unavailable: 'This panel page is no longer available.',
});

/**
 * @typedef {object} PaginationSession
 * @property {string|undefined} guildId Optional guild boundary for component interactions.
 * @property {string|undefined} ownerUserId Optional user boundary for component interactions.
 * @property {string} key Stable identity used to preserve the visible page across rerenders.
 * @property {Array<Array<object>>} pages Serialized Discord component pages.
 */

/**
 * @typedef {object} PaginationMetadata
 * @property {string} key Stable pagination identity.
 * @property {Array<Array<unknown>>} pages Component pages attached to an outgoing payload.
 */

/**
 * Build reusable Discord component-pagination mechanics around a feature's
 * custom-ID session store. Feature-specific page composition remains outside
 * this module.
 *
 * @param {object} options
 * @param {string} options.action Routed custom-ID action for page buttons.
 * @param {(action: string, parts: string[], state: object) => string} options.buildStateCustomId
 * @param {(customId: string) => ({action?: string, state?: object}|null)} options.parseCustomId
 * @param {{previous?: string, next?: string}} [options.labels]
 * @param {{expired?: string, wrongOwner?: string, wrongGuild?: string, unavailable?: string}} [options.copy]
 * @param {string} [options.metadataProperty] Non-enumerable payload metadata property.
 * @param {(error: Error) => void} [options.onRestoreError]
 * @param {{warn?: (action: string, error: Error) => void}} [options.reporter]
 */
function createPagination({
    action,
    buildStateCustomId,
    parseCustomId,
    labels = {},
    copy = {},
    metadataProperty = 'uxPagination',
    onRestoreError,
    reporter,
} = {}) {
    const normalizedAction = String(action ?? '').trim();
    if (!normalizedAction) throw new Error('Panel pagination requires a routed action.');
    if (typeof buildStateCustomId !== 'function' || typeof parseCustomId !== 'function') {
        throw new Error('Panel pagination requires custom-ID build and parse functions.');
    }

    const resolvedLabels = Object.freeze({ ...DEFAULT_LABELS, ...labels });
    const resolvedCopy = Object.freeze({ ...DEFAULT_COPY, ...copy });
    const reportRestoreError = onRestoreError ?? ((error) => {
        if (reporter?.warn) reporter.warn('Failed to restore panel pagination after render error', error);
        else console.warn('Failed to restore panel pagination after render error:', error);
    });

    /** @returns {PaginationSession} */
    function createSession({ guildId, ownerUserId, key, panelSession } = {}) {
        return {
            guildId: guildId === undefined ? undefined : String(guildId),
            ownerUserId: ownerUserId === undefined ? undefined : String(ownerUserId),
            key: String(key ?? ''),
            panelSession,
            pages: [],
        };
    }

    function setPages(session, pages) {
        session.pages = pages.map((components) => components.map((component) => component?.toJSON?.() ?? component));
    }

    function buildButton(customId, label, disabled = false) {
        return new Discord.ButtonBuilder()
            .setCustomId(customId)
            .setLabel(label)
            .setStyle(Discord.ButtonStyle.Secondary)
            .setDisabled(disabled);
    }

    function buildRow(session, page, pageCount) {
        return new Discord.ActionRowBuilder().addComponents(
            buildButton(
                buildStateCustomId(normalizedAction, [], { pagination: session, page: page - 1 }),
                resolvedLabels.previous,
                page <= 0,
            ),
            buildButton(
                buildStateCustomId(normalizedAction, [], { pagination: session, page }),
                `Page ${page + 1}/${pageCount}`,
                true,
            ),
            buildButton(
                buildStateCustomId(normalizedAction, [], { pagination: session, page: page + 1 }),
                resolvedLabels.next,
                page >= pageCount - 1,
            ),
        );
    }

    function getPage(session, page) {
        if (!session) throw new Error(resolvedCopy.expired);
        const pageIndex = Math.max(0, Math.min(Number(page) || 0, session.pages.length - 1));
        return { session, page: pageIndex, components: session.pages[pageIndex] };
    }

    async function handleInteraction(interaction, parts, state = {}) {
        const { session, components } = getPage(state.pagination, state.page);
        if (session.ownerUserId && String(interaction.user?.id) !== session.ownerUserId) {
            throw new Error(resolvedCopy.wrongOwner);
        }
        if (session.guildId && String(interaction.guild?.id ?? '') !== session.guildId) {
            throw new Error(resolvedCopy.wrongGuild);
        }
        if (!components) throw new Error(resolvedCopy.unavailable);

        return interaction.update({ components });
    }

    function attachPages(payload, pages, key) {
        Object.defineProperty(payload, metadataProperty, {
            value: { key: String(key ?? ''), pages },
            enumerable: false,
        });
        return payload;
    }

    function getVisibleState(message) {
        const stack = (message?.components ?? []).map((component) => component?.toJSON?.() ?? component);
        while (stack.length > 0) {
            const component = stack.pop();
            if (!component) continue;
            if (
                component.type === Discord.ComponentType.Button
                && component.disabled === true
                && String(component.label ?? '').startsWith('Page ')
            ) {
                const parsed = parseCustomId(component.custom_id);
                if (parsed?.action === normalizedAction) return parsed.state;
            }
            if (Array.isArray(component.components)) stack.push(...component.components);
            if (component.accessory) stack.push(component.accessory);
        }
        return undefined;
    }

    function selectPayloadPage(payload, sourceMessage) {
        /** @type {PaginationMetadata|undefined} */
        const pagination = payload?.[metadataProperty];
        const pages = pagination?.pages;
        if (!Array.isArray(pages) || pages.length < 2) return payload;
        const visibleState = getVisibleState(sourceMessage);
        return selectPayloadPageFromState(payload, visibleState);
    }

    function selectPayloadPageFromState(payload, visibleState) {
        /** @type {PaginationMetadata|undefined} */
        const pagination = payload?.[metadataProperty];
        const pages = pagination?.pages;
        if (!Array.isArray(pages) || pages.length < 2) return payload;
        if (!visibleState?.pagination || visibleState.pagination.key !== pagination.key) return payload;
        const requestedPage = Number(visibleState.page ?? 0);
        const page = Math.max(0, Math.min(Number.isInteger(requestedPage) ? requestedPage : 0, pages.length - 1));
        payload.components = pages[page];
        return payload;
    }

    async function acknowledgeRender(interaction, deferSourceUpdate, showLoading) {
        if (!showLoading || typeof interaction.update !== 'function') {
            await deferSourceUpdate(interaction);
            return undefined;
        }

        const originalComponents = snapshotMessageComponents(interaction.message);
        if (originalComponents.length < 1) {
            await deferSourceUpdate(interaction);
            return undefined;
        }
        await interaction.update({
            components: buildLoadingComponents(originalComponents, interaction.customId),
        });
        return originalComponents;
    }

    async function restoreComponents(interaction, originalComponents) {
        if (!originalComponents) return;
        await interaction.editReply({ components: originalComponents }).catch(reportRestoreError);
    }

    return Object.freeze({
        labels: resolvedLabels,
        acknowledgeRender,
        attachPages,
        buildButton,
        buildRow,
        createSession,
        handleInteraction,
        restoreComponents,
        getVisibleState,
        selectPayloadPage,
        selectPayloadPageFromState,
        setPages,
    });
}

module.exports = {
    createPagination,
};
