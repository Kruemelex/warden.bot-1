const Discord = require('discord.js');
const { createDescriptorModalEditor } = require('../../ux/interactions/editor');
const { acknowledgePanelInteraction } = require('../../ux/interactions/acknowledgement');
const {
    buildExistingTextField,
    buildModal: buildAdminModal,
    buildModalRoleSelectField,
    buildModalStringSelectField,
    getAllowedOptionValues,
    getModalSelectedRole,
    getModalSelectValues,
    getModalTextInput,
    getRequiredModalSingleSelect,
} = require('../../ux/components/modalFields');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const { formatDuration } = require('../presentation/templates');
const {
    VERIFICATION_MODES,
    getVerificationSnapshot,
    saveVerificationGuildSettingsOnly,
} = require('../service');
const { notifyVerificationAutokickScheduleChanged } = require('../runtime/autokickEngine');
const {
    scheduleVerificationPostReconciliation,
} = require('../runtime/postReconciler');
const { getChallengeSelectOptions } = require('./challengeEditor');
const { resolveBaselineEdits } = require('./edits');
const {
    buildActiveChallengeIdsValue,
    buildAdminEditorSection,
    buildUpdatedAuditField,
    buildVerificationAdminPanel,
    replaceAdminPanel,
} = require('./panel');
const {
    respondAdminError,
    respondAdminModalError,
    respondAdminNoChanges,
    userErrorEmbed,
} = require('./feedback');

const SETTINGS_MODE_OPTIONS = [
    { label: 'Challenge', value: VERIFICATION_MODES.challenge },
    { label: 'Halt', value: VERIFICATION_MODES.halt },
    { label: 'One-Click', value: VERIFICATION_MODES.oneClick },
];

const SETTINGS_AUTOKICK_OPTIONS = [
    { label: 'ON', value: 'on' },
    { label: 'OFF', value: 'off' },
];

function publicPostAutokickSignature(settings) {
    return settings?.autokickEnabled
        ? `enabled:${settings.autokickSeconds}`
        : 'disabled';
}

function getRequiredModalRole(interaction, customId, fieldLabel) {
    const role = getModalSelectedRole(interaction, customId);
    if (!role) throw new Error(`Please select a valid ${fieldLabel}.`);
    if (role.id === interaction.guild?.id) {
        throw new Error('The @everyone role cannot be used as the Verification Role.');
    }
    if (role.managed) {
        throw new Error('A bot or integration-managed role cannot be used as the Verification Role.');
    }
    if (!role.editable) {
        throw new Error('Warden cannot manage that role. Move Warden above it in the server role list, then try again.');
    }
    return role;
}

