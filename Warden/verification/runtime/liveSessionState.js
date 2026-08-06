const crypto = require('crypto');
const { VERIFICATION_MODES } = require('../service');
const {
    buildVerificationExpiredResponse,
    buildVerificationInProgressResponse,
} = require('../presentation/documents/notices');
const { sendEphemeralNotice } = require('./interactionResponses');

const DEFAULT_SCREEN_EXPIRY_MS = 10 * 60 * 1000;
const VERIFICATION_PROCESSING_HARD_EXPIRY_MS = 15 * 60 * 1000;
const VERIFICATION_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_VERIFICATION_SESSIONS = 250;
const MAX_TIMEOUT_DELAY_MS = 0x7fffffff;
const activeChallenges = new Map();
const activeChallengeExpiryTimers = new Map();
const cooldowns = new Map();
const sessionAttempts = new WeakMap();

const SESSION_PHASES = Object.freeze({
    preparing: 'preparing',
    ready: 'ready',
    transitioning: 'transitioning',
    terminal: 'terminal',
});

const LEGAL_SESSION_TRANSITIONS = Object.freeze({
    [SESSION_PHASES.preparing]: new Set([SESSION_PHASES.ready, SESSION_PHASES.terminal]),
    [SESSION_PHASES.ready]: new Set([
        SESSION_PHASES.transitioning,
        SESSION_PHASES.terminal,
    ]),
    [SESSION_PHASES.transitioning]: new Set([SESSION_PHASES.ready, SESSION_PHASES.terminal]),
    [SESSION_PHASES.terminal]: new Set(),
});

function getVerificationStateKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function getInteractionStateKey(interaction) {
    return getVerificationStateKey(interaction.guildId ?? interaction.guild?.id, interaction.user.id);
}

function setChallenge(userId, challenge, expiryMs = DEFAULT_SCREEN_EXPIRY_MS) {
    if (!activeChallenges.has(userId) && activeChallenges.size >= MAX_ACTIVE_VERIFICATION_SESSIONS) {
        cleanupExpiredVerificationState();
        if (activeChallenges.size >= MAX_ACTIVE_VERIFICATION_SESSIONS) return false;
    }

    // The caller keeps this exact object. It becomes the registry's canonical
    // session so handles, guards and timers cannot drift across a clone.
    const session = challenge;
    const createdTimestamp = session.createdTimestamp ?? Date.now();
    session.createdTimestamp = createdTimestamp;
    session.expiresAt = session.expiresAt ?? createdTimestamp + expiryMs;
    session.phase ??= SESSION_PHASES.ready;
    const attempt = createAttempt(session);
    activeChallenges.set(userId, session);
    if (session.phase !== SESSION_PHASES.preparing) {
        scheduleChallengeExpiry(userId, session, attempt, session.expiresAt);
    }
    return true;
}

function createAttempt(session) {
    const attempt = Object.freeze({});
    sessionAttempts.set(session, attempt);
    return attempt;
}

function captureSessionAttempt(session) {
    return sessionAttempts.get(session);
}

function isCurrentAttempt(userId, expectedSession, expectedAttempt) {
    if (activeChallenges.get(userId) !== expectedSession) return false;
    const currentAttempt = sessionAttempts.get(expectedSession);
    return Boolean(currentAttempt) && (!expectedAttempt || currentAttempt === expectedAttempt);
}

function transitionSessionPhaseIfCurrent(
    userId,
    expectedSession,
    expectedPhase,
    nextPhase,
    { attempt, update } = {},
) {
    if (!isCurrentAttempt(userId, expectedSession, attempt)) return false;
    if (expectedSession.phase !== expectedPhase) return false;
    if (!LEGAL_SESSION_TRANSITIONS[expectedPhase]?.has(nextPhase)) return false;

    expectedSession.phase = nextPhase;
    update?.(expectedSession);
    if (nextPhase === SESSION_PHASES.terminal) clearChallenge(userId);
    return true;
}

