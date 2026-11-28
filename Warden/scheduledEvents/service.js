'use strict';

const { Routes } = require('discord.js');
const { botIdent } = require('../../functions');
const { createConsoleReporter } = require('../../logging/consoleReporting');
const { normalizeScheduledEvent } = require('./eventPayload');
const repository = require('./repository');
const publisher = require('./websitePublisher');
const { enqueueGuildWork, runGuildMutation, drainGuildMutations } = require('./guildMutations');

const report = createConsoleReporter('Scheduled Events').forSubsystem('Lifecycle');
const DAILY_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_RETRY_DELAY_MS = 60_000;

let lifecycle;
let reconciliation;
let initialization;
let lifecycleGeneration = 0;
let stopping = false;
const websiteSettingWrites = new Map();
const websiteActions = new Map();

class WebsiteDeliveryError extends Error {
    constructor(cause) {
        super(cause.message, { cause });
    }
}

function configuredGuildId() {
    return String(process.env.GUILDID ?? botIdent().activeBot?.guildId ?? '').trim();
}

function assertWardenGuild(guildId) {
    const configured = configuredGuildId();
    const actual = String(guildId ?? '').trim();
    if (!configured || actual !== configured) {
        const error = new Error('Scheduled event publishing is available only in Warden’s configured server.');
        error.code = 'SCHEDULED_EVENTS_GUILD_MISMATCH';
        throw error;
    }
    return actual;
}

function eventGuildId(event) {
    return String(event?.guildId ?? event?.guild?.id ?? '').trim();
}

async function resolveCreatorDisplayName(event) {
    const creatorId = String(event?.creatorId ?? event?.creator?.id ?? '').trim();
    const members = event?.guild?.members;
    if (!creatorId || !members) return undefined;
    if (typeof members.fetch !== 'function') return undefined;
    try {
        const member = await members.fetch({ user: creatorId, force: true, cache: false });
        return member?.displayName || undefined;
    }
    catch {
        return undefined;
    }
}

async function normalizeWithCreatorDisplayName(event, options) {
    const creatorName = await resolveCreatorDisplayName(event);
    return {
        event: normalizeScheduledEvent(event, { ...options, creatorName }),
        resolvedCreatorName: creatorName,
    };
}

function preserveCreatorDisplayName(normalized, resolvedCreatorName, existing) {
    if (resolvedCreatorName || !existing?.creatorName) return normalized;
    return { ...normalized, creatorName: existing.creatorName };
}

function schedulePublicationSync(event, guildId, reason) {
    if (stopping || !['published', 'delete_pending'].includes(event?.publicationState)) return;
    publisher.requestAutomaticWebsiteSync(guildId, reason);
}

async function handleCreate(event) {
    const guildId = assertWardenGuild(eventGuildId(event));
    const saved = await runGuildMutation(guildId, async () => {
        const resolved = await normalizeWithCreatorDisplayName(event);
        let normalized = resolved.event;
        const existing = await repository.getEvent(guildId, normalized.eventId);
        if (existing?.status === 'Ended') return existing;
        normalized = preserveCreatorDisplayName(normalized, resolved.resolvedCreatorName, existing);
        return repository.upsertEvent(normalized);
    });
    schedulePublicationSync(saved, guildId, 'event created');
    return saved;
}

async function handleUpdate(_oldEvent, newEvent) {
    const guildId = assertWardenGuild(eventGuildId(newEvent));
    const { saved, reason } = await runGuildMutation(guildId, async () => {
        const resolved = await normalizeWithCreatorDisplayName(newEvent);
        let normalized = resolved.event;
        const existing = await repository.getEvent(guildId, normalized.eventId);
        if (existing?.status === 'Ended' && normalized.status !== 'Ended') return { saved: existing };
        try {
            const fresh = await newEvent.client.rest.get(Routes.guildScheduledEvent(guildId, normalized.eventId), {
                query: new URLSearchParams({ with_user_count: 'true' }),
            });
            if (!Number.isSafeInteger(fresh.user_count) || fresh.user_count < 0) {
                throw new Error('Discord returned an invalid scheduled event interested count.');
            }
            normalized = { ...normalized, interestedCount: fresh.user_count };
        }
        catch (error) {
            normalized = { ...normalized, interestedCount: existing?.interestedCount ?? null };
            report.warn('Interested count refresh failed; retaining stored count', error);
        }
        normalized = preserveCreatorDisplayName(normalized, resolved.resolvedCreatorName, existing);
        const detailsChanged = !existing || Object.entries(normalized)
            .some(([field, value]) => field !== 'interestedCount' && existing[field] !== value);
        const next = await repository.upsertEvent(normalized);
        if (next.status === 'Ended' && (!next.publicationState || next.publicationState === 'deleted')) {
            await repository.removeTerminalEvent(guildId, next.eventId);
            return {};
        }
        if (detailsChanged) return { saved: next, reason: 'event updated' };
        if (next.interestedCount !== existing.interestedCount) return { saved: next, reason: 'interest changed' };
        return { saved: next };
    });
    if (reason) schedulePublicationSync(saved, guildId, reason);
    return saved;
}

