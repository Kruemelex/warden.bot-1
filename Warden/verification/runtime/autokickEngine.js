'use strict';

const crypto = require('node:crypto');
const Discord = require('discord.js');
const {
    isTransientDatabaseError,
    retryTransientDatabaseOperation,
} = require('../../db/errorPolicy');
const { reportVerificationError } = require('../errorLogging');
const {
    DEADLINE_STAGES,
    PHASES,
    authorizeVerificationAutokickIntent,
    beginVerificationAutokickCompletionFence,
    claimPendingVerificationAutokickReports,
    claimVerificationAutokickWork,
    cleanupRetiredVerificationAutokickEntries,
    enqueueVerificationAutokickGeneration,
    finishVerificationAutokickCompletionFence,
    finishVerificationAutokickKick,
    finishVerificationAutokickOutcomeUnknown,
    finishVerificationAutokickReport,
    getVerificationAutokickConfiguration,
    getVerificationAutokickSchedule,
    markVerificationAutokickDmAttempted,
    markVerificationAutokickReportDispatched,
    recoverVerificationAutokickCompletion,
    releaseVerificationAutokickCompletionFence,
    releaseVerificationAutokickReport,
    releaseVerificationAutokickWork,
    renewVerificationAutokickLease,
    retireDisabledVerificationAutokickQueue,
    retireVerificationAutokickGeneration,
    resetVerificationAutokickCountdownAfterOnboarding,
    terminalizeVerificationAutokickWork,
} = require('../data/autokickRepository');
const { buildVerificationAutoKickPayload } = require('../presentation/documents/notices');
const {
    AUTOKICK_UNKNOWN_FAILURE_MAX_ATTEMPTS,
    getAutokickRetryDelay,
    hasMatchingJoin,
    hasMemberFlag,
    isKnownTransientAutokickError,
    isPlausibleJoinEvent,
    isTerminalKickPermissionError: isTerminalKickPermissionErrorPolicy,
    isUnknownMemberError: isUnknownMemberErrorPolicy,
} = require('../domain/autokickPolicy');
const { createAutokickPoller } = require('./autokickPoller');
const { createVerificationLogger } = require('../logging');
const {
    buildAutokickReportNonce,
    clearAutokickReportAcknowledgements,
    deliverAutokickReport,
    flushAutokickReportAcknowledgements,
} = require('./autokickReportDelivery');

const POLL_ACTIVE_INTERVAL_MS = 5_000;
const POLL_RECOVERY_INTERVAL_MS = 10 * 60 * 1000;
const POLL_MIN_DELAY_MS = 1_000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const CLAIM_BATCH_SIZE = 3;
const REPORT_BATCH_SIZE = 3;
const DM_TO_KICK_DELAY_MS = 1_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILIATION_BATCH_SIZE = 5;
const MEMBER_RECONCILIATION_INTERVAL_MS = 30 * 60 * 1000;
const POLL_ERROR_MAX_DELAY_MS = 5 * 60 * 1000;
const POLL_ERROR_LOG_INTERVAL_MS = 60 * 1000;
const MEMBER_FLAGS = Object.freeze({
    completedOnboarding: Discord.GuildMemberFlags.CompletedOnboarding,
    bypassesVerification: Discord.GuildMemberFlags.BypassesVerification,
});
const guildRuntimes = new Map();
const pendingKickAcknowledgements = new Map();
const autokickLog = createVerificationLogger('Autokick');

