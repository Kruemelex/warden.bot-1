const verificationDb = require('./data/verificationStore');
const { createVerificationLogger } = require('./logging');
const {
    ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
    isChallengeActive,
} = require('./domain/activeChallengePolicy');
const { evaluateVerificationConfig } = require('./domain/validation');
const { getAnswerTypeDescriptor } = require('./domain/answerTypes');
const { normalizeGuildId } = require('./domain/identity');
const {
    getVerificationImageInventory,
    refreshVerificationImageInventory,
} = require('./assets/image-inventory');
const { getVerificationGuildLifecycle } = require('./runtime/guildLifecycle');
const {
    getPublishedVerificationRuntimeContext,
    publishVerificationRuntimeContext,
} = require('./runtime/runtimeContext');
const { VERIFICATION_MODES } = verificationDb;
const runtimeContextChanges = new Map();
const serviceLog = createVerificationLogger('Service');

function normalizeVerificationAdminGuildId(guildId) {
    return normalizeGuildId(guildId);
}

function resolveVerificationAdminGuildId(interaction) {
    return interaction?.guildId || interaction?.guild?.id || process.env.GUILDID;
}

const CATALOG_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateCatalogId(value, label) {
    const id = String(value ?? '').trim();
    if (id.length < 1 || id.length > 100 || !CATALOG_ID_PATTERN.test(id)) {
        throw new Error(`${label} ID must be 1-100 characters of lowercase kebab-case.`);
    }
    return id;
}

function validateCatalogReferenceId(value, label) {
    const id = String(value ?? '').trim();
    if (!id || id.length > 100) throw new Error(`${label} ID must be 1-100 characters.`);
    return id;
}

function requireCatalogText(value, label, maxLength) {
    const text = String(value ?? '').trim();
    if (!text || text.length > maxLength) throw new Error(`${label} must be 1-${maxLength} characters.`);
    return text;
}

function createCustomChallenge(guildId, data, actorId) {
    const description = String(data?.description ?? '').trim();
    if (description.length > 4000) throw new Error('Challenge description must be at most 4000 characters.');
    const normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    return commitVerificationMutation(normalizedGuildId, (publicationOptions) =>
        verificationDb.createCustomChallenge(normalizedGuildId, {
            id: validateCatalogId(data?.id, 'Challenge'),
            title: requireCatalogText(data?.title, 'Challenge title', 256),
            description: description || undefined,
            color: String(data?.color ?? '').trim() || undefined,
        }, actorId, publicationOptions));
}

function createCustomQuestion(guildId, challengeId, data, actorId) {
    const answerType = String(data?.answerType ?? 'none');
    if (getAnswerTypeDescriptor(answerType)?.availableOnCreate !== true) {
        throw new Error('New plain questions support No Answer or Text Answer. Set a gallery task before using Position or Gallery Count answers.');
    }
    return commitChallengeCatalogMutation(verificationDb.createCustomQuestion, guildId, challengeId, [{
        id: validateCatalogId(data?.id, 'Question'),
        label: requireCatalogText(data?.label, 'Question label', 128),
        text: requireCatalogText(data?.text, 'Question text', 4000),
        separateStep: data?.separateStep === true,
        generatedImage: { enabled: false, type: 'none' },
        answer: { required: answerType !== 'none', type: answerType },
    }, actorId]);
}

function deleteOrResetChallenge(guildId, challengeId, actorId, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.deleteOrResetChallenge, guildId, challengeId, [actorId], options);
}

function deleteOrResetQuestion(guildId, challengeId, questionId, actorId, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.deleteOrResetQuestion, guildId, challengeId,
        [validateCatalogReferenceId(questionId, 'Question'), actorId], options);
}

async function getVerificationSnapshot(guildId, options) {
    const normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    if (options?.fresh === true) {
        return verificationDb.loadVerificationSnapshot(normalizedGuildId, options);
    }
    try {
        return getPublishedVerificationRuntimeContext(normalizedGuildId).snapshot;
    }
    catch (error) {
        if (error?.code !== 'VERIFICATION_RUNTIME_NOT_READY') throw error;
        return verificationDb.loadVerificationSnapshot(normalizedGuildId, options);
    }
}

function assertVerificationRuntimePublishable(
    snapshot,
    imageInventory = getVerificationImageInventory(),
) {
    const report = evaluateVerificationConfig(snapshot?.runtime, { imageInventory });
    if (report.activeBlockingIssues.length < 1) return report;
    const error = new Error(
        'Verification configuration cannot be activated: '
        + report.activeBlockingIssues.map((issue) => issue.message).join(' | '),
    );
    error.code = 'VERIFICATION_RUNTIME_CONTEXT_INVALID';
    error.verificationConfigReport = report;
    throw error;
}

function requireVerificationGuildLifecycle(guildId) {
    const lifecycle = getVerificationGuildLifecycle(guildId);
    if (!lifecycle) {
        const error = new Error('Verification is not ready for runtime publication.');
        error.code = 'VERIFICATION_RUNTIME_NOT_READY';
        throw error;
    }
    lifecycle.assertCurrent();
    return lifecycle;
}

