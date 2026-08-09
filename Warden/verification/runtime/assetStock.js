const crypto = require('crypto');
const path = require('path');
const { buildQuestionScreens } = require('../domain/challenges');
const { getQuestionScreenPresentation } = require('../domain/screenPlan');
const {
    extractQuestionAssetsForStock,
    prepareQuestionAssets,
    releaseQuestionAssetDelivery,
    restoreQuestionAssetsFromStock,
} = require('../assets/screenAssets');
const { getImageGenerationConfig } = require('../assets/config');
const {
    getVerificationImageInventory,
    refreshVerificationImageInventory,
} = require('../assets/image-inventory');
const { getVerificationRenderSupervisorStats } = require('../assets/render-supervisor');
const {
    getVerificationStockInterruptionSignal,
    getVerificationScreenWorkStats,
    runVerificationScreenWork,
} = require('./screen-work-limiter');
const {
    acquireVerificationAttachmentDelivery,
    getVerificationAttachmentDeliveryStats,
} = require('./resource-admission');
const { createVerificationAssetStockStore } = require('./asset-stock-store');
const { getBoundedEnvironmentInteger } = require('./environment');
const { createVerificationLogger } = require('../logging');
const {
    MIB,
    hasWardenMemoryHeadroom,
} = require('../../runtime/memory-admission');

const assetStockLog = createVerificationLogger('Asset stock');

const STOCK_SIGNATURE_VERSION = 2;
const STOCK_INTER_ENTRY_GRACE_MS = 250;
const STOCK_RECHECK_MS = 15_000;
const STOCK_FAILURE_BACKOFF_MAX_MS = 10 * 60_000;
const STOCK_FAILURE_LOG_INTERVAL_MS = 60_000;
const STOCK_DEFAULT_MAX_MIB = 96;
const STOCK_HARD_MAX_MIB = 96;
const STOCK_DEFAULT_MAX_ENTRIES_PER_SIGNATURE = 18;
const STOCK_DEFAULT_REFILL_AT_ENTRIES = 12;
const STOCK_MAX_RSS_BYTES = 256 * 1024 * 1024;
const STOCK_MIN_CONTAINER_HEADROOM_BYTES = 256 * MIB;

function formatMiB(bytes) {
    return (Number(bytes ?? 0) / 1024 / 1024).toFixed(1);
}

const STOCK_MAX_MIB = getBoundedEnvironmentInteger(
    'VERIFICATION_ASSET_STOCK_MAX_MB',
    STOCK_DEFAULT_MAX_MIB,
    8,
    STOCK_HARD_MAX_MIB,
);
const STOCK_MAX_BYTES = STOCK_MAX_MIB * 1024 * 1024;
const STOCK_MAX_ENTRIES_PER_SIGNATURE = getBoundedEnvironmentInteger(
    'VERIFICATION_ASSET_STOCK_MAX_PER_SIGNATURE',
    STOCK_DEFAULT_MAX_ENTRIES_PER_SIGNATURE,
    1,
    18,
);
const STOCK_REFILL_AT_ENTRIES = getBoundedEnvironmentInteger(
    'VERIFICATION_ASSET_STOCK_REFILL_AT',
    Math.min(
        STOCK_DEFAULT_REFILL_AT_ENTRIES,
        Math.max(0, STOCK_MAX_ENTRIES_PER_SIGNATURE - 1),
    ),
    0,
    Math.max(0, STOCK_MAX_ENTRIES_PER_SIGNATURE - 1),
);
const stockParentDirectory = path.resolve(
    process.env.VERIFICATION_ASSET_STOCK_DIR
        || path.join(__dirname, '../../..', 'verificationAssetStock'),
);
const stockStore = createVerificationAssetStockStore({
    rootDirectory: stockParentDirectory,
    maxBytes: STOCK_MAX_BYTES,
});

const guildStates = new Map();
const activeReadPromises = new Set();
const activeCleanupPromises = new Set();
const stockState = {
    requirements: new Map(),
    requirementsFingerprint: '',
    refillSignatures: new Set(),
    availableBySignature: new Map(),
    entriesById: new Map(),
    totalBytes: 0,
    roundRobinCursor: 0,
    revision: 0,
    timer: undefined,
    fillPromise: undefined,
    reconciliationController: new AbortController(),
    recovered: false,
    recoveryPromise: undefined,
    recoveryReport: undefined,
    recoveryResult: undefined,
    lastRecoveryErrorLogAt: 0,
};
let shuttingDown = false;
let shutdownPromise;

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
        const canonicalValue = canonicalize(value[key]);
        if (canonicalValue !== undefined) result[key] = canonicalValue;
        return result;
    }, {});
}

function stableHash(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(value)))
        .digest('hex');
}

