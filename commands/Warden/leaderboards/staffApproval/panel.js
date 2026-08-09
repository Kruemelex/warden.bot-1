'use strict';

const Discord = require('discord.js');
const { getIdentityBrandColor } = require('../../../../functions');
const { createAdminPanelDocument } = require('../../../../ux/documents');
const { formatSpeedrunTime } = require('../leaderboardApprovalMessages');

const EDIT_ACTIONS = Object.freeze({
    identity: 'editIdentity',
    speedrunRun: 'editSpeedrunRun',
    speedrunTime: 'editSpeedrunTime',
    evidence: 'editEvidence',
    aceScore: 'editAceScore',
});

function escapeDisplay(value, fallback = 'Not set') {
    const text = String(value ?? '').trim();
    const resolved = text || fallback;
    return resolved.length <= 1800 ? resolved : `${resolved.slice(0, 1799)}…`;
}

function buildEditButton(action, buildActionCustomId) {
    return new Discord.ButtonBuilder()
        .setCustomId(buildActionCustomId(action))
        .setLabel('Edit')
        .setStyle(Discord.ButtonStyle.Secondary);
}

function editorSection(title, lines, action, buildActionCustomId) {
    return {
        kind: 'section',
        title,
        content: [].concat(lines).join('\n'),
        accessory: buildEditButton(action, buildActionCustomId),
    };
}

/**
 * Build the semantic editor panel. Custom-ID route allocation is injected so
 * this factory remains purely presentation-oriented and can be rendered more
 * than once without consuming session routes during budget estimation.
 */
function createLeaderboardEditorDocument(context, submission, { buildActionCustomId } = {}) {
    if (typeof buildActionCustomId !== 'function') {
        throw new Error('Leaderboard editor panels require a session action-ID builder.');
    }

    const editorBlocks = [
        editorSection('Pilot', [
            `- **User:** <@${submission.user_id}>`,
            `- **Stored name:** ${escapeDisplay(submission.name)}`,
        ], EDIT_ACTIONS.identity, buildActionCustomId),
    ];

    if (context.leaderboard === 'speedrun') {
        editorBlocks.push(
            editorSection('Run Details', [
                `- **Ship:** ${escapeDisplay(submission.ship)}`,
                `- **Variant:** ${escapeDisplay(submission.variant)}`,
                `- **Class:** ${escapeDisplay(submission.class)}`,
            ], EDIT_ACTIONS.speedrunRun, buildActionCustomId),
            editorSection('Time', formatSpeedrunTime(submission.time, submission.milliseconds), EDIT_ACTIONS.speedrunTime, buildActionCustomId),
            editorSection('Evidence & Comment', [
                `- **Link:** ${escapeDisplay(submission.link)}`,
                `- **Comment:** ${escapeDisplay(submission.comments, '-')}`,
            ], EDIT_ACTIONS.evidence, buildActionCustomId),
        );
    }
    else {
        editorBlocks.push(
            editorSection('Score Details', [
                `- **Ship:** ${escapeDisplay(submission.shiptype)}`,
                `- **Time / Hull lost:** ${submission.timetaken}s / ${submission.percenthulllost}%`,
                `- **Medium / Small modules:** ${submission.mgauss} / ${submission.sgauss}`,
                `- **Medium / Small rounds:** ${submission.mgaussfired} / ${submission.sgaussfired}`,
                `- **Calculated score:** ${Number(submission.score).toFixed(2)}`,
            ], EDIT_ACTIONS.aceScore, buildActionCustomId),
            editorSection('Evidence', `- **Link:** ${escapeDisplay(submission.link)}`, EDIT_ACTIONS.evidence, buildActionCustomId),
        );
    }

    return createAdminPanelDocument({
        title: `Edit ${context.leaderboard === 'ace' ? 'Ace' : 'Speedrun'} Submission #${submission.id}`,
        description: 'Changes are saved to the pending database row and then reflected on the Staff approval post.',
        accentColor: getIdentityBrandColor('Warden'),
        editorBlocks,
    });
}

module.exports = {
    EDIT_ACTIONS,
    createLeaderboardEditorDocument,
    escapeDisplay,
};
