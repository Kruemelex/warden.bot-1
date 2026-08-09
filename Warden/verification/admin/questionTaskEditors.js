const { createDescriptorModalEditor } = require('../../../ux/interactions/editor');
const {
    buildModal: buildAdminModal,
    buildModalStringSelectField,
    getModalSelectValues,
    getRequiredModalSingleSelect,
} = require('../../../ux/components/modalFields');
const {
    DEFAULT_ROTATION_ALIGNMENT_DEGREES,
    getDegreeList,
} = require('../domain/questionTasks/shared/degrees');
const {
    getGalleryPresentation,
    getGallerySize,
    getMaxControlImageRepeats,
    getMaxSolutionImageRepeats,
    getMaximumGallerySize,
    getMaximumSolutionImageCount,
    getMinimumSolutionImageCount,
    resolveGalleryImageCountOptions,
} = require('../domain/questionTasks/shared/gallery');
const {
    getRotationAlignmentConfig,
    getRotationAlignmentOffsets,
    getRotationClockPositionDegrees,
    getRotationGenerationDegrees,
    getRotationMaxPositionRepeats,
    resolveClockPositionCapacity,
} = require('../domain/questionTasks/rotationAlignment');
const {
    getNormalizedQuestionTaskType: getQuestionTaskType,
    getQuestionTaskEditorCapabilities,
} = require('../domain/questionTasks/taskRegistry');
const {
    updateCatalogQuestionImageDirections,
    updateCatalogQuestionOptions,
} = require('../service');
const {
    getUnknownVerificationImageIds,
    refreshVerificationImageInventory,
} = require('../assets/image-inventory');
const {
    baselineEditsChanged,
    resolveBaselineEdits,
    resolveBaselineStringSetEdit,
    sameStringSet,
} = require('./edits');
const {
    respondAdminError,
    respondAdminModalError,
    respondAdminNoChanges,
    userErrorEmbed,
} = require('./feedback');
const {
    GALLERY_PRESENTATION_OPTIONS,
    buildDegreeSelectField,
    buildDirectionDegreesSelectField,
    buildImageDirectionImageSelectField,
    buildIntegerSelectField,
    getIntegerSelectOptions,
    getQuestionDirectionImageIds,
    validatePendingQuestionImageIds,
} = require('./questionPanel');
const {
    beginQuestionModalSubmission,
    expectedCatalogQuestions,
    replyWithCommittedQuestionPanel,
    validateQuestionPanelInteraction,
} = require('./questionContext');

const ROTATION_DEGREE_VALUES = new Set(DEFAULT_ROTATION_ALIGNMENT_DEGREES.map(String));
const ROTATION_DEGREE_OPTIONS = DEFAULT_ROTATION_ALIGNMENT_DEGREES.map((degree) => ({ value: String(degree) }));

function getRequiredGalleryLimit(interaction, customId, label) {
    return Number(getRequiredModalSingleSelect(interaction, customId, getIntegerSelectOptions(), label));
}

function getRawRotationList(value) {
    if (Array.isArray(value)) return value.map(String);
    return value === undefined || value === null ? [] : [String(value)];
}

const getRawRotationScalar = (value) => value === undefined || value === null ? '' : String(value);

const expectedQuestion = (context) => ({ expected: expectedCatalogQuestions(context, [context.question.id]) });

function applyPendingImageSelection(question, roleKey, selectedIds) {
    return {
        ...question,
        generatedImage: {
            ...(question.generatedImage ?? {}),
            imageIds: {
                ...(question.generatedImage?.imageIds ?? {}),
                [roleKey]: [...selectedIds],
            },
        },
    };
}

function getPendingImageIdsPatch(context) {
    const pending = context.pendingImageSelection;
    return pending?.changed
        ? { imageIds: { ...(context.question.generatedImage?.imageIds ?? {}) } }
        : {};
}

function addPendingImageSelectionBaseline(form, context) {
    const pending = context.pendingImageSelection;
    if (pending?.changed !== true) return form;
    return {
        ...form,
        baseline: {
            ...(form.baseline ?? {}),
            pending_image_role: pending.roleKey,
            pending_image_baseline_ids: [...pending.baselineIds],
            pending_image_selected_ids: [...pending.selectedIds],
        },
    };
}

async function loadQuestionTaskOpenContext(interaction, parts, state = {}) {
    const [guildId, ownerUserId, challengeId, questionId, roleKey] = parts;
    const viewModel = state.pickerViewModel;
    if (!viewModel) return validateQuestionPanelInteraction(interaction, parts, state);

    if (
        String(viewModel.challenge?.id ?? '') !== String(challengeId)
        || String(viewModel.question?.id ?? '') !== String(questionId)
    ) {
        await respondAdminError(interaction, {
            embeds: [userErrorEmbed('This image picker view expired. Reopen the question panel.')],
        });
        return { error: true };
    }

    const baselineIds = [...new Set((state.baselineIds ?? []).map(String))];
    const selectedIds = [...new Set((state.selectedIds ?? []).map(String))];
    const question = applyPendingImageSelection(viewModel.question, roleKey, selectedIds);
    return {
        guildId,
        ownerUserId,
        challengeId,
        questionId,
        challenge: viewModel.challenge,
        question,
        catalogQuestionsById: new Map([[String(questionId), viewModel.catalogQuestion]]),
        pendingImageSelection: {
            baselineIds,
            changed: !sameStringSet(baselineIds, selectedIds),
            roleKey,
            selectedIds,
            value: selectedIds,
        },
    };
}

