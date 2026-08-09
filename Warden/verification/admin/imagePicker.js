const Discord = require('discord.js');
const { deferSourceUpdate } = require('../../../ux/interactions/acknowledgement');
const {
    buildStringSelectComponent,
    truncateSelectText,
} = require('../../../ux/components/modalFields');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const {
    ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
    isChallengeActive,
} = require('../domain/activeChallengePolicy');
const {
    getUnknownVerificationImageIds,
    refreshVerificationImageInventory,
} = require('../assets/image-inventory');
const { prepareGalleryImageAttachments } = require('../assets/screenAssets');
const { updateCatalogQuestionImageIds } = require('../service');
const { resolveBaselineStringSetEdit } = require('./edits');
const {
    getNormalizedQuestionTaskType: getQuestionTaskType,
    getQuestionTaskEditorCapabilities,
    getQuestionTaskImageRoleConfig: getTaskImageRoleConfig,
} = require('../domain/questionTasks/taskRegistry');
const {
    getMaxControlImageRepeats,
    getMaxSolutionImageRepeats,
    getMaximumSolutionImageCount,
    getMinimumSolutionImageCount,
} = require('../domain/questionTasks/shared/gallery');
const {
    ADMIN_PAGINATION_LABELS,
    acknowledgeAdminPanelRender,
    buildAdminEditorSection,
    buildAdminPaginationButton,
    buildVerificationAdminPanel,
    replaceAdminPanel,
    restoreAdminPanelComponents,
} = require('./panel');
const {
    respondAdminError,
    respondAdminNoChanges,
    userErrorEmbed,
} = require('./feedback');
const {
    expectedCatalogQuestions,
    replyWithCommittedQuestionPanel,
    validateQuestionAdminInteraction,
} = require('./questionContext');
const {
    buildQuestionEditorPayload,
    validatePendingQuestionImageIds,
} = require('./questionPanel');
const { runVerificationScreenWork } = require('../runtime/screen-work-limiter');

const IMAGE_PICKER_PAGE_SIZE = VERIFICATION_UI_LIMITS.selectOptions;
const IMAGE_PICKER_COMPOSITE_LAYOUT = Object.freeze({
    tileSize: 192,
    labelPadding: 4,
    labelSize: 36,
});

function getPickerRole(question, roleKey) {
    const taskType = getQuestionTaskType(question);
    const role = getTaskImageRoleConfig(taskType)?.roles.find((candidate) => candidate.key === roleKey);
    if (!role) {
        throw new Error(`Role "${roleKey}" is not editable for this question's current task.`);
    }
    return { role, taskType };
}

function normalizePickerState(state, question, roleKey) {
    const currentIds = [...new Set((question.generatedImage?.imageIds?.[roleKey] ?? []).map(String))];
    return {
        baselineIds: [...new Set((state?.baselineIds ?? currentIds).map(String))],
        selectedIds: [...new Set((state?.selectedIds ?? currentIds).map(String))],
        page: Math.max(0, Number.isInteger(Number(state?.page)) ? Number(state.page) : 0),
    };
}

function pickerSelectionChanged(baselineIds, selectedIds) {
    const baseline = new Set((baselineIds ?? []).map(String));
    const selected = new Set((selectedIds ?? []).map(String));
    return baseline.size !== selected.size || [...baseline].some((imageId) => !selected.has(imageId));
}

function buildPickerCustomId(action, context, roleKey, panelSession) {
    return panelSession.build(action,
        context.guildId,
        context.ownerUserId,
        context.challengeId,
        context.question.id,
        roleKey,
    );
}

function buildPickerButton(action, label, style, context, roleKey, panelSession, disabled = false) {
    return new Discord.ButtonBuilder()
        .setCustomId(buildPickerCustomId(action, context, roleKey, panelSession))
        .setLabel(label)
        .setStyle(style)
        .setDisabled(disabled);
}

function buildPickerPaginationButton(action, label, context, roleKey, panelSession, disabled = false) {
    return buildAdminPaginationButton(buildPickerCustomId(action, context, roleKey, panelSession), label, disabled);
}

