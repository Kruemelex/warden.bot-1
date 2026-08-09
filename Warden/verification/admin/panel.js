'use strict';

const { createVerificationLogger } = require('../logging');
const { getIdentityBrandColor } = require('../../../functions');
const { createAdminPanelDocument } = require('../../../ux/documents');
const { renderComponentsV2 } = require('../../../ux/renderers/componentsV2');
const { createPanelSessionRegistry } = require('../../../ux/interactions/sessions');
const { createPagination } = require('../../../ux/interactions/pagination');
const {
    completePanelInteraction,
    deferSourceUpdate,
    sanitizeMessageEditOptions,
} = require('../../../ux/interactions/acknowledgement');

const ADMIN_PAGINATION_METADATA = 'verificationAdminPagination';
const PANEL_PAYLOAD_METADATA = Symbol('verificationAdminPanel');
const adminPanelLog = createVerificationLogger('Admin UX');

const panelSessions = createPanelSessionRegistry({
    prefix: 'wVA',
    label: 'Verification Admin',
    maxEntries: 250,
});

const adminPagination = createPagination({
    action: 'adminPage',
    buildStateCustomId: (action, parts, state) =>
        state.pagination.panelSession.buildState(action, parts, state),
    parseCustomId: panelSessions.parse,
    metadataProperty: ADMIN_PAGINATION_METADATA,
    copy: {
        expired: 'This verification admin panel page has expired. Re-run the command to reopen it.',
        wrongOwner: 'This verification admin panel belongs to another user.',
        wrongGuild: 'This verification admin panel belongs to another server.',
        unavailable: 'This verification admin panel page is no longer available.',
    },
    reporter: adminPanelLog,
});

function createVerificationAdminPanelSession({ guildId, ownerUserId, state = {} } = {}) {
    return panelSessions.create({ guildId, ownerUserId, state });
}

function parseVerificationAdminCustomId(customId) {
    return panelSessions.parse(customId);
}