async function beginQuestionTaskModalSubmission(interaction, parts, state = {}) {
    const submission = await beginQuestionModalSubmission(interaction, parts, state);
    if (submission.failed) return submission;
    const pendingRole = state.baseline?.pending_image_role;
    if (!pendingRole) return submission;

    try {
        const context = submission.context;
        const baselineIds = [...new Set((state.baseline.pending_image_baseline_ids ?? []).map(String))];
        const selectedIds = [...new Set((state.baseline.pending_image_selected_ids ?? []).map(String))];
        const currentIds = context.question.generatedImage?.imageIds?.[pendingRole] ?? [];
        const edit = resolveBaselineStringSetEdit(
            `${pendingRole} images`,
            baselineIds,
            currentIds,
            selectedIds,
        );
        const inventory = await refreshVerificationImageInventory({ force: true });
        if (inventory.scanSucceeded !== true) {
            throw new Error('The verification image directory could not be read, so the pending image selection was not saved.');
        }
        const missingIds = getUnknownVerificationImageIds(edit.value, inventory);
        if (missingIds.length > 0) {
            throw new Error(`These selected images are no longer available: ${missingIds.join(', ')}`);
        }
        const question = applyPendingImageSelection(context.question, pendingRole, edit.value);
        const validationError = validatePendingQuestionImageIds(question, pendingRole, edit.value);
        if (validationError) throw new Error(validationError);

        return {
            ...submission,
            context: {
                ...context,
                question,
                pendingImageSelection: {
                    ...edit,
                    baselineIds,
                    roleKey: pendingRole,
                    selectedIds,
                },
            },
        };
    }
    catch (error) {
        await respondAdminModalError(interaction, submission.responseMode, {
            embeds: [userErrorEmbed(error.message)],
        });
        return { ...submission, failed: true };
    }
}

function buildGalleryLimitsModal(question) {
    const taskType = getQuestionTaskType(question);
    const taskCapabilities = getQuestionTaskEditorCapabilities(taskType);
    if (!taskCapabilities.galleryLimits) throw new Error('This question does not use gallery limits.');
    const roleSpecificLimits = taskCapabilities.roleSpecificGalleryLimits === true;
    const gallerySize = String(getGallerySize(question));
    const minimumSolutionImages = String(getMinimumSolutionImageCount(question));
    const maximumSolutionImages = String(getMaximumSolutionImageCount(question));
    return {
        title: roleSpecificLimits ? 'Edit Gallery Layout' : 'Edit Gallery Limits',
        baseline: {
            'gallery task type': taskType,
            'gallery presentation': getGalleryPresentation(question),
            'gallery size': gallerySize,
            ...(!roleSpecificLimits ? {
                'minimum solution images': minimumSolutionImages,
                'maximum solution images': maximumSolutionImages,
            } : {}),
        },
        fields: [
            buildModalStringSelectField({
                label: 'Gallery Presentation',
                description: 'Composite grids support 25 images; individual attachments support 10.',
                customId: 'gallery_presentation',
                placeholder: 'Choose gallery presentation...',
                options: GALLERY_PRESENTATION_OPTIONS,
                selectedValues: [getGalleryPresentation(question)],
                minValues: 1,
                maxValues: 1,
                required: true,
            }),
            buildIntegerSelectField('gallery_size', 'Gallery Size', gallerySize, 'Total number of images shown in each generated gallery.'),
            ...(!roleSpecificLimits ? [
                buildIntegerSelectField('minimum_solution_images', 'Minimum Solution Images', minimumSolutionImages, 'Minimum solution images selected for each generated gallery.'),
                buildIntegerSelectField('maximum_solution_images', 'Maximum Solution Images', maximumSolutionImages, 'Maximum solution images selected for each generated gallery.'),
            ] : []),
        ],
    };
}

function resolveGalleryLimitEdits(question, baseline, values) {
    const taskCapabilities = getQuestionTaskEditorCapabilities(getQuestionTaskType(question));
    const roleSpecificLimits = taskCapabilities.roleSpecificGalleryLimits === true;
    return resolveBaselineEdits(baseline, {
        presentation: {
            field: 'gallery presentation',
            current: getGalleryPresentation(question),
            submitted: values.galleryPresentation,
        },
        gallerySize: {
            field: 'gallery size',
            current: String(getGallerySize(question)),
            submitted: String(values.gallerySize),
        },
        ...(!roleSpecificLimits ? {
            solutionMinimum: {
                field: 'minimum solution images',
                current: String(getMinimumSolutionImageCount(question)),
                submitted: String(values.minimumSolutionImages),
            },
            solutionMaximum: {
                field: 'maximum solution images',
                current: String(getMaximumSolutionImageCount(question)),
                submitted: String(values.maximumSolutionImages),
            },
        } : {}),
    });
}