function publishVerificationSnapshot(snapshot, {
    imageInventory = getVerificationImageInventory(),
    lifecycle,
} = {}) {
    const owner = lifecycle ?? requireVerificationGuildLifecycle(snapshot?.guildId);
    owner.assertCurrent();
    const configReport = assertVerificationRuntimePublishable(snapshot, imageInventory);
    return publishVerificationRuntimeContext({
        snapshot,
        imageInventory,
        configReport,
        lifecycle: owner,
    });
}

function serializeVerificationRuntimeContextChange(guildId, work, lifecycle) {
    const normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    const owner = lifecycle ?? requireVerificationGuildLifecycle(normalizedGuildId);
    if (String(owner.guildId) !== normalizedGuildId) {
        throw new TypeError('Verification lifecycle ownership must match the mutation guild.');
    }
    owner.assertCurrent();
    const previous = runtimeContextChanges.get(normalizedGuildId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => work(owner));
    runtimeContextChanges.set(normalizedGuildId, current);
    void current.finally(() => {
        if (runtimeContextChanges.get(normalizedGuildId) === current) {
            runtimeContextChanges.delete(normalizedGuildId);
        }
    }).catch(() => {});
    return owner.track(current);
}

function scheduleAssetStockReconciliation(context, { lifecycle } = {}) {
    const owner = lifecycle ?? requireVerificationGuildLifecycle(context.guildId);
    owner.assertCurrent();
    const task = require('./runtime/assetStock').reconcileVerificationAssetStock({
        guildId: context.guildId,
        runtime: context.snapshot.runtime,
        imageInventory: context.imageInventory,
    }).catch((error) => {
        serviceLog.warn('Asset stock reconciliation failed:', error);
        return undefined;
    });
    return owner.track(task);
}

function assertInactiveChallengeMutation(snapshot, challengeId) {
    if (!challengeId || !isChallengeActive(snapshot?.activeChallengeIds, challengeId)) return;
    const error = new Error(ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE);
    error.code = 'VERIFICATION_ACTIVE_CHALLENGE_EDIT_LOCKED';
    throw error;
}

async function commitVerificationMutation(guildId, write, { inactiveChallengeId } = {}) {
    const normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    return serializeVerificationRuntimeContextChange(normalizedGuildId, async (lifecycle) => {
        const current = getPublishedVerificationRuntimeContext(normalizedGuildId);
        assertInactiveChallengeMutation(current.snapshot, inactiveChallengeId);
        const imageInventory = getVerificationImageInventory();
        const committed = await write({
            validateSnapshot: (candidate) =>
                assertVerificationRuntimePublishable(candidate, imageInventory),
        });
        lifecycle.assertCurrent();
        const runtimeContext = publishVerificationSnapshot(committed.snapshot, {
            imageInventory,
            lifecycle,
        });
        void scheduleAssetStockReconciliation(runtimeContext, { lifecycle });
        return Object.freeze({ ...committed, runtimeContext });
    });
}

function commitVerificationDbMutation(method, guildId, args, options = {}, mutationPolicy) {
    return commitVerificationMutation(guildId, (publicationOptions) =>
        method(guildId, ...args, { ...options, ...publicationOptions }), mutationPolicy);
}

function commitChallengeCatalogMutation(
    method, guildId, challengeId, args, options = {}, allowWhileActive = false,
) {
    const normalizedChallengeId = validateCatalogReferenceId(challengeId, 'Challenge');
    return commitVerificationDbMutation(
        method, guildId, [normalizedChallengeId, ...args], options,
        allowWhileActive ? undefined : { inactiveChallengeId: normalizedChallengeId },
    );
}

async function refreshVerificationRuntimeContext({ guildId, refreshImages = true } = {}) {
    const normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    return serializeVerificationRuntimeContextChange(normalizedGuildId, async (lifecycle) => {
        const imageInventory = refreshImages
            ? await refreshVerificationImageInventory({ force: true })
            : getVerificationImageInventory();
        lifecycle.assertCurrent();
        const snapshot = await getVerificationSnapshot(normalizedGuildId, { fresh: true });
        lifecycle.assertCurrent();
        const context = publishVerificationSnapshot(snapshot, { imageInventory, lifecycle });
        void scheduleAssetStockReconciliation(context, { lifecycle });
        return context;
    });
}

async function initializeVerificationRuntimeContext({
    guildId,
    imageInventory = getVerificationImageInventory(),
    lifecycle,
} = {}) {
    const normalizedGuildId = normalizeVerificationAdminGuildId(guildId);
    return serializeVerificationRuntimeContextChange(normalizedGuildId, async (owner) => {
        owner.assertCurrent();
        const snapshot = await getVerificationSnapshot(normalizedGuildId, { fresh: true });
        owner.assertCurrent();
        const runtimeContext = publishVerificationSnapshot(snapshot, {
            imageInventory,
            lifecycle: owner,
        });
        return Object.freeze({ runtimeContext, snapshot });
    }, lifecycle);
}

function saveVerificationGuildSettingsOnly(guildId, settings, updatedBy, options = {}) {
    return commitVerificationDbMutation(
        verificationDb.saveVerificationGuildSettingsOnly, guildId, [settings, updatedBy], options,
    );
}