function assertBufferFreeStockMetadata(value, seen = new Set()) {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        throw new Error('Verification asset stock metadata retained binary image data.');
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) assertBufferFreeStockMetadata(item, seen);
        return;
    }
    for (const item of Object.values(value)) assertBufferFreeStockMetadata(item, seen);
}

function getScreenStockSignature(screen, inventory = getVerificationImageInventory()) {
    return stableHash({
        stockSignatureVersion: STOCK_SIGNATURE_VERSION,
        imageInventory: {
            directory: inventory.directory,
            images: inventory.images.map((image) => ({
                id: image.id,
                size: image.size,
                contentSha256: image.contentSha256,
            })),
        },
        renderConfig: getImageGenerationConfig(),
        questions: (screen?.questions ?? []).map((question) => {
            const presentation = getQuestionScreenPresentation(question);
            return {
                label: question.label,
                taskType: presentation.taskType,
                gallery: presentation.gallery,
                generatedImage: question.generatedImage,
                answer: {
                    required: question.answer?.required === true,
                    type: question.answer?.type,
                },
            };
        }),
    });
}

function screenNeedsAssetStock(screen) {
    return (screen?.questions ?? []).some((question) => {
        const presentation = getQuestionScreenPresentation(question);
        return presentation.taskType === 'prompt-text'
            || presentation.taskType === 'gallery-rotation-alignment'
            || (
                presentation.gallery
                && question.generatedImage?.compositeImageGallery === true
            );
    });
}

function buildGuildStockRequirements(runtime, imageInventory = getVerificationImageInventory()) {
    const requirements = new Map();
    if (runtime?.mode !== 'challenge') return requirements;
    for (const challenge of runtime.activeChallenges ?? []) {
        for (const screen of buildQuestionScreens(challenge)) {
            if (!screenNeedsAssetStock(screen)) continue;
            const signature = getScreenStockSignature(screen, imageInventory);
            const existing = requirements.get(signature);
            if (existing) continue;
            requirements.set(signature, {
                signature,
                challengeId: challenge.id,
                screen,
                imageInventory,
            });
        }
    }
    return requirements;
}

function getGuildState(guildId, create = true) {
    const normalizedGuildId = String(guildId ?? '').trim();
    if (!normalizedGuildId) return undefined;
    let state = guildStates.get(normalizedGuildId);
    if (!state && create) {
        state = {
            guildId: normalizedGuildId,
            requirements: new Map(),
        };
        guildStates.set(normalizedGuildId, state);
    }
    return state;
}

function buildProcessRequirements() {
    const requirements = new Map();
    for (const state of guildStates.values()) {
        for (const guildRequirement of state.requirements.values()) {
            const existing = requirements.get(guildRequirement.signature);
            if (existing) {
                existing.guildIds.add(state.guildId);
                continue;
            }
            const previous = stockState.requirements.get(guildRequirement.signature);
            requirements.set(guildRequirement.signature, {
                ...guildRequirement,
                guildIds: new Set([state.guildId]),
                consecutiveFailures: previous?.consecutiveFailures ?? 0,
                retryAfterMs: previous?.retryAfterMs,
                lastFailureLogAt: previous?.lastFailureLogAt ?? 0,
            });
        }
    }
    return requirements;
}

function requirementFingerprint(requirements) {
    return [...requirements.keys()].sort().join('\n');
}

function getAvailableEntries(signature, create = false) {
    let entries = stockState.availableBySignature.get(signature);
    if (!entries && create) {
        entries = [];
        stockState.availableBySignature.set(signature, entries);
    }
    return entries;
}

function getAvailableEntryCount(signature) {
    return getAvailableEntries(signature)?.length ?? 0;
}

function getAvailableItemCount() {
    return [...stockState.availableBySignature.values()]
        .reduce((total, entries) => total + entries.length, 0);
}

function reconcileRefillSignatures() {
    if (!stockState.recovered) return;
    for (const signature of stockState.refillSignatures) {
        if (
            !stockState.requirements.has(signature)
            || getAvailableEntryCount(signature) >= STOCK_MAX_ENTRIES_PER_SIGNATURE
        ) stockState.refillSignatures.delete(signature);
    }
    for (const signature of stockState.requirements.keys()) {
        if (getAvailableEntryCount(signature) <= STOCK_REFILL_AT_ENTRIES) {
            stockState.refillSignatures.add(signature);
        }
    }
}

function requestRefillIfLow(signature) {
    if (
        !stockState.requirements.has(signature)
        || getAvailableEntryCount(signature) > STOCK_REFILL_AT_ENTRIES
    ) return false;
    const previousSize = stockState.refillSignatures.size;
    stockState.refillSignatures.add(signature);
    return stockState.refillSignatures.size !== previousSize;
}