function getResolvedGalleryLimitValues(question, edits) {
    return {
        galleryPresentation: edits.presentation.value,
        gallerySize: Number(edits.gallerySize.value),
        minimumSolutionImages: edits.solutionMinimum
            ? Number(edits.solutionMinimum.value)
            : getMinimumSolutionImageCount(question),
        maximumSolutionImages: edits.solutionMaximum
            ? Number(edits.solutionMaximum.value)
            : getMaximumSolutionImageCount(question),
    };
}

function validateGalleryLimits({ context, question, edits }) {
    const taskCapabilities = getQuestionTaskEditorCapabilities(getQuestionTaskType(question));
    const values = getResolvedGalleryLimitValues(question, edits);
    const proposedGeneratedImage = {
        ...(question.generatedImage ?? {}),
        compositeImageGallery: values.galleryPresentation === 'composite',
        gallerySize: values.gallerySize,
        solutionImageCount: {
            min: values.minimumSolutionImages,
            max: values.maximumSolutionImages,
        },
    };
    const maximumGallerySize = getMaximumGallerySize(proposedGeneratedImage);
    if (values.gallerySize > maximumGallerySize) {
        return `Gallery size must be between 1 and ${maximumGallerySize} for this ${values.galleryPresentation === 'composite' ? 'composite gallery' : 'Discord attachment gallery'}.`;
    }
    if (values.minimumSolutionImages < 1 || values.minimumSolutionImages > values.gallerySize) {
        return `Minimum solution images must be between 1 and the gallery size (${values.gallerySize}).`;
    }
    if (values.maximumSolutionImages < values.minimumSolutionImages || values.maximumSolutionImages > values.gallerySize) {
        return `Maximum solution images must be between the minimum (${values.minimumSolutionImages}) and gallery size (${values.gallerySize}).`;
    }
    const countOptions = resolveGalleryImageCountOptions(proposedGeneratedImage, context.challengeId);
    if (taskCapabilities.roleSpecificGalleryLimits) {
        const solutionImageIds = question.generatedImage?.imageIds?.solution ?? [];
        const maximumRequiredSolutions = Math.max(...countOptions.validSolutionCounts);
        const maximumSolutionRepeats = getMaxSolutionImageRepeats(question);
        if (solutionImageIds.length > 0 && solutionImageIds.length * maximumSolutionRepeats < maximumRequiredSolutions) {
            return `The selected solution images provide ${solutionImageIds.length * maximumSolutionRepeats} slots, but this gallery may require ${maximumRequiredSolutions}. Increase the solution repetition limit or select more solution images.`;
        }
        const controlImageIds = question.generatedImage?.imageIds?.control ?? [];
        const maximumControlRepeats = getMaxControlImageRepeats(question);
        const maximumRequiredControls = Math.max(...countOptions.validSolutionCounts
            .map((solutionCount) => values.gallerySize - solutionCount));
        if (controlImageIds.length > 0 && controlImageIds.length * maximumControlRepeats < maximumRequiredControls) {
            return `The selected control images provide ${controlImageIds.length * maximumControlRepeats} slots, but this gallery may require ${maximumRequiredControls}. Increase the repetition limit or select more control images.`;
        }
        return undefined;
    }

    const rotationAlignment = proposedGeneratedImage.rotationAlignment ?? {};
    const { capacity } = resolveClockPositionCapacity(
        getDegreeList(rotationAlignment.clockPositionDegrees),
        values.gallerySize,
        rotationAlignment.maxImageOrientationRepeats,
    );
    return capacity < values.gallerySize
        ? `The configured clock positions provide ${capacity} slots, but this gallery requires ${values.gallerySize}. Reduce the gallery size or edit Rotation Settings.`
        : undefined;
}

function writeGalleryLimits({ context, question, edits, userId }) {
    const values = getResolvedGalleryLimitValues(question, edits);
    const generatedImage = {};
    if (edits.presentation.changed) generatedImage.compositeImageGallery = values.galleryPresentation === 'composite';
    if (edits.gallerySize.changed) generatedImage.gallerySize = values.gallerySize;
    if (edits.solutionMinimum?.changed || edits.solutionMaximum?.changed) {
        generatedImage.solutionImageCount = {
            min: values.minimumSolutionImages,
            max: values.maximumSolutionImages,
        };
    }

    return updateCatalogQuestionOptions(context.guildId, context.challengeId, {
        [context.question.id]: { generatedImage },
    }, userId, expectedQuestion(context));
}

function assertRoleSpecificGalleryLimits(question) {
    if (!getQuestionTaskEditorCapabilities(getQuestionTaskType(question)).roleSpecificGalleryLimits) {
        throw new Error('This question does not use role-specific gallery limits.');
    }
}