function claimToken() {
    return crypto.randomBytes(24).toString('base64url');
}
function generation(source) {
    return {
        guildId: source.guildId ?? source.guild?.id,
        userId: source.userId ?? source.id,
        joinedAtMs: source.joinedAtMs ?? source.joinedTimestamp,
    };
}
function errorCode(err) {
    return String(err?.code ?? err?.cause?.code ?? err?.name ?? 'unknown').slice(0, 64);
}
function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}
function resetPollFailureState(runtime) {
    runtime.pollFailureCount = 0;
    runtime.pollFailureWasDatabase = false;
    runtime.firstPollError = null;
}
function hasCompletedOnboarding(member) {
    return hasMemberFlag(member, MEMBER_FLAGS.completedOnboarding);
}
function bypassesVerification(member) {
    return hasMemberFlag(member, MEMBER_FLAGS.bypassesVerification);
}
function isUnknownMemberError(err) {
    return isUnknownMemberErrorPolicy(err, Discord.RESTJSONErrorCodes.UnknownMember);
}
function isTerminalKickPermissionError(err) {
    return isTerminalKickPermissionErrorPolicy(
        err,
        Discord.RESTJSONErrorCodes.MissingAccess,
        Discord.RESTJSONErrorCodes.MissingPermissions,
    );
}
async function fetchCurrentMember(guild, userId) {
    try {
        return await guild.members.fetch({ user: userId, force: true });
    }
    catch (err) {
        if (isUnknownMemberError(err)) return null;
        throw err;
    }
}
function logAutokickFailure(guild, error) {
    void reportVerificationError({
        guild,
        title: '⛔ Verification autokick failed',
    }, error);
}
function notifyVerificationAutokickScheduleChanged(guildId) {
    const runtime = guildRuntimes.get(guildId);
    if (runtime?.pollFailureCount === 0) runtime.poller.wake();
}
async function beginOrRepairAutokickCountdown(target) {
    const countdown = await resetVerificationAutokickCountdownAfterOnboarding(target);
    if (countdown.status !== 'missing') return countdown;

    const enrollment = await enqueueVerificationAutokickGeneration(target);
    if (
        !enrollment.entry
        || enrollment.entry.joinedAtMs !== target.joinedAtMs
        || enrollment.entry.phase === PHASES.terminal
    ) return enrollment;
    return resetVerificationAutokickCountdownAfterOnboarding(target);
}