function addAvailableEntry(entry) {
    if (stockState.entriesById.has(entry.id)) {
        throw new Error(`Verification asset stock entry ${entry.id} is already registered.`);
    }
    entry.stockLifecycle = 'available';
    entry.lastUsedAt = Number(entry.lastUsedAt ?? entry.createdAt ?? Date.now());
    stockState.entriesById.set(entry.id, entry);
    stockState.totalBytes += Number(entry.totalBytes ?? 0);
    const entries = getAvailableEntries(entry.signature, true);
    entries.push(entry);
    entries.sort((left, right) =>
        Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0));
}

function removeAvailableEntry(entry) {
    const entries = getAvailableEntries(entry.signature);
    const index = entries?.indexOf(entry) ?? -1;
    if (index < 0) return false;
    entries.splice(index, 1);
    if (entries.length < 1) stockState.availableBySignature.delete(entry.signature);
    return true;
}

function trackPromise(set, promise) {
    set.add(promise);
    void promise.then(
        () => set.delete(promise),
        () => set.delete(promise),
    );
    return promise;
}

function finalizeEntryRemoval(entry) {
    if (stockState.entriesById.get(entry.id) !== entry) return;
    stockState.entriesById.delete(entry.id);
    stockState.totalBytes = Math.max(
        0,
        stockState.totalBytes - Number(entry.totalBytes ?? 0),
    );
    entry.stockLifecycle = 'removed';
    entry.deletePromise = undefined;
}

function scheduleEntryRemoval(entry, { logFailure = true } = {}) {
    if (!entry || entry.stockLifecycle === 'removed') return Promise.resolve(true);
    removeAvailableEntry(entry);
    if (entry.deletePromise) return entry.deletePromise;
    entry.stockLifecycle = 'retired';
    const deletion = (async () => {
        try {
            await stockStore.remove(entry);
            finalizeEntryRemoval(entry);
            return true;
        }
        catch (error) {
            entry.stockLifecycle = 'retired';
            entry.deletePromise = undefined;
            if (logFailure) {
                assetStockLog.warn('Failed to delete a retired entry:', error);
            }
            return false;
        }
        finally {
            scheduleFill();
        }
    })();
    entry.deletePromise = deletion;
    return trackPromise(activeCleanupPromises, deletion);
}

async function cleanupRetiredEntries() {
    const retired = [...stockState.entriesById.values()]
        .filter((entry) => entry.stockLifecycle === 'retired');
    if (retired.length < 1) return;
    await Promise.all(retired.map((entry) => scheduleEntryRemoval(entry)));
}

function retireUnrequiredEntries() {
    const retired = [];
    for (const [signature, entries] of stockState.availableBySignature) {
        if (stockState.requirements.has(signature)) continue;
        for (const entry of [...entries]) {
            retired.push(entry);
            void scheduleEntryRemoval(entry);
        }
    }
    return {
        items: retired.length,
        bytes: retired.reduce((total, entry) => total + Number(entry.totalBytes ?? 0), 0),
        signatures: new Set(retired.map((entry) => entry.signature)).size,
    };
}

function reportConfigurationStockDrop(incompatible) {
    if (incompatible.items < 1) return;
    assetStockLog.neutral('Dropped stock invalidated by configuration changes', {
        entries: incompatible.items,
        signatures: incompatible.signatures,
        sizeMiB: Number(formatMiB(incompatible.bytes)),
        at: new Date(),
    });
}

function replaceProcessRequirements(requirements) {
    const fingerprint = requirementFingerprint(requirements);
    const changed = fingerprint !== stockState.requirementsFingerprint;
    stockState.requirements = requirements;
    stockState.requirementsFingerprint = fingerprint;
    if (changed) {
        stockState.revision += 1;
        stockState.roundRobinCursor = 0;
        stockState.reconciliationController.abort(Object.assign(
            new Error('Verification asset stock requirements changed.'),
            {
                name: 'AbortError',
                code: 'VERIFICATION_ASSET_STOCK_RECONCILED',
                interruptedBy: 'configuration change',
            },
        ));
        stockState.reconciliationController = new AbortController();
    }
    const incompatible = stockState.recovered
        ? retireUnrequiredEntries()
        : { items: 0, bytes: 0, signatures: 0 };
    reconcileRefillSignatures();
    scheduleFill();
    return { changed, incompatible };
}

function logRecoveryFailure(error) {
    const now = Date.now();
    if (now - stockState.lastRecoveryErrorLogAt < STOCK_FAILURE_LOG_INTERVAL_MS) return;
    stockState.lastRecoveryErrorLogAt = now;
    assetStockLog.warn(
        'Asset stock recovery is unavailable; live rendering remains active:',
        error,
    );
}

