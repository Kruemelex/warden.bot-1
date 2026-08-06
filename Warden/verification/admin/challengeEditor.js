'use strict';

const Discord = require('discord.js');
const {
    acknowledgePanelInteraction,
    deferSourceUpdate,
} = require('../../ux/interactions/acknowledgement');
const {
    buildExistingTextField,
    buildModal: buildAdminModal,
    buildModalTextLabel,
    buildStringSelectComponent,
    getModalTextInput,
} = require('../../ux/components/modalFields');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const {
    ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
    isChallengeActive,
} = require('../domain/activeChallengePolicy');
const {
    buildVerificationAdminNotice,
} = require('../presentation/adminNotices');
const {
    createCustomChallenge,
    deleteOrResetChallenge,
    deleteOrResetQuestion,
    getVerificationAdminChallenge,
    getVerificationSnapshot,
    updateCatalogChallengeMetadata,
} = require('../service');
const { startVerificationChallengePreview } = require('../runtime/previewFlow');
const { resolveBaselineEdit } = require('./edits');
const {
    buildActiveChallengeIdsValue,
    buildAdminEditorSection,
    buildUpdatedAuditField,
    buildVerificationAdminPanel,
    replaceAdminPanel,
    truncateAdminFieldValue,
} = require('./panel');
const {
    respondAdminError,
    respondAdminModalError,
    respondAdminNoChanges,
    userErrorEmbed,
} = require('./feedback');
const {
    buildChallengeAuditFields,
    buildQuestionCatalogValue,
    buildQuestionManagementSections,
    buildQuestionSelectionComponents,
    buildQuestionSelectionPrompt,
} = require('./questionPanel');

const CHALLENGE_TITLE_MAX_LENGTH = 256;
const CHALLENGE_DESCRIPTION_MAX_LENGTH = 4000;

function buildAvailableChallengeIdsValue(challenges, enabledChallengeIds) {
    const challengeList = Object.values(challenges)
        .map(challenge => `- ${enabledChallengeIds.includes(challenge.id) ? '**' : ''}${challenge.id}${enabledChallengeIds.includes(challenge.id) ? '** [active]' : ''}`)
        .join('\n');
    return challengeList || 'None';
}

function getChallengeSelectOptions(challenges) {
    return Object.values(challenges).map((challenge) => ({
        label: challenge.id || challenge.title,
        value: String(challenge.id),
        description: challenge.title || challenge.id,
    }));
}

function assertChallengeSelectMenuLimit(challenges) {
    const count = Object.values(challenges).length;
    if (count > VERIFICATION_UI_LIMITS.selectOptions) {
        throw new Error(`There are ${count} configured challenges, but Verification Admin supports at most ${VERIFICATION_UI_LIMITS.selectOptions}.`);
    }
}

function buildChallengeSelectRow(guildId, ownerUserId, challenges, panelSession) {
    assertChallengeSelectMenuLimit(challenges);
    return new Discord.ActionRowBuilder().addComponents(buildStringSelectComponent({
        customId: panelSession.build('challengeSelect', guildId, ownerUserId),
        placeholder: 'Choose a challenge...',
        options: getChallengeSelectOptions(challenges),
    }));
}

function buildChallengesPanelPayload({ verificationSettings, challenges, guildId, ownerUserId }) {
    return buildVerificationAdminPanel({
        guildId,
        ownerUserId,
        key: `challenges:${guildId}`,
        state: {
            panelViewModel: Object.freeze({ verificationSettings, challenges }),
        },
        compose: (panelSession) => {
            const enabledChallengeIds = verificationSettings.activeChallengeIds ?? [];
            const challengeLimitReached = Object.values(challenges).length
                >= VERIFICATION_UI_LIMITS.selectOptions;
            const createButton = new Discord.ButtonBuilder()
                .setCustomId(panelSession.build('challengeCreate', guildId, ownerUserId))
                .setLabel(challengeLimitReached ? 'Challenge Limit Reached' : 'Create Challenge')
                .setStyle(Discord.ButtonStyle.Success)
                .setDisabled(challengeLimitReached);
            return {
                title: 'Verification Challenges Configuration',
                description: 'Configured verification challenges.',
                fields: [{
                    name: 'Active Challenges',
                    value: buildActiveChallengeIdsValue(verificationSettings),
                    inline: false,
                }],
                sections: [buildAdminEditorSection(
                    'Available Challenges',
                    buildAvailableChallengeIdsValue(challenges, enabledChallengeIds),
                    createButton,
                )],
                selectionPrompts: [
                    '### Select to continue\nChoose a challenge from the list above to open its interactive challenge editor.',
                ],
                selectionActions: [buildChallengeSelectRow(
                    guildId,
                    ownerUserId,
                    challenges,
                    panelSession,
                )],
            };
        },
    });
}