function buildSolutionImageLimitsModal(question) {
    assertRoleSpecificGalleryLimits(question);
    const minimumSolutionImages = String(getMinimumSolutionImageCount(question));
    const maximumSolutionImages = String(getMaximumSolutionImageCount(question));
    const maximumSolutionRepeats = String(getMaxSolutionImageRepeats(question));
    return {
        baseline: {
            'gallery task type': getQuestionTaskType(question),
            'minimum solution images': minimumSolutionImages,
            'maximum solution images': maximumSolutionImages,
            'maximum solution repetitions': maximumSolutionRepeats,
        },
        fields: [
            buildIntegerSelectField('minimum_solution_images', 'Minimum Solution Images', minimumSolutionImages, 'Minimum solution images selected for each generated gallery.'),
            buildIntegerSelectField('maximum_solution_images', 'Maximum Solution Images', maximumSolutionImages, 'Maximum solution images selected for each generated gallery.'),
            buildIntegerSelectField('maximum_solution_repeats', 'Maximum Solution Occurrences', maximumSolutionRepeats, 'Maximum times one solution image may appear in one gallery.'),
        ],
    };
}

function resolveSolutionImageLimitEdits(question, baseline, values) {
    return resolveBaselineEdits(baseline, {
        solutionMinimum: {
            field: 'minimum solution images',
            current: String(getMinimumSolutionImageCount(question)),
            submitted: String(values.minimumSolutionImages),
        },
        solutionMaximum: {
            field: 'maximum solution images',
            current: String(getMaximumSolutionImageCount(question)),
            submitted: String(values.maximumSolutionImages),
        },
        solutionRepeats: {
            field: 'maximum solution repetitions',
            current: String(getMaxSolutionImageRepeats(question)),
            submitted: String(values.maximumSolutionRepeats),
        },
    });
}

function getResolvedSolutionImageLimitValues(edits) {
    return {
        minimumSolutionImages: Number(edits.solutionMinimum.value),
        maximumSolutionImages: Number(edits.solutionMaximum.value),
        maximumSolutionRepeats: Number(edits.solutionRepeats.value),
    };
}

function validateSolutionImageLimits({ question, edits }) {
    const values = getResolvedSolutionImageLimitValues(edits);
    const gallerySize = getGallerySize(question);
    if (values.minimumSolutionImages < 1 || values.minimumSolutionImages > gallerySize) {
        return `Minimum solution images must be between 1 and the gallery size (${gallerySize}).`;
    }
    if (values.maximumSolutionImages < values.minimumSolutionImages || values.maximumSolutionImages > gallerySize) {
        return `Maximum solution images must be between the minimum (${values.minimumSolutionImages}) and gallery size (${gallerySize}).`;
    }
    if (values.maximumSolutionRepeats < 1 || values.maximumSolutionRepeats > gallerySize) {
        return `Maximum solution occurrences must be between 1 and the gallery size (${gallerySize}).`;
    }
    const solutionImageIds = question.generatedImage?.imageIds?.solution ?? [];
    const capacity = solutionImageIds.length * values.maximumSolutionRepeats;
    if (solutionImageIds.length > 0 && capacity < values.maximumSolutionImages) {
        return `The selected solution images provide ${capacity} slots, but this gallery may require ${values.maximumSolutionImages}. Increase the occurrence limit or select more solution images.`;
    }
    const controlImageIds = question.generatedImage?.imageIds?.control ?? [];
    const maximumControlCapacity = controlImageIds.length * getMaxControlImageRepeats(question);
    const maximumRequiredControls = gallerySize - values.minimumSolutionImages;
    return controlImageIds.length > 0 && maximumControlCapacity < maximumRequiredControls
        ? `The selected control images provide ${maximumControlCapacity} slots, but this gallery may require ${maximumRequiredControls}. Increase the control occurrence limit or select more control images.`
        : undefined;
}

function writeSolutionImageLimits({ context, edits, userId }) {
    const values = getResolvedSolutionImageLimitValues(edits);
    return updateCatalogQuestionOptions(context.guildId, context.challengeId, {
        [context.question.id]: {
            generatedImage: {
                ...getPendingImageIdsPatch(context),
                solutionImageCount: {
                    min: values.minimumSolutionImages,
                    max: values.maximumSolutionImages,
                },
                maxSolutionImageRepeats: values.maximumSolutionRepeats,
            },
        },
    }, userId, expectedQuestion(context));
}

function buildControlImageLimitsModal(question) {
    assertRoleSpecificGalleryLimits(question);
    const maximumControlRepeats = String(getMaxControlImageRepeats(question));
    return {
        baseline: {
            'gallery task type': getQuestionTaskType(question),
            'maximum control repetitions': maximumControlRepeats,
        },
        fields: [
            buildIntegerSelectField('maximum_control_repeats', 'Maximum Control Occurrences', maximumControlRepeats, 'Maximum times one control image may appear in one gallery.'),
        ],
    };
}

function resolveControlImageLimitEdits(question, baseline, values) {
    return resolveBaselineEdits(baseline, {
        controlRepeats: {
            field: 'maximum control repetitions',
            current: String(getMaxControlImageRepeats(question)),
            submitted: String(values.maximumControlRepeats),
        },
    });
}

function validateControlImageLimits({ question, edits }) {
    const maximumControlRepeats = Number(edits.controlRepeats.value);
    const gallerySize = getGallerySize(question);
    if (maximumControlRepeats < 1 || maximumControlRepeats > gallerySize) {
        return `Maximum control occurrences must be between 1 and the gallery size (${gallerySize}).`;
    }
    const controlImageIds = question.generatedImage?.imageIds?.control ?? [];
    const maximumRequiredControls = gallerySize - getMinimumSolutionImageCount(question);
    const capacity = controlImageIds.length * maximumControlRepeats;
    return controlImageIds.length > 0 && capacity < maximumRequiredControls
        ? `The selected control images provide ${capacity} slots, but this gallery may require ${maximumRequiredControls}. Increase the occurrence limit or select more control images.`
        : undefined;
}