async function recoverPersistedStock() {
    if (stockState.recovered) return stockState.recoveryReport;
    if (stockState.recoveryPromise) return stockState.recoveryPromise;
    const attempt = (async () => {
        const recoveredEntries = await stockStore.initialize();
        const report = {
            validatedItems: recoveredEntries.length,
            validatedBytes: recoveredEntries.reduce(
                (total, entry) => total + Number(entry.totalBytes ?? 0),
                0,
            ),
            overSignatureCapItems: 0,
            overSignatureCapBytes: 0,
        };
        const counts = new Map();
        for (const entry of recoveredEntries) {
            if (stockState.entriesById.has(entry.id)) continue;
            const count = counts.get(entry.signature) ?? 0;
            addAvailableEntry(entry);
            if (count >= STOCK_MAX_ENTRIES_PER_SIGNATURE) {
                report.overSignatureCapItems += 1;
                report.overSignatureCapBytes += Number(entry.totalBytes ?? 0);
                void scheduleEntryRemoval(entry);
                continue;
            }
            counts.set(entry.signature, count + 1);
        }
        stockState.recovered = true;
        stockState.recoveryReport = Object.freeze(report);
        stockState.lastRecoveryErrorLogAt = 0;
        return stockState.recoveryReport;
    })();
    stockState.recoveryPromise = attempt;
    try {
        return await attempt;
    }
    catch (error) {
        if (stockState.recoveryPromise === attempt) stockState.recoveryPromise = undefined;
        throw error;
    }
    finally {
        if (stockState.recovered && stockState.recoveryPromise === attempt) {
            stockState.recoveryPromise = undefined;
        }
    }
}

function buildRecoveryResult(report, incompatible) {
    if (!report) return undefined;
    if (stockState.recoveryResult) return stockState.recoveryResult;
    const retainedItems = getAvailableItemCount();
    const retainedBytes = [...stockState.availableBySignature.values()]
        .flat()
        .reduce((total, entry) => total + Number(entry.totalBytes ?? 0), 0);
    const discardedItems = incompatible.items + report.overSignatureCapItems;
    const discardedBytes = incompatible.bytes + report.overSignatureCapBytes;
    const recovery = Object.freeze({
        validatedItems: report.validatedItems,
        validatedBytes: report.validatedBytes,
        retainedItems,
        retainedBytes,
        incompatibleItems: incompatible.items,
        incompatibleBytes: incompatible.bytes,
        incompatibleSignatures: incompatible.signatures,
        overSignatureCapItems: report.overSignatureCapItems,
        overSignatureCapBytes: report.overSignatureCapBytes,
        discardedItems,
        discardedBytes,
        signatureVersion: STOCK_SIGNATURE_VERSION,
    });
    stockState.recoveryResult = recovery;
    return recovery;
}

function getRequirementsInRoundRobinOrder() {
    const requirements = [...stockState.requirements.values()]
        .sort((left, right) => left.signature.localeCompare(right.signature));
    if (requirements.length < 1) return [];
    const start = stockState.roundRobinCursor % requirements.length;
    return [
        ...requirements.slice(start),
        ...requirements.slice(0, start),
    ];
}

function chooseFillRequirement() {
    const ordered = getRequirementsInRoundRobinOrder();
    if (ordered.length < 1) return undefined;
    const now = Date.now();
    for (const requirement of ordered) {
        if (!stockState.refillSignatures.has(requirement.signature)) continue;
        if (getAvailableEntryCount(requirement.signature) >= STOCK_MAX_ENTRIES_PER_SIGNATURE) {
            stockState.refillSignatures.delete(requirement.signature);
            continue;
        }
        if ((requirement.retryAfterMs ?? 0) > now) continue;
        const index = [...stockState.requirements.keys()]
            .sort()
            .indexOf(requirement.signature);
        stockState.roundRobinCursor = index + 1;
        return requirement;
    }
    return undefined;
}

function getNextRequirementRetryDelay() {
    const now = Date.now();
    const retryTimes = [...stockState.requirements.values()]
        .filter((requirement) =>
            stockState.refillSignatures.has(requirement.signature)
            && getAvailableEntryCount(requirement.signature) < STOCK_MAX_ENTRIES_PER_SIGNATURE)
        .map((requirement) => requirement.retryAfterMs)
        .filter((retryAfterMs) => Number.isFinite(retryAfterMs) && retryAfterMs > now);
    if (retryTimes.length < 1) return undefined;
    return Math.max(1, Math.min(...retryTimes) - now);
}

function hasEligibleFillRequirement() {
    const now = Date.now();
    return [...stockState.requirements.values()].some((requirement) =>
        stockState.refillSignatures.has(requirement.signature)
        && getAvailableEntryCount(requirement.signature) < STOCK_MAX_ENTRIES_PER_SIGNATURE
        && (requirement.retryAfterMs ?? 0) <= now);
}

