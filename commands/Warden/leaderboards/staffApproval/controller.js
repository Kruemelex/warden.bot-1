'use strict';

const Discord = require('discord.js');
const { createConsoleReporter } = require('../../../../logging/consoleReporting');
const { botLog } = require('../../../../functions');
const { buildModal } = require('../../../../ux/components/modalFields');
const { createDescriptorModalEditor } = require('../../../../ux/interactions/editor');
const {
    acknowledgePanelInteraction,
    completePanelInteraction,
    respondAfterAcknowledgement,
    sanitizeMessageEditOptions,
} = require('../../../../ux/interactions/acknowledgement');
const { createInteractionRouter } = require('../../../../ux/interactions/router');
const { createPanelSessionRegistry } = require('../../../../ux/interactions/sessions');
const { renderComponentsV2 } = require('../../../../ux/renderers/componentsV2');
const { buildApprovalMessage } = require('../leaderboardApprovalMessages');
const { createLeaderboardEditorDescriptors, validateAceScoreInputs } = require('./editor');
const { createKeyedOperationQueue } = require('./keyedOperations');
const { createLeaderboardEditorDocument } = require('./panel');
const repository = require('../../../../Warden/db/leaderboards/repository');
const { getLeaderboard, getSubmissionId } = repository;
const { assertLeaderboardMutationAllowed } = require('../../../../Warden/leaderboards/policy');
const { publishApprovedSubmission } = require('../../../../Warden/leaderboards/websitePublisher');

const websiteReport = createConsoleReporter('Leaderboard').forSubsystem('Website');
const staffApprovalReport = createConsoleReporter('Leaderboard').forSubsystem('Staff approval');

const sessionRegistry = createPanelSessionRegistry({
    prefix: 'wLA',
    label: 'Leaderboard editor',
    ttlMs: 2 * 60 * 60 * 1000,
    maxEntries: 250,
});
const resolutionOperations = createKeyedOperationQueue({ maxPendingPerKey: 8 });