function getChallenge(userId, expiryMs = DEFAULT_SCREEN_EXPIRY_MS) {
    const challenge = activeChallenges.get(userId);
    if (!challenge) return undefined;

    const expiresAt = challenge.expiresAt ?? ((challenge.createdTimestamp ?? 0) + expiryMs);
    if (Date.now() > expiresAt) {
        clearChallenge(userId);
        return undefined;
    }

    return challenge;
}

function clearChallenge(userId) {
    const expiryTimer = activeChallengeExpiryTimers.get(userId);
    if (expiryTimer?.timer) clearTimeout(expiryTimer.timer);
    activeChallengeExpiryTimers.delete(userId);
    const session = activeChallenges.get(userId);
    if (session) session.phase = SESSION_PHASES.terminal;
    activeChallenges.delete(userId);
}

function isCurrentChallengeGeneration(userId, expectedSession, { attempt, phase } = {}) {
    if (!isCurrentAttempt(userId, expectedSession, attempt)) return false;
    return !phase || expectedSession.phase === phase;
}

function clearChallengeIfCurrent(userId, expectedSession, options) {
    if (!isCurrentChallengeGeneration(userId, expectedSession, options)) return false;
    clearChallenge(userId);
    return true;
}

function clearVerificationStateIfCurrent(userId, expectedSession) {
    if (!clearChallengeIfCurrent(userId, expectedSession)) return false;
    clearCooldown(userId);
    return true;
}

function setSessionExpiry(userId, session, attempt, expiresAt) {
    session.expiresAt = expiresAt;
    scheduleChallengeExpiry(userId, session, attempt, expiresAt);
}

// Queueing and rendering use a hard internal deadline. Each successfully
// prepared screen receives a fresh member-facing expiry at delivery time.
function beginScreenProcessingIfCurrent(userId, expectedSession, { attempt } = {}) {
    if (!isCurrentChallengeGeneration(userId, expectedSession, { attempt })) return false;

    const currentSession = activeChallenges.get(userId);
    const now = Date.now();
    const currentDeadline = Number(currentSession.expiresAt);
    if (!Number.isFinite(currentDeadline) || now >= currentDeadline) {
        clearChallenge(userId);
        return false;
    }
    if (currentSession.phase === SESSION_PHASES.transitioning) return true;

    if (currentSession.phase === SESSION_PHASES.ready) {
        if (!transitionSessionPhaseIfCurrent(
            userId,
            currentSession,
            SESSION_PHASES.ready,
            SESSION_PHASES.transitioning,
            { attempt },
        )) return false;
    }
    if (currentSession.phase !== SESSION_PHASES.preparing
        && currentSession.phase !== SESSION_PHASES.transitioning) return false;

    setSessionExpiry(
        userId,
        currentSession,
        attempt ?? captureSessionAttempt(currentSession),
        now + VERIFICATION_PROCESSING_HARD_EXPIRY_MS,
    );
    return true;
}

function startScreenExpiryIfCurrent(userId, expectedSession, { attempt } = {}) {
    if (!isCurrentChallengeGeneration(userId, expectedSession, { attempt })) return false;

    const currentSession = activeChallenges.get(userId);
    const now = Date.now();
    const screenExpiryMs = Number(currentSession.screenExpiryMs);
    if (currentSession.phase !== SESSION_PHASES.transitioning
        || !Number.isFinite(currentSession.expiresAt)
        || now >= currentSession.expiresAt
        || !Number.isFinite(screenExpiryMs)
        || screenExpiryMs <= 0) {
        clearChallenge(userId);
        return false;
    }

    if (!transitionSessionPhaseIfCurrent(
        userId,
        currentSession,
        SESSION_PHASES.transitioning,
        SESSION_PHASES.ready,
        { attempt },
    )) return false;
    setSessionExpiry(
        userId,
        currentSession,
        attempt ?? captureSessionAttempt(currentSession),
        now + screenExpiryMs,
    );
    return true;
}