function writeControlImageLimits({ context, edits, userId }) {
    return updateCatalogQuestionOptions(context.guildId, context.challengeId, {
        [context.question.id]: {
            generatedImage: {
                ...getPendingImageIdsPatch(context),
                maxControlImageRepeats: Number(edits.controlRepeats.value),
            },
        },
    }, userId, expectedQuestion(context));
}

function buildRotationSettingsModal(question) {
    if (!getQuestionTaskEditorCapabilities(getQuestionTaskType(question)).rotationSettings) {
        throw new Error('This question does not use Rotation Alignment settings.');
    }
    const clockPositions = getRotationClockPositionDegrees(question).map(String);
    const rotationDegrees = getRotationGenerationDegrees(question).map(String);
    const maximumPositionRepeats = String(getRotationMaxPositionRepeats(question));
    const offsets = getRotationAlignmentOffsets(question);
    const configured = getRotationAlignmentConfig(question);
    const alignmentRule = configured.alignmentRule ?? {};
    return {
        baseline: {
            clock_positions: getRawRotationList(configured.clockPositionDegrees),
            rotation_degrees: getRawRotationList(configured.rotationDegrees),
            maximum_position_repetitions: getRawRotationScalar(configured.maxImageOrientationRepeats),
            center_target_offset: getRawRotationScalar(alignmentRule.centerTargetOffsetDegrees),
            outer_target_offset: getRawRotationScalar(alignmentRule.outerTargetOffsetDegrees),
        },
        fields: [
            buildDegreeSelectField('clock_positions', 'Clock Positions', clockPositions, 'Positions used to place the outer image.', true),
            buildDegreeSelectField('rotation_degrees', 'Generated Rotations', rotationDegrees, 'Rotations available when generating control tiles.', true),
            buildIntegerSelectField('maximum_position_repetitions', 'Maximum Position Repetitions', maximumPositionRepeats, 'Maximum times one clock position may appear.'),
            buildDegreeSelectField('center_target_offset', 'Center Target Offset', offsets.center, 'Required world-direction offset for the center image.'),
            buildDegreeSelectField('outer_target_offset', 'Outer Target Offset', offsets.outer, 'Required world-direction offset for the outer image.'),
        ],
    };
}

function resolveRotationSettingsEdits(question, baseline, values) {
    const currentConfigured = getRotationAlignmentConfig(question);
    const currentAlignmentRule = currentConfigured.alignmentRule ?? {};
    return resolveBaselineEdits(baseline, {
        clockPositions: {
            field: 'clock positions',
            baselineKey: 'clock_positions',
            kind: 'string-set',
            current: getRawRotationList(currentConfigured.clockPositionDegrees),
            submitted: values.clockPositions,
        },
        rotationDegrees: {
            field: 'generated rotations',
            baselineKey: 'rotation_degrees',
            kind: 'string-set',
            current: getRawRotationList(currentConfigured.rotationDegrees),
            submitted: values.rotationDegrees,
        },
        maximumRepeats: {
            baselineKey: 'maximum_position_repetitions',
            current: getRawRotationScalar(currentConfigured.maxImageOrientationRepeats),
            submitted: String(values.maximumPositionRepeats),
        },
        centerOffset: {
            baselineKey: 'center_target_offset',
            current: getRawRotationScalar(currentAlignmentRule.centerTargetOffsetDegrees),
            submitted: String(values.centerOffset),
        },
        outerOffset: {
            baselineKey: 'outer_target_offset',
            current: getRawRotationScalar(currentAlignmentRule.outerTargetOffsetDegrees),
            submitted: String(values.outerOffset),
        },
    });
}

function getResolvedRotationSettings(question, edits) {
    const currentOffsets = getRotationAlignmentOffsets(question);
    return {
        clockPositionDegrees: edits.clockPositions.changed
            ? edits.clockPositions.value.map(Number)
            : getRotationClockPositionDegrees(question),
        rotationDegrees: edits.rotationDegrees.changed
            ? edits.rotationDegrees.value.map(Number)
            : getRotationGenerationDegrees(question),
        maxImageOrientationRepeats: edits.maximumRepeats.changed
            ? Number(edits.maximumRepeats.value)
            : getRotationMaxPositionRepeats(question),
        centerTargetOffsetDegrees: edits.centerOffset.changed
            ? Number(edits.centerOffset.value)
            : currentOffsets.center,
        outerTargetOffsetDegrees: edits.outerOffset.changed
            ? Number(edits.outerOffset.value)
            : currentOffsets.outer,
    };
}

function validateRotationSettings({ question, edits }) {
    const values = getResolvedRotationSettings(question, edits);
    const { capacity } = resolveClockPositionCapacity(values.clockPositionDegrees, getGallerySize(question), values.maxImageOrientationRepeats);
    return capacity < getGallerySize(question) ? `Clock positions provide ${capacity} slots, but this gallery requires ${getGallerySize(question)}.` : undefined;
}