async function persistEventOperation(type, guild, source, options = {}) {
    const target = generation(source);
    if (type === 'retire') {
        return retireVerificationAutokickGeneration({
            ...target,
            terminalReason: options.reason ?? 'event-retired',
            insertIfMissing: options.insertIfMissing,
        });
    }
    const member = await fetchCurrentMember(guild, target.userId);
    if (!hasMatchingJoin(member, target) || member.user?.bot) {
        return retireVerificationAutokickGeneration({
            ...target,
            terminalReason: member?.user?.bot ? 'bot-member' : 'membership-ended',
            insertIfMissing: type === 'enroll' ? true : options.insertIfMissing ?? false,
        });
    }
    if (type === 'enroll') {
        const enrolled = await enqueueVerificationAutokickGeneration({
            ...target,
            trustedReconciliation: options.trustedReconciliation === true,
        });
        if (
            !enrolled.entry
            || enrolled.entry.joinedAtMs !== target.joinedAtMs
            || enrolled.entry.phase === PHASES.terminal
        ) return enrolled;
        if (bypassesVerification(member)) {
            return persistEventOperation('bypass', guild, target, options);
        }
        return hasCompletedOnboarding(member)
            ? beginOrRepairAutokickCountdown(target)
            : enrolled;
    }
    if (type === 'countdown') {
        if (bypassesVerification(member)) {
            return persistEventOperation('bypass', guild, target, options);
        }
        if (!hasCompletedOnboarding(member)) return { status: 'not-onboarded' };
        return beginOrRepairAutokickCountdown(target);
    }
    if (type === 'bypass') {
        const settings = await getVerificationAutokickConfiguration(guild.id);
        const currentMember = await fetchCurrentMember(guild, target.userId);
        const roleId = settings.verificationRoleId;
        if (!roleId || !hasMatchingJoin(currentMember, target) || !bypassesVerification(currentMember)) {
            return { status: 'bypass-ineligible' };
        }
        const completionReason = options.reason ?? 'verification-bypass';
        const fence = await beginAutokickCompletion(currentMember, roleId, completionReason);
        if (!fence.safeToComplete) return fence;
        if (currentMember.roles.cache.has(roleId)) {
            await currentMember.roles.remove(roleId, 'Discord Verify Member bypass granted.');
        }
        const postMutationMember = await fetchCurrentMember(guild, target.userId);
        if (!hasMatchingJoin(postMutationMember, target)) {
            if (postMutationMember && !postMutationMember.roles.cache.has(roleId)) {
                await postMutationMember.roles.add(
                    roleId,
                    'Restoring verification gate after membership changed during bypass completion.',
                );
            }
            const error = new Error('Membership changed while completing the Verification bypass.');
            error.code = 'VERIFICATION_AUTOKICK_GENERATION_CHANGED';
            await releaseAutokickCompletion(fence, error);
            return { status: 'generation-changed' };
        }
        return finishAutokickCompletion(fence, completionReason);
    }
    throw new Error(`Unknown verification autokick event retry type: ${type}`);
}
async function runEventOperation(type, member, options = {}) {
    if (!member?.guild || !Number.isFinite(member.joinedTimestamp)) {
        throw new Error(`Verification autokick ${type} requires a current guild membership generation.`);
    }
    const result = await persistEventOperation(type, member.guild, member, options);
    notifyVerificationAutokickScheduleChanged(member.guild.id);
    return result;
}
function enrollAutokickMember(member) {
    if (member?.user?.bot || !isPlausibleJoinEvent(member)) return Promise.resolve({ status: 'ignored' });
    return runEventOperation('enroll', member);
}
function startAutokickCountdown(member) {
    return runEventOperation('countdown', member);
}
function retireAutokickMember(member, reason = 'event-retired', options = {}) {
    return runEventOperation('retire', member, { ...options, reason });
}
function processGrantedVerificationBypass(member, options = {}) {
    return runEventOperation('bypass', member, {
        ...options,
        reason: 'verification-bypass',
    });
}
function commonMemberIneligibility(member, entry, settings) {
    if (!member) return 'member-absent';
    if (!hasMatchingJoin(member, entry)) return 'generation-changed';
    if (member.user?.bot) return 'bot-member';
    if (bypassesVerification(member)) return 'verification-bypass';
    if (!settings.autokickEnabled) return 'settings-ineligible';
    return null;
}
function verificationMemberIneligibility(member, entry, settings) {
    const common = commonMemberIneligibility(member, entry, settings);
    if (common) return common;
    if (!hasCompletedOnboarding(member)) return 'onboarding-incomplete';
    if (!settings.verificationRoleId) return 'settings-ineligible';
    if (!member.roles.cache.has(settings.verificationRoleId)) return 'role-removed';
    return null;
}
async function terminalize(entry, token, reason, options = {}) {
    return terminalizeVerificationAutokickWork({
        ...generation(entry),
        leaseToken: token,
        phases: options.phases,
        terminalReason: reason,
        deadLettered: options.deadLettered,
        countFailure: options.countFailure,
        errorCode: options.errorCode,
    });
}
async function releaseClaim(entry, token, err, phases) {
    return releaseVerificationAutokickWork({
        ...generation(entry),
        leaseToken: token,
        phases,
        retryDelayMs: getAutokickRetryDelay(entry.attemptCount + 1),
        errorCode: errorCode(err),
        unknownFailure: !isKnownTransientAutokickError(err),
    });
}
async function removeBypassRole(member, settings) {
    const roleId = settings.verificationRoleId;
    if (!roleId) return;
    const currentMember = await fetchCurrentMember(member.guild, member.id);
    if (
        !hasMatchingJoin(currentMember, generation(member))
        || !bypassesVerification(currentMember)
        || !currentMember.roles.cache.has(roleId)
    ) return;
    await currentMember.roles.remove(roleId, 'Discord Verify Member bypass granted.');
}
async function handleClaimFailure(guild, entry, token, err) {
    const unknown = !isKnownTransientAutokickError(err);
    const nextUnknownCount = entry.unknownAttemptCount + (unknown ? 1 : 0);
    if (unknown && nextUnknownCount >= AUTOKICK_UNKNOWN_FAILURE_MAX_ATTEMPTS) {
        const result = await terminalize(entry, token, 'unknown-error-exhausted', {
            deadLettered: true,
            countFailure: true,
            errorCode: errorCode(err),
        });
        if (result.terminalized) {
            const exhausted = new Error(
                `Verification autokick stopped retrying an unclassified failure after ${nextUnknownCount} attempts.`,
                { cause: err },
            );
            exhausted.code = 'VERIFICATION_AUTOKICK_UNKNOWN_FAILURE_EXHAUSTED';
            await logAutokickFailure(guild, exhausted);
        }
        return;
    }
    const result = await releaseClaim(entry, token, err);
    if (result.released) await logAutokickFailure(guild, err);
}
function kickAcknowledgementKey(entry) {
    return `${entry.guildId}:${entry.userId}:${entry.joinedAtMs}`;
}

