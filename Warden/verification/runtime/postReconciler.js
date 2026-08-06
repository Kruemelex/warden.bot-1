'use strict';

const { createVerificationLogger } = require('../logging');
const { reportVerificationError } = require('../errorLogging');
const { buildVerificationPostPayload } = require('../presentation/post');
const {
    listVerificationPosts,
    removeVerificationPosts,
} = require('../service');

const FETCH_RETRY_DELAY_MS = 750;
const RECONCILIATION_CONCURRENCY = 2;
const DEFINITIVELY_MISSING_CODES = new Set(['10003', '10008']);
const reconcilerStates = new Map();
const postLog = createVerificationLogger('Public posts');

function delay(ms, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', cancel);
            resolve(true);
        }, ms);
        function cancel() {
            clearTimeout(timer);
            resolve(false);
        }
        signal?.addEventListener('abort', cancel, { once: true });
    });
}

function getDiscordErrorCode(error) {
    return String(error?.code ?? error?.rawError?.code ?? '');
}

function isDefinitivelyMissing(error) {
    return DEFINITIVELY_MISSING_CODES.has(getDiscordErrorCode(error))
        || Number(error?.status ?? error?.rawError?.status) === 404
        || error?.code === 'VERIFICATION_POST_CHANNEL_UNUSABLE';
}

async function fetchVerificationPost(guild, post) {
    const channel = await guild.channels.fetch(post.channelId);
    if (!channel?.isTextBased?.() || typeof channel.messages?.fetch !== 'function') {
        const error = new Error(`Registered verification post channel ${post.channelId} is no longer usable.`);
        error.code = 'VERIFICATION_POST_CHANNEL_UNUSABLE';
        throw error;
    }
    return channel.messages.fetch(post.messageId);
}

async function reconcileVerificationPost(guild, post, payload, lifecycle) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!lifecycle.isCurrent()) return { status: 'cancelled', post };
        try {
            const message = await fetchVerificationPost(guild, post);
            if (!lifecycle.isCurrent()) return { status: 'cancelled', post };
            await message.edit(payload);
            return { status: 'updated', post };
        }
        catch (error) {
            if (attempt === 0) {
                if (!await delay(FETCH_RETRY_DELAY_MS, lifecycle.signal)) {
                    return { status: 'cancelled', post };
                }
                continue;
            }
            return isDefinitivelyMissing(error)
                ? { status: 'missing', post }
                : { status: 'failed', post, error };
        }
    }
    return { status: 'missing', post };
}

async function mapWithConcurrency(values, limit, work, shouldContinue = () => true) {
    const results = new Array(values.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < values.length) {
            if (!shouldContinue()) return;
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await work(values[index], index);
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(limit, values.length) },
        () => worker(),
    ));
    return results;
}

function contextualizePostError(result) {
    return new Error(
        `Verification post ${result.post.messageId} in channel ${result.post.channelId} could not be updated.`,
        { cause: result.error },
    );
}

async function reconcileVerificationPosts(state, request) {
    state.lifecycle.assertCurrent();
    const posts = await listVerificationPosts(state.guild.id);
    if (posts.length < 1) return Object.freeze({ registered: 0, updated: 0, removed: 0, failed: 0 });

    const payload = buildVerificationPostPayload(request.verificationSettings);
    const results = await mapWithConcurrency(
        posts,
        RECONCILIATION_CONCURRENCY,
        (post) => reconcileVerificationPost(state.guild, post, payload, state.lifecycle),
        () => state.lifecycle.isCurrent(),
    );
    state.lifecycle.assertCurrent();

    const missing = results.filter((result) => result.status === 'missing').map((result) => result.post);
    const failures = results.filter((result) => result.status === 'failed');
    let cleanupError;
    let removed = 0;
    if (missing.length > 0) {
        try {
            await removeVerificationPosts(state.guild.id, missing);
            removed = missing.length;
        }
        catch (error) {
            cleanupError = error;
        }
    }

    const summary = Object.freeze({
        registered: posts.length,
        updated: results.filter((result) => result.status === 'updated').length,
        removed,
        failed: failures.length + (cleanupError ? 1 : 0),
        reason: request.reason,
    });
    if (summary.failed < 1) {
        postLog.complete('Reconciliation completed', summary);
        return summary;
    }

    const error = new AggregateError(
        [
            ...failures.map(contextualizePostError),
            cleanupError
                ? new Error('Missing verification posts could not be removed from the registry.', { cause: cleanupError })
                : undefined,
        ].filter(Boolean),
        `${summary.failed} verification post reconciliation operation${summary.failed === 1 ? '' : 's'} failed.`,
    );
    await reportVerificationError({
        guild: state.guild,
        title: '⛔ Verification post reconciliation failed',
        details: [
            `Registered: ${summary.registered}`,
            `Updated: ${summary.updated}`,
            `Removed: ${summary.removed}`,
            `Failed: ${summary.failed}`,
        ],
    }, error);
    return summary;
}

function startReconciliationDrain(state) {
    if (state.running) return state.running;
    const drain = (async () => {
        let latestSummary;
        while (state.pending && state.lifecycle.isCurrent()) {
            const request = state.pending;
            state.pending = undefined;
            try {
                latestSummary = await reconcileVerificationPosts(state, request);
            }
            catch (error) {
                if (!state.lifecycle.isCurrent()) return latestSummary;
                await reportVerificationError({
                    guild: state.guild,
                    title: '⛔ Verification post reconciliation failed',
                }, error);
            }
        }
        return latestSummary;
    })();
    state.running = state.lifecycle.track(drain).finally(() => {
        state.running = undefined;
        if (state.pending && state.lifecycle.isCurrent()) startReconciliationDrain(state);
    });
    return state.running;
}

function initializeVerificationPostReconciler({ guild, lifecycle }) {
    if (!guild?.id || !lifecycle) {
        throw new TypeError('Verification post reconciliation requires a guild and lifecycle owner.');
    }
    if (String(guild.id) !== String(lifecycle.guildId)) {
        throw new TypeError('Verification post reconciliation lifecycle ownership must match the guild.');
    }
    lifecycle.assertCurrent();
    const state = {
        guild,
        lifecycle,
        pending: undefined,
        running: undefined,
    };
    reconcilerStates.set(String(guild.id), state);
    lifecycle.addDisposer(() => {
        if (reconcilerStates.get(String(guild.id)) === state) {
            reconcilerStates.delete(String(guild.id));
        }
    });
    return state;
}

function scheduleVerificationPostReconciliation(guildId, verificationSettings, reason = 'settings changed') {
    const state = reconcilerStates.get(String(guildId));
    if (!state?.lifecycle.isCurrent()) return Promise.resolve(undefined);
    state.pending = { verificationSettings, reason };
    return startReconciliationDrain(state);
}

module.exports = {
    initializeVerificationPostReconciler,
    scheduleVerificationPostReconciliation,
};