function writeRotationSettings({ context, question, edits, userId }) {
    const values = getResolvedRotationSettings(question, edits);
    return updateCatalogQuestionOptions(context.guildId, context.challengeId, {
        [context.question.id]: {
            generatedImage: {
                rotationAlignment: {
                    clockPositionDegrees: values.clockPositionDegrees,
                    maxImageOrientationRepeats: values.maxImageOrientationRepeats,
                    rotationDegrees: values.rotationDegrees,
                    alignmentRule: {
                        centerTargetOffsetDegrees: values.centerTargetOffsetDegrees,
                        outerTargetOffsetDegrees: values.outerTargetOffsetDegrees,
                    },
                },
            },
        },
    }, userId, expectedQuestion(context));
}

async function buildDirectionsModal(question, parts, sourceInteraction) {
    const taskType = parts[4] ?? getQuestionTaskType(question);
    if (!getQuestionTaskEditorCapabilities(taskType).directions) {
        throw new Error('This question does not use image directions.');
    }
    const imageIds = getQuestionDirectionImageIds(question);
    if (imageIds.length < 1) {
        await respondAdminError(sourceInteraction, {
            embeds: [userErrorEmbed('Select Center and Outer images before editing their directions.')],
        });
        return undefined;
    }
    return {
        baseline: {
            image_directions: Object.fromEntries(Object.entries(question.generatedImage?.imageDirections ?? {})
                .map(([imageId, values]) => [imageId, Array.isArray(values) ? [...values] : []])),
            direction_image_ids: imageIds,
        },
        fields: [
            buildImageDirectionImageSelectField(imageIds),
            buildDirectionDegreesSelectField(),
        ],
    };
}

function readDirectionValues(interaction, state) {
    const directionImageIds = state.baseline?.direction_image_ids ?? [];
    const selectedImageTokens = getModalSelectValues(interaction, 'direction_image_ids');
    return {
        selectedImageTokens,
        imageIds: selectedImageTokens.map((token) => {
            const match = /^image-(\d+)$/.exec(token);
            return match ? directionImageIds[Number(match[1])] : undefined;
        }).filter(Boolean),
        degrees: getModalSelectValues(interaction, 'direction_degrees').map(Number),
    };
}

function validateDirectionValues(question, values) {
    if (values.imageIds.length !== values.selectedImageTokens.length || values.imageIds.length < 1) {
        return 'Select at least one valid configured image.';
    }
    if (values.degrees.length < 1) return 'Select at least one direction/orientation.';
    const currentConfiguredIds = new Set(getQuestionDirectionImageIds(question));
    const unavailableImageIds = values.imageIds.filter((imageId) => !currentConfiguredIds.has(imageId));
    if (unavailableImageIds.length > 0) {
        return `These images are no longer configured for this question: ${unavailableImageIds.join(', ')}`;
    }
    const invalidDegrees = values.degrees.filter((degree) => !ROTATION_DEGREE_VALUES.has(String(degree)));
    return invalidDegrees.length > 0
        ? `Invalid direction degree${invalidDegrees.length === 1 ? '' : 's'}: ${invalidDegrees.join(', ')}`
        : undefined;
}

function resolveDirectionEdits(question, baseline, values) {
    const submittedDirections = values.degrees.map(String);
    const currentDirections = question.generatedImage?.imageDirections ?? {};
    const openingDirections = baseline?.image_directions ?? {};
    const directionUpdates = {};
    for (const imageId of values.imageIds) {
        const currentValues = (currentDirections[imageId] ?? []).map(String);
        const openingValues = (openingDirections[imageId] ?? []).map(String);
        if (sameStringSet(submittedDirections, openingValues) || sameStringSet(submittedDirections, currentValues)) continue;
        if (!sameStringSet(currentValues, openingValues)) {
            throw new Error(`The directions for image file **${imageId}** were changed by another administrator. Reopen the editor and apply your change again.`);
        }
        directionUpdates[imageId] = values.degrees;
    }
    return directionUpdates;
}