function recordRequirementFailure(signature, error) {
    const requirement = stockState.requirements.get(signature);
    if (!requirement) return;
    requirement.consecutiveFailures = (requirement.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(
        STOCK_FAILURE_BACKOFF_MAX_MS,
        STOCK_RECHECK_MS * (2 ** Math.min(requirement.consecutiveFailures - 1, 5)),
    );
    requirement.retryAfterMs = Date.now() + backoffMs;
    const now = Date.now();
    if (now - (requirement.lastFailureLogAt ?? 0) >= STOCK_FAILURE_LOG_INTERVAL_MS) {
        requirement.lastFailureLogAt = now;
        assetStockLog.warn('Fill failed', error, { signature });
    }
}

function resetRequirementFailure(requirement) {
    requirement.consecutiveFailures = 0;
    requirement.retryAfterMs = undefined;
}

function isExpectedStockAbort(error) {
    return error?.name === 'AbortError'
        || error?.code === 'VERIFICATION_SCREEN_WORK_ABORTED'
        || error?.code === 'VERIFICATION_ASSET_STOCK_ABORTED'
        || error?.code === 'VERIFICATION_ASSET_STOCK_RECONCILED';
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw getStockAbortReason(signal);
}

function getStockAbortReason(signal) {
    return signal?.reason ?? Object.assign(
        new Error('Verification asset stock preparation was cancelled.'),
        { name: 'AbortError', code: 'VERIFICATION_ASSET_STOCK_ABORTED' },
    );
}

function createPreparedEntryDraft(requirement, preparedAssets) {
    const extracted = extractQuestionAssetsForStock(requirement.screen, preparedAssets);
    const totalBytes = extracted.deliveries.reduce(
        (total, record) => total + Number(record.buffer?.length ?? 0),
        0,
    );
    if (totalBytes < 1) {
        for (const record of extracted.deliveries) record.buffer = undefined;
        throw new Error('Verification asset stock preparation produced no attachment bytes.');
    }
    assertBufferFreeStockMetadata(extracted.assets);
    return {
        id: crypto.randomUUID(),
        signature: requirement.signature,
        assets: extracted.assets,
        deliveries: extracted.deliveries,
        files: [],
        totalBytes,
        directory: undefined,
        createdAt: Date.now(),
        stockLifecycle: 'pending',
    };
}

function releaseEntryDraft(entry) {
    for (const record of entry?.deliveries ?? []) record.buffer = undefined;
    if (entry) entry.deliveries = undefined;
}

function getOldestEvictableEntry(targetSignature) {
    // Evict only surplus coverage from another signature. Replacing the sole
    // entry for A with the sole entry for B would make the round-robin filler
    // churn forever when the byte ceiling cannot hold both.
    return [...stockState.availableBySignature.values()]
        .flat()
        .filter((entry) =>
            entry.signature !== targetSignature
            && (
                !stockState.requirements.has(entry.signature)
                || getAvailableEntryCount(entry.signature) > 1
            ))
        .sort((left, right) =>
            Number(left.lastUsedAt ?? left.createdAt ?? 0)
            - Number(right.lastUsedAt ?? right.createdAt ?? 0))[0];
}

async function makeRoomForEntry(entryBytes, targetSignature) {
    if (entryBytes > STOCK_MAX_BYTES) return false;
    while (stockState.totalBytes + entryBytes > STOCK_MAX_BYTES) {
        const oldest = getOldestEvictableEntry(targetSignature);
        if (!oldest) return false;
        if (!await scheduleEntryRemoval(oldest)) return false;
    }
    return true;
}

async function prepareStockEntryDraft(requirement, expectedRevision) {
    let releaseAttachment;
    let preparedAssets;
    try {
        const draft = await runVerificationScreenWork(async ({ signal: queueSignal }) => {
            const signal = AbortSignal.any([
                queueSignal,
                stockState.reconciliationController.signal,
            ]);
            throwIfAborted(signal);
            releaseAttachment = await acquireVerificationAttachmentDelivery({
                priority: 'stock',
                signal,
                label: `Pre-generating verification asset stock for ${requirement.challengeId}`,
            });
            try {
                preparedAssets = await prepareQuestionAssets(
                    requirement.screen,
                    requirement.challengeId,
                    {
                        priority: 'stock',
                        signal,
                        imageInventory: requirement.imageInventory,
                    },
                );
                throwIfAborted(signal);
                const draft = createPreparedEntryDraft(requirement, preparedAssets);
                preparedAssets = undefined;
                if (
                    shuttingDown
                    || stockState.revision !== expectedRevision
                    || !stockState.requirements.has(draft.signature)
                ) {
                    releaseEntryDraft(draft);
                    return undefined;
                }
                return draft;
            }
            catch (error) {
                releaseAttachment?.();
                releaseAttachment = undefined;
                throw error;
            }
            finally {
                if (preparedAssets) releaseQuestionAssetDelivery(preparedAssets);
            }
        }, {
            priority: 'stock',
            timeoutMs: 2 * 60 * 1000,
            label: `Pre-generating verification asset stock for ${requirement.challengeId}`,
        });
        if (!draft) {
            releaseAttachment?.();
            return undefined;
        }
        return { draft, releaseAttachment };
    }
    catch (error) {
        releaseAttachment?.();
        throw error;
    }
}

async function fillOneStockEntry(requirement) {
    const expectedRevision = stockState.revision;
    let draft;
    let releaseAttachment;
    try {
        const prepared = await prepareStockEntryDraft(requirement, expectedRevision);
        if (!prepared) return undefined;
        ({ draft, releaseAttachment } = prepared);
        if (
            shuttingDown
            || stockState.revision !== expectedRevision
            || !stockState.requirements.has(draft.signature)
        ) return undefined;
        if (!await makeRoomForEntry(draft.totalBytes, draft.signature)) {
            const error = new Error(
                'Verification asset stock has no evictable capacity for this entry.',
            );
            error.code = 'VERIFICATION_ASSET_STOCK_CAPACITY';
            throw error;
        }
        throwIfAborted(stockState.reconciliationController.signal);
        await stockStore.persist(draft, stockState.reconciliationController.signal);
        if (
            shuttingDown
            || stockState.revision !== expectedRevision
            || !stockState.requirements.has(draft.signature)
        ) {
            await stockStore.remove(draft);
            return undefined;
        }
        addAvailableEntry(draft);
        resetRequirementFailure(stockState.requirements.get(draft.signature));
        return draft;
    }
    catch (error) {
        error.stockSignature = requirement.signature;
        throw error;
    }
    finally {
        releaseEntryDraft(draft);
        releaseAttachment?.();
    }
}

function canRunBackgroundStock() {
    const screenStats = getVerificationScreenWorkStats();
    const renderStats = getVerificationRenderSupervisorStats();
    const attachmentStats = getVerificationAttachmentDeliveryStats();
    return screenStats.active === 0
        && screenStats.queued === 0
        && Number(screenStats.maintenanceActive ?? 0) === 0
        && Number(screenStats.maintenanceQueued ?? 0) === 0
        && Number(screenStats.speculativeDelayMs ?? 0) <= 0
        && Number(screenStats.stockSuspendedMs ?? 0) <= 0
        && renderStats.active === 0
        && attachmentStats.active === 0
        && attachmentStats.queued === 0
        && hasWardenMemoryHeadroom(STOCK_MIN_CONTAINER_HEADROOM_BYTES, {
            fallbackMaxRssBytes: STOCK_MAX_RSS_BYTES,
        });
}

function yieldStockSessionTurn(signal) {
    return new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
        };
        const abort = () => {
            clearTimeout(timer);
            reject(getStockAbortReason(signal));
        };
        const timer = setTimeout(finish, STOCK_INTER_ENTRY_GRACE_MS);
        timer.unref?.();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
    });
}