function truncateAdminFieldValue(value, maxLength = 1024) {
    const text = String(value ?? 'Not set');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function chunkAdminDisplayLines(lines, maxLength = 3_700, maxChunks = 3) {
    const chunks = [];
    let chunk = [];
    let length = 0;
    for (const line of lines) {
        const normalizedLine = truncateAdminFieldValue(line, maxLength);
        const nextLength = length + normalizedLine.length + (chunk.length > 0 ? 1 : 0);
        if (chunk.length > 0 && nextLength > maxLength) {
            chunks.push(chunk);
            chunk = [];
            length = 0;
        }
        chunk.push(normalizedLine);
        length += normalizedLine.length + (chunk.length > 1 ? 1 : 0);
    }
    if (chunk.length > 0) chunks.push(chunk);
    if (chunks.length <= maxChunks) return chunks;
    const visibleChunks = chunks.slice(0, Math.max(0, maxChunks - 1));
    const hiddenLineCount = chunks.slice(Math.max(0, maxChunks - 1)).flat().length;
    return [
        ...visibleChunks,
        [`… ${hiddenLineCount} additional item${hiddenLineCount === 1 ? '' : 's'} omitted.`],
    ];
}

function buildAdminEditorSection(title, value, accessory) {
    const lines = Array.isArray(value) ? value : [value];
    const chunks = chunkAdminDisplayLines(lines);
    return {
        kind: 'section',
        content: chunks.map((chunk, index) => index === 0
            ? `${title ? `### ${title}\n` : ''}${chunk.join('\n') || 'Not set'}`
            : chunk.join('\n')),
        accessory,
    };
}

function formatDiscordLocalTimestamp(value) {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
    if (!Number.isFinite(timestamp)) return String(value ?? 'Unknown time');
    return `<t:${Math.floor(timestamp / 1000)}:f>`;
}

function buildUpdatedAuditField({ updatedAt, updatedBy } = {}) {
    if (!updatedAt) return [];
    return [{
        name: 'Updated',
        value: `${formatDiscordLocalTimestamp(updatedAt)}${updatedBy ? ` by <@${updatedBy}>` : ''}`,
        inline: false,
    }];
}

function buildActiveChallengeIdsValue(verificationSettings) {
    return verificationSettings.activeChallengeIds?.length
        ? verificationSettings.activeChallengeIds.map((challengeId) => `- ${challengeId}`).join('\n')
        : 'None';
}

function formatList(values, empty = 'Not set') {
    return values?.length ? values.map((value) => `- ${value}`).join('\n') : empty;
}

function formatJson(value) {
    if (!value || (typeof value === 'object' && Object.keys(value).length < 1)) return 'Not set';
    return '```json\n' + JSON.stringify(value, null, 2).slice(0, 950) + '\n```';
}

function normalizeFields(fields = []) {
    return fields.filter(Boolean).map((field) => ({
        name: truncateAdminFieldValue(field.name ?? field.title ?? 'Information', 256),
        value: truncateAdminFieldValue(
            field.value ?? field.content ?? field.description ?? 'Not set',
        ),
        inline: field.inline === true,
    }));
}

function buildEditorBlocks({
    leadingActions = [],
    sections = [],
    galleries = [],
    selectionPrompts = [],
    selectionActions = [],
} = {}) {
    const blocks = [
        ...leadingActions.map((row) => ({ kind: 'actions', rows: [row] })),
        ...sections,
        ...galleries,
    ];
    if (selectionPrompts.length > 0 || selectionActions.length > 0) {
        blocks.push({
            kind: 'group',
            blocks: [
                ...selectionPrompts.map((content) => ({ kind: 'text', content })),
                ...(selectionActions.length > 0
                    ? [{ kind: 'actions', rows: selectionActions }]
                    : []),
            ],
        });
    }
    return blocks;
}

/**
 * Compose and render one owner/guild-bound Verification Admin panel. The
 * callback receives the only session that may allocate routes for the panel.
 */
function buildVerificationAdminPanel({
    guildId,
    ownerUserId,
    key,
    state = {},
    compose,
} = {}) {
    if (typeof compose !== 'function') {
        throw new Error('Verification Admin panels require a compose callback.');
    }
    const panelSession = createVerificationAdminPanelSession({ guildId, ownerUserId, state });
    try {
        const panel = compose(panelSession) ?? {};
        const paginationSession = adminPagination.createSession({
            guildId,
            ownerUserId,
            key,
            panelSession,
        });
        const document = createAdminPanelDocument({
            title: panel.title,
            description: panel.description,
            accentColor: panel.accentColor
                ?? getIdentityBrandColor('Warden'),
            fields: normalizeFields([
                ...(panel.fields ?? []),
                ...(panel.trailingFields ?? []),
            ]),
            editorBlocks: buildEditorBlocks(panel),
            actions: panel.actions ?? [],
            navigationActions: panel.navigationActions ?? [],
            files: panel.files ?? [],
            footer: panel.footer,
            ephemeral: true,
            pagination: { key: String(key ?? '') },
        });
        const rendered = renderComponentsV2(document, {
            paginationRowFactory: ({ page, pageCount }) =>
                adminPagination.buildRow(paginationSession, page, pageCount),
        });
        let payload = sanitizeMessageEditOptions(rendered.payload);
        // Every panel is delivered through message edit. Explicitly retire
        // files from the source panel before attaching this panel's files.
        payload.attachments = [];
        if (rendered.pages.length > 1) {
            adminPagination.setPages(paginationSession, rendered.pages);
            payload = adminPagination.attachPages(payload, rendered.pages, key);
        }
        Object.defineProperty(payload, PANEL_PAYLOAD_METADATA, {
            value: Object.freeze({ panelSession }),
            enumerable: false,
        });
        return payload;
    }
    catch (error) {
        panelSession.dispose();
        throw error;
    }
}

function disposePanelPayload(payload) {
    payload?.[PANEL_PAYLOAD_METADATA]?.panelSession?.dispose();
}

function markAdminPanelSuccess(panelPayload) {
    const children = panelPayload?.components
        ?.flatMap((container) => container?.data?.components ?? container?.components ?? []);
    const updatedField = children?.findLast?.((component) =>
        String(component?.data?.content ?? component?.content ?? '').startsWith('### Updated\n'));
    if (!updatedField) return panelPayload;

    const current = String(updatedField.data?.content ?? updatedField.content);
    if (current.startsWith('### Updated\n✅ ')) return panelPayload;
    const next = `### Updated\n✅ ${current.slice('### Updated\n'.length)}`;
    if (typeof updatedField.setContent === 'function') updatedField.setContent(next);
    else if (updatedField.data) updatedField.data.content = next;
    else updatedField.content = next;
    return panelPayload;
}

/**
 * Replace a panel without retiring recoverable navigation on delivery errors.
 * A committed mutation is different: its source session is invalidated before
 * any destination rendering so stale controls can never mutate fresh state.
 */
async function replaceAdminPanel(interaction, {
    sourcePanelSession,
    buildPayload,
    committed = false,
    preservePage = true,
    markSuccess = committed,
} = {}) {
    if (typeof buildPayload !== 'function') {
        throw new Error('Verification Admin panel replacement requires a payload builder.');
    }
    const visibleState = preservePage
        ? adminPagination.getVisibleState(interaction.message)
        : undefined;
    if (committed) {
        completePanelInteraction(interaction);
        sourcePanelSession?.dispose();
    }

    let payload;
    try {
        payload = await buildPayload();
        adminPagination.selectPayloadPageFromState(payload, visibleState);
        if (markSuccess) markAdminPanelSuccess(payload);
        const response = await interaction.editReply(sanitizeMessageEditOptions(payload));
        if (!committed) sourcePanelSession?.dispose();
        return response;
    }
    catch (error) {
        disposePanelPayload(payload);
        throw error;
    }
}

async function acknowledgeAdminPanelRender(interaction, showLoading) {
    return adminPagination.acknowledgeRender(interaction, deferSourceUpdate, showLoading);
}

module.exports = {
    ADMIN_PAGINATION_LABELS: adminPagination.labels,
    acknowledgeAdminPanelRender,
    buildActiveChallengeIdsValue,
    buildAdminEditorSection,
    buildAdminPaginationButton: adminPagination.buildButton,
    buildUpdatedAuditField,
    buildVerificationAdminPanel,
    formatJson,
    formatList,
    handleAdminPaginationInteraction: adminPagination.handleInteraction,
    parseVerificationAdminCustomId,
    replaceAdminPanel,
    restoreAdminPanelComponents: adminPagination.restoreComponents,
    truncateAdminFieldValue,
};