const QUESTION_TASK_EDITOR_DESCRIPTORS = Object.freeze({
    galleryLimits: {
        modalAction: 'questionGalleryLimitsModal',
        title: 'Edit Gallery Limits',
        buildModal: ({ question }) => buildGalleryLimitsModal(question),
        submitAvailable: ({ question, state }) => {
            const taskType = getQuestionTaskType(question);
            if (!getQuestionTaskEditorCapabilities(taskType).galleryLimits) {
                return 'This question no longer uses a gallery task.';
            }
            return state.baseline?.['gallery task type'] !== taskType
                ? 'The gallery task type changed while this editor was open. Reopen Gallery Limits and apply the change again.'
                : undefined;
        },
        readValues: ({ interaction, question }) => {
            const taskCapabilities = getQuestionTaskEditorCapabilities(getQuestionTaskType(question));
            const roleSpecificLimits = taskCapabilities.roleSpecificGalleryLimits === true;
            return {
                galleryPresentation: getRequiredModalSingleSelect(interaction, 'gallery_presentation', GALLERY_PRESENTATION_OPTIONS, 'gallery presentation'),
                gallerySize: getRequiredGalleryLimit(interaction, 'gallery_size', 'gallery size'),
                minimumSolutionImages: roleSpecificLimits
                    ? undefined
                    : getRequiredGalleryLimit(interaction, 'minimum_solution_images', 'minimum solution images'),
                maximumSolutionImages: roleSpecificLimits
                    ? undefined
                    : getRequiredGalleryLimit(interaction, 'maximum_solution_images', 'maximum solution images'),
            };
        },
        resolveEdits: ({ question, state, values }) => resolveGalleryLimitEdits(question, state.baseline, values),
        hasChanges: ({ edits }) => baselineEditsChanged(edits),
        validate: validateGalleryLimits,
        write: writeGalleryLimits,
    },
    solutionImageLimits: {
        modalAction: 'questionSolutionImageLimitsModal',
        title: 'Edit Solution Image Limits',
        buildModal: ({ question }) => buildSolutionImageLimitsModal(question),
        submitAvailable: ({ question, state }) => {
            const taskType = getQuestionTaskType(question);
            if (!getQuestionTaskEditorCapabilities(taskType).roleSpecificGalleryLimits) {
                return 'This question no longer uses solution image limits.';
            }
            return state.baseline?.['gallery task type'] !== taskType
                ? 'The gallery task type changed while this editor was open. Reopen Solution Images and apply the change again.'
                : undefined;
        },
        readValues: ({ interaction }) => ({
            minimumSolutionImages: getRequiredGalleryLimit(interaction, 'minimum_solution_images', 'minimum solution images'),
            maximumSolutionImages: getRequiredGalleryLimit(interaction, 'maximum_solution_images', 'maximum solution images'),
            maximumSolutionRepeats: getRequiredGalleryLimit(interaction, 'maximum_solution_repeats', 'maximum solution occurrences'),
        }),
        resolveEdits: ({ question, state, values }) => resolveSolutionImageLimitEdits(question, state.baseline, values),
        hasChanges: ({ edits, context }) => baselineEditsChanged(edits)
            || context.pendingImageSelection?.changed === true,
        validate: validateSolutionImageLimits,
        write: writeSolutionImageLimits,
    },
    controlImageLimits: {
        modalAction: 'questionControlImageLimitsModal',
        title: 'Edit Control Image Limits',
        buildModal: ({ question }) => buildControlImageLimitsModal(question),
        submitAvailable: ({ question, state }) => {
            const taskType = getQuestionTaskType(question);
            if (!getQuestionTaskEditorCapabilities(taskType).roleSpecificGalleryLimits) {
                return 'This question no longer uses control image limits.';
            }
            return state.baseline?.['gallery task type'] !== taskType
                ? 'The gallery task type changed while this editor was open. Reopen Control Images and apply the change again.'
                : undefined;
        },
        readValues: ({ interaction }) => ({
            maximumControlRepeats: getRequiredGalleryLimit(interaction, 'maximum_control_repeats', 'maximum control occurrences'),
        }),
        resolveEdits: ({ question, state, values }) => resolveControlImageLimitEdits(question, state.baseline, values),
        hasChanges: ({ edits, context }) => baselineEditsChanged(edits)
            || context.pendingImageSelection?.changed === true,
        validate: validateControlImageLimits,
        write: writeControlImageLimits,
    },
    rotationSettings: {
        modalAction: 'questionRotationSettingsModal',
        title: 'Edit Rotation Settings',
        buildModal: ({ question }) => buildRotationSettingsModal(question),
        submitAvailable: ({ question }) => getQuestionTaskEditorCapabilities(getQuestionTaskType(question)).rotationSettings
            ? undefined : 'This question no longer uses Rotation Alignment settings.',
        readValues: ({ interaction }) => {
            const clockPositions = getModalSelectValues(interaction, 'clock_positions');
            const rotationDegrees = getModalSelectValues(interaction, 'rotation_degrees');
            if (clockPositions.length < 1 || clockPositions.some((value) => !ROTATION_DEGREE_VALUES.has(value))) {
                throw new Error('Select at least one valid clock position.');
            }
            if (rotationDegrees.length < 1 || rotationDegrees.some((value) => !ROTATION_DEGREE_VALUES.has(value))) {
                throw new Error('Select at least one valid generated rotation.');
            }
            return {
                clockPositions,
                rotationDegrees,
                maximumPositionRepeats: getRequiredGalleryLimit(interaction, 'maximum_position_repetitions', 'maximum position repetitions'),
                centerOffset: Number(getRequiredModalSingleSelect(interaction, 'center_target_offset', ROTATION_DEGREE_OPTIONS, 'center target offset')),
                outerOffset: Number(getRequiredModalSingleSelect(interaction, 'outer_target_offset', ROTATION_DEGREE_OPTIONS, 'outer target offset')),
            };
        },
        resolveEdits: ({ question, state, values }) => resolveRotationSettingsEdits(question, state.baseline, values),
        hasChanges: ({ edits }) => baselineEditsChanged(edits),
        validate: validateRotationSettings,
        write: writeRotationSettings,
    },
    directions: {
        modalAction: 'questionDirectionsModal',
        title: 'Assign Image Directions',
        buildModal: ({ question, parts, sourceInteraction }) => buildDirectionsModal(question, parts, sourceInteraction),
        submitAvailable: ({ question }) => getQuestionTaskEditorCapabilities(getQuestionTaskType(question)).directions
            ? undefined : 'This question does not use image directions.',
        readValues: ({ interaction, state }) => readDirectionValues(interaction, state),
        validateValues: ({ question, values }) => validateDirectionValues(question, values),
        resolveEdits: ({ question, state, values }) => resolveDirectionEdits(question, state.baseline, values),
        hasChanges: ({ edits }) => Object.keys(edits).length > 0,
        write: ({ context, edits, userId }) => updateCatalogQuestionImageDirections(
            context.guildId,
            context.challengeId,
            context.question.id,
            edits,
            userId,
            expectedQuestion(context),
        ),
    },
});