function buildImageRoleLimitsSection(context, roleKey, panelSession, challengeActive = false) {
    if (!getQuestionTaskEditorCapabilities(getQuestionTaskType(context.question)).roleSpecificGalleryLimits) {
        return undefined;
    }
    const solutionRole = roleKey === 'solution';
    if (!solutionRole && roleKey !== 'control') return undefined;
    const action = solutionRole
        ? 'questionEditSolutionImageLimits'
        : 'questionEditControlImageLimits';
    const values = solutionRole
        ? [
            `- **Minimum solution images:** ${getMinimumSolutionImageCount(context.question)}`,
            `- **Maximum solution images:** ${getMaximumSolutionImageCount(context.question)}`,
            `- **Maximum occurrences per image:** ${getMaxSolutionImageRepeats(context.question)}`,
        ]
        : [`- **Maximum occurrences per image:** ${getMaxControlImageRepeats(context.question)}`];
    return buildAdminEditorSection(
        `${solutionRole ? 'Solution' : 'Control'} limits`,
        values,
        buildPickerButton(action, 'Edit', Discord.ButtonStyle.Secondary,
            context, roleKey, panelSession, challengeActive),
    );
}

async function buildPickerPreview(pageImages, pageOffset) {
    if (pageImages.length < 1) return {};
    try {
        const prepared = await prepareGalleryImageAttachments({
            selectedImages: pageImages.map((image, index) => ({
                ...image,
                position: pageOffset + index + 1,
            })),
            useCompositeImage: true,
            compositeLayout: IMAGE_PICKER_COMPOSITE_LAYOUT,
        }, { priority: 'admin' });
        const composite = prepared.compositeImage;
        if (!composite?.attachment || !composite.displayUrl) return {};

        const gallery = {
            kind: 'gallery',
            items: [{
                url: composite.displayUrl,
                description: `Images ${pageOffset + 1}-${pageOffset + pageImages.length} on this page`,
            }],
        };
        return { gallery, files: [composite.attachment] };
    }
    catch (err) {
        return {
            warning: `Preview generation failed for this page: ${String(err.message || err).slice(0, 500)}`,
        };
    }
}