async function handleVerificationChallengesCommand(interaction, guildId) {
    const snapshot = await getVerificationSnapshot(guildId);
    const challenges = snapshot.challengeCatalog;
    try { assertChallengeSelectMenuLimit(challenges); }
    catch (err) { return interaction.editReply(buildVerificationAdminNotice('Verification Admin', err.message, 'error')); }
    return interaction.editReply(buildChallengesPanelPayload({
        verificationSettings: snapshot.guildSettings,
        challenges,
        guildId,
        ownerUserId: interaction.user.id,
    }));
}

async function handleChallengeSelectMenu(interaction, parts, state = {}) {
    const [guildId, ownerUserId] = parts;
    const challengeId = interaction.values?.[0];
    await deferSourceUpdate(interaction);
    const snapshot = await getVerificationSnapshot(guildId);
    const challenge = snapshot.challengesById.get(String(challengeId));
    if (!challenge) return respondAdminError(interaction, { embeds: [userErrorEmbed(`Unknown verification challenge ID: ${challengeId}`)] });
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        buildPayload: () => buildChallengeOverviewPanelPayload({
            enabledChallengeIds: snapshot.activeChallengeIds,
            mode: 'edit', guildId, userId: ownerUserId, challengeId, challenge,
        }),
    });
}

function buildChallengeOverviewPanel(enabledChallengeIds, challengeId, challenge, options = {}) {
    const {
        components = [],
        sections = [],
        selectionPrompts = [],
        selectionComponents = [],
        navigationComponents = [],
        hideEditableFields = false,
    } = options;
    const missingQuestions = (challenge.questions?.length ?? 0) < 1;
    const auditFields = [...buildChallengeAuditFields(challenge, enabledChallengeIds), ...buildUpdatedAuditField(challenge)];
    const fields = [...auditFields];
    if (!hideEditableFields) fields.unshift(
        { name: 'Title', value: truncateAdminFieldValue(challenge.title ?? 'Not set'), inline: false },
        { name: 'Description', value: truncateAdminFieldValue(challenge.description ?? 'Not set'), inline: false },
        { name: `${missingQuestions ? '⚠️ ' : ''}Questions`, value: buildQuestionCatalogValue(challenge), inline: false },
    );

    return {
        title: `Verification Challenge: ${challengeId}`,
        description: '',
        fields,
        actions: components,
        sections,
        selectionPrompts,
        selectionActions: selectionComponents,
        navigationActions: navigationComponents,
    };
}

function buildChallengeOverviewComponents(guildId, userId, challengeId, panelSession) {
    if (!challengeId) return [];

    return [new Discord.ActionRowBuilder().addComponents(
        new Discord.ButtonBuilder()
            .setCustomId(panelSession.build('challengesBack', guildId, userId))
            .setLabel('Back')
            .setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder()
            .setCustomId(panelSession.build('challengePreview', guildId, userId, challengeId))
            .setLabel('Preview')
            .setStyle(Discord.ButtonStyle.Primary),
    )];
}