function listVerificationPosts(guildId) {
    return verificationDb.listVerificationPosts(normalizeVerificationAdminGuildId(guildId));
}

function registerVerificationPost(guildId, post) {
    return verificationDb.registerVerificationPost(normalizeVerificationAdminGuildId(guildId), post);
}

function removeVerificationPosts(guildId, posts) {
    return verificationDb.removeVerificationPosts(normalizeVerificationAdminGuildId(guildId), posts);
}

function updateCatalogChallengeMetadata(guildId, challengeId, patch, updatedBy, options = {}) {
    return commitVerificationDbMutation(
        verificationDb.updateCatalogChallengeMetadata, guildId, [challengeId, patch, updatedBy], options,
    );
}

function updateCatalogQuestionFields(guildId, challengeId, questionId, data, updatedBy, options = {}) {
    const copyOnly = Object.keys(data ?? {}).length > 0
        && Object.keys(data).every((key) => key === 'label' || key === 'text');
    return commitChallengeCatalogMutation(
        verificationDb.updateCatalogQuestionFields, guildId, challengeId,
        [questionId, data, updatedBy], options, copyOnly);
}

function updateCatalogQuestionPrompt(guildId, challengeId, questionId, text, updatedBy, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.updateCatalogQuestionPrompt, guildId, challengeId,
        [questionId, text, updatedBy], options);
}

function updateCatalogQuestionAnswers(guildId, challengeId, questionId, answers, updatedBy, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.updateCatalogQuestionAnswers, guildId, challengeId,
        [questionId, answers, updatedBy], options);
}

function updateCatalogQuestionImageIds(guildId, challengeId, questionId, imageIds, updatedBy, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.updateCatalogQuestionImageIds, guildId, challengeId,
        [questionId, imageIds, updatedBy], options);
}

function updateCatalogQuestionImageDirections(guildId, challengeId, questionId, directions, updatedBy, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.updateCatalogQuestionImageDirections, guildId, challengeId,
        [questionId, directions, updatedBy], options);
}

function questionOptionsAreCopyOnly(patches) {
    const questionPatches = Object.values(patches ?? {});
    return questionPatches.length > 0 && questionPatches.every((patch) => {
        const patchKeys = Object.keys(patch ?? {});
        const answerKeys = Object.keys(patch?.answer ?? {});
        return patchKeys.length === 1
            && patchKeys[0] === 'answer'
            && answerKeys.length > 0
            && answerKeys.every((key) => key === 'inputLabel' || key === 'inputPlaceholder');
    });
}

function updateCatalogQuestionOptions(guildId, challengeId, patches, updatedBy, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.updateCatalogQuestionOptions, guildId, challengeId,
        [patches, updatedBy], options, questionOptionsAreCopyOnly(patches));
}

function resetCatalogQuestionFieldsToTemplate(guildId, challengeId, questionId, fields, updatedBy, options = {}) {
    return commitChallengeCatalogMutation(
        verificationDb.resetCatalogQuestionFieldsToTemplate, guildId, challengeId,
        [questionId, fields, updatedBy], options);
}

function getCatalogQuestionChangesFromSnapshot(snapshot, challengeId, questionId) {
    return verificationDb.getCatalogQuestionChanges(snapshot, challengeId, questionId);
}

async function getVerificationChallenge(guildId, challengeId, options) {
    const snapshot = await getVerificationSnapshot(guildId, options);
    return snapshot.challengesById.get(String(challengeId ?? '').trim());
}

async function getVerificationAdminChallenge(guildId, challengeId, options) {
    return getVerificationChallenge(normalizeVerificationAdminGuildId(guildId), challengeId, options);
}

module.exports = {
    VERIFICATION_MODES,
    evaluateVerificationConfig,
    getVerificationAdminChallenge,
    getCatalogQuestionChangesFromSnapshot,
    getVerificationSnapshot,
    ensureVerificationDataSchema: verificationDb.ensureVerificationDataSchema,
    ensureVerificationGuildSettings: verificationDb.ensureVerificationGuildSettings,
    initializeVerificationRuntimeContext,
    refreshVerificationRuntimeContext,
    synchronizeVerificationCatalog: verificationDb.synchronizeVerificationCatalog,
    verifyVerificationDatabaseConnection: verificationDb.verifyVerificationDatabaseConnection,
    normalizeVerificationAdminGuildId,
    resolveVerificationAdminGuildId,
    listVerificationPosts,
    registerVerificationPost,
    removeVerificationPosts,
    saveVerificationGuildSettingsOnly,
    updateCatalogChallengeMetadata,
    updateCatalogQuestionFields,
    updateCatalogQuestionPrompt,
    updateCatalogQuestionAnswers,
    updateCatalogQuestionImageIds,
    updateCatalogQuestionImageDirections,
    updateCatalogQuestionOptions,
    resetCatalogQuestionFieldsToTemplate,
    createCustomChallenge,
    createCustomQuestion,
    deleteOrResetChallenge,
    deleteOrResetQuestion,
};
