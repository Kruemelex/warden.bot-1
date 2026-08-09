const Discord = require('discord.js');
const { botLog } = require('../../functions');
const {
    createVerificationLogger,
    logVerificationStartupStatus,
} = require('./logging');
const { reportVerificationError } = require('./errorLogging');
const {
    ensureVerificationDataSchema,
    ensureVerificationGuildSettings,
    initializeVerificationRuntimeContext,
    synchronizeVerificationCatalog,
    verifyVerificationDatabaseConnection,
} = require('./service');
const { refreshVerificationImageInventory } = require('./assets/image-inventory');
const { shutdownVerificationRenderSupervisor } = require('./assets/render-supervisor');
const {
    reconcileVerificationAssetStock,
    removeVerificationAssetStockGuild,
    shutdownVerificationAssetStock,
} = require('./runtime/assetStock');
const {
    initializeVerificationAutokick,
    shutdownVerificationAutokick,
} = require('./runtime/autokickEngine');
const {
    beginVerificationGuildLifecycle,
    disposeAllVerificationGuildLifecycles,
    disposeVerificationGuildLifecycle,
} = require('./runtime/guildLifecycle');
const {
    clearAllPublishedVerificationRuntimeContexts,
    clearPublishedVerificationRuntimeContext,
} = require('./runtime/runtimeContext');
const {
    startVerificationRuntimeRefreshWorker,
} = require('./runtime/runtimeRefreshWorker');
const {
    initializeVerificationPostReconciler,
    scheduleVerificationPostReconciliation,
} = require('./runtime/postReconciler');
const { shutdownVerificationPreviews } = require('./runtime/previewFlow');

const STARTUP_RETRY_DELAY_MS = 1_000;
const TRANSIENT_STARTUP_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_SEQUENCE_TIMEOUT',
    'ER_LOCK_DEADLOCK',
    'ER_LOCK_WAIT_TIMEOUT',
    'WARDEN_DB_ACQUIRE_TIMEOUT',
    'VERIFICATION_SNAPSHOT_TIMEOUT',
]);

let verificationShutdownPromise;
const initializationByGuild = new Map();
const startupLog = createVerificationLogger('Startup');

function formatMiB(bytes) {
    return (Number(bytes ?? 0) / 1024 / 1024).toFixed(1);
}

function logVerificationFeatureLoading(botName) {
    logVerificationStartupStatus(botName, 'Loading Verification Feature', '🕗');
}

function logVerificationFeatureSuccess(botName) {
    logVerificationStartupStatus(botName, 'Verification Feature', '✅');
}

function annotateStartupError(stage, error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    normalizedError.verificationStartupStage ??= stage;
    return normalizedError;
}

function logVerificationFeatureFailure(botName, error) {
    const stage = error?.verificationStartupStage ?? 'startup';
    startupLog.error(`${stage} failed.`, error);
    logVerificationStartupStatus(botName, 'Verification Feature', '❌', { failed: true });
}

function isTransientStartupError(error) {
    for (let current = error; current; current = current.cause) {
        if (TRANSIENT_STARTUP_ERROR_CODES.has(String(current?.code ?? ''))) return true;
    }
    return false;
}