function buildChallengeEditPanelComponents(mode, guildId, userId, challengeId, challenge, panelSession, challengeActive = false) {
    if (mode !== 'edit') return { sections: [], selectionPrompts: [], selectionComponents: [] };
    const button = (action, label, style = Discord.ButtonStyle.Secondary) => new Discord.ButtonBuilder()
        .setCustomId(panelSession.build(action, guildId, userId, challengeId))
        .setLabel(label)
        .setStyle(style);
    const destructiveButton = new Discord.ButtonBuilder()
        .setCustomId(panelSession.build('challengeDelete', mode, guildId, userId, challengeId))
        .setLabel(challenge?.protectedTemplate === true ? 'Reset to Template' : 'Delete Challenge')
        .setStyle(Discord.ButtonStyle.Danger)
        .setDisabled(challengeActive);
    return {
        sections: [
            ...(challengeActive ? [buildAdminEditorSection(undefined, ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE)] : []),
            buildAdminEditorSection(undefined, `Challenge settings for **${challengeId}**.`, destructiveButton),
            buildAdminEditorSection('Challenge details', [
                `- **Title:** ${challenge.title ?? 'Not set'}`,
                `- **Description:** ${challenge.description ?? 'Not set'}`,
            ], button('challengeEdit', 'Edit')),
            ...buildQuestionManagementSections(mode, guildId, userId, challengeId, challenge, panelSession, challengeActive),
        ],
        selectionPrompts: [buildQuestionSelectionPrompt(challenge)],
        selectionComponents: buildQuestionSelectionComponents(mode, guildId, userId, challengeId, challenge, undefined, panelSession),
    };
}

async function handleChallengesBackButton(interaction, parts, state = {}) {
    const [guildId, ownerUserId] = parts;
    await deferSourceUpdate(interaction);
    const snapshot = await getVerificationSnapshot(guildId);
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        buildPayload: () => buildChallengesPanelPayload({
            verificationSettings: snapshot.guildSettings,
            challenges: snapshot.challengeCatalog,
            guildId,
            ownerUserId,
        }),
    });
}

function buildChallengeOverviewPanelPayload({ enabledChallengeIds, mode, guildId, userId, challengeId, challenge }) {
    return buildVerificationAdminPanel({
        guildId,
        ownerUserId: userId,
        key: `challenge:${guildId}:${challengeId}`,
        state: {
            panelViewModel: Object.freeze({ enabledChallengeIds, mode, challenge }),
        },
        compose: (panelSession) => {
            const challengeActive = isChallengeActive(enabledChallengeIds, challengeId);
            const editor = buildChallengeEditPanelComponents(
                mode,
                guildId,
                userId,
                challengeId,
                challenge,
                panelSession,
                challengeActive,
            );
            return buildChallengeOverviewPanel(
                enabledChallengeIds,
                challengeId,
                challenge,
                {
                    navigationComponents: buildChallengeOverviewComponents(
                        guildId,
                        userId,
                        challengeId,
                        panelSession,
                    ),
                    sections: editor.sections,
                    selectionPrompts: editor.selectionPrompts,
                    selectionComponents: editor.selectionComponents,
                    hideEditableFields: mode === 'edit',
                },
            );
        },
    });
}

async function validateChallengeAdminInteraction(interaction, parts, { acknowledge = false } = {}) {
    const [mode, guildId, ownerUserId, challengeId] = parts;
    if (acknowledge) await deferSourceUpdate(interaction);
    const snapshot = await getVerificationSnapshot(guildId);
    const challenge = snapshot.challengesById.get(String(challengeId));
    if (!challenge) {
        await respondAdminError(interaction, { embeds: [userErrorEmbed(`Unknown verification challenge ID: ${challengeId}`)] });
        return { error: true };
    }
    return { mode, guildId, ownerUserId, challengeId, challenge, snapshot };
}

async function handleChallengeOverviewButton(interaction, parts, state = {}) {
    const context = await validateChallengeAdminInteraction(interaction, parts, { acknowledge: true });
    if (context.error) return;
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        buildPayload: () => buildChallengeOverviewPanelPayload({
            enabledChallengeIds: context.snapshot.activeChallengeIds,
            mode: context.mode,
            guildId: context.guildId,
            userId: context.ownerUserId,
            challengeId: context.challengeId,
            challenge: context.challenge,
        }),
    });
}

async function handleChallengePreviewButton(interaction, parts) {
    const [guildId, ownerUserId, challengeId] = parts;
    return startVerificationChallengePreview(interaction, { guildId, challengeId });
}