async function finishConfirmedKick(entry, token) {
    try {
        const result = await finishVerificationAutokickKick({
            ...generation(entry), leaseToken: token, reportNonce: entry.reportNonce,
        });
        if (result.finished || result.status === 'stale-lease') {
            pendingKickAcknowledgements.delete(kickAcknowledgementKey(entry));
        }
        return result;
    }
    catch (error) {
        pendingKickAcknowledgements.set(kickAcknowledgementKey(entry), { entry, token });
        if (!isTransientDatabaseError(error)) {
            autokickLog.error('Confirmed kick persistence is pending:', error);
        }
        return { status: 'persistence-pending', finished: false };
    }
}

async function flushKickAcknowledgements(guildId) {
    const records = [...pendingKickAcknowledgements.values()]
        .filter(({ entry }) => entry.guildId === guildId);
    for (const { entry, token } of records) await finishConfirmedKick(entry, token);
    return records.length;
}

function clearKickAcknowledgements(guildId) {
    const targetGuildId = guildId === undefined || guildId === null ? undefined : String(guildId);
    let cleared = 0;
    for (const [key, record] of pendingKickAcknowledgements.entries()) {
        if (targetGuildId !== undefined && record.entry.guildId !== targetGuildId) continue;
        pendingKickAcknowledgements.delete(key);
        cleared += 1;
    }
    return cleared;
}

async function processKickIntent(guild, entry, token) {
    const member = await fetchCurrentMember(guild, entry.userId);
    if (!member || !hasMatchingJoin(member, entry)) {
        await finishVerificationAutokickOutcomeUnknown({
            ...generation(entry), reportNonce: entry.reportNonce,
        });
        return;
    }
    if (member.kickable === false) {
        const error = new Error(`Warden cannot kick verification member ${member.id}; check permissions and role hierarchy.`);
        error.code = 'VERIFICATION_AUTOKICK_MEMBER_UNKICKABLE';
        const result = await terminalize(entry, token, 'member-unkickable', {
            phases: [PHASES.kickIntent], deadLettered: true, countFailure: true, errorCode: error.code,
        });
        if (result.terminalized) await logAutokickFailure(guild, error);
        return;
    }
    try {
        const reason = entry.deadlineStage === DEADLINE_STAGES.onboarding
            ? 'Verification autokick: user did not complete Discord onboarding within the configured timer.'
            : 'Verification autokick: user still had the unverified role after the configured timer.';
        await member.kick(reason);
    }
    catch (error) {
        if (isUnknownMemberError(error)) {
            await finishVerificationAutokickOutcomeUnknown({
                ...generation(entry), reportNonce: entry.reportNonce,
            });
            return;
        }
        if (isTerminalKickPermissionError(error)) {
            const result = await terminalize(entry, token, 'kick-permission-denied', {
                phases: [PHASES.kickIntent], deadLettered: true, countFailure: true, errorCode: errorCode(error),
            });
            if (result.terminalized) await logAutokickFailure(guild, error);
            return;
        }
        await handleClaimFailure(guild, entry, token, error);
        return;
    }
    await finishConfirmedKick(entry, token);
}