function delay(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function runVerificationStartupStep(stage, work, { retryTransient = false } = {}) {
    try {
        return await work();
    }
    catch (firstError) {
        if (!retryTransient || !isTransientStartupError(firstError)) {
            throw annotateStartupError(stage, firstError);
        }
        await delay(STARTUP_RETRY_DELAY_MS);
        try {
            return await work();
        }
        catch (retryError) {
            if (retryError !== firstError && retryError.cause === undefined) {
                retryError.cause = firstError;
            }
            throw annotateStartupError(stage, retryError);
        }
    }
}

function getEntriesPerSignature(stock) {
    const counts = stock?.entriesPerSignature ?? [];
    if (counts.length < 1) {
        return { minimum: 0, maximum: 0, limit: stock?.maxEntriesPerSignature ?? 0 };
    }
    const minimum = Math.min(...counts);
    const maximum = Math.max(...counts);
    return { minimum, maximum, limit: stock.maxEntriesPerSignature };
}

function logAssetStockStartup(stock) {
    if (!stock) return;
    const recovery = stock.recovery ?? {};
    const targetItems = stock.signatures * stock.maxEntriesPerSignature;
    const foundItems = recovery.validatedItems ?? stock.items;
    const foundTargetItems = Math.max(targetItems, foundItems);
    const foundBytes = recovery.validatedBytes ?? stock.bytes;
    const retainedItems = recovery.retainedItems ?? stock.items;
    const retainedBytes = recovery.retainedBytes ?? stock.bytes;
    startupLog.success('Asset stock recovered', {
        found: {
            entries: foundItems,
            targetEntries: foundTargetItems,
            sizeMiB: Number(formatMiB(foundBytes)),
        },
        retained: {
            entries: retainedItems,
            targetEntries: targetItems,
            sizeMiB: Number(formatMiB(retainedBytes)),
        },
        entriesPerSignature: getEntriesPerSignature(stock),
        storage: { limitMiB: stock.maxMiB, directory: stock.directory },
    });
}

function logAutokickStartup(result) {
    const state = result?.alreadyInitialized
        ? 'already initialized'
        : result?.reconciliationPending ? 'reconciliation scheduled' : 'ready';
    startupLog.success('Autokick initialized', { state });
}

async function shutdownVerificationSubsystems() {
    await disposeAllVerificationGuildLifecycles();
    shutdownVerificationPreviews();
    await shutdownVerificationAssetStock();
    const results = await Promise.allSettled([
        shutdownVerificationRenderSupervisor(),
    ]);
    clearAllPublishedVerificationRuntimeContexts();
    const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
        throw new AggregateError(errors, 'Multiple verification subsystems failed to stop.');
    }
}

function shutdownWardenVerification() {
    verificationShutdownPromise ??= shutdownVerificationSubsystems();
    return verificationShutdownPromise;
}

async function disposeWardenVerificationGuild(guildId) {
    return disposeVerificationGuildLifecycle(guildId);
}

async function initializeWardenVerificationNow({ guild, guildId, botName, lifecycle }) {
    logVerificationFeatureLoading(botName);
    const normalizedGuildId = lifecycle.guildId;

    let snapshot;
    let runtimeContext;
    let assetStockResult;
    let autokickResult;
    let imageInventoryIssues = [];

    try {
        await runVerificationStartupStep(
            'database connection',
            verifyVerificationDatabaseConnection,
            { retryTransient: true },
        );
        lifecycle.assertCurrent();
        await runVerificationStartupStep(
            'schema preparation',
            ensureVerificationDataSchema,
            { retryTransient: true },
        );
        lifecycle.assertCurrent();
        await runVerificationStartupStep(
            'settings initialization',
            () => ensureVerificationGuildSettings(normalizedGuildId),
            { retryTransient: true },
        );
        lifecycle.assertCurrent();
        await runVerificationStartupStep(
            'catalog synchronization',
            () => synchronizeVerificationCatalog(normalizedGuildId),
            { retryTransient: true },
        );
        lifecycle.assertCurrent();

        const imageInventory = await runVerificationStartupStep(
            'image inventory validation',
            () => refreshVerificationImageInventory({ force: true }),
        );
        lifecycle.assertCurrent();
        imageInventoryIssues = imageInventory.issues;
        startupLog.success('Images indexed', {
            valid: imageInventory.images.length,
            unavailable: imageInventoryIssues.length,
        });

        const initializedRuntime = await runVerificationStartupStep(
            'snapshot load and runtime publication',
            () => initializeVerificationRuntimeContext({
                guildId: normalizedGuildId,
                imageInventory,
                lifecycle,
            }),
            { retryTransient: true },
        );
        snapshot = initializedRuntime.snapshot;
        runtimeContext = initializedRuntime.runtimeContext;
        startupLog.complete('Data validation and runtime publication completed');

        initializeVerificationPostReconciler({ guild, lifecycle });
        void scheduleVerificationPostReconciliation(
            normalizedGuildId,
            snapshot.guildSettings,
            'startup',
        );

        await lifecycle.track((async () => {
            try {
                assetStockResult = await reconcileVerificationAssetStock({
                    guildId: normalizedGuildId,
                    runtime: runtimeContext.snapshot.runtime,
                    imageInventory: runtimeContext.imageInventory,
                });
                lifecycle.assertCurrent();
                logAssetStockStartup(assetStockResult);
            }
            catch (error) {
                if (!lifecycle.isCurrent()) return;
                startupLog.warn('Asset stock failed; live rendering remains available.', error);
            }
        })());

        if (imageInventoryIssues.length > 0) {
            startupLog.warn('Image inventory contains unavailable or ignored entries', undefined, {
                count: imageInventoryIssues.length,
            });
            const issueLines = imageInventoryIssues.map((issue) => `- ${issue}`);
            void botLog(guild, new Discord.EmbedBuilder()
                .setTitle('Verification image inventory preflight warning')
                .setDescription(
                    `Some entries in /verificationImages were unavailable or ignored:\n`
                    + issueLines.join('\n').slice(0, 3900),
                ),
            2,
            'error',
            ).catch((error) => {
                startupLog.error('Failed to deliver the image inventory warning.', error);
            });
        }

        lifecycle.assertCurrent();
        autokickResult = await runVerificationStartupStep(
            'autokick initialization',
            () => initializeVerificationAutokick(guild),
            { retryTransient: true },
        );
        lifecycle.assertCurrent();
        logAutokickStartup(autokickResult);

        startVerificationRuntimeRefreshWorker({
            guildId: normalizedGuildId,
            lifecycle,
        });

        logVerificationFeatureSuccess(botName);
        return {
            ok: true,
            snapshot,
            runtimeContext,
            assetStockResult,
            autokickResult,
            imageInventoryIssues,
        };
    }
    catch (error) {
        const startupError = annotateStartupError('startup', error);
        logVerificationFeatureFailure(botName, startupError);
        void reportVerificationError({
            guild,
            title: '⛔ Verification startup failed',
            consoleOutput: false,
        }, startupError);
        return {
            ok: false,
            error: startupError,
            snapshot,
            runtimeContext,
            assetStockResult,
            autokickResult,
            imageInventoryIssues,
        };
    }
}