function reportStockFillSession(session, status, interruptedBy) {
    if (!session || session.entriesCreated < 1) return;
    const data = {
        status,
        ...(status === 'interrupted' && interruptedBy ? { interruptedBy } : {}),
        createdEntries: session.entriesCreated,
        createdMiB: Number(formatMiB(session.bytesCreated)),
        durationMs: Date.now() - session.startedAt,
        poolEntries: getAvailableItemCount(),
        poolMiB: Number(formatMiB(stockState.totalBytes)),
        limitMiB: STOCK_MAX_MIB,
        completedAt: new Date(),
    };
    if (status === 'complete') assetStockLog.complete('Fill completed', data);
    else assetStockLog.success('Fill progress retained', data);
}

async function runStockFillSession() {
    if (!canRunBackgroundStock()) return { status: 'waiting' };
    await recoverPersistedStock();
    reconcileRefillSignatures();
    await cleanupRetiredEntries();
    if (!canRunBackgroundStock()) return { status: 'waiting' };
    const sessionSignal = AbortSignal.any([
        getVerificationStockInterruptionSignal(),
        stockState.reconciliationController.signal,
    ]);
    const session = {
        startedAt: Date.now(),
        entriesCreated: 0,
        bytesCreated: 0,
    };
    const interrupted = (error) => ({
        status: shuttingDown ? 'shutdown' : 'interrupted',
        interruptedBy: error.interruptedBy ?? 'foreground work',
        delayMs: STOCK_RECHECK_MS,
        session,
    });
    while (!shuttingDown && canRunBackgroundStock()) {
        const requirement = chooseFillRequirement();
        if (!requirement) break;
        try {
            const entry = await fillOneStockEntry(requirement);
            if (entry) {
                session.entriesCreated += 1;
                session.bytesCreated += Number(entry.totalBytes ?? 0);
            }
            else break;
        }
        catch (error) {
            if (isExpectedStockAbort(error)) return interrupted(error);
            recordRequirementFailure(error.stockSignature, error);
        }
        try {
            await yieldStockSessionTurn(sessionSignal);
            throwIfAborted(sessionSignal);
        }
        catch (error) {
            if (isExpectedStockAbort(error)) return interrupted(error);
            throw error;
        }
    }
    if (shuttingDown) return { status: 'shutdown', session };
    if (!canRunBackgroundStock()) return { status: 'waiting', session };
    if (chooseFillRequirement()) return { status: 'backoff', session };
    const retryDelay = getNextRequirementRetryDelay();
    if (retryDelay !== undefined) {
        return { status: 'backoff', delayMs: retryDelay, session };
    }
    return { status: 'complete', session };
}

