const {
    getCatalogQuestionChangesFromSnapshot,
    getVerificationSnapshot,
} = require('../service');
const {
    acknowledgePanelInteraction,
    deferSourceUpdate,
} = require('../../ux/interactions/acknowledgement');
const {
    buildQuestionEditorPayload,
} = require('./questionPanel');
const { resolveQuestion } = require('../domain/challenges');
const {
    replaceAdminPanel,
} = require('./panel');
const {
    respondAdminError,
    respondAdminModalError,
    userErrorEmbed,
} = require('./feedback');

async function getQuestionAdminContext(parts) {
    const [guildId, ownerUserId, challengeId, questionId] = parts;
    const snapshot = await getVerificationSnapshot(guildId);
    const challenge = snapshot.challengesById.get(String(challengeId));
    const catalog = snapshot.challengeCatalog;
    const catalogChallenge = catalog?.[challengeId];
    const catalogQuestionsById = new Map((catalogChallenge?.questions ?? [])
        .map((candidate) => [String(candidate.id), candidate]));
    const question = challenge ? resolveQuestion(challenge, questionId) : undefined;
    return {
        snapshot,
        guildId,
        ownerUserId,
        challengeId,
        questionId,
        challenge,
        question,
        questionChanges: getCatalogQuestionChangesFromSnapshot(snapshot, challengeId, questionId),
        catalogQuestionsById,
    };
}

async function validateQuestionPanelInteraction(interaction, parts, state = {}) {
    const [guildId, ownerUserId, challengeId, questionId] = parts;
    const viewModel = state.panelViewModel;
    if (!viewModel?.challenge || !viewModel?.question) {
        await respondAdminError(interaction, {
            embeds: [userErrorEmbed('This question panel expired. Reopen the question editor.')],
        });
        return { error: true };
    }
    return {
        guildId,
        ownerUserId,
        challengeId,
        questionId,
        challenge: viewModel.challenge,
        question: viewModel.question,
        questionChanges: viewModel.questionChanges,
        enabledChallengeIds: viewModel.enabledChallengeIds ?? [],
        catalogQuestionsById: new Map([[String(questionId), viewModel.catalogQuestion]]),
        panelSession: state.panelSession,
    };
}

async function validateQuestionAdminInteraction(interaction, parts, { acknowledge = false } = {}) {
    const [guildId, ownerUserId] = parts;
    if (acknowledge) await deferSourceUpdate(interaction);

    const context = await getQuestionAdminContext(parts);
    if (!context.challenge) {
        await respondAdminError(interaction, {
            embeds: [userErrorEmbed(`Unknown verification challenge ID: ${context.challengeId}`)],
        });
        return { error: true };
    }
    if (!context.question) {
        await respondAdminError(interaction, {
            embeds: [userErrorEmbed(`Unknown question ID for **${context.challengeId}**: ${context.questionId}`)],
        });
        return { error: true };
    }
    return context;
}

async function beginQuestionModalSubmission(interaction, parts, state = {}) {
    const responseMode = await acknowledgePanelInteraction(interaction, {
        sourceCustomId: state.sourceCustomId,
        panelSession: state.panelSession,
        formGeneration: state.formGeneration,
    });
    const [guildId, ownerUserId, challengeId, questionId] = parts;
    const context = await getQuestionAdminContext([guildId, ownerUserId, challengeId, questionId]);
    if (!context.challenge || !context.question) {
        await respondAdminModalError(interaction, responseMode, { embeds: [userErrorEmbed('Unknown challenge or question.')] });
        return { failed: true };
    }
    return { responseMode, context };
}

function expectedCatalogQuestions(context, questionIds) {
    return Object.fromEntries((questionIds ?? [])
        .map((questionId) => [questionId, context.catalogQuestionsById.get(String(questionId))])
        .filter(([, question]) => question));
}

function replyWithCommittedQuestionPanel(interaction, context, mutation, state = {}) {
    return replaceAdminPanel(interaction, {
        sourcePanelSession: state.panelSession,
        committed: true,
        buildPayload: () => {
            const effectiveChallenge = mutation.snapshot.challengesById.get(String(context.challengeId))
                ?? context.challenge;
            const effectiveQuestion = resolveQuestion(effectiveChallenge, context.question.id)
                ?? context.question;
            const catalogQuestion = mutation.snapshot.challengeCatalog?.[context.challengeId]?.questions
                ?.find((question) => String(question.id) === String(context.question.id));
            return buildQuestionEditorPayload({
                mode: 'edit',
                guildId: context.guildId,
                ownerUserId: context.ownerUserId,
                challengeId: context.challengeId,
                challenge: effectiveChallenge,
                question: effectiveQuestion,
                catalogQuestion,
                questionChanges: getCatalogQuestionChangesFromSnapshot(
                    mutation.snapshot,
                    context.challengeId,
                    context.question.id,
                ),
                enabledChallengeIds: mutation.snapshot.activeChallengeIds,
            });
        },
    });
}

module.exports = {
    beginQuestionModalSubmission,
    expectedCatalogQuestions,
    replyWithCommittedQuestionPanel,
    validateQuestionAdminInteraction,
    validateQuestionPanelInteraction,
};
