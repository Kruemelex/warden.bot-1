const Discord = require('discord.js');
const { reportVerificationError } = require('../errorLogging');
const {
    VERIFICATION_MODES,
} = require('../service');
const {
    LEGACY_RENDERER,
} = require('../presentation/documents/challengeScreen');
const {
    buildVerificationExpiredResponse,
    buildVerificationStateOptions,
} = require('../presentation/documents/notices');
const {
    isVerificationRenderAvailabilityError,
    isVerificationRenderCapacityError,
} = require('../assets/errors');
const {
    deliverPanelUpdateOrFallback,
    sendEphemeralNotice,
} = require('./interactionResponses');
const {
    beginAutokickCompletion,
    finishAutokickCompletion,
    releaseAutokickCompletion,
} = require('./autokickEngine');
const {
    clearChallenge,
    clearChallengeIfCurrent,
    clearCooldown,
    clearVerificationStateIfCurrent,
    getInteractionStateKey,
    resolveVerificationMode,
} = require('./liveSessionState');
const {
    createChallengeFingerprint,
    deactivateQuestionMessage,
    editStoredVerificationMessage,
    getQuestionMessageHandle,
} = require('./liveMessageRenderer');
const { getPublishedVerificationRuntimeContext } = require('./runtimeContext');

async function resolveManageableVerificationRole(guild, runtime) {
    const verificationRoleId = runtime?.verificationRoleId;
    if (!verificationRoleId) throw new Error('The Verification Role is not configured.');

    const role = guild?.roles.cache.get(verificationRoleId)
        ?? await guild?.roles.fetch(verificationRoleId).catch(() => null);
    if (!role) throw new Error('The configured Verification Role no longer exists.');
    if (!role.editable) throw new Error('Warden cannot manage the configured Verification Role.');
    return role;
}

function isUnknownGuildMemberError(err) {
    const code = err?.code ?? err?.rawError?.code;
    return code === Discord.RESTJSONErrorCodes.UnknownMember || code === 'Unknown Member';
}

async function fetchCurrentVerificationMember(guild, userId) {
    try {
        return await guild.members.fetch({ user: userId, force: true });
    }
    catch (err) {
        if (isUnknownGuildMemberError(err)) return null;
        throw err;
    }
}

async function restoreVerificationRoleAfterMembershipRace(member, verificationRole, shouldRestore) {
    if (!shouldRestore || !member || member.roles.cache.has(verificationRole.id)) return;
    await member.roles.add(
        verificationRole,
        'Restoring verification gate after membership changed during verification.',
    );
}

async function releaseCompletionFence(fence, error) {
    if (!fence) return;
    await releaseAutokickCompletion(fence, error);
}

function verificationCompletionConflictMessage() {
    return 'Your server membership or verification state changed while verification was completing. Please start again.';
}

function buildVerificationCompletionConflict(message) {
    const error = new Error(message);
    error.code = 'VERIFICATION_COMPLETION_CONFLICT';
    return error;
}

async function rollbackVerificationCompletion({
    interaction,
    completionFence,
    verificationRole,
    removedVerificationRole,
}, error) {
    const cleanupErrors = [];
    try {
        const currentMember = await fetchCurrentVerificationMember(
            interaction.guild,
            interaction.user.id,
        );
        await restoreVerificationRoleAfterMembershipRace(
            currentMember,
            verificationRole,
            removedVerificationRole || error?.code === 'VERIFICATION_COMPLETION_CONFLICT',
        );
    }
    catch (cleanupError) {
        cleanupErrors.push(cleanupError);
    }
    try {
        await releaseCompletionFence(completionFence, error);
    }
    catch (cleanupError) {
        cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
        throw new AggregateError(
            [error, ...cleanupErrors],
            'Verification completion failed and could not be fully rolled back.',
        );
    }
}

function getLiveSessionConfigurationChange(context, session) {
    const snapshot = context.snapshot;
    const runtime = snapshot.runtime;
    if (resolveVerificationMode(runtime) !== VERIFICATION_MODES.challenge) {
        return 'Verification mode changed while this challenge was in progress. Please start again.';
    }
    if (!(runtime.activeChallengeIds ?? []).includes(String(session.challengeId))) {
        return 'This verification challenge was deactivated while it was in progress. Please start again.';
    }
    if (runtime.verificationRoleId !== session.verificationRoleId) {
        return 'The Verification Role changed while this challenge was in progress. Please start again.';
    }
    if (
        Number.isInteger(session.imageInventoryRevision)
        && session.imageInventoryRevision !== context.imageInventory.contentRevision
    ) {
        return 'Verification images changed while this challenge was in progress. Please start again.';
    }
    const currentChallenge = snapshot.challengesById.get(String(session.challengeId));
    if (
        !currentChallenge
        || createChallengeFingerprint(currentChallenge) !== session.challengeFingerprint
    ) {
        return 'This verification challenge was edited while it was in progress. Please start again.';
    }
    return undefined;
}

async function expireChangedLiveSession(interaction, session, message) {
    const stateKey = getInteractionStateKey(interaction);
    clearChallengeIfCurrent(stateKey, session);
    await deactivateQuestionMessage(interaction, session, message, { title: 'Verification Changed' });
    return sendEphemeralNotice(interaction, buildVerificationExpiredResponse(message));
}

