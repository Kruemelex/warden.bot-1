const Discord = require('discord.js');
const { botLog } = require('../../functions');
const { createVerificationLogger } = require('./logging');
const {
    isVerificationRenderAvailabilityError,
    isVerificationRenderCapacityError,
} = require('./assets/errors');

const AVAILABILITY_BOTLOG_INTERVAL_MS = 60_000;
const CAPACITY_CONSOLE_INTERVAL_MS = 60_000;
const availabilityBotLogsByGuild = new Map();
const capacityConsoleLogs = new Map();
const botLoggedErrors = new WeakSet();
const capacityLog = createVerificationLogger('Capacity');
const errorLog = createVerificationLogger('Error reporting');
const executionLog = createVerificationLogger('Execution');

function getErrorText(error, seen = new WeakSet()) {
    if (error && typeof error === 'object') {
        if (seen.has(error)) return '[Repeated verification error]';
        seen.add(error);
    }
    const text = String(error?.stack ?? error?.message ?? error ?? 'Unknown verification error.');
    if (!Array.isArray(error?.errors) || error.errors.length < 1) return text;
    return [
        text,
        ...error.errors.map((nestedError, index) =>
            `Nested error ${index + 1}:\n${getErrorText(nestedError, seen)}`),
    ].join('\n\n');
}

function isVerificationCapacityError(error) {
    return isVerificationRenderCapacityError(error)
        || error?.code === 'VERIFICATION_ADMIN_MODAL_TIMEOUT'
        || error?.code === 'VERIFICATION_PREVIEW_CAPACITY';
}

function isVerificationConsoleOnlyError(error) {
    return isVerificationCapacityError(error)
        || error?.code === 'VERIFICATION_PREVIEW_NOTICE';
}

function getGuildId(context) {
    return String(
        context.guildId
        ?? context.guild?.id
        ?? context.interaction?.guildId
        ?? context.interaction?.guild?.id
        ?? 'unknown',
    );
}

function claimAvailabilityBotLog(context, error) {
    if (!isVerificationRenderAvailabilityError(error)) return true;

    const now = Date.now();
    const guildId = getGuildId(context);
    const previousLogAt = availabilityBotLogsByGuild.get(guildId) ?? 0;
    if (now - previousLogAt < AVAILABILITY_BOTLOG_INTERVAL_MS) return false;

    availabilityBotLogsByGuild.set(guildId, now);
    for (const [loggedGuildId, loggedAt] of availabilityBotLogsByGuild) {
        if (now - loggedAt >= AVAILABILITY_BOTLOG_INTERVAL_MS) {
            availabilityBotLogsByGuild.delete(loggedGuildId);
        }
    }
    return true;
}

function claimErrorBotLog(error) {
    if (!error || typeof error !== 'object') return true;
    if (botLoggedErrors.has(error)) return false;
    botLoggedErrors.add(error);
    return true;
}

function logVerificationCapacity(context, error, title) {
    const now = Date.now();
    const key = [
        getGuildId(context),
        error?.code ?? 'unknown',
        error?.phase ?? 'unknown',
        title,
    ].join(':');
    const previousLogAt = capacityConsoleLogs.get(key) ?? 0;
    if (now - previousLogAt < CAPACITY_CONSOLE_INTERVAL_MS) return;
    capacityLog.warn('Capacity threshold reached', error, { operation: title });
    capacityConsoleLogs.set(key, now);
    for (const [loggedKey, loggedAt] of capacityConsoleLogs) {
        if (now - loggedAt >= CAPACITY_CONSOLE_INTERVAL_MS) {
            capacityConsoleLogs.delete(loggedKey);
        }
    }
}

function buildErrorDescription(context, error) {
    const details = [
        ...(context.details ?? []),
        context.userId ? `User: <@${context.userId}>` : undefined,
        '',
        '```',
        getErrorText(error),
        '```',
    ].filter((line) => line !== undefined);
    return details.join('\n').slice(0, 4_096);
}

async function reportVerificationError(context, error) {
    const title = String(context.title ?? '⛔ Verification execution failed');
    if (isVerificationConsoleOnlyError(error)) {
        if (isVerificationCapacityError(error)) {
            logVerificationCapacity(context, error, title);
        }
        return { consoleOnly: true, discordLogged: false };
    }

    if (context.consoleOutput !== false) {
        executionLog.error(title, error);
    }
    const guild = context.guild ?? context.interaction?.guild;
    if (!guild) return { consoleOnly: false, discordLogged: false };
    if (!claimErrorBotLog(error) || !claimAvailabilityBotLog(context, error)) {
        return { consoleOnly: false, discordLogged: false };
    }

    try {
        await botLog(
            guild,
            new Discord.EmbedBuilder()
                .setTitle(title.slice(0, 256))
                .setDescription(buildErrorDescription(context, error)),
            2,
            'error',
        );
        return { consoleOnly: false, discordLogged: true };
    }
    catch (logError) {
        errorLog.error('Failed to send bot log.', logError);
        return { consoleOnly: false, discordLogged: false };
    }
}

module.exports = {
    reportVerificationError,
};