async function handleDelete(event) {
    const guildId = assertWardenGuild(eventGuildId(event));
    const normalized = normalizeScheduledEvent(event, { terminal: true, terminalReason: 'canceled' });
    const saved = await runGuildMutation(guildId, async () => {
        const existing = await repository.getEvent(guildId, normalized.eventId);
        if (!existing) {
            await repository.upsertEvent(normalized);
            await repository.removeTerminalEvent(guildId, normalized.eventId);
            return undefined;
        }
        return repository.markEventEnded(guildId, normalized.eventId, { reason: normalized.terminalReason });
    });
    schedulePublicationSync(saved, guildId, 'event removed');
    return saved;
}

async function applyInterestedCount(event, delta) {
    const guildId = assertWardenGuild(eventGuildId(event));
    return runGuildMutation(guildId, async () => {
        const normalized = normalizeScheduledEvent(event);
        const existing = await repository.getEvent(guildId, normalized.eventId);
        if (existing?.status === 'Ended') return existing;
        if (!existing) {
            const saved = await repository.upsertEvent(normalized);
            schedulePublicationSync(saved, guildId, 'interest changed');
            return saved;
        }
        const baseCount = Number.isSafeInteger(existing.interestedCount) && existing.interestedCount >= 0
            ? existing.interestedCount
            : Number.isSafeInteger(event?.userCount) && event.userCount >= 0 ? event.userCount : null;
        if (baseCount === null) return existing;
        const interestedCount = Math.max(0, baseCount + delta);
        if (interestedCount === existing.interestedCount) return existing;
        const saved = await repository.upsertEvent({ ...existing, interestedCount });
        schedulePublicationSync(saved, guildId, 'interest changed');
        return saved;
    });
}

function handleUserAdd(event) {
    return applyInterestedCount(event, 1);
}

function handleUserRemove(event) {
    return applyInterestedCount(event, -1);
}

async function reconcile(guild, { reason = 'manual' } = {}) {
    const guildId = assertWardenGuild(guild?.id);
    const result = await runGuildMutation(guildId, async () => {
        const fetched = await guild.scheduledEvents.fetch();
        const saved = [];
        const eventIds = [];
        for (const sourceEvent of fetched.values()) {
            const resolved = await normalizeWithCreatorDisplayName(sourceEvent);
            let event = resolved.event;
            eventIds.push(event.eventId);
            const existing = await repository.getEvent(guildId, event.eventId);
            if (existing?.status === 'Ended' && event.status !== 'Ended') saved.push(existing);
            else {
                event = preserveCreatorDisplayName(event, resolved.resolvedCreatorName, existing);
                saved.push(await repository.upsertEvent(event));
            }
        }
        const terminalized = await repository.markMissingEventsEnded(guildId, eventIds);
        return { saved, terminalized };
    });
    let sync;
    try {
        sync = await requestWebsiteSync(guildId, { reason });
    }
    catch (error) {
        throw new WebsiteDeliveryError(error);
    }
    report.success('Reconciliation completed', {
        reason,
        mirrored: result.saved.length,
        terminalized: result.terminalized.length,
        sync: sync.skipped ?? 'published',
    });
    return { mirrored: result.saved.length, terminalized: result.terminalized.length, sync };
}

function startLifecycle(guild) {
    if (lifecycle) return;
    stopping = false;
    publisher.start();
    lifecycle = {
        guild,
        generation: lifecycleGeneration,
        retryTimer: undefined,
        timer: setInterval(() => {
            void reconcileLifecycle('daily');
        }, DAILY_RECONCILIATION_INTERVAL_MS),
    };
    lifecycle.timer.unref?.();
}

async function reconcileLifecycle(reason) {
    if (!lifecycle || reconciliation) return reconciliation;
    const activeLifecycle = lifecycle;
    reconciliation = reconcile(activeLifecycle.guild, { reason })
        .catch((error) => {
            if (!(error instanceof WebsiteDeliveryError) && lifecycle === activeLifecycle && activeLifecycle.generation === lifecycleGeneration) {
                report.warn('Scheduled reconciliation failed', error, { reason });
                scheduleStartupRetry(activeLifecycle);
            }
            return { failed: true };
        })
        .finally(() => { reconciliation = undefined; });
    return reconciliation;
}

function scheduleStartupRetry(activeLifecycle) {
    if (activeLifecycle.retryTimer || lifecycle !== activeLifecycle) return;
    activeLifecycle.retryTimer = setTimeout(() => {
        activeLifecycle.retryTimer = undefined;
        void reconcileLifecycle('startup retry');
    }, STARTUP_RETRY_DELAY_MS);
    activeLifecycle.retryTimer.unref?.();
}