async function validateLiveSessionConfiguration(interaction, session, runtimeContext) {
    const context = runtimeContext ?? getPublishedVerificationRuntimeContext(interaction.guild?.id);
    const configurationChange = getLiveSessionConfigurationChange(context, session);
    if (!configurationChange) return true;
    await expireChangedLiveSession(interaction, session, configurationChange);
    return false;
}

async function completeVerification(interaction, session) {
    const runtimeContext = getPublishedVerificationRuntimeContext(interaction.guild?.id);
    const snapshot = runtimeContext.snapshot;
    if (session && !await validateLiveSessionConfiguration(interaction, session, runtimeContext)) return undefined;
    const runtime = snapshot.runtime;
    const verificationRole = await resolveManageableVerificationRole(interaction.guild, runtime);
    const member = await fetchCurrentVerificationMember(interaction.guild, interaction.user.id);
    if (!member) {
        throw new Error('The member left the server while verification was completing.');
    }
    if (
        session
        && Number.isFinite(session.membershipJoinedAtMs)
        && member.joinedTimestamp !== session.membershipJoinedAtMs
    ) {
        return expireChangedLiveSession(
            interaction,
            session,
            'Your server membership changed while verification was in progress. Please start again.',
        );
    }

    const completionFence = await beginAutokickCompletion(member, verificationRole.id);
    if (completionFence.safeToComplete !== true) {
        if (!session) {
            throw new Error('Autokick was already finalizing while one-click verification was completing.');
        }
        return expireChangedLiveSession(
            interaction,
            session,
            verificationCompletionConflictMessage(),
        );
    }

    const removedVerificationRole = member.roles.cache.has(verificationRole.id);
    let completionFinished = false;
    let accessGranted = false;
    try {
        if (removedVerificationRole) {
            await member.roles.remove(verificationRole);
        }
        const postMutationMember = await fetchCurrentVerificationMember(
            interaction.guild,
            interaction.user.id,
        );
        if (!postMutationMember || postMutationMember.joinedTimestamp !== member.joinedTimestamp) {
            throw buildVerificationCompletionConflict(
                'The server membership changed while verification was completing.',
            );
        }
        accessGranted = true;

        const completion = await finishAutokickCompletion(completionFence);
        if (completion.finished !== true && completion.recoverable !== true) {
            throw buildVerificationCompletionConflict(
                'The autokick completion fence changed while verification was completing.',
            );
        }
        completionFinished = true;
    }
    catch (error) {
        if (!completionFinished && !accessGranted) {
            await rollbackVerificationCompletion({
                interaction,
                completionFence,
                verificationRole,
                removedVerificationRole,
            }, error);
        }
        else if (!completionFinished && accessGranted) {
            completionFinished = true;
            void reportVerificationError({
                interaction,
                title: '⛔ Verification completion persistence delayed',
                userId: interaction.user.id,
                details: [
                    'The Verification Role was removed successfully.',
                    'Durable completion recovery remains pending and will not re-add the role.',
                ],
            }, error);
        }
        if (session && error?.code === 'VERIFICATION_COMPLETION_CONFLICT') {
            return expireChangedLiveSession(
                interaction,
                session,
                verificationCompletionConflictMessage(),
            );
        }
        if (!accessGranted) throw error;
    }

    const questionHandle = getQuestionMessageHandle(session);
    const successResponse = buildVerificationStateOptions(undefined, {
        renderer: questionHandle?.renderer ?? LEGACY_RENDERER,
        templateKey: 'successEmbed',
    });

    const stateKey = getInteractionStateKey(interaction);
    if (session) {
        clearVerificationStateIfCurrent(stateKey, session);
    }
    else {
        clearChallenge(stateKey);
        clearCooldown(stateKey);
    }
    return deliverPanelUpdateOrFallback(
        interaction,
        () => editStoredVerificationMessage(interaction, questionHandle, successResponse),
        successResponse,
    );
}

async function logImageGenerationError(interaction, title, challengeId, err, screenIndex) {
    return reportVerificationError({
        interaction,
        title: '⛔ Verification image challenge generation failed',
        userId: interaction.user.id,
        details: [
            `Operation: ${title}`,
            `Challenge: **${challengeId}**`,
            screenIndex === undefined ? undefined : `Screen: **${screenIndex + 1}**`,
        ],
    }, err);
}

function getImageGenerationErrorMessage(error) {
    if (isVerificationRenderCapacityError(error)) {
        return 'Verification image processing is temporarily busy. Please try again shortly. If the problem persists, contact staff.';
    }
    if (isVerificationRenderAvailabilityError(error)) {
        return 'Verification image processing is temporarily unavailable. Please try again shortly. If the problem persists, contact staff.';
    }
    return 'Verification could not generate the image challenge. Please try again later. If the problem persists, contact staff.';
}

module.exports = {
    completeVerification,
    getLiveSessionConfigurationChange,
    fetchCurrentVerificationMember,
    getImageGenerationErrorMessage,
    logImageGenerationError,
    resolveManageableVerificationRole,
    validateLiveSessionConfiguration,
};
