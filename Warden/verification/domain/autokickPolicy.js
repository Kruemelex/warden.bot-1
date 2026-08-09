const AUTOKICK_PROCESS_RETRY_MS = 30 * 1000;
const AUTOKICK_PROCESS_MAX_RETRY_MS = 10 * 60 * 1000;
const AUTOKICK_UNKNOWN_FAILURE_MAX_ATTEMPTS = 8;
const RETIRED_AUTOKICK_RETENTION_MS = 10 * 60 * 1000;
const MAX_JOIN_EVENT_AGE_MS = 5 * 60 * 1000;
const MAX_JOIN_EVENT_FUTURE_SKEW_MS = 60 * 1000;

const TRANSIENT_AUTOKICK_ERROR_CODES = new Set([
    'ER_CON_COUNT_ERROR',
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'ER_QUERY_INTERRUPTED',
    'ER_SERVER_SHUTDOWN',
    'ER_TOO_MANY_USER_CONNECTIONS',
]);

function hasMemberFlag(member, flag) {
    return member?.flags?.has?.(flag) === true;
}

function memberRolesAdded(oldMember, newMember) {
    const oldRoles = oldMember?.roles?.cache;
    const newRoles = newMember?.roles?.cache;
    if (!oldRoles || !newRoles) return true;

    for (const roleId of newRoles.keys()) {
        if (!oldRoles.has(roleId)) return true;
    }
    return false;
}

function hasMatchingJoin(member, entry) {
    return Boolean(
        member?.guild?.id === entry.guildId
        && member.id === entry.userId
        && Number.isFinite(member.joinedTimestamp)
        && member.joinedTimestamp === entry.joinedAtMs,
    );
}

function isPlausibleJoinEvent(member, now = Date.now()) {
    if (!Number.isFinite(member?.joinedTimestamp)) return false;
    const joinAge = now - member.joinedTimestamp;
    return joinAge >= -MAX_JOIN_EVENT_FUTURE_SKEW_MS && joinAge <= MAX_JOIN_EVENT_AGE_MS;
}

function getAutokickRetryDelay(failureCount) {
    return Math.min(
        AUTOKICK_PROCESS_RETRY_MS * (2 ** Math.min(failureCount - 1, 10)),
        AUTOKICK_PROCESS_MAX_RETRY_MS,
    );
}

function getDiscordErrorCode(err) {
    return err?.code ?? err?.rawError?.code;
}

function isUnknownMemberError(err, unknownMemberCode) {
    const errorCode = getDiscordErrorCode(err);
    return errorCode === unknownMemberCode || errorCode === 'Unknown Member';
}

function isTerminalKickPermissionError(err, missingAccessCode, missingPermissionsCode) {
    const errorCode = getDiscordErrorCode(err);
    const status = Number(err?.status ?? err?.httpStatus ?? err?.response?.status);
    return status === 403
        || errorCode === missingAccessCode
        || errorCode === missingPermissionsCode;
}

function isKnownTransientAutokickError(err) {
    const status = Number(err?.status ?? err?.httpStatus ?? err?.response?.status);
    if (status === 408 || status === 429 || status >= 500) return true;
    if (err?.retryAfter !== undefined || err?.retry_after !== undefined) return true;

    const code = String(err?.code ?? err?.cause?.code ?? '');
    return code === '408'
        || code === '429'
        || /^(?:PROTOCOL_|WARDEN_DB_|VERIFICATION_TRANSACTION_|ECONN|ETIMEDOUT|EAI_AGAIN|ENET|EHOST|UND_ERR_)/.test(code)
        || TRANSIENT_AUTOKICK_ERROR_CODES.has(code)
        || code === 'VERIFICATION_SNAPSHOT_TIMEOUT'
        || err?.name === 'AbortError';
}

module.exports = {
    AUTOKICK_UNKNOWN_FAILURE_MAX_ATTEMPTS,
    MAX_JOIN_EVENT_AGE_MS,
    RETIRED_AUTOKICK_RETENTION_MS,
    getAutokickRetryDelay,
    hasMatchingJoin,
    hasMemberFlag,
    isKnownTransientAutokickError,
    isPlausibleJoinEvent,
    isTerminalKickPermissionError,
    isUnknownMemberError,
    memberRolesAdded,
};