function scheduleFill(delayMs = STOCK_RECHECK_MS) {
    if (shuttingDown || stockState.timer || stockState.fillPromise) return;
    reconcileRefillSignatures();
    const hasMaintenance = [...stockState.entriesById.values()]
        .some((entry) => entry.stockLifecycle === 'retired');
    const needsRecovery = !stockState.recovered && stockState.requirements.size > 0;
    if (stockState.refillSignatures.size < 1 && !hasMaintenance && !needsRecovery) return;
    const retryDelay = getNextRequirementRetryDelay();
    if (!hasEligibleFillRequirement() && retryDelay !== undefined) {
        delayMs = Math.max(delayMs, retryDelay);
    }
    stockState.timer = setTimeout(() => {
        stockState.timer = undefined;
        const fillPromise = runStockFillSession();
        stockState.fillPromise = fillPromise;
        void fillPromise.then(
            (outcome) => {
                if (stockState.fillPromise === fillPromise) stockState.fillPromise = undefined;
                reportStockFillSession(
                    outcome.session,
                    outcome.status,
                    outcome.interruptedBy,
                );
                if (
                    shuttingDown
                    || outcome.status === 'shutdown'
                ) return;
                scheduleFill(
                    outcome.delayMs
                    ?? (outcome.status === 'waiting' ? STOCK_RECHECK_MS : 0),
                );
            },
            (error) => {
                if (stockState.fillPromise === fillPromise) stockState.fillPromise = undefined;
                if (!isExpectedStockAbort(error)) logRecoveryFailure(error);
                if (!shuttingDown) scheduleFill();
            },
        );
    }, Math.max(0, delayMs));
    stockState.timer.unref?.();
}

async function reconcileVerificationAssetStock({
    guildId,
    runtime,
    imageInventory,
} = {}) {
    if (shuttingDown) return { stopped: true };
    const state = getGuildState(guildId ?? runtime?.guildId);
    if (!state) return { skipped: true };
    try {
        const inventory = imageInventory ?? await refreshVerificationImageInventory();
        state.imageInventory = inventory;
        state.requirements = buildGuildStockRequirements(runtime, inventory);
        const replacement = replaceProcessRequirements(buildProcessRequirements());
        const recoveryReport = await recoverPersistedStock();
        const postRecoveryIncompatible = retireUnrequiredEntries();
        const incompatible = {
            items: replacement.incompatible.items + postRecoveryIncompatible.items,
            bytes: replacement.incompatible.bytes + postRecoveryIncompatible.bytes,
            signatures: replacement.incompatible.signatures
                + postRecoveryIncompatible.signatures,
        };
        reportConfigurationStockDrop(incompatible);
        const recovery = buildRecoveryResult(recoveryReport, incompatible);
        scheduleFill();
        return Object.freeze({
            ...getVerificationAssetStockStats(state.guildId),
            recovery,
        });
    }
    catch (error) {
        logRecoveryFailure(error);
        scheduleFill();
        return Object.freeze({
            ...getVerificationAssetStockStats(state.guildId),
            recoveryUnavailable: true,
            recoveryErrorCode: error?.code,
        });
    }
}

async function removeVerificationAssetStockGuild(guildId) {
    const normalizedGuildId = String(guildId ?? '').trim();
    if (!normalizedGuildId || !guildStates.delete(normalizedGuildId)) return false;
    replaceProcessRequirements(buildProcessRequirements());
    return true;
}

function reserveVerificationAssetStock({ guildId, screen, imageInventory } = {}) {
    if (shuttingDown || !screenNeedsAssetStock(screen)) return undefined;
    const state = getGuildState(guildId, false);
    if (!state) return undefined;
    const signature = getScreenStockSignature(
        screen,
        imageInventory ?? state.imageInventory,
    );
    if (!state.requirements.has(signature)) return undefined;
    const entries = getAvailableEntries(signature);
    const entry = entries?.shift();
    if (!entry) {
        requestRefillIfLow(signature);
        scheduleFill();
        return undefined;
    }
    if (entries.length < 1) stockState.availableBySignature.delete(signature);
    entry.stockLifecycle = 'reserved';
    entry.lastUsedAt = Date.now();
    if (requestRefillIfLow(signature)) scheduleFill(0);
    return { entry, screen, settled: false };
}