async function showChallengeEditModalFromButton(interaction, parts, state = {}) {
    const [guildId, ownerUserId, challengeId] = parts;
    const challenge = state.panelViewModel?.challenge;
    if (!challenge) return respondAdminError(interaction, { embeds: [userErrorEmbed(`Unknown verification challenge ID: ${challengeId}`)] });

    const modal = buildAdminModal(
        state.panelSession.buildForm(
            'challengeEditModal',
            [guildId, ownerUserId, challengeId],
            {
                challenge_title: challenge.title ?? '',
                challenge_description: challenge.description ?? '',
            },
            interaction.customId,
        ),
        'Edit Challenge',
        buildExistingTextField({
            customId: 'challenge_title',
            label: 'Challenge Title',
            currentValue: challenge.title ?? '',
            maxLength: CHALLENGE_TITLE_MAX_LENGTH,
        }),
        buildExistingTextField({
            customId: 'challenge_description',
            label: 'Challenge Description',
            currentValue: challenge.description ?? '',
            style: Discord.TextInputStyle.Paragraph,
            maxLength: CHALLENGE_DESCRIPTION_MAX_LENGTH,
        }),
    );

    return interaction.showModal(modal);
}

async function handleChallengeEditModalSubmit(interaction, parts, state = {}) {
    const [guildId, ownerUserId, challengeId] = parts;
    const responseMode = await acknowledgePanelInteraction(interaction, {
        sourceCustomId: state.sourceCustomId,
        panelSession: state.panelSession,
        formGeneration: state.formGeneration,
    });
    const challenge = await getVerificationAdminChallenge(guildId, challengeId);
    if (!challenge) return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(`Unknown verification challenge ID: ${challengeId}`)] });

    const title = getModalTextInput(interaction, 'challenge_title');
    const description = getModalTextInput(interaction, 'challenge_description');
    if (!title || !description) return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Challenge title and description cannot be blank. Use the explicit reset action when applicable.')] });
    let titleEdit;
    let descriptionEdit;
    try {
        titleEdit = resolveBaselineEdit('challenge_title', state.baseline, challenge.title, title);
        descriptionEdit = resolveBaselineEdit('challenge_description', state.baseline, challenge.description, description);
    }
    catch (err) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] });
    }
    if (!titleEdit.changed && !descriptionEdit.changed) return respondAdminNoChanges(interaction, responseMode);

    const mutation = await updateCatalogChallengeMetadata(
        guildId,
        challengeId,
        {
            ...(titleEdit.changed ? { title: titleEdit.value } : {}),
            ...(descriptionEdit.changed ? { description: descriptionEdit.value } : {}),
        },
        interaction.user.id,
        { expected: { title: challenge.title, description: challenge.description, updatedAt: challenge.updatedAt } },
    );
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        committed: true,
        buildPayload: () => buildChallengeOverviewPanelPayload({
            enabledChallengeIds: mutation.snapshot.guildSettings.activeChallengeIds ?? [],
            mode: 'edit',
            guildId,
            userId: ownerUserId,
            challengeId,
            challenge: mutation.snapshot.challengesById.get(String(challengeId)) ?? challenge,
        }),
    });
}

function showCreateChallengeModal(interaction, parts, state = {}) {
    const [guildId, ownerUserId] = parts;
    return interaction.showModal(buildAdminModal(
        state.panelSession.buildForm(
            'challengeCreateModal',
            [guildId, ownerUserId],
            {},
            interaction.customId,
        ),
        'Create Challenge',
        buildModalTextLabel('challenge_id', 'Challenge ID', { placeholder: 'lowercase-kebab-case (max 100)', maxLength: 100, required: true }),
        buildModalTextLabel('challenge_title', 'Challenge Title', { maxLength: 256, required: true }),
        buildModalTextLabel('challenge_description', 'Description', { required: false, maxLength: 4000 }),
    ));
}