function parseDurationSeconds(input) {
    const value = String(input ?? '').trim().toLowerCase();
    if (!value) return undefined;

    const compactMatch = value.match(/^(\d+)(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/);
    if (compactMatch) {
        const amount = Number(compactMatch[1]);
        const unit = compactMatch[2] ?? 'seconds';
        return unit.startsWith('m') ? amount * 60 : amount;
    }

    const spacedMatch = value.match(/^(\d+)\s+(seconds?|secs?|minutes?|mins?)$/);
    if (spacedMatch) {
        const amount = Number(spacedMatch[1]);
        return spacedMatch[2].startsWith('m') ? amount * 60 : amount;
    }

    return undefined;
}

function assertSettingsChallengeSelectMenuLimit(challenges) {
    const count = Object.values(challenges).length;
    if (count > VERIFICATION_UI_LIMITS.selectOptions) {
        throw new Error(`There are ${count} configured challenges, but Verification Admin supports at most ${VERIFICATION_UI_LIMITS.selectOptions}.`);
    }
}

function buildSettingsEditButton(action, guildId, ownerUserId, panelSession) {
    return new Discord.ButtonBuilder()
        .setCustomId(panelSession.build(action, guildId, ownerUserId))
        .setLabel('Edit')
        .setStyle(Discord.ButtonStyle.Secondary);
}

function buildSettingsSections(verificationSettings, challenges, guildId, ownerUserId, panelSession) {
    const missingActiveChallenges = verificationSettings.mode === VERIFICATION_MODES.challenge
        && !(verificationSettings.activeChallengeIds?.length > 0);
    const verificationRoleId = verificationSettings.verificationRoleId;
    const section = (title, value, action) => buildAdminEditorSection(
        title,
        value,
        buildSettingsEditButton(action, guildId, ownerUserId, panelSession),
    );

    return [
        section(
            `${verificationRoleId ? '' : '⚠️ '}Verification Role`,
            verificationRoleId ? `<@&${verificationRoleId}>` : 'Not configured',
            'settingsEditRole',
        ),
        section('Mode', verificationSettings.mode, 'settingsEditMode'),
        section(
            `${missingActiveChallenges ? '⚠️ ' : ''}Active Challenges`,
            buildActiveChallengeIdsValue(verificationSettings),
            'settingsEditChallenges',
        ),
        section('Challenge Timers', [
            `- **Screen Expiry:** ${formatDuration(verificationSettings.screenExpirySeconds)}`,
            `- **Retry Cooldown:** ${formatDuration(verificationSettings.cooldownSeconds)}`,
        ], 'settingsEditChallengeTimers'),
        section('Autokick', [
            `- **State:** ${verificationSettings.autokickEnabled ? 'ON' : 'OFF'}`,
            `- **Timer:** ${formatDuration(verificationSettings.autokickSeconds)}`,
        ], 'settingsEditAutokick'),
    ];
}

function buildSettingsPanelPayload({ verificationSettings, challenges, guildId, ownerUserId }) {
    return buildVerificationAdminPanel({
        guildId,
        ownerUserId,
        key: `settings:${guildId}`,
        state: {
            panelViewModel: Object.freeze({ settings: verificationSettings, challenges }),
        },
        compose: (panelSession) => ({
            title: 'Verification Settings',
            description: 'Current verification settings.',
            sections: buildSettingsSections(
                verificationSettings,
                challenges,
                guildId,
                ownerUserId,
                panelSession,
            ),
            trailingFields: buildUpdatedAuditField(verificationSettings),
        }),
    });
}

async function handleVerificationSettingsCommand(interaction, guildId) {
    const snapshot = await getVerificationSnapshot(guildId);
    return interaction.editReply(buildSettingsPanelPayload({
        verificationSettings: snapshot.guildSettings,
        challenges: snapshot.challengeCatalog,
        guildId,
        ownerUserId: interaction.user.id,
    }));
}

function durationField(customId, label, seconds, options = {}) {
    return buildExistingTextField({
        customId,
        label,
        currentValue: `${seconds}s`,
        maxLength: 32,
        ...options,
    });
}

function parseDurationField(interaction, customId, label) {
    const input = getModalTextInput(interaction, customId);
    const seconds = parseDurationSeconds(input);
    if (!seconds) {
        throw new Error(`Invalid ${label}. Use a value like \`90s\`, \`2m\`, or \`2 minutes\`.`);
    }
    return seconds;
}

function scalarEdits(state, definitions) {
    return resolveBaselineEdits(state.baseline, definitions);
}

function settingsRevisionBaseline(settings, values = {}) {
    return { ...values, settings_revision: settings.settingsRevision };
}

const SETTINGS_EDITOR_DEFINITIONS = Object.freeze({
    role: {
        action: 'settingsRoleModal',
        title: 'Edit Verification Role',
        notifyAutokickScheduleChanged: true,
        build: ({ object: settings, interaction }) => ({
            baseline: settingsRevisionBaseline(settings, {
                verification_role_id: settings.verificationRoleId ?? '',
            }),
            fields: [buildModalRoleSelectField({
                label: 'Verification Role',
                description: 'Removed on success and used to identify autokick candidates.',
                customId: 'verification_role_id',
                placeholder: 'Choose the unverified member role...',
                selectedRoleId: interaction.guild?.roles.cache.has(settings.verificationRoleId)
                    ? settings.verificationRoleId
                    : undefined,
            })],
        }),
        read: ({ interaction }) => ({
            roleId: getRequiredModalRole(interaction, 'verification_role_id', 'Verification Role').id,
        }),
        resolve: ({ state, object: settings, values }) => scalarEdits(state, {
            roleId: {
                baselineKey: 'verification_role_id',
                current: settings.verificationRoleId ?? '',
                submitted: values.roleId,
            },
        }),
        patch: ({ edits }) => ({ verificationRoleId: edits.roleId.value }),
    },
    mode: {
        action: 'settingsModeModal',
        title: 'Edit Verification Mode',
        build: ({ object: settings }) => ({
            baseline: settingsRevisionBaseline(settings, { mode: settings.mode }),
            fields: [buildModalStringSelectField({
                label: 'Mode',
                description: 'Choose the verification mode.',
                customId: 'mode',
                placeholder: 'Choose verification mode...',
                options: SETTINGS_MODE_OPTIONS,
                selectedValues: [settings.mode],
            })],
        }),
        read: ({ interaction }) => ({
            mode: getRequiredModalSingleSelect(interaction, 'mode', SETTINGS_MODE_OPTIONS, 'verification mode'),
        }),
        resolve: ({ state, object: settings, values }) => scalarEdits(state, {
            mode: { current: settings.mode, submitted: values.mode },
        }),
        validate: ({ object: settings, edits }) => {
            const effectiveMode = edits.mode.changed ? edits.mode.value : settings.mode;
            return effectiveMode === VERIFICATION_MODES.challenge && !(settings.activeChallengeIds?.length > 0)
                ? 'Challenge mode requires at least one active challenge.'
                : undefined;
        },
        patch: ({ edits }) => ({ mode: edits.mode.value }),
    },
    challenges: {
        action: 'settingsChallengesModal',
        title: 'Edit Active Challenges',
        requiresChallenges: true,
        build: ({ object: settings, context }) => {
            const options = getChallengeSelectOptions(context.challenges);
            return {
                baseline: settingsRevisionBaseline(settings, {
                    active_challenge_ids: [...(settings.activeChallengeIds ?? [])],
                }),
                fields: [buildModalStringSelectField({
                    label: 'Active Challenges',
                    description: 'Challenge mode requires at least one; Halt and One-Click may be empty.',
                    customId: 'active_challenge_ids',
                    placeholder: 'Choose active challenges...',
                    options,
                    selectedValues: settings.activeChallengeIds ?? [],
                    minValues: 0,
                    maxValues: Math.max(1, options.length),
                    required: false,
                })],
            };
        },
        read: ({ interaction, context }) => {
            const challengeIds = getModalSelectValues(interaction, 'active_challenge_ids');
            const allowedIds = getAllowedOptionValues(getChallengeSelectOptions(context.challenges));
            if (challengeIds.some((challengeId) => !allowedIds.has(challengeId))) {
                throw new Error('One or more selected active challenges are no longer available.');
            }
            return { challengeIds };
        },
        resolve: ({ state, object: settings, values }) => scalarEdits(state, {
            challengeIds: {
                field: 'active challenges',
                baselineKey: 'active_challenge_ids',
                kind: 'string-set',
                current: settings.activeChallengeIds ?? [],
                submitted: values.challengeIds,
            },
        }),
        validate: ({ object: settings, edits }) => settings.mode === VERIFICATION_MODES.challenge
            && edits.challengeIds.value.length < 1
            ? 'Challenge mode requires at least one active challenge.'
            : undefined,
        patch: ({ edits }) => ({ activeChallengeIds: edits.challengeIds.value }),
    },
    challengeTimers: {
        action: 'settingsChallengeTimersModal',
        title: 'Edit Challenge Timers',
        build: ({ object: settings }) => ({
            baseline: settingsRevisionBaseline(settings, {
                screenExpirySeconds: String(settings.screenExpirySeconds),
                cooldownSeconds: String(settings.cooldownSeconds),
            }),
            fields: [
                durationField('screen_expiry_timer', 'Screen Expiry Timer', settings.screenExpirySeconds, {
                    placeholder: '10m or 600s',
                    description: 'Each delivered screen receives this full duration.',
                }),
                durationField('challenge_retry_cooldown', 'Challenge Retry Cooldown', settings.cooldownSeconds, {
                    placeholder: '60s or 1m',
                    description: 'Delay before another verification attempt.',
                }),
            ],
        }),
        read: ({ interaction }) => ({
            screenExpirySeconds: parseDurationField(interaction, 'screen_expiry_timer', 'Screen Expiry Timer'),
            cooldownSeconds: parseDurationField(interaction, 'challenge_retry_cooldown', 'Challenge Retry Cooldown'),
        }),
        resolve: ({ state, object: settings, values }) => scalarEdits(state, {
            screenExpirySeconds: {
                current: String(settings.screenExpirySeconds),
                submitted: String(values.screenExpirySeconds),
            },
            cooldownSeconds: {
                current: String(settings.cooldownSeconds),
                submitted: String(values.cooldownSeconds),
            },
        }),
        patch: ({ edits }) => ({
            screenExpirySeconds: Number(edits.screenExpirySeconds.value),
            cooldownSeconds: Number(edits.cooldownSeconds.value),
        }),
    },
    autokick: {
        action: 'settingsAutokickModal',
        title: 'Edit Autokick',
        notifyAutokickScheduleChanged: true,
        reconcileVerificationPosts: true,
        build: ({ object: settings }) => ({
            baseline: settingsRevisionBaseline(settings, {
                autokick_enabled: settings.autokickEnabled === true ? 'on' : 'off',
                autokickSeconds: String(settings.autokickSeconds),
            }),
            fields: [
                buildModalStringSelectField({
                    label: 'Autokick',
                    description: 'Choose whether failed verification autokicks.',
                    customId: 'autokick_enabled',
                    placeholder: 'Choose autokick state...',
                    options: SETTINGS_AUTOKICK_OPTIONS,
                    selectedValues: [settings.autokickEnabled === true ? 'on' : 'off'],
                }),
                durationField('autokick_timer', 'Autokick Timer', settings.autokickSeconds, {
                    placeholder: '10m or 600s',
                    description: 'Delay before an unverified member is removed.',
                }),
            ],
        }),
        read: ({ interaction }) => ({
            enabled: getRequiredModalSingleSelect(interaction, 'autokick_enabled', SETTINGS_AUTOKICK_OPTIONS, 'autokick state'),
            seconds: parseDurationField(interaction, 'autokick_timer', 'Autokick Timer'),
        }),
        resolve: ({ state, object: settings, values }) => scalarEdits(state, {
            enabled: {
                baselineKey: 'autokick_enabled',
                current: settings.autokickEnabled === true ? 'on' : 'off',
                submitted: values.enabled,
            },
            seconds: {
                baselineKey: 'autokickSeconds',
                current: String(settings.autokickSeconds),
                submitted: String(values.seconds),
            },
        }),
        patch: ({ edits }) => ({
            autokickEnabled: edits.enabled.value === 'on',
            autokickSeconds: Number(edits.seconds.value),
        }),
    },
});

function getSettingsEditorIdentity(parts) {
    const [guildId, ownerUserId] = parts;
    return { guildId, ownerUserId };
}

async function loadSettingsOpenContext(interaction, parts, descriptor, state) {
    const identity = getSettingsEditorIdentity(parts);
    const viewModel = state?.panelViewModel;
    if (!viewModel?.settings) {
        await respondAdminError(interaction, {
            embeds: [userErrorEmbed('This settings panel expired. Reopen /verification-settings.')],
        });
        return { error: true };
    }
    const { settings, challenges } = viewModel;
    if (descriptor.requiresChallenges) assertSettingsChallengeSelectMenuLimit(challenges);
    return { ...identity, settings, challenges };
}

async function loadSettingsSubmissionContext(parts, descriptor) {
    const identity = getSettingsEditorIdentity(parts);
    const snapshot = await getVerificationSnapshot(identity.guildId, { fresh: true });
    const settings = snapshot.guildSettings;
    const challenges = descriptor.requiresChallenges
        ? snapshot.challengeCatalog
        : undefined;
    if (descriptor.requiresChallenges) assertSettingsChallengeSelectMenuLimit(challenges);
    return { ...identity, settings, challenges };
}

async function commitSettingsEdit(descriptor, { context, edits, actorId, state }) {
    return saveVerificationGuildSettingsOnly(
        context.guildId,
        { ...context.settings, ...descriptor.patch({ edits }) },
        actorId,
        { expectedRevision: state.baseline?.settings_revision },
    );
}

const SETTINGS_EDITOR_DESCRIPTORS = Object.freeze(Object.fromEntries(
    Object.entries(SETTINGS_EDITOR_DEFINITIONS).map(([name, descriptor]) => [name, Object.freeze({
        ...descriptor,
        commit: (details) => commitSettingsEdit(descriptor, details),
    })]),
));

const settingsModalEditor = createDescriptorModalEditor({
    descriptors: SETTINGS_EDITOR_DESCRIPTORS,
    loadOpenContext: ({ descriptor, interaction, parts, state }) =>
        loadSettingsOpenContext(interaction, parts, descriptor, state),
    beginSubmission: async ({ descriptor, interaction, parts, state }) => {
        const acknowledgement = await acknowledgePanelInteraction(interaction, {
            sourceCustomId: state.sourceCustomId,
            panelSession: state.panelSession,
            formGeneration: state.formGeneration,
        });
        const context = await loadSettingsSubmissionContext(parts, descriptor);
        return { acknowledgement, context };
    },
    getObject: (context) => context.settings,
    getModalParts: ({ context }) => [
        context.guildId,
        context.ownerUserId,
    ],
    buildCustomId: ({ action, modalParts, baseline, state, interaction }) =>
        state.panelSession.buildForm(action, modalParts, baseline, interaction.customId),
    buildModal: ({ customId, title, fields }) => buildAdminModal(customId, title, ...fields),
    respondError: ({ interaction, acknowledgement, message }) => respondAdminModalError(
        interaction,
        acknowledgement,
        { embeds: [userErrorEmbed(message)] },
    ),
    respondNoChanges: ({ interaction, acknowledgement }) => respondAdminNoChanges(interaction, acknowledgement),
    complete: ({ interaction, context, descriptor, result, state }) => {
        if (descriptor.notifyAutokickScheduleChanged) notifyVerificationAutokickScheduleChanged(context.guildId);
        if (
            descriptor.reconcileVerificationPosts
            && publicPostAutokickSignature(context.settings)
                !== publicPostAutokickSignature(result.snapshot.guildSettings)
        ) {
            void scheduleVerificationPostReconciliation(
                context.guildId,
                result.snapshot.guildSettings,
                'autokick settings changed',
            );
        }
        return replaceAdminPanel(interaction, {
            sourcePanelSession: state.panelSession,
            committed: true,
            buildPayload: () => buildSettingsPanelPayload({
                verificationSettings: result.snapshot.guildSettings,
                challenges: result.snapshot.challengeCatalog,
                guildId: context.guildId,
                ownerUserId: context.ownerUserId,
            }),
        });
    },
});

const openSettings = (name) => (interaction, parts, state) =>
    settingsModalEditor.open(name, interaction, parts, state);
const submitSettings = (name) => (interaction, parts, state) =>
    settingsModalEditor.submit(name, interaction, parts, state);
const showSettingsRoleModal = openSettings('role');
const showSettingsModeModal = openSettings('mode');
const showSettingsChallengesModal = openSettings('challenges');
const showSettingsChallengeTimersModal = openSettings('challengeTimers');
const showSettingsAutokickModal = openSettings('autokick');
const handleSettingsRoleModalSubmit = submitSettings('role');
const handleSettingsModeModalSubmit = submitSettings('mode');
const handleSettingsChallengesModalSubmit = submitSettings('challenges');
const handleSettingsChallengeTimersModalSubmit = submitSettings('challengeTimers');
const handleSettingsAutokickModalSubmit = submitSettings('autokick');

module.exports = {
    handleSettingsAutokickModalSubmit,
    handleSettingsChallengesModalSubmit,
    handleSettingsChallengeTimersModalSubmit,
    handleSettingsModeModalSubmit,
    handleSettingsRoleModalSubmit,
    handleVerificationSettingsCommand,
    showSettingsAutokickModal,
    showSettingsChallengesModal,
    showSettingsChallengeTimersModal,
    showSettingsModeModal,
    showSettingsRoleModal,
};