function consumeVerificationAssetStockReservation(reservation) {
    if (!reservation?.entry || reservation.settled) return undefined;
    reservation.settled = true;
    const { entry, screen } = reservation;
    const read = (async () => {
        try {
            if (shuttingDown) return undefined;
            const deliveries = await stockStore.readDeliveries(entry);
            return restoreQuestionAssetsFromStock(screen, entry.assets, deliveries);
        }
        catch (error) {
            assetStockLog.warn(
                'Asset stock checkout failed; falling back to live rendering:',
                error,
            );
            return undefined;
        }
        finally {
            void scheduleEntryRemoval(entry);
        }
    })();
    return trackPromise(activeReadPromises, read);
}

function discardVerificationAssetStockReservation(reservation) {
    if (!reservation?.entry || reservation.settled) return false;
    reservation.settled = true;
    void scheduleEntryRemoval(reservation.entry);
    return true;
}

function decideVerificationAssetDelivery({ guildId, screen, imageInventory } = {}) {
    if (!screenNeedsAssetStock(screen)) {
        return Object.freeze({
            mode: 'immediate',
            reason: 'screen-does-not-require-heavy-assets',
        });
    }
    const reservation = reserveVerificationAssetStock({ guildId, screen, imageInventory });
    return Object.freeze({
        mode: reservation ? 'immediate' : 'queued',
        reason: reservation ? 'asset-stock-reserved' : 'asset-stock-unavailable',
        reservation,
    });
}

function getVerificationAssetStockStats(guildId) {
    const state = getGuildState(guildId, false);
    const guildSignatures = new Set(state?.requirements.keys() ?? []);
    const entriesPerSignature = [...guildSignatures]
        .map((signature) => getAvailableEntryCount(signature));
    const availableEntries = [...guildSignatures]
        .flatMap((signature) => getAvailableEntries(signature) ?? []);
    const result = {
        signatures: state?.requirements.size ?? 0,
        stockedSignatures: [...guildSignatures]
            .filter((signature) => getAvailableEntryCount(signature) > 0).length,
        items: availableEntries.length,
        bytes: availableEntries.reduce(
            (total, entry) => total + Number(entry.totalBytes ?? 0),
            0,
        ),
        processItems: stockState.entriesById.size,
        processBytes: stockState.totalBytes,
        maxBytes: STOCK_MAX_BYTES,
        maxMiB: STOCK_MAX_MIB,
        maxEntriesPerSignature: STOCK_MAX_ENTRIES_PER_SIGNATURE,
        refillAtEntriesPerSignature: STOCK_REFILL_AT_ENTRIES,
        refillPendingSignatures: [...guildSignatures]
            .filter((signature) => stockState.refillSignatures.has(signature)).length,
        entriesPerSignature: Object.freeze(entriesPerSignature),
        directory: stockParentDirectory,
        filling: Boolean(stockState.fillPromise),
        recovered: stockState.recovered,
    };
    if (state) {
        result.screenWork = getVerificationScreenWorkStats();
        result.attachmentWork = getVerificationAttachmentDeliveryStats();
        result.renderer = getVerificationRenderSupervisorStats();
        result.memory = process.memoryUsage();
    }
    return Object.freeze(result);
}

async function performVerificationAssetStockShutdown() {
    shuttingDown = true;
    if (stockState.timer) clearTimeout(stockState.timer);
    stockState.timer = undefined;
    stockState.reconciliationController.abort(Object.assign(
        new Error('Verification asset stock is shutting down.'),
        {
            name: 'AbortError',
            code: 'VERIFICATION_ASSET_STOCK_SHUTDOWN',
            interruptedBy: 'shutdown',
        },
    ));
    if (stockState.fillPromise) await Promise.allSettled([stockState.fillPromise]);
    if (activeReadPromises.size > 0) {
        await Promise.allSettled([...activeReadPromises]);
    }
    const nonAvailableEntries = [...stockState.entriesById.values()]
        .filter((entry) => entry.stockLifecycle !== 'available');
    await Promise.allSettled(nonAvailableEntries.map((entry) => scheduleEntryRemoval(entry)));
    if (activeCleanupPromises.size > 0) {
        await Promise.allSettled([...activeCleanupPromises]);
    }
    guildStates.clear();
    stockState.requirements.clear();
    stockState.refillSignatures.clear();
    stockState.availableBySignature.clear();
    stockState.entriesById.clear();
    stockState.totalBytes = 0;
}

function shutdownVerificationAssetStock() {
    shutdownPromise ??= performVerificationAssetStockShutdown();
    return shutdownPromise;
}

module.exports = {
    consumeVerificationAssetStockReservation,
    decideVerificationAssetDelivery,
    discardVerificationAssetStockReservation,
    getVerificationAssetStockStats,
    reconcileVerificationAssetStock,
    removeVerificationAssetStockGuild,
    screenNeedsAssetStock,
    shutdownVerificationAssetStock,
};