async function showCatalogDeleteModal(interaction, parts, type, state = {}) {
    const [mode, guildId, ownerUserId, challengeId, questionId] = parts;
    if (mode !== 'edit') return respondAdminError(interaction, { embeds: [userErrorEmbed('Catalog entries can only be changed from an editable panel.')] });
    const challenge = state.panelViewModel?.challenge;
    if (!challenge || (type === 'question' && !challenge.questions?.some((question) => question.id === questionId))) {
        return respondAdminError(interaction, { embeds: [userErrorEmbed('This catalog entry no longer exists. Refresh the panel.')] });
    }
    const targetId = type === 'question' ? questionId : challengeId;
    const targetEntry = type === 'question'
        ? challenge.questions.find((question) => question.id === questionId)
        : challenge;
    const destructiveVerb = targetEntry?.protectedTemplate === true ? 'Reset' : 'Delete';
    return interaction.showModal(buildAdminModal(
        state.panelSession.buildForm(
            `${type}DeleteModal`,
            [mode, guildId, ownerUserId, challengeId, questionId ?? ''],
            { target_updated_at: targetEntry.updatedAt ?? '' },
            interaction.customId,
        ),
        `${destructiveVerb} ${type === 'question' ? 'Question' : 'Challenge'}`,
        buildModalTextLabel('confirmation', `Type ${targetId} to confirm`, { maxLength: 128, required: true }),
    ));
}

async function handleCreateChallengeModal(interaction, parts, state = {}) {
    const [guildId, ownerUserId] = parts;
    const responseMode = await acknowledgePanelInteraction(interaction, {
        sourceCustomId: state.sourceCustomId,
        panelSession: state.panelSession,
        formGeneration: state.formGeneration,
    });
    let created;
    try {
        created = await createCustomChallenge(guildId, {
            id: getModalTextInput(interaction, 'challenge_id'),
            title: getModalTextInput(interaction, 'challenge_title'),
            description: getModalTextInput(interaction, 'challenge_description'),
        }, interaction.user.id);
    }
    catch (err) { return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] }); }
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        committed: true,
        buildPayload: () => buildChallengesPanelPayload({
            verificationSettings: created.snapshot.guildSettings,
            challenges: created.snapshot.challengeCatalog,
            guildId,
            ownerUserId,
        }),
    });
}

async function handleCatalogDeleteModal(interaction, parts, type, state = {}) {
    const [mode, guildId, ownerUserId, challengeId, questionId = ''] = parts;
    const responseMode = await acknowledgePanelInteraction(interaction, {
        sourceCustomId: state.sourceCustomId,
        panelSession: state.panelSession,
        formGeneration: state.formGeneration,
    });
    if (mode !== 'edit') return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Catalog entries can only be changed from an editable panel.')] });
    const targetId = type === 'question' ? questionId : challengeId;
    if (getModalTextInput(interaction, 'confirmation') !== targetId) {
        return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(`Confirmation must exactly match \`${targetId}\`.`)] });
    }
    let changed;
    try {
        changed = type === 'question'
            ? await deleteOrResetQuestion(guildId, challengeId, questionId, interaction.user.id,
                { expected: { updatedAt: state.baseline?.target_updated_at || undefined } })
            : await deleteOrResetChallenge(guildId, challengeId, interaction.user.id,
                { expected: { updatedAt: state.baseline?.target_updated_at || undefined } });
    }
    catch (err) { return respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed(err.message)] }); }
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        committed: true,
        buildPayload: () => {
            const settings = changed.snapshot.guildSettings;
            const challenges = changed.snapshot.challengeCatalog;
            return type === 'question'
                ? buildChallengeOverviewPanelPayload({ enabledChallengeIds: settings.activeChallengeIds ?? [],
                    mode, guildId, userId: ownerUserId, challengeId, challenge: challenges[challengeId] })
                : (changed.result.action === 'deleted'
                    ? buildChallengesPanelPayload({ verificationSettings: settings, challenges, guildId, ownerUserId })
                    : buildChallengeOverviewPanelPayload({ enabledChallengeIds: settings.activeChallengeIds ?? [],
                        mode, guildId, userId: ownerUserId, challengeId, challenge: challenges[challengeId] }));
        },
    });
}

module.exports = {
    buildChallengeOverviewPanelPayload,
    getChallengeSelectOptions,
    handleCatalogDeleteModal,
    handleChallengeOverviewButton,
    handleChallengePreviewButton,
    handleChallengeSelectMenu,
    handleChallengesBackButton,
    handleChallengeEditModalSubmit,
    handleCreateChallengeModal,
    handleVerificationChallengesCommand,
    showCatalogDeleteModal,
    showChallengeEditModalFromButton,
    showCreateChallengeModal,
};