async function buildQuestionImagePickerPayload(context, roleKey, inputState, inventory) {
    const { role } = getPickerRole(context.question, roleKey);
    const state = normalizePickerState(inputState, context.question, roleKey);
    const selectedIds = new Set(state.selectedIds);
    const pageCount = Math.max(1, Math.ceil(inventory.images.length / IMAGE_PICKER_PAGE_SIZE));
    const page = Math.min(state.page, pageCount - 1);
    const pageOffset = page * IMAGE_PICKER_PAGE_SIZE;
    const pageImages = inventory.images.slice(pageOffset, pageOffset + IMAGE_PICKER_PAGE_SIZE);
    const pageImageIds = pageImages.map((image) => image.id);
    const enabledChallengeIds = context.snapshot?.activeChallengeIds
        ?? context.enabledChallengeIds
        ?? [];
    const challengeActive = isChallengeActive(enabledChallengeIds, context.challengeId);
    const renderedState = {
        ...state,
        page,
        pageImageIds,
        maxValues: role.maxValues ?? null,
        pickerViewModel: Object.freeze({
            challenge: context.challenge,
            question: context.question,
            catalogQuestion: context.catalogQuestionsById.get(String(context.question.id)),
            questionChanges: context.questionChanges,
            enabledChallengeIds,
        }),
    };
    const preview = await buildPickerPreview(pageImages, pageOffset);
    const missingSelectedIds = getUnknownVerificationImageIds(state.selectedIds, inventory);
    const hasPendingChanges = pickerSelectionChanged(state.baselineIds, state.selectedIds);
    const issueLines = [
        ...inventory.issues,
        ...(missingSelectedIds.length > 0
            ? [`Selected image file${missingSelectedIds.length === 1 ? ' is' : 's are'} unavailable: ${missingSelectedIds.join(', ')}. Clear or replace the selection before saving.`]
            : []),
        ...(preview.warning ? [preview.warning] : []),
    ];

    return buildVerificationAdminPanel({
        guildId: context.guildId,
        ownerUserId: context.ownerUserId,
        key: `images:${context.guildId}:${context.challengeId}:${context.question.id}:${roleKey}`,
        state: renderedState,
        compose: (panelSession) => {
            const limitsSection = buildImageRoleLimitsSection(
                context, roleKey, panelSession, challengeActive,
            );

            const selectionRows = [];
            if (pageImages.length > 0) {
                const select = buildStringSelectComponent({
                    customId: buildPickerCustomId(
                        'questionImagesSelect',
                        context,
                        roleKey,
                        panelSession,
                    ),
                    placeholder: `Choose ${role.label.toLowerCase()} on page ${page + 1}...`,
                    options: pageImages.map((image, index) => ({
                        label: truncateSelectText(`${pageOffset + index + 1}. ${image.id}`),
                        value: `image-${index}`,
                        description: selectedIds.has(image.id)
                            ? 'Selected'
                            : 'Local verification image',
                    })),
                    selectedValues: pageImages
                        .map((image, index) => selectedIds.has(image.id)
                            ? `image-${index}`
                            : undefined)
                        .filter(Boolean),
                    minValues: 0,
                    maxValues: Math.min(
                        role.maxValues ?? pageImages.length,
                        pageImages.length,
                    ),
                });
                select.setDisabled(challengeActive);
                selectionRows.push(new Discord.ActionRowBuilder().addComponents(select));
            }

            const navigationRow = new Discord.ActionRowBuilder().addComponents(
                buildPickerButton(
                    'questionImagesBack',
                    'Back',
                    Discord.ButtonStyle.Secondary,
                    context,
                    roleKey,
                    panelSession,
                ),
                buildPickerPaginationButton(
                    'questionImagesPrevious',
                    ADMIN_PAGINATION_LABELS.previous,
                    context,
                    roleKey,
                    panelSession,
                    page <= 0,
                ),
                buildPickerPaginationButton(
                    'questionImagesNext',
                    ADMIN_PAGINATION_LABELS.next,
                    context,
                    roleKey,
                    panelSession,
                    page >= pageCount - 1,
                ),
                buildPickerButton(
                    'questionImagesRefresh',
                    'Refresh',
                    Discord.ButtonStyle.Primary,
                    context,
                    roleKey,
                    panelSession,
                ),
            );
            const saveRow = new Discord.ActionRowBuilder().addComponents(
                buildPickerButton(
                    'questionImagesClear',
                    'Clear Selection',
                    Discord.ButtonStyle.Danger,
                    context,
                    roleKey,
                    panelSession,
                    challengeActive || selectedIds.size < 1,
                ),
                buildPickerButton(
                    'questionImagesSave',
                    'Save',
                    Discord.ButtonStyle.Success,
                    context,
                    roleKey,
                    panelSession,
                    challengeActive
                        || !hasPendingChanges
                        || inventory.scanSucceeded !== true
                        || missingSelectedIds.length > 0,
                ),
            );
            const pendingLimitsNotice = hasPendingChanges && limitsSection
                ? '\nRole-limit edits will validate and save this pending image selection in the same change.'
                : '';
            const prompt = pageImages.length > 0
                ? `### Select images\nThe numbered preview corresponds to the options below. Page selections remain pending until **Save**.${pendingLimitsNotice}${issueLines.length > 0 ? `\n\n⚠️ ${issueLines.map((issue) => Discord.escapeMarkdown(issue)).join('\n⚠️ ')}` : ''}`
                : `### No images available\nUpload a supported image to \`/home/container/verificationImages\` or refresh this picker.${issueLines.length > 0 ? `\n\n⚠️ ${issueLines.map((issue) => Discord.escapeMarkdown(issue)).join('\n⚠️ ')}` : ''}`;
            return {
                title: `Verification Images: ${role.label}`,
                description: role.description,
                fields: [
                    { name: 'Question', value: `${context.challengeId}/${context.question.id}`, inline: false },
                    { name: 'Role', value: role.label, inline: false },
                    { name: 'Selection', value: `${selectedIds.size} pending • ${inventory.images.length} available`, inline: false },
                    { name: 'Page', value: `${page + 1}/${pageCount}`, inline: false },
                ],
                galleries: preview.gallery ? [preview.gallery] : [],
                sections: [
                    ...(challengeActive ? [buildAdminEditorSection(
                        undefined, ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
                    )] : []),
                    ...(limitsSection ? [limitsSection] : []),
                ],
                selectionPrompts: [prompt],
                selectionActions: selectionRows,
                navigationActions: [navigationRow, saveRow],
                files: preview.files ?? [],
            };
        },
    });
}