async function processVerificationRecovery(guild, entry, token) {
    const member = await fetchCurrentMember(guild, entry.userId);
    if (!member) {
        await terminalize(entry, token, 'membership-ended', { phases: [PHASES.verifying] });
        return;
    }
    const roleId = entry.authorizedRoleId;
    const completionReason = entry.terminalReason || 'verified';
    if (!roleId) {
        const error = new Error('Durable Verification completion is missing its captured role decision.');
        error.code = 'VERIFICATION_AUTOKICK_COMPLETION_DECISION_MISSING';
        const result = await terminalize(entry, token, 'completion-decision-missing', {
            phases: [PHASES.verifying], deadLettered: true, countFailure: true, errorCode: error.code,
        });
        if (result.terminalized) await logAutokickFailure(guild, error);
        return;
    }
    if (!hasMatchingJoin(member, entry)) {
        try {
            if (!member.roles.cache.has(roleId)) {
                await member.roles.add(roleId, 'Restoring verification gate after membership changed during recovery.');
            }
            await terminalize(entry, token, 'membership-replaced', { phases: [PHASES.verifying] });
        }
        catch (error) {
            const result = await releaseClaim(entry, token, error, [PHASES.verifying]);
            if (result.released) await logAutokickFailure(guild, error);
        }
        return;
    }
    if (!member.roles.cache.has(roleId)) {
        await recoverVerificationAutokickCompletion({
            ...generation(entry), leaseToken: token, verified: true, terminalReason: completionReason,
        });
        return;
    }
    try {
        await member.roles.remove(roleId, 'Completing durable Discord verification access.');
        const postMutationMember = await fetchCurrentMember(guild, entry.userId);
        if (!postMutationMember || !hasMatchingJoin(postMutationMember, entry)) {
            if (postMutationMember && !postMutationMember.roles.cache.has(roleId)) {
                await postMutationMember.roles.add(
                    roleId,
                    'Restoring verification gate after membership changed during recovery.',
                );
            }
            await terminalize(entry, token, 'membership-replaced', { phases: [PHASES.verifying] });
            return;
        }
        await finishVerificationAutokickCompletionFence({
            ...generation(entry), leaseToken: token, terminalReason: completionReason,
        });
    }
    catch (error) {
        const result = await releaseClaim(entry, token, error, [PHASES.verifying]);
        if (result.released) await logAutokickFailure(guild, error);
    }
}

async function processWaiting(guild, entry, token) {
    let member = await fetchCurrentMember(guild, entry.userId);
    let settings = await getVerificationAutokickConfiguration(guild.id);
    let ineligible = commonMemberIneligibility(member, entry, settings);
    if (ineligible) {
        if (ineligible === 'verification-bypass') await removeBypassRole(member, settings);
        await terminalize(entry, token, ineligible, { phases: [PHASES.waiting] });
        return;
    }
    if (entry.deadlineStage === DEADLINE_STAGES.onboarding && hasCompletedOnboarding(member)) {
        await resetVerificationAutokickCountdownAfterOnboarding(generation(entry));
        return;
    }
    if (entry.deadlineStage === DEADLINE_STAGES.verification) {
        ineligible = verificationMemberIneligibility(member, entry, settings);
        if (ineligible) {
            if (ineligible === 'verification-bypass') await removeBypassRole(member, settings);
            await terminalize(entry, token, ineligible, { phases: [PHASES.waiting] });
            return;
        }
    }
    // Onboarding candidates deliberately do not require the verification role:
    // Discord may not assign it until onboarding completes. Explicit verification
    // completion and Discord's verification-bypass flag retire the row separately.
    if (entry.dmAttemptedAtMs === null) {
        const marked = await markVerificationAutokickDmAttempted({ ...generation(entry), leaseToken: token });
        if (!marked.marked) return;
        const payload = buildVerificationAutoKickPayload(member, { autokickSeconds: entry.countdownSeconds });
        await member.send(payload).catch((error) => {
            autokickLog.warn('DM delivery failed; continuing:', error);
        });
    }
    await delay(DM_TO_KICK_DELAY_MS);
    const renewal = await renewVerificationAutokickLease({
        ...generation(entry), leaseToken: token, phases: [PHASES.waiting], leaseDurationMs: CLAIM_LEASE_MS,
    });
    if (!renewal.renewed) return;
    settings = await getVerificationAutokickConfiguration(guild.id);
    member = await fetchCurrentMember(guild, entry.userId);
    ineligible = commonMemberIneligibility(member, entry, settings);
    if (!ineligible && entry.deadlineStage === DEADLINE_STAGES.onboarding && hasCompletedOnboarding(member)) {
        await resetVerificationAutokickCountdownAfterOnboarding(generation(entry));
        return;
    }
    if (!ineligible && entry.deadlineStage === DEADLINE_STAGES.verification) {
        ineligible = verificationMemberIneligibility(member, entry, settings);
    }
    if (ineligible) {
        if (ineligible === 'verification-bypass') await removeBypassRole(member, settings);
        await terminalize(entry, token, ineligible, { phases: [PHASES.waiting] });
        return;
    }
    const authorization = await authorizeVerificationAutokickIntent({
        ...generation(entry), leaseToken: token,
        deadlineStage: entry.deadlineStage,
        expectedVerificationRoleId: settings.verificationRoleId,
        leaseDurationMs: CLAIM_LEASE_MS,
        reportNonce: buildAutokickReportNonce(entry),
        userTag: member.user?.tag,
        displayName: member.displayName,
    });
    if (!authorization.authorized) {
        if (['disabled', 'settings-changed'].includes(authorization.status)) {
            await terminalize(entry, token, 'settings-ineligible', { phases: [PHASES.waiting] });
        }
        return;
    }
    await processKickIntent(guild, authorization.entry, token);
}