async function respondEphemeral(interaction, content, acknowledgement) {
    const payload = { content, flags: Discord.MessageFlags.Ephemeral };
    if (acknowledgement) {
        return respondAfterAcknowledgement(interaction, acknowledgement, payload);
    }
    if (interaction.deferred) return interaction.editReply({ content });
    if (interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

function buildContext(interaction, leaderboard, submissionId) {
    return {
        leaderboard: getLeaderboard(leaderboard),
        submissionId: getSubmissionId(submissionId),
        ownerUserId: String(interaction.user.id),
        guildId: String(interaction.guildId),
        channelId: String(interaction.channelId),
        approvalMessageId: String(interaction.message.id),
        panelMessageId: undefined,
    };
}

function assertApprovalPostCurrent(context, submission, subject = 'editor') {
    if (submission.embed_id && String(submission.embed_id) !== String(context.approvalMessageId)) {
        if (subject === 'editor') {
            throw new Error('This editor is attached to an outdated approval post. Use Edit on the current post.');
        }
        throw new Error('This action is attached to an outdated approval post. Use the current post.');
    }
}

function renderEditorPanel(context, submission, session) {
    const document = createLeaderboardEditorDocument(context, submission, {
        buildActionCustomId: (action) => session.build(action),
    });
    return renderComponentsV2(document).payload;
}

function createPanelState(context, submission) {
    return { context, submission };
}

function createEditorPanelSession(context, submission) {
    const state = createPanelState(context, submission);
    const session = sessionRegistry.create({
        ownerUserId: context.ownerUserId,
        guildId: context.guildId,
        state,
    });
    return { session, state };
}

async function getEphemeralMessage(interaction, response) {
    if (response?.id) return response;
    if (typeof interaction.fetchReply === 'function') return interaction.fetchReply();
    return undefined;
}

async function refreshApprovalPost(interaction, context, submission) {
    const channel = await interaction.guild.channels.fetch(context.channelId);
    const message = await channel.messages.fetch(context.approvalMessageId);
    await message.edit(buildApprovalMessage(context.leaderboard, submission));
}

const descriptors = createLeaderboardEditorDescriptors({
    commitPendingEdits: (request) => repository.commitPendingEdits(request),
});

const descriptorEditor = createDescriptorModalEditor({
    descriptors,
    // Modal opens read only the owner-bound panel snapshot. Database reads
    // belong to submit, after the modal interaction has been acknowledged.
    loadOpenContext: ({ state }) => {
        const context = state.context;
        const submission = state.submission;
        if (!context || !submission) throw new Error('This Leaderboard editor is no longer available.');
        return { ...context, object: submission };
    },
    beginSubmission: async ({ state }) => {
        const context = state.context;
        if (!context) throw new Error('This Leaderboard editor is no longer available.');
        await assertLeaderboardMutationAllowed(context.guildId);
        const submission = await repository.loadPendingSubmission(context.leaderboard, context.submissionId);
        assertApprovalPostCurrent(context, submission);
        return {
            context: { ...context, object: submission },
            acknowledgement: state.acknowledgement,
        };
    },
    getModalParts: () => [],
    buildCustomId: ({ action, baseline, interaction, state }) => {
        if (!state.panelSession) throw new Error('This Leaderboard editor is no longer available.');
        return state.panelSession.buildForm(action, [], baseline, interaction.customId);
    },
    buildModal: ({ customId, title, fields }) => buildModal(customId, title, fields),
    respondError: ({ interaction, acknowledgement, message }) => respondEphemeral(
        interaction,
        `⛔ ${message || 'Failed to save the Leaderboard edit.'}`,
        acknowledgement,
    ),
    respondNoChanges: async ({ interaction, acknowledgement, context, object }) => {
        try {
            await refreshApprovalPost(interaction, context, object);
            return respondEphemeral(
                interaction,
                'No database changes were needed. The Staff approval post was refreshed.',
                acknowledgement,
            );
        }
        catch (error) {
            staffApprovalReport.error('Approval post refresh failed after unchanged edit', error, {
                leaderboard: context.leaderboard,
                submissionId: context.submissionId,
            });
            return respondEphemeral(
                interaction,
                '⚠️ No database changes were needed, but the Staff approval post could not be refreshed.',
                acknowledgement,
            );
        }
    },
    complete: async ({ interaction, acknowledgement, context, state, result }) => {
        // A committed mutation retires this panel before any follow-up delivery
        // attempt. A failed panel refresh must never leave stale controls live.
        completePanelInteraction(interaction, acknowledgement);
        state.panelSession?.dispose();

        let approvalRefreshError;
        try {
            await refreshApprovalPost(interaction, context, result);
        }
        catch (error) {
            approvalRefreshError = error;
            staffApprovalReport.error('Approval post refresh failed after edit', error, {
                leaderboard: context.leaderboard,
                submissionId: context.submissionId,
            });
        }

        let panelRefreshError;
        let nextSession;
        try {
            const nextContext = { ...context };
            const next = createEditorPanelSession(nextContext, result);
            nextSession = next.session;
            await interaction.webhook.editMessage(
                context.panelMessageId,
                sanitizeMessageEditOptions(renderEditorPanel(nextContext, result, next.session)),
            );
        }
        catch (error) {
            nextSession?.dispose();
            panelRefreshError = error;
            staffApprovalReport.warn('Editor panel refresh failed', error, {
                leaderboard: context.leaderboard,
                submissionId: context.submissionId,
            });
        }

        const message = approvalRefreshError
            ? '⚠️ Changes saved, but the Staff approval post could not be refreshed. Approval will still use the updated database row; reopen Edit and save an unchanged section to retry the refresh.'
            : panelRefreshError
                ? '⚠️ Changes saved and the Staff approval post was refreshed, but this editor could not be refreshed. Click Edit on the Staff approval post again.'
                : '✅ Changes saved and the Staff approval post was refreshed.';
        return respondEphemeral(interaction, message, acknowledgement);
    },
});

const COMPONENT_ACTIONS = Object.freeze({
    editIdentity: (interaction, parts, state) => descriptorEditor.open('identity', interaction, parts, state),
    editSpeedrunRun: (interaction, parts, state) => descriptorEditor.open('speedrunRun', interaction, parts, state),
    editSpeedrunTime: (interaction, parts, state) => descriptorEditor.open('speedrunTime', interaction, parts, state),
    editEvidence: (interaction, parts, state) => descriptorEditor.open('evidence', interaction, parts, state),
    editAceScore: (interaction, parts, state) => descriptorEditor.open('aceScore', interaction, parts, state),
});

const MODAL_ACTIONS = Object.freeze({
    identityModal: (interaction, parts, state) => descriptorEditor.submit('identity', interaction, parts, state),
    speedrunRunModal: (interaction, parts, state) => descriptorEditor.submit('speedrunRun', interaction, parts, state),
    speedrunTimeModal: (interaction, parts, state) => descriptorEditor.submit('speedrunTime', interaction, parts, state),
    evidenceModal: (interaction, parts, state) => descriptorEditor.submit('evidence', interaction, parts, state),
    aceScoreModal: (interaction, parts, state) => descriptorEditor.submit('aceScore', interaction, parts, state),
});

async function authorizeSessionInteraction({ interaction, parsed }) {
    if (String(interaction.user?.id) !== String(parsed.ownerUserId)) {
        await respondEphemeral(interaction, '⛔ This Leaderboard editor belongs to another Staff member.');
        return false;
    }
    const interactionGuildId = interaction.guildId ?? interaction.guild?.id;
    if (String(interactionGuildId) !== String(parsed.guildId)) {
        await respondEphemeral(interaction, '⛔ This Leaderboard editor belongs to another server.');
        return false;
    }
    return true;
}

const interactionRouter = createInteractionRouter({
    parse: sessionRegistry.parse,
    componentActions: COMPONENT_ACTIONS,
    modalActions: MODAL_ACTIONS,
    authorize: authorizeSessionInteraction,
    acknowledgeModal: async ({ interaction, parsed }) => {
        parsed.state.acknowledgement = await acknowledgePanelInteraction(interaction, {
            sourceCustomId: parsed.state.sourceCustomId,
            panelSession: parsed.state.panelSession,
            formGeneration: parsed.state.formGeneration,
        });
    },
    onExpired: ({ interaction }) => respondEphemeral(
        interaction,
        'This Leaderboard editor has expired or changed. Click Edit on the Staff approval post again.',
    ),
    onComponentError: ({ interaction, error }) => respondEphemeral(
        interaction,
        `⛔ ${error.message || 'Failed to open the Leaderboard editor.'}`,
    ),
    onModalError: ({ interaction, parsed, error }) => {
        staffApprovalReport.error('Editor modal failed', error);
        return respondEphemeral(
            interaction,
            `⛔ ${error.message || 'Failed to save the Leaderboard edit.'}`,
            parsed.state.acknowledgement,
        );
    },
});

async function openEditor(interaction, leaderboard, submissionId) {
    await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
    let session;
    try {
        const context = buildContext(interaction, leaderboard, submissionId);
        await assertLeaderboardMutationAllowed(context.guildId);
        const submission = await repository.loadPendingSubmission(context.leaderboard, context.submissionId);
        assertApprovalPostCurrent(context, submission);
        const panel = createEditorPanelSession(context, submission);
        session = panel.session;
        const response = await interaction.editReply(sanitizeMessageEditOptions(
            renderEditorPanel(context, submission, session),
        ));
        const message = await getEphemeralMessage(interaction, response);
        if (!message?.id) throw new Error('The Leaderboard editor message could not be identified.');
        context.panelMessageId = String(message.id);
    }
    catch (error) {
        session?.dispose();
        staffApprovalReport.error('Editor open failed', error, { leaderboard, submissionId });
        return respondEphemeral(interaction, `⛔ ${error.message || 'Failed to open the Leaderboard editor.'}`);
    }
    return undefined;
}

async function notifySubmitter(interaction, submission, approved, leaderboard) {
    try {
        const user = await interaction.guild.members.fetch(String(submission.user_id));
        const message = approved
            ? `Hey! 👋 This is Warden letting you know that your ${leaderboard} submission has been approved. You can view it with \`/leaderboard\`. Submission ID: #${submission.id}`
            : `Hello! Warden here to let you know that your ${leaderboard} submission was declined. Please contact an AXI Staff member if you would like more information. Submission ID: #${submission.id}`;
        await user.send(message);
    }
    catch (error) {
        staffApprovalReport.warn('Submitter notification failed', error, {
            leaderboard,
            submissionId: submission.id,
        });
    }
}

async function maybeNotifyMyrmidon(interaction, submission) {
    if (!['medusa', 'hydra'].includes(String(submission.variant))) return;
    const member = await interaction.guild.members.fetch(String(submission.user_id)).catch(() => undefined);
    if (!member || member.roles.cache.some((role) => role.name === 'Myrmidon')) return;
    const thresholds = { small: 1440, medium: 720, large: 360 };
    if (Number(submission.time) >= Number(thresholds[submission.class])) return;
    await interaction.channel.send({
        content: `Hey, ${interaction.member}!\n**Speedrun submission #${submission.id}** is eligible for **Myrmidon**. Please contact <@${submission.user_id}> to see if they want the rank.`,
    }).catch((error) => staffApprovalReport.warn('Myrmidon eligibility notice failed', error, {
        submissionId: submission.id,
    }));
}

async function editResolvedApprovalPost(interaction, payload, resolvedState) {
    try {
        await interaction.message.edit(payload);
        return undefined;
    }
    catch (cause) {
        const error = new Error(`${resolvedState} was saved in the database, but the Staff approval post could not be refreshed.`);
        error.code = 'LEADERBOARD_POST_REFRESH_FAILED';
        error.cause = cause;
        return error;
    }
}

async function approveSubmission(interaction, context) {
    const { submission, newlyApproved } = await repository
        .approvePendingSubmission(context.leaderboard, context.submissionId);
    const leaderboard = context.leaderboard;
    if (leaderboard !== 'ace' && newlyApproved) {
        await maybeNotifyMyrmidon(interaction, submission);
    }

    const refreshError = await editResolvedApprovalPost(interaction, {
        content: newlyApproved
            ? `✅ **${leaderboard} submission #${submission.id} approved by ${interaction.member}.**`
            : `✅ **${leaderboard} submission #${submission.id} approved.**`,
        components: [],
    }, 'Approval');
    if (newlyApproved) await notifySubmitter(interaction, submission, true, leaderboard, context);
    if (newlyApproved) {
        void publishApprovedSubmission(context.guildId, leaderboard, submission)
            .catch((error) => websiteReport.warn('Approval sync failed', error, {
                leaderboard,
                submissionId: submission.id,
            }));
    }
    if (refreshError) throw refreshError;
}

async function deleteSubmission(interaction, context, submission) {
    const leaderboard = context.leaderboard;
    // Post-first keeps the visible action recoverable: a crash before the CAS
    // leaves a pending row whose existing embed_id startup reconciliation will
    // rebuild with the shared approval-message builder.
    await interaction.message.edit({
        content: `⛔ **${leaderboard} submission #${submission.id} denied by ${interaction.member}.**`,
        components: [],
    });

    try {
        // The user identity is part of the deletion compare-and-swap so an
        // editor cannot change the submitter before the decline notification.
        await repository.deletePendingSubmission(leaderboard, submission.id, {
            expectedUserId: submission.user_id,
        });
    }
    catch (deleteError) {
        let authoritative;
        try {
            authoritative = await repository.loadSubmission(leaderboard, submission.id);
        }
        catch (reloadError) {
            throw new AggregateError(
                [deleteError, reloadError],
                'The deletion failed and the pending submission could not be reloaded for post recovery.',
                { cause: deleteError },
            );
        }

        // A transient response failure can hide a successful DELETE. Absence
        // is authoritative success; never restore controls or suppress notice.
        if (!authoritative) {
            await notifySubmitter(interaction, submission, false, leaderboard, context);
            return;
        }

        if (Number(authoritative.approval) === 0) {
            try {
                await interaction.message.edit(buildApprovalMessage(leaderboard, authoritative));
            }
            catch (restoreError) {
                throw new AggregateError(
                    [deleteError, restoreError],
                    'The deletion failed and the Staff approval post could not be restored.',
                    { cause: deleteError },
                );
            }
        }
        throw deleteError;
    }

    await notifySubmitter(interaction, submission, false, leaderboard, context);
}

async function handleApprovalAction(interaction, leaderboard, action, submissionId) {
    await interaction.deferUpdate();
    try {
        // Every Ace approval can replace another Ace row. One short global Ace
        // queue preserves staff-action order without adding schema or lock rows;
        // Speedrun actions remain isolated per submission.
        const operationKey = leaderboard === 'ace'
            ? 'ace:resolution'
            : `${leaderboard}:${submissionId}`;
        await resolutionOperations.run(operationKey, async () => {
            const context = buildContext(interaction, leaderboard, submissionId);
            await assertLeaderboardMutationAllowed(context.guildId);
            const submission = await repository.loadSubmission(context.leaderboard, context.submissionId);
            if (!submission) throw new Error('That submission no longer exists. It may already have been deleted.');
            assertApprovalPostCurrent(context, submission, 'action');

            if (action === 'approve') {
                if (![0, 1].includes(Number(submission.approval))) {
                    throw new Error('That submission is no longer pending approval.');
                }
                await approveSubmission(interaction, context);
            }
            else {
                const error = repository.pendingError(submission);
                if (error) throw new Error(error);
                await deleteSubmission(interaction, context, submission);
            }
        });
    }
    catch (error) {
        staffApprovalReport.error('Approval action failed', error, {
            action,
            leaderboard,
            submissionId,
        });
        if (error.code !== 'LEADERBOARD_POST_REFRESH_FAILED') {
            void Promise.resolve().then(() => botLog(
                interaction.guild,
                new Discord.EmbedBuilder()
                    .setDescription(`\`\`\`${error.stack}\`\`\``)
                    .setTitle('⛔ Leaderboard approval action failed'),
                2,
                'error',
            ))
                .catch((logError) => staffApprovalReport.error('Discord error report failed', logError, {
                    action,
                    leaderboard,
                    submissionId,
                }));
        }
        await interaction.followUp({
            content: `⛔ ${error.message || 'The Leaderboard action failed. Please try again.'}`,
            flags: Discord.MessageFlags.Ephemeral,
        }).catch((responseError) => staffApprovalReport.error('Staff error response failed', responseError, {
            action,
            leaderboard,
            submissionId,
        }));
    }
}

function parseApprovalCustomId(customId) {
    const match = String(customId).match(/^submission-(ace|speedrun)-(approve|deny|edit)-(\d+)$/);
    if (!match) return undefined;
    return {
        leaderboard: match[1],
        action: match[2],
        submissionId: Number(match[3]),
    };
}

async function handleLeaderboardInteraction(interaction) {
    const approvalAction = interaction.isButton?.() && parseApprovalCustomId(interaction.customId);
    if (approvalAction) {
        if (approvalAction.action === 'edit') {
            await openEditor(interaction, approvalAction.leaderboard, approvalAction.submissionId);
        }
        else {
            await handleApprovalAction(
                interaction,
                approvalAction.leaderboard,
                approvalAction.action,
                approvalAction.submissionId,
            );
        }
        return true;
    }

    if (!String(interaction.customId ?? '').startsWith('wLA:')) return false;
    if (interaction.isModalSubmit?.()) return interactionRouter.handleModal(interaction);
    if (interaction.isButton?.()) return interactionRouter.handleComponent(interaction);
    return false;
}

module.exports = {
    handleLeaderboardInteraction,
    openEditor,
    parseApprovalCustomId,
    renderEditorPanel,
    validateAceScoreInputs,
};