function initializeWardenVerification({ guild, guildId, botName = 'Warden' } = {}) {
    const normalizedGuildId = String(guildId ?? '').trim();
    if (verificationShutdownPromise) {
        const error = annotateStartupError(
            'shutdown',
            Object.assign(
                new Error('Verification cannot initialize after subsystem shutdown has begun.'),
                { code: 'VERIFICATION_SUBSYSTEM_SHUTDOWN' },
            ),
        );
        return Promise.resolve({ ok: false, error, imageInventoryIssues: [] });
    }
    if (!normalizedGuildId) {
        const error = annotateStartupError(
            'configuration',
            new Error('No verification guild ID is configured.'),
        );
        logVerificationFeatureLoading(botName);
        logVerificationFeatureFailure(botName, error);
        return Promise.resolve({ ok: false, error, imageInventoryIssues: [] });
    }
    const existing = initializationByGuild.get(normalizedGuildId);
    if (existing) return existing;

    const lifecycle = beginVerificationGuildLifecycle(normalizedGuildId);
    lifecycle.addDisposer(() => removeVerificationAssetStockGuild(normalizedGuildId));
    lifecycle.addDisposer(() => shutdownVerificationAutokick(normalizedGuildId));
    lifecycle.addDisposer(() => {
        clearPublishedVerificationRuntimeContext(normalizedGuildId, lifecycle);
    });
    lifecycle.addDisposer(() => shutdownVerificationPreviews(normalizedGuildId));

    let initialization;
    lifecycle.addDisposer(() => {
        if (initializationByGuild.get(normalizedGuildId) === initialization) {
            initializationByGuild.delete(normalizedGuildId);
        }
    });
    initialization = lifecycle.track(initializeWardenVerificationNow({
        guild,
        guildId: normalizedGuildId,
        botName,
        lifecycle,
    })).then(async (result) => {
        if (result.ok) return result;
        try {
            await lifecycle.dispose(result.error);
        }
        catch (disposeError) {
            result.error.disposeError = disposeError;
            startupLog.error('Rollback failed.', disposeError);
        }
        return result;
    });
    initializationByGuild.set(normalizedGuildId, initialization);
    return initialization;
}

module.exports = {
    disposeWardenVerificationGuild,
    initializeWardenVerification,
    shutdownWardenVerification,
};