function getCurrentChallengeGeneration(userId, expectedSession, options) {
    if (!isCurrentChallengeGeneration(userId, expectedSession, options)) return undefined;

    const currentSession = activeChallenges.get(userId);
    const expiresAt = Number(currentSession.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
        clearChallengeIfCurrent(userId, expectedSession);
        return undefined;
    }

    return currentSession;
}

function createInitialSessionStaleError(message) {
    const err = new Error(message);
    err.code = 'VERIFICATION_INITIAL_SESSION_STALE';
    return err;
}

async function assertPendingInitialLiveSessionCurrent(
    interaction,
    stateKey,
    session,
    fetchCurrentMember,
    { attempt = captureSessionAttempt(session) } = {},
) {
    if (!getCurrentChallengeGeneration(
        stateKey,
        session,
        { phase: SESSION_PHASES.preparing, attempt },
    )) {
        throw createInitialSessionStaleError('This verification attempt is no longer current. Please start again.');
    }

    const member = await fetchCurrentMember(interaction.guild, interaction.user.id);
    if (!member || member.joinedTimestamp !== session.membershipJoinedAtMs) {
        clearChallengeIfCurrent(stateKey, session, { attempt });
        throw createInitialSessionStaleError('Your server membership changed while verification was preparing. Please start again.');
    }

    if (!getCurrentChallengeGeneration(
        stateKey,
        session,
        { phase: SESSION_PHASES.preparing, attempt },
    )) {
        throw createInitialSessionStaleError('This verification attempt is no longer current. Please start again.');
    }
}

function commitPendingInitialLiveSession(userId, session, { attempt } = {}) {
    if (!getCurrentChallengeGeneration(
        userId,
        session,
        { phase: SESSION_PHASES.preparing, attempt },
    )) return false;
    const screenExpiryMs = Number(session.screenExpiryMs);
    if (!Number.isFinite(screenExpiryMs) || screenExpiryMs <= 0) {
        clearChallengeIfCurrent(userId, session);
        return false;
    }
    if (!transitionSessionPhaseIfCurrent(
        userId,
        session,
        SESSION_PHASES.preparing,
        SESSION_PHASES.ready,
        { attempt },
    )) return false;
    setSessionExpiry(
        userId,
        session,
        attempt ?? captureSessionAttempt(session),
        Date.now() + screenExpiryMs,
    );
    return true;
}

function scheduleChallengeExpiry(userId, session, attempt, expiresAt) {
    const existingTimer = activeChallengeExpiryTimers.get(userId);
    if (existingTimer?.timer) clearTimeout(existingTimer.timer);

    const expire = () => {
        if (!isCurrentAttempt(userId, session, attempt)) return;
        const remaining = Number(expiresAt) - Date.now();
        if (remaining > MAX_TIMEOUT_DELAY_MS) {
            const timer = setTimeout(expire, MAX_TIMEOUT_DELAY_MS);
            timer.unref?.();
            activeChallengeExpiryTimers.set(userId, { timer, session, attempt, expiresAt });
            return;
        }

        expireChallengeIfDue(userId, session, attempt, expiresAt);
    };

    const timer = setTimeout(expire, Math.max(0, Math.min(Number(expiresAt) - Date.now(), MAX_TIMEOUT_DELAY_MS)));
    timer.unref?.();
    activeChallengeExpiryTimers.set(userId, { timer, session, attempt, expiresAt });
}

function expireChallengeIfDue(userId, expectedSession, expectedAttempt, expiresAt) {
    const session = activeChallenges.get(userId);
    if (
        session?.expiresAt === expiresAt
        && isCurrentAttempt(userId, expectedSession, expectedAttempt)
        && Date.now() >= expiresAt
    ) clearChallenge(userId);
}