async function processClaim(guild, entry, token) {
    try {
        if (entry.phase === PHASES.verifying) return await processVerificationRecovery(guild, entry, token);
        if (entry.phase === PHASES.kickIntent) return await processKickIntent(guild, entry, token);
        if (entry.phase === PHASES.waiting) return await processWaiting(guild, entry, token);
        throw new Error(`Unsupported Verification autokick phase: ${entry.phase}`);
    }
    catch (error) {
        await handleClaimFailure(guild, entry, token, error);
    }
}
async function reconcileCurrentMembers(guild, runtime) {
    const now = Date.now();
    if (!runtime.reconciliationMembers && now < runtime.nextReconciliationAt) return 0;
    if (!runtime.reconciliationMembers) {
        const settings = await getVerificationAutokickConfiguration(guild.id);
        if (!settings.autokickEnabled || !settings.verificationRoleId) {
            runtime.reconciliationComplete = true;
            runtime.nextReconciliationAt = now + MEMBER_RECONCILIATION_INTERVAL_MS;
            return 0;
        }
        const members = await guild.members.fetch();
        runtime.reconciliationMembers = [...members.values()].filter((member) =>
            !member.user?.bot
            && Number.isFinite(member.joinedTimestamp)
            && member.roles.cache.has(settings.verificationRoleId));
        runtime.reconciliationCursor = 0;
        runtime.reconciliationComplete = false;
    }
    const entries = runtime.reconciliationMembers.slice(
        runtime.reconciliationCursor,
        runtime.reconciliationCursor + RECONCILIATION_BATCH_SIZE,
    );
    runtime.reconciliationCursor += entries.length;
    for (const member of entries) {
        try {
            await persistEventOperation(
                bypassesVerification(member) ? 'bypass' : 'enroll',
                guild,
                member,
                { insertIfMissing: true, trustedReconciliation: true },
            );
        }
        catch (error) {
            await logAutokickFailure(guild, error);
        }
    }
    if (runtime.reconciliationCursor >= runtime.reconciliationMembers.length) {
        runtime.reconciliationMembers = null;
        runtime.reconciliationCursor = 0;
        runtime.reconciliationComplete = true;
        runtime.nextReconciliationAt = Date.now() + MEMBER_RECONCILIATION_INTERVAL_MS;
    }
    return entries.length;
}

