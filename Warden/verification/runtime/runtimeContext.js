'use strict';

const { normalizeGuildId } = require('../domain/identity');

const contexts = new Map();

function validatePublishedInputs(snapshot, imageInventory, configReport) {
    const guildId = normalizeGuildId(snapshot?.guildId ?? snapshot?.runtime?.guildId);
    if (!snapshot?.runtime || String(snapshot.runtime.guildId) !== guildId) {
        throw new TypeError('A complete guild-matched Verification snapshot is required.');
    }
    if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) {
        throw new TypeError('Verification snapshots require a positive generation.');
    }
    if (
        !imageInventory
        || !Array.isArray(imageInventory.images)
        || !(imageInventory.byId instanceof Map)
        || !Number.isSafeInteger(imageInventory.contentRevision)
    ) {
        throw new TypeError('A complete Verification image inventory is required.');
    }
    if (!configReport || !Array.isArray(configReport.activeBlockingIssues)) {
        throw new TypeError('A complete Verification configuration report is required.');
    }
    if (configReport.activeBlockingIssues.length > 0) {
        const error = new Error('Unsafe active Verification configuration cannot be published.');
        error.code = 'VERIFICATION_RUNTIME_CONTEXT_INVALID';
        error.verificationConfigReport = configReport;
        throw error;
    }
    return guildId;
}

function publishVerificationRuntimeContext({ snapshot, imageInventory, configReport, lifecycle } = {}) {
    if (!lifecycle) {
        throw new TypeError('Verification runtime publication requires a guild lifecycle owner.');
    }
    lifecycle.assertCurrent();
    const guildId = validatePublishedInputs(snapshot, imageInventory, configReport);
    if (String(lifecycle.guildId) !== guildId) {
        throw new TypeError('Verification runtime lifecycle ownership must match the snapshot guild.');
    }
    const current = contexts.get(guildId)?.context;
    if (current && snapshot.generation < current.snapshot.generation) {
        const error = new Error('A stale Verification snapshot cannot replace the published runtime.');
        error.code = 'VERIFICATION_RUNTIME_CONTEXT_STALE';
        throw error;
    }
    const context = Object.freeze({
        guildId,
        imageInventory,
        snapshot,
    });
    lifecycle.assertCurrent();
    contexts.set(guildId, {
        context,
        lifecycle,
    });
    return context;
}

function getPublishedVerificationRuntimeContext(guildId) {
    const entry = contexts.get(normalizeGuildId(guildId));
    if (entry?.context && entry.lifecycle.isCurrent()) {
        return entry.context;
    }
    const error = new Error('Verification has not published a ready runtime context yet.');
    error.code = 'VERIFICATION_RUNTIME_NOT_READY';
    throw error;
}

function clearPublishedVerificationRuntimeContext(guildId, lifecycle) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const entry = contexts.get(normalizedGuildId);
    if (!entry) return false;
    if (lifecycle && entry.lifecycle !== lifecycle) return false;
    contexts.delete(normalizedGuildId);
    return true;
}

function clearAllPublishedVerificationRuntimeContexts() {
    contexts.clear();
}

module.exports = {
    clearAllPublishedVerificationRuntimeContexts,
    clearPublishedVerificationRuntimeContext,
    getPublishedVerificationRuntimeContext,
    publishVerificationRuntimeContext,
};