function setCooldown(userId, retryAt) {
    cooldowns.set(userId, retryAt);
}

function getCooldownRemaining(userId) {
    const retryAt = cooldowns.get(userId);
    if (!retryAt) return 0;

    const remaining = retryAt - Date.now();
    if (remaining <= 0) {
        clearCooldown(userId);
        return 0;
    }

    return remaining;
}

function clearCooldown(userId) {
    cooldowns.delete(userId);
}

function cleanupExpiredVerificationState() {
    const now = Date.now();

    for (const [userId, session] of activeChallenges.entries()) {
        const expiresAt = Number(session?.expiresAt ?? 0);
        if (expiresAt > 0 && now >= expiresAt) {
            clearChallenge(userId);
        }
    }

    for (const [userId, retryAt] of cooldowns.entries()) {
        if (Number(retryAt) <= now) {
            cooldowns.delete(userId);
        }
    }
}

const cleanupInterval = setInterval(cleanupExpiredVerificationState, VERIFICATION_SESSION_CLEANUP_INTERVAL_MS);
cleanupInterval.unref?.();

function resolveVerificationMode(verificationSettings) {
    const configuredMode = verificationSettings?.mode;
    return Object.values(VERIFICATION_MODES).includes(configuredMode) ? configuredMode : VERIFICATION_MODES.challenge;
}

function resolveScreenExpiryMs(verificationSettings) {
    const seconds = Number(verificationSettings?.screenExpirySeconds);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_SCREEN_EXPIRY_MS;
}

function resolveCooldownSeconds(verificationSettings) {
    const seconds = Number(verificationSettings?.cooldownSeconds);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
}

function selectVerificationChallenge(runtime) {
    const challenges = runtime?.activeChallenges ?? [];
    if (challenges.length < 2) {
        return challenges[0];
    }

    return challenges[Math.floor(Math.random() * challenges.length)];
}

function createSessionToken() {
    return crypto.randomUUID().replaceAll('-', '');
}

// The fallback button deliberately has a different lifetime from ordinary
// screen controls. Screen controls are invalidated whenever the user moves;
// the fallback must continue to open whichever screen is current.
function isStaleOldVersionComponent(parsed, session) {
    return !parsed?.fallbackToken || parsed.fallbackToken !== session.fallbackToken;
}

function getActiveSession(userId) {
    const session = activeChallenges.get(userId);
    if (!session) return undefined;

    const expiresAt = Number(session.expiresAt ?? 0);
    if (expiresAt > 0 && Date.now() > expiresAt) {
        clearChallenge(userId);
        return undefined;
    }

    return session;
}

async function getActiveSessionOrReplyFast(interaction) {
    const stateKey = getInteractionStateKey(interaction);
    const session = getActiveSession(stateKey);

    if (!session) {
        await sendEphemeralNotice(interaction, buildVerificationExpiredResponse());
        return undefined;
    }

    if (session.phase === SESSION_PHASES.preparing) {
        await sendEphemeralNotice(interaction, buildVerificationInProgressResponse(session.expiresAt));
        return undefined;
    }

    return session;
}

module.exports = {
    SESSION_PHASES,
    assertPendingInitialLiveSessionCurrent,
    beginScreenProcessingIfCurrent,
    captureSessionAttempt,
    clearChallenge,
    clearChallengeIfCurrent,
    clearCooldown,
    clearVerificationStateIfCurrent,
    commitPendingInitialLiveSession,
    createSessionToken,
    getActiveSession,
    getActiveSessionOrReplyFast,
    getChallenge,
    getCooldownRemaining,
    getInteractionStateKey,
    isStaleOldVersionComponent,
    resolveScreenExpiryMs,
    resolveCooldownSeconds,
    resolveVerificationMode,
    startScreenExpiryIfCurrent,
    selectVerificationChallenge,
    setChallenge,
    setCooldown,
    transitionSessionPhaseIfCurrent,
};