async function processGuildPoll(guild, runtime, control) {
    if (control.isStopping()) return POLL_RECOVERY_INTERVAL_MS;
    const acknowledgedKicks = await flushKickAcknowledgements(guild.id);
    const acknowledgedReports = await flushAutokickReportAcknowledgements(
        guild.id,
        finishVerificationAutokickReport,
    );
    const token = claimToken();
    const batch = await claimVerificationAutokickWork({
        guildId: guild.id,
        leaseToken: token,
        leaseDurationMs: CLAIM_LEASE_MS,
        limit: CLAIM_BATCH_SIZE,
    });
    for (const entry of batch.entries) {
        if (control.isStopping()) break;
        await processClaim(guild, entry, token);
    }
    if (control.isStopping()) return POLL_RECOVERY_INTERVAL_MS;
    const reportToken = claimToken();
    const reports = await claimPendingVerificationAutokickReports({
        guildId: guild.id,
        leaseToken: reportToken,
        leaseDurationMs: CLAIM_LEASE_MS,
        limit: REPORT_BATCH_SIZE,
    });
    for (const entry of reports.entries) {
        try {
            await deliverAutokickReport({
                guild,
                entry,
                leaseToken: reportToken,
                finishReport: finishVerificationAutokickReport,
                markDispatched: markVerificationAutokickReportDispatched,
                releaseReport: releaseVerificationAutokickReport,
                retryDelayMs: getAutokickRetryDelay(entry.reportAttemptCount + 1),
            });
        }
        catch (error) {
            if (!error?.reportAcknowledgementPending) {
                autokickLog.error('Success report delivery failed:', error);
            }
        }
    }
    const reconciledCount = await reconcileCurrentMembers(guild, runtime);
    if (Date.now() - runtime.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        runtime.lastCleanupAt = Date.now();
        await cleanupRetiredVerificationAutokickEntries({ limit: 500 });
    }
    if (
        batch.entries.length > 0
        || reports.entries.length > 0
        || acknowledgedKicks > 0
        || acknowledgedReports.attempted > 0
        || reconciledCount > 0
        || !runtime.reconciliationComplete
    ) return POLL_ACTIVE_INTERVAL_MS;

    const schedule = await getVerificationAutokickSchedule(guild.id);
    const databaseDelayMs = schedule.nextAvailableAtMs === null
        ? Infinity
        : Math.max(
            POLL_MIN_DELAY_MS,
            schedule.nextAvailableAtMs - schedule.databaseNowMs,
        );
    return Math.min(
        POLL_RECOVERY_INTERVAL_MS,
        databaseDelayMs,
        Math.max(POLL_MIN_DELAY_MS, runtime.nextReconciliationAt - Date.now()),
    );
}
async function initializeVerificationAutokick(guild) {
    if (!guild?.id) throw new Error('Verification autokick startup requires a guild.');
    if (guildRuntimes.has(guild.id)) return { alreadyInitialized: true };

    const disabled = await retireDisabledVerificationAutokickQueue(guild.id);
    const runtime = {
        guild,
        poller: null,
        lastCleanupAt: Date.now(),
        pollFailureCount: 0,
        pollFailureWasDatabase: false,
        firstPollError: null,
        lastPollErrorLogAt: 0,
        reconciliationComplete: disabled.status !== 'enabled',
        reconciliationCursor: 0,
        reconciliationMembers: null,
        nextReconciliationAt: disabled.status === 'enabled' ? 0 : Date.now() + MEMBER_RECONCILIATION_INTERVAL_MS,
    };
    runtime.poller = createAutokickPoller({
        intervalMs: POLL_ACTIVE_INTERVAL_MS,
        process: async (control) => {
            const nextDelayMs = await processGuildPoll(guild, runtime, control);
            resetPollFailureState(runtime);
            return nextDelayMs;
        },
        onError: async (err) => {
            runtime.pollFailureCount += 1;
            const now = Date.now();
            if (runtime.pollFailureCount === 1) {
                runtime.pollFailureWasDatabase = isTransientDatabaseError(err);
                runtime.firstPollError = err;
            }
            const isSilentDatabaseRetry = runtime.pollFailureCount === 1
                && runtime.pollFailureWasDatabase;
            if (
                !isSilentDatabaseRetry
                && now - runtime.lastPollErrorLogAt >= POLL_ERROR_LOG_INTERVAL_MS
            ) {
                runtime.lastPollErrorLogAt = now;
                if (
                    runtime.pollFailureWasDatabase
                    && runtime.pollFailureCount === 2
                    && isTransientDatabaseError(err)
                ) {
                    if (
                        err instanceof Error
                        && err !== runtime.firstPollError
                        && err.cause === undefined
                    ) {
                        err.cause = runtime.firstPollError;
                    }
                    autokickLog.error(
                        'Database poll still unavailable after retry',
                        err,
                        { attempts: runtime.pollFailureCount },
                    );
                } else if (runtime.pollFailureWasDatabase && runtime.pollFailureCount === 2) {
                    autokickLog.error(
                        'Background poll failed after database retry',
                        err,
                        { attempts: runtime.pollFailureCount },
                    );
                } else {
                    autokickLog.error('Background poll failed', err, {
                        attempts: runtime.pollFailureCount,
                    });
                }
            }
            return Math.min(
                POLL_ACTIVE_INTERVAL_MS * (2 ** Math.min(runtime.pollFailureCount - 1, 10)),
                POLL_ERROR_MAX_DELAY_MS,
            );
        },
    });
    guildRuntimes.set(guild.id, runtime);
    return {
        reconciliationPending: !runtime.reconciliationComplete,
    };
}
async function shutdownVerificationAutokick(guildOrId) {
    const guildId = typeof guildOrId === 'string' ? guildOrId : guildOrId?.id;
    const runtimes = guildId
        ? [guildRuntimes.get(guildId)].filter(Boolean)
        : [...guildRuntimes.values()];
    const errors = [];
    for (const runtime of runtimes) {
        try {
            const stopped = await runtime.poller.stop(null);
            if (!stopped) {
                throw new Error(`Verification autokick shutdown timed out for guild ${runtime.guild.id}.`);
            }
            guildRuntimes.delete(runtime.guild.id);
            clearKickAcknowledgements(runtime.guild.id);
            clearAutokickReportAcknowledgements(runtime.guild.id);
        }
        catch (error) {
            errors.push(error);
        }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
        throw new AggregateError(errors, 'Multiple Verification autokick runtimes failed to stop.');
    }
    if (runtimes.length === 0) {
        clearKickAcknowledgements(guildId);
        clearAutokickReportAcknowledgements(guildId);
    }
}
async function beginAutokickCompletion(member, verificationRoleId, reason = 'verified') {
    const token = claimToken();
    const result = await beginVerificationAutokickCompletionFence({
        ...generation(member),
        leaseToken: token,
        expectedVerificationRoleId: verificationRoleId,
        completionReason: reason,
        leaseDurationMs: CLAIM_LEASE_MS,
    });
    notifyVerificationAutokickScheduleChanged(member.guild.id);
    return {
        ...result,
        ...generation(member),
        leaseToken: token,
        completionReason: reason,
    };
}
async function finishAutokickCompletion(fence, reason = fence?.completionReason ?? 'verified') {
    if (fence.fenceAcquired !== true) {
        return { status: fence.status ?? 'no-fence', finished: true, noOp: true };
    }
    const acknowledgement = {
        ...generation(fence),
        leaseToken: fence.leaseToken,
        terminalReason: reason,
        repairMissingCompletion: true,
    };
    try {
        const retry = await retryTransientDatabaseOperation(
            () => finishVerificationAutokickCompletionFence(acknowledgement),
        );
        notifyVerificationAutokickScheduleChanged(fence.guildId);
        return { ...retry.value, retried: retry.retried };
    }
    catch (error) {
        notifyVerificationAutokickScheduleChanged(fence.guildId);
        const retryFailureIsTransient = error?.databaseRetryAttempted === true
            ? error.databaseRetryFinalErrorTransient === true
            : isTransientDatabaseError(error);
        if (retryFailureIsTransient) {
            // Access was already granted. Leave the fenced verifying row for
            // the durable worker instead of retrying the Discord role mutation.
            return { status: 'persistence-pending', finished: false, recoverable: true };
        }
        throw error;
    }
}
async function releaseAutokickCompletion(fence, err) {
    if (fence.fenceAcquired !== true) {
        return { status: fence.status ?? 'no-fence', released: true, noOp: true };
    }
    const result = await releaseVerificationAutokickCompletionFence({
        ...generation(fence),
        leaseToken: fence.leaseToken,
        errorCode: errorCode(err),
    });
    notifyVerificationAutokickScheduleChanged(fence.guildId);
    return result;
}
module.exports = {
    beginAutokickCompletion,
    bypassesVerification,
    enrollAutokickMember,
    finishAutokickCompletion,
    hasCompletedOnboarding,
    initializeVerificationAutokick,
    notifyVerificationAutokickScheduleChanged,
    processGrantedVerificationBypass,
    releaseAutokickCompletion,
    retireAutokickMember,
    shutdownVerificationAutokick,
    startAutokickCountdown,
};