async function getPickerInteractionContext(interaction, parts) {
    const [guildId, ownerUserId, challengeId, questionId, roleKey] = parts;
    const context = await validateQuestionAdminInteraction(interaction, [guildId, ownerUserId, challengeId, questionId]);
    if (context.error) return context;
    getPickerRole(context.question, roleKey);
    return { ...context, roleKey };
}

async function renderPickerComponent(interaction, parts, state, { forceRefresh = false, showLoading = false } = {}) {
    const originalComponents = await acknowledgeAdminPanelRender(interaction, showLoading);
    try {
        return await runVerificationScreenWork(async () => {
            const context = await getPickerInteractionContext(interaction, parts);
            if (context.error) {
                await restoreAdminPanelComponents(interaction, originalComponents);
                return undefined;
            }
            const inventory = await refreshVerificationImageInventory({ force: forceRefresh });
            return replaceAdminPanel(interaction, {
                sourcePanelSession: state?.panelSession,
                buildPayload: () => buildQuestionImagePickerPayload(
                    context,
                    context.roleKey,
                    state,
                    inventory,
                ),
            });
        }, {
            priority: 'admin',
            label: 'Rendering verification image picker',
        });
    }
    catch (err) {
        await restoreAdminPanelComponents(interaction, originalComponents);
        throw err;
    }
}

function showQuestionImagePicker(interaction, parts, state = {}) {
    return renderPickerComponent(interaction, parts, state, {
        forceRefresh: true,
        showLoading: true,
    });
}

function handleQuestionImagePickerPrevious(interaction, parts, state = {}) {
    return renderPickerComponent(
        interaction,
        parts,
        { ...state, page: Math.max(0, Number(state.page ?? 0) - 1) },
        { showLoading: true },
    );
}

function handleQuestionImagePickerNext(interaction, parts, state = {}) {
    return renderPickerComponent(
        interaction,
        parts,
        { ...state, page: Number(state.page ?? 0) + 1 },
        { showLoading: true },
    );
}

function handleQuestionImagePickerRefresh(interaction, parts, state = {}) {
    return renderPickerComponent(interaction, parts, state, { forceRefresh: true, showLoading: true });
}

function handleQuestionImagePickerClear(interaction, parts, state = {}) {
    return renderPickerComponent(interaction, parts, {
        ...state,
        selectedIds: [],
    }, { showLoading: true });
}

function handleQuestionImagePickerSelect(interaction, parts, state = {}) {
    const pageImageIds = Array.isArray(state.pageImageIds) ? state.pageImageIds : [];
    const selectedPageIds = (interaction.values ?? []).map((token) => {
        const match = /^image-(\d+)$/.exec(String(token));
        return match ? pageImageIds[Number(match[1])] : undefined;
    }).filter(Boolean);
    if (selectedPageIds.length !== (interaction.values ?? []).length) {
        return respondAdminError(interaction, { embeds: [userErrorEmbed('This image page changed unexpectedly. Refresh the picker and try again.')] });
    }

    const selectedIds = new Set((state.selectedIds ?? []).map(String));
    if (Number(state.maxValues) === 1 && selectedPageIds.length > 0) selectedIds.clear();
    else for (const imageId of pageImageIds) selectedIds.delete(imageId);
    for (const imageId of selectedPageIds) selectedIds.add(imageId);
    return renderPickerComponent(
        interaction,
        parts,
        { ...state, selectedIds: [...selectedIds] },
        { showLoading: true },
    );
}