async function initialize({ guild, guildId } = {}) {
    const normalizedGuildId = assertWardenGuild(guildId ?? guild?.id);
    if (!guild || String(guild.id) !== normalizedGuildId) {
        throw new Error('Scheduled event startup requires Warden’s configured guild.');
    }
    startLifecycle(guild);
    const activeLifecycle = lifecycle;
    if (activeLifecycle.startup) return activeLifecycle.startup;
    const attempt = (async () => {
        await repository.ensureSchema();
        return reconcile(guild, { reason: 'startup' });
    })();
    initialization = attempt;
    activeLifecycle.startup = attempt;
    try {
        return await initialization;
    }
    catch (error) {
        if (!(error instanceof WebsiteDeliveryError) && lifecycle === activeLifecycle && activeLifecycle.generation === lifecycleGeneration) {
            scheduleStartupRetry(activeLifecycle);
        }
        throw error;
    }
    finally {
        if (initialization === attempt) initialization = undefined;
    }
}

async function listCurrentEvents(guildId) {
    return repository.listCurrentEvents(assertWardenGuild(guildId));
}

function isWebsiteSyncPaused(guildId) {
    return repository.isWebsiteSyncPaused(assertWardenGuild(guildId));
}

function setWebsiteSyncPaused(guildId, paused) {
    const key = assertWardenGuild(guildId);
    return enqueueGuildWork(websiteSettingWrites, key, async () => {
        await repository.setWebsiteSyncPaused(key, paused);
        if (paused) publisher.pauseWebsiteSync(key);
    });
}

async function assertWebsiteActionsAvailable(guildId) {
    if (await repository.isWebsiteSyncPaused(guildId)) {
        throw new Error('Website syncing is paused. Enable syncing before publishing or deleting website posts.');
    }
    assertWebsiteConfigured();
}

function changeWebsitePublication(guildId, eventId, mutate, reason) {
    const normalizedGuildId = assertWardenGuild(guildId);
    return enqueueGuildWork(websiteActions, normalizedGuildId, async () => {
        const event = await runGuildMutation(normalizedGuildId, async () => {
            await assertWebsiteActionsAvailable(normalizedGuildId);
            return mutate(normalizedGuildId, eventId);
        });
        const sync = await requestWebsiteSync(normalizedGuildId, { reason });
        assertWebsiteSyncCompleted(sync);
        return { event, sync };
    });
}

async function publishEvent(guildId, eventId) {
    return changeWebsitePublication(guildId, eventId, repository.publishEvent, 'admin publish');
}

async function requestWebsiteDeletion(guildId, eventId) {
    return changeWebsitePublication(guildId, eventId, repository.requestWebsiteDeletion, 'admin delete');
}

function requestWebsiteSync(guildId, options) {
    const normalizedGuildId = assertWardenGuild(guildId);
    if (stopping) return Promise.resolve({ skipped: 'shutdown' });
    return publisher.requestWebsiteSync(normalizedGuildId, options);
}

async function shutdown() {
    stopping = true;
    lifecycleGeneration += 1;
    if (lifecycle?.timer) clearInterval(lifecycle.timer);
    if (lifecycle?.retryTimer) clearTimeout(lifecycle.retryTimer);
    lifecycle = undefined;
    await Promise.allSettled([
        initialization,
        reconciliation,
        publisher.shutdown(),
        drainGuildMutations(),
        ...websiteSettingWrites.values(),
        ...websiteActions.values(),
    ].filter(Boolean));
}

function assertWebsiteConfigured() {
    if (publisher.isWebsiteSyncConfigured()) return;
    const error = new Error('Scheduled event website publishing is not configured. Set AXI_EVENTS_SYNC_URL, AXI_EVENTS_SYNC_KEY_ID, and AXI_EVENTS_SYNC_SECRET.');
    error.code = 'SCHEDULED_EVENTS_WEBSITE_SYNC_UNCONFIGURED';
    throw error;
}

function assertWebsiteSyncCompleted(sync) {
    if (!sync?.skipped) return;
    const error = new Error(`Scheduled event website publishing was skipped (${sync.skipped}). No website change was confirmed.`);
    error.code = 'SCHEDULED_EVENTS_WEBSITE_SYNC_SKIPPED';
    throw error;
}

module.exports = {
    assertWardenGuild,
    assertWebsiteConfigured,
    handleCreate,
    handleDelete,
    handleUpdate,
    handleUserAdd,
    handleUserRemove,
    initialize,
    isWebsiteSyncPaused,
    listCurrentEvents,
    publishEvent,
    reconcile,
    requestWebsiteDeletion,
    requestWebsiteSync,
    runGuildMutation,
    setWebsiteSyncPaused,
    startLifecycle,
    shutdown,
};
