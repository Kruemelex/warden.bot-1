const Discord = require('discord.js');
const crypto = require('crypto');
const { createVerificationLogger } = require('../logging');
const {
    COMPONENTS_V2_RENDERER,
    LEGACY_RENDERER,
} = require('../presentation/documents/challengeScreen');
const { buildVerificationStateOptions } = require('../presentation/documents/notices');
const {
    deferSourceUpdate,
    sanitizeMessageEditOptions,
} = require('./interactionResponses');

const messageCleanupLog = createVerificationLogger('Message cleanup');

const CHALLENGE_FINGERPRINT_IGNORED_FIELDS = new Set([
    'createdAt', 'createdBy', 'protectedTemplate', 'sourceTemplateId', 'sourceType',
    'templateVersion', 'updatedAt', 'updatedBy',
]);

function canonicalizeChallengeValue(value) {
    if (Array.isArray(value)) return value.map(canonicalizeChallengeValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        if (CHALLENGE_FINGERPRINT_IGNORED_FIELDS.has(key)) return result;
        const canonicalValue = canonicalizeChallengeValue(value[key]);
        if (canonicalValue !== undefined) result[key] = canonicalValue;
        return result;
    }, {});
}

function projectChallengeBehavior(challenge = {}) {
    const { title: _title, description: _description, questions = [], ...challengeBehavior } = challenge;
    return {
        ...challengeBehavior,
        questions: questions.map(({ label: _label, text: _text, answer, ...questionBehavior }) => {
            if (!answer) return questionBehavior;
            const { inputLabel: _inputLabel, inputPlaceholder: _inputPlaceholder, ...answerBehavior } = answer;
            return { ...questionBehavior, answer: answerBehavior };
        }),
    };
}

function createChallengeFingerprint(challenge) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalizeChallengeValue(projectChallengeBehavior(challenge))))
        .digest('hex');
}

function setSessionMessageHandle(session, role, id, renderer) {
    if (!id) return undefined;
    session.messageHandles ??= {};
    const handle = { id, role, renderer };
    session.messageHandles[role] = handle;
    return handle;
}

function getSessionMessageHandle(session, role) {
    return session?.messageHandles?.[role];
}

function cloneSessionMessageHandles(session) {
    return Object.fromEntries(Object.entries(session?.messageHandles ?? {})
        .map(([role, handle]) => [role, { ...handle }]));
}

function getOldVersionPromptHandle(session) {
    return getSessionMessageHandle(session, 'fallback-prompt');
}

function getPayloadRenderer(options = {}) {
    if ((Number(options.flags ?? 0) & Discord.MessageFlags.IsComponentsV2) !== 0) {
        return COMPONENTS_V2_RENDERER;
    }
    if (Array.isArray(options.embeds)) return LEGACY_RENDERER;
    // Do not guess for an intentionally minimal payload. This keeps typed
    // handles protective in production while allowing no-op test/adapter
    // payloads that carry no renderer-specific fields.
    return undefined;
}

function assertRendererSafeEdit(handle, options) {
    if (!handle?.id) return;
    const payloadRenderer = getPayloadRenderer(options);
    if (payloadRenderer && handle.renderer !== payloadRenderer) {
        throw new Error(`Refusing to edit ${handle.role} message ${handle.id} with ${payloadRenderer}; it is a ${handle.renderer} message.`);
    }
}

async function editStoredVerificationMessage(interaction, handle, options) {
    if (!handle?.id) throw new Error('There is no stored verification message to edit.');
    assertRendererSafeEdit(handle, options);
    return interaction.webhook.editMessage(handle.id, sanitizeMessageEditOptions(options));
}

async function replaceQuestionMessage(interaction, session, options, { forceStoredMessage = false } = {}) {
    const editOptions = sanitizeMessageEditOptions({ ...options, flags: options.flags ?? Discord.MessageFlags.Ephemeral });
    const questionHandle = getSessionMessageHandle(
        session,
        'challenge',
    );
    if (questionHandle) assertRendererSafeEdit(questionHandle, editOptions);

    const replacementErrors = [];
    try {
        if (!forceStoredMessage && interaction.isButton?.() && !interaction.deferred && !interaction.replied) {
            await interaction.update(editOptions);
            return { id: questionHandle?.id, created: false };
        }

        if (forceStoredMessage && interaction.isButton?.() && !interaction.deferred && !interaction.replied) {
            await deferSourceUpdate(interaction);
        }

        if (interaction.isModalSubmit?.() || forceStoredMessage) {
            const message = await interaction.webhook.editMessage(questionHandle?.id ?? '@original', editOptions);
            return { id: message?.id ?? questionHandle?.id, created: false };
        }

        if (interaction.deferred || interaction.replied) {
            const message = await interaction.editReply(editOptions);
            return { id: message?.id ?? questionHandle?.id, created: false };
        }
    }
    catch (err) {
        replacementErrors.push(err);
    }

    const message = await interaction.followUp({ ...options, flags: options.flags ?? Discord.MessageFlags.Ephemeral }).catch((err) => {
        replacementErrors.push(err);
        return undefined;
    });
    if (message?.id) return { id: message.id, created: true };
    if (replacementErrors.length < 1) {
        replacementErrors.push(new Error('Discord returned no verification replacement message.'));
    }
    throw new AggregateError(
        replacementErrors,
        'Discord could not replace the verification question message.',
        { cause: replacementErrors[0] },
    );
}

async function editOldVersionPrompt(interaction, session, options) {
    const promptHandle = getOldVersionPromptHandle(session);
    if (!promptHandle) {
        throw new Error('The verification Old Version prompt is no longer editable.');
    }

    const editedMessage = await editStoredVerificationMessage(interaction, promptHandle, options);
    if (!editedMessage?.id) {
        throw new Error('Discord did not confirm the verification Old Version prompt update.');
    }
    return editedMessage;
}

async function deactivateOldVersionPrompt(interaction, session, options = {}) {
    const promptHandle = getOldVersionPromptHandle(session);
    if (!promptHandle) return;

    await editStoredVerificationMessage(
        interaction,
        promptHandle,
        buildVerificationStateOptions(
            options.description ?? 'A legacy embed version of this verification challenge was sent below.',
            {
                renderer: LEGACY_RENDERER,
                title: options.title ?? 'Old Version sent',
            },
        ),
    );
}

function getQuestionMessageHandle(session) {
    return getSessionMessageHandle(session, 'challenge');
}

async function deactivateQuestionMessage(interaction, session, message = 'Verification step completed.', options = {}) {
    const questionHandle = getQuestionMessageHandle(session);
    if (!questionHandle) return;

    await editStoredVerificationMessage(
        interaction,
        questionHandle,
        buildVerificationStateOptions(message, {
            renderer: questionHandle.renderer,
            ...options,
        }),
    ).catch((err) => {
        messageCleanupLog.warn('Failed to deactivate question message:', err);
    });
}

module.exports = {
    cloneSessionMessageHandles,
    createChallengeFingerprint,
    deactivateOldVersionPrompt,
    deactivateQuestionMessage,
    editOldVersionPrompt,
    editStoredVerificationMessage,
    getOldVersionPromptHandle,
    getQuestionMessageHandle,
    replaceQuestionMessage,
    setSessionMessageHandle,
};