async function handleQuestionImagePickerBack(interaction, parts, state = {}) {
    await deferSourceUpdate(interaction);
    const [guildId, ownerUserId, challengeId, questionId] = parts;
    const context = await validateQuestionAdminInteraction(interaction, [guildId, ownerUserId, challengeId, questionId]);
    if (context.error) return undefined;
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        buildPayload: () => buildQuestionEditorPayload({
            mode: 'edit',
            guildId: context.guildId,
            ownerUserId: context.ownerUserId,
            challengeId: context.challengeId,
            challenge: context.challenge,
            question: context.question,
            catalogQuestion: context.catalogQuestionsById.get(String(context.question.id)),
            questionChanges: context.questionChanges,
            enabledChallengeIds: context.snapshot.activeChallengeIds,
        }),
    });
}

async function handleQuestionImagePickerSave(interaction, parts, state = {}) {
    await deferSourceUpdate(interaction);
    const context = await getPickerInteractionContext(interaction, parts);
    if (context.error) return undefined;
    const inventory = await refreshVerificationImageInventory({ force: true });
    if (inventory.scanSucceeded !== true) {
        return respondAdminError(interaction, {
            embeds: [userErrorEmbed('The verification image directory could not be read, so no image changes were saved. Fix the directory warning and refresh the picker before trying again.')],
        });
    }
    const reconciledState = normalizePickerState(state, context.question, context.roleKey);
    const selectedIds = reconciledState.selectedIds;
    const missingIds = getUnknownVerificationImageIds(selectedIds, inventory);
    if (missingIds.length > 0) {
        return respondAdminError(interaction, {
            embeds: [userErrorEmbed(`These selected images are no longer available: ${missingIds.join(', ')}`)],
        });
    }

    const pendingQuestion = {
        ...context.question,
        generatedImage: {
            ...(context.question.generatedImage ?? {}),
            imageIds: {
                ...(context.question.generatedImage?.imageIds ?? {}),
                [context.roleKey]: selectedIds,
            },
        },
    };
    const validationError = validatePendingQuestionImageIds(pendingQuestion, context.roleKey, selectedIds);
    if (validationError) {
        return respondAdminError(interaction, { embeds: [userErrorEmbed(validationError)] });
    }

    let edit;
    try {
        edit = resolveBaselineStringSetEdit(
            `${getPickerRole(context.question, context.roleKey).role.label} images`,
            reconciledState.baselineIds,
            context.question.generatedImage?.imageIds?.[context.roleKey] ?? [],
            selectedIds,
        );
    }
    catch (err) {
        return respondAdminError(interaction, { embeds: [userErrorEmbed(err.message)] });
    }
    if (!edit.changed) {
        return respondAdminNoChanges(interaction, undefined, 'No image changes were saved; the current configuration was preserved.');
    }

    const updatedSettings = await updateCatalogQuestionImageIds(
        context.guildId,
        context.challengeId,
        context.question.id,
        { [context.roleKey]: edit.value },
        interaction.user.id,
        { expected: expectedCatalogQuestions(context, [context.question.id]) },
    );
    const response = await replyWithCommittedQuestionPanel(
        interaction,
        context,
        updatedSettings,
        state,
    );
    return response;
}

module.exports = {
    handleQuestionImagePickerBack,
    handleQuestionImagePickerClear,
    handleQuestionImagePickerNext,
    handleQuestionImagePickerPrevious,
    handleQuestionImagePickerRefresh,
    handleQuestionImagePickerSave,
    handleQuestionImagePickerSelect,
    showQuestionImagePicker,
};