const DESCRIPTOR_MODAL_EDITORS = Object.freeze(Object.fromEntries(
    Object.entries(QUESTION_TASK_EDITOR_DESCRIPTORS).map(([name, descriptor]) => [name, {
        action: descriptor.modalAction,
        title: descriptor.title,
        available: ({ phase, object: question, state }) => phase === 'submit'
            ? descriptor.submitAvailable?.({ question, state })
            : undefined,
        build: ({ context, object: question, interaction, parts, state }) =>
            addPendingImageSelectionBaseline(descriptor.buildModal({
                context,
                question,
                sourceInteraction: interaction,
                parts,
                state,
            }), context),
        read: ({ interaction, object: question, state }) =>
            descriptor.readValues({ interaction, question, state }),
        validateValues: ({ context, object: question, state, values }) =>
            descriptor.validateValues?.({ context, question, state, values }),
        resolve: ({ object: question, state, values }) =>
            descriptor.resolveEdits({ question, state, values }),
        hasChanges: ({ context, object: question, edits }) =>
            descriptor.hasChanges({ context, question, edits }),
        validate: ({ context, object: question, state, values, edits }) =>
            descriptor.validate?.({ context, question, state, values, edits }),
        commit: ({ context, object: question, edits, actorId }) =>
            descriptor.write({
                context,
                question,
                edits,
                userId: actorId,
            }),
    }]),
));

const questionTaskModalEditor = createDescriptorModalEditor({
    descriptors: DESCRIPTOR_MODAL_EDITORS,
    loadOpenContext: ({ interaction, parts, state }) =>
        loadQuestionTaskOpenContext(interaction, parts, state),
    beginSubmission: ({ interaction, parts, state }) =>
        beginQuestionTaskModalSubmission(interaction, parts, state),
    getObject: (context) => context.question,
    getModalParts: ({ context }) => [
        context.guildId,
        context.ownerUserId,
        context.challengeId,
        context.question.id,
    ],
    buildCustomId: ({ action, modalParts, baseline, state, interaction }) =>
        state.panelSession.buildForm(action, modalParts, baseline, interaction.customId),
    buildModal: ({ customId, title, fields }) => buildAdminModal(customId, title, ...fields),
    respondError: ({ interaction, acknowledgement, message }) =>
        respondAdminModalError(interaction, acknowledgement, { embeds: [userErrorEmbed(message)] }),
    respondNoChanges: ({ interaction, acknowledgement }) =>
        respondAdminNoChanges(interaction, acknowledgement),
    complete: async ({ interaction, context, result, state }) => {
        return replyWithCommittedQuestionPanel(
            interaction,
            context,
            result,
            state,
        );
    },
});

const openQuestionTask = (name) => (interaction, parts, state) =>
    questionTaskModalEditor.open(name, interaction, parts, state);
const submitQuestionTask = (name) => (interaction, parts, state) =>
    questionTaskModalEditor.submit(name, interaction, parts, state);
const showQuestionGalleryLimitsModal = openQuestionTask('galleryLimits');
const showQuestionSolutionImageLimitsModal = openQuestionTask('solutionImageLimits');
const showQuestionControlImageLimitsModal = openQuestionTask('controlImageLimits');
const showQuestionRotationSettingsModal = openQuestionTask('rotationSettings');
const showQuestionDirectionsModal = openQuestionTask('directions');
const handleQuestionGalleryLimitsModalSubmit = submitQuestionTask('galleryLimits');
const handleQuestionSolutionImageLimitsModalSubmit = submitQuestionTask('solutionImageLimits');
const handleQuestionControlImageLimitsModalSubmit = submitQuestionTask('controlImageLimits');
const handleQuestionRotationSettingsModalSubmit = submitQuestionTask('rotationSettings');
const handleQuestionDirectionsModalSubmit = submitQuestionTask('directions');

module.exports = {
    handleQuestionControlImageLimitsModalSubmit,
    handleQuestionDirectionsModalSubmit,
    handleQuestionGalleryLimitsModalSubmit,
    handleQuestionRotationSettingsModalSubmit,
    handleQuestionSolutionImageLimitsModalSubmit,
    showQuestionControlImageLimitsModal,
    showQuestionDirectionsModal,
    showQuestionGalleryLimitsModal,
    showQuestionRotationSettingsModal,
    showQuestionSolutionImageLimitsModal,
};
