'use strict';

const verificationSettings = require('./settingsRepository');
const verificationCatalog = require('./catalogRepository');
const verificationPosts = require('./postRepository');
const { ensureVerificationSchema } = require('../../db/verification');
const { withVerificationTransaction } = require('./transaction');
const { normalizeVerificationChallenge } = require('../domain/challenges');
const { normalizeGuildId } = require('../domain/identity');
const {
    cloneCatalogValue,
    comparableValuesEqual,
    normalizeBoolean,
} = require('./values');

const SNAPSHOT_LOAD_TIMEOUT_MS = 60_000;
const snapshotLoads = new Map();
let snapshotGeneration = 0;

function createReadonlyMap(entries) {
    const map = new Map(entries);
    const failMutation = () => {
        throw new TypeError('Verification snapshots are immutable.');
    };
    for (const method of ['set', 'delete', 'clear']) {
        Object.defineProperty(map, method, {
            configurable: false,
            enumerable: false,
            value: failMutation,
            writable: false,
        });
    }
    return Object.freeze(map);
}

function freezeCatalogValue(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(freezeCatalogValue));
    if (value && typeof value === 'object') {
        return Object.freeze(Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, freezeCatalogValue(entry)]),
        ));
    }
    return value;
}

function attachCatalogMetadata(normalized, catalogEntry) {
    const questionsById = new Map((catalogEntry.questions ?? []).map((question) => [String(question.id), question]));
    const questions = Object.freeze((normalized.questions ?? []).map((question) => {
        const source = questionsById.get(String(question.id)) ?? {};
        return Object.freeze({ ...question,
            sourceType: source.sourceType, sourceTemplateId: source.sourceTemplateId,
            templateVersion: source.templateVersion, protectedTemplate: source.protectedTemplate === true,
            createdBy: source.createdBy, updatedBy: source.updatedBy,
            createdAt: source.createdAt, updatedAt: source.updatedAt });
    }));
    return Object.freeze({ ...normalized, questions,
        sourceType: catalogEntry.sourceType, sourceTemplateId: catalogEntry.sourceTemplateId,
        templateVersion: catalogEntry.templateVersion, protectedTemplate: catalogEntry.protectedTemplate === true,
        createdBy: catalogEntry.createdBy, updatedBy: catalogEntry.updatedBy,
        createdAt: catalogEntry.createdAt, updatedAt: catalogEntry.updatedAt });
}

function buildSnapshot(guildId, guildSettings, challengeCatalog) {
    const generation = ++snapshotGeneration;
    const frozenChallengeCatalog = freezeCatalogValue(challengeCatalog);
    const challenges = Object.freeze(Object.values(frozenChallengeCatalog)
        .map((challenge) => attachCatalogMetadata(
            freezeCatalogValue(normalizeVerificationChallenge(challenge)),
            challenge,
        )));
    const challengesById = createReadonlyMap(challenges.map((challenge) => [challenge.id, challenge]));
    const activeChallengeIds = Object.freeze([...(guildSettings.activeChallengeIds ?? [])]);
    const activeChallenges = Object.freeze(activeChallengeIds
        .map((challengeId) => challengesById.get(String(challengeId)))
        .filter(Boolean));
    const runtime = Object.freeze({
        guildId,
        verificationRoleId: guildSettings.verificationRoleId,
        mode: guildSettings.mode,
        activeChallengeIds,
        screenExpirySeconds: guildSettings.screenExpirySeconds,
        cooldownSeconds: guildSettings.cooldownSeconds,
        autokickEnabled: guildSettings.autokickEnabled,
        autokickSeconds: guildSettings.autokickSeconds,
        challenges,
        activeChallenges,
    });

    const nativeGuildSettings = { ...guildSettings, activeChallengeIds };
    const snapshot = {
        guildId,
        generation,
        guildSettings: Object.freeze(nativeGuildSettings),
        runtime,
        challengeCatalog: frozenChallengeCatalog,
        challengesById,
        activeChallengeIds,
    };
    return Object.freeze(snapshot);
}

async function readVerificationSnapshot(query, guildId) {
    const guildSettings = await verificationSettings.readVerificationGuildSettings(guildId, query);
    const challengeCatalog = await verificationCatalog.readVerificationChallengeCatalog(guildId, query);
    return buildSnapshot(guildId, guildSettings, challengeCatalog);
}

function buildQuestionChangeSet(question = {}, templateQuestion) {
    // Custom Questions have no protected baseline. Their explicit delete/reset
    // action is the safe way to remove them; Clear Selector is template-only.
    if (!templateQuestion) return {};
    const values = Object.fromEntries(['order', 'label', 'text', 'separateStep', 'generatedImage', 'answer']
        .filter((key) => Object.prototype.hasOwnProperty.call(question, key)
            || Object.prototype.hasOwnProperty.call(templateQuestion, key))
        .map((key) => [key, cloneCatalogValue(question[key])]));

    return Object.entries(values).reduce((changes, [key, value]) => {
        const templateValue = templateQuestion[key];
        if (comparableValuesEqual(value, templateValue)) return changes;
        if (
            (key === 'generatedImage' || key === 'answer')
            && value && templateValue
            && typeof value === 'object' && !Array.isArray(value)
            && typeof templateValue === 'object' && !Array.isArray(templateValue)
        ) {
            const nestedChanges = [...new Set([...Object.keys(value), ...Object.keys(templateValue)])]
                .reduce((nested, nestedKey) => {
                const nestedValue = value[nestedKey];
                if (!comparableValuesEqual(nestedValue, templateValue[nestedKey])) {
                    nested[nestedKey] = cloneCatalogValue(nestedValue);
                }
                return nested;
            }, {});
            if (Object.keys(nestedChanges).length > 0) changes[key] = nestedChanges;
            return changes;
        }
        changes[key] = value;
        return changes;
    }, {});
}

function getCatalogQuestionChanges(snapshot, challengeId, questionId) {
    const normalizedChallengeId = String(challengeId ?? '').trim();
    const normalizedQuestionId = normalizeQuestionId(questionId);
    const question = snapshot?.challengesById?.get(normalizedChallengeId)?.questions
        ?.find((candidate) => candidate.id === normalizedQuestionId);
    if (!question) return undefined;

    const templateQuestion = verificationCatalog.getVerificationChallengeTemplate(normalizedChallengeId)?.questions
        ?.find((candidate) => candidate.id === normalizedQuestionId);
    return Object.freeze({
        changes: Object.freeze(buildQuestionChangeSet(question, templateQuestion)),
        updatedAt: question.updatedAt,
        updatedBy: question.updatedBy,
        protectedTemplate: question.protectedTemplate === true,
    });
}

async function waitForVerificationSnapshotLoad(load, timeoutMs) {
    let timeout;
    try {
        return await Promise.race([
            load.work,
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const err = new Error(
                        `Verification data load timed out after ${timeoutMs}ms. Please try again.`,
                    );
                    err.code = 'VERIFICATION_SNAPSHOT_TIMEOUT';
                    reject(err);
                }, timeoutMs);
                timeout.unref?.();
            }),
        ]);
    }
    finally {
        clearTimeout(timeout);
    }
}

async function loadVerificationSnapshot(guildId, options = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const configuredTimeoutMs = Number(options.timeoutMs);
    const timeoutMs = Number.isInteger(configuredTimeoutMs) && configuredTimeoutMs > 0
        ? configuredTimeoutMs
        : SNAPSHOT_LOAD_TIMEOUT_MS;

    let load = snapshotLoads.get(normalizedGuildId);
    if (!load) {
        load = {
            work: withVerificationTransaction(
                (query) => readVerificationSnapshot(query, normalizedGuildId),
                { isolationLevel: 'REPEATABLE READ' },
            ),
        };
        snapshotLoads.set(normalizedGuildId, load);
        void load.work.finally(() => {
            if (snapshotLoads.get(normalizedGuildId) === load) {
                snapshotLoads.delete(normalizedGuildId);
            }
        }).catch(() => {});
    }

    return waitForVerificationSnapshotLoad(load, timeoutMs);
}

async function verifyVerificationDatabaseConnection() {
    const database = require('../../db/database');
    await database.query('SELECT 1');
}

async function ensureVerificationDataSchema() {
    await ensureVerificationSchema();
}

async function synchronizeVerificationCatalog(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await verificationCatalog.synchronizeVerificationChallengeCatalog(normalizedGuildId);
}

async function ensureVerificationGuildSettings(guildId) {
    return verificationSettings.ensureVerificationGuildSettings(normalizeGuildId(guildId));
}

async function runVerificationWrite(guildId, write, options = {}) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const committed = await write(normalizedGuildId, async (query, result) => {
        const snapshot = await readVerificationSnapshot(query, normalizedGuildId);
        await options.validateSnapshot?.(snapshot);
        return Object.freeze({ result, snapshot });
    });
    if (!committed?.snapshot) {
        throw new Error('Verification write committed without returning its complete snapshot.');
    }
    return committed;
}

function saveVerificationGuildSettingsOnly(guildId, settings, updatedBy, options = {}) {
    return runVerificationWrite(guildId, (normalizedGuildId, finalize) =>
        verificationSettings.saveVerificationGuildSettingsOnly(
            normalizedGuildId,
            settings,
            updatedBy,
            { ...options, finalize },
        ), options);
}

const ALLOWED_IMAGE_ROLES = new Set(['source', 'solution', 'control', 'center', 'outer']);
const ALLOWED_IMAGE_DIRECTION_DEGREES = new Set([0, 45, 90, 135, 180, 225, 270, 315]);

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function normalizeStringArray(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
    return [...new Set(values.map((entry) => String(entry ?? '').trim()).filter(Boolean))];
}

function normalizeQuestionId(questionId) {
    return String(questionId ?? '').trim();
}

function normalizeDirectionList(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
    return [...new Set(values
        .map((degrees) => Number(degrees) === 360 ? 0 : Number(degrees))
        .filter((degrees) => Number.isInteger(degrees) && ALLOWED_IMAGE_DIRECTION_DEGREES.has(degrees)))]
        .sort((left, right) => left - right);
}

function getTemplateQuestion(challengeId, questionId) {
    return verificationCatalog.getVerificationChallengeTemplate(challengeId)?.questions
        ?.find((question) => question.id === String(questionId));
}

function assignOrDelete(target, key, value) {
    if (value === null || value === '') delete target[key];
    else target[key] = cloneCatalogValue(value);
}

function applyQuestionPatch(question, patch = {}) {
    const updated = cloneCatalogValue(question);
    for (const key of ['order', 'label', 'text', 'separateStep']) {
        if (hasOwn(patch, key)) assignOrDelete(updated, key, patch[key]);
    }

    for (const containerKey of ['generatedImage', 'answer']) {
        if (!hasOwn(patch, containerKey)) continue;
        const containerPatch = patch[containerKey];
        if (containerPatch === null || containerPatch === '') {
            delete updated[containerKey];
            continue;
        }

        const currentContainer = cloneCatalogValue(updated[containerKey] ?? {});
        for (const [key, value] of Object.entries(containerPatch ?? {})) {
            assignOrDelete(currentContainer, key, value);
        }
        if (Object.keys(currentContainer).length > 0) updated[containerKey] = currentContainer;
        else delete updated[containerKey];
    }

    return updated;
}

function getPathValue(value, path) {
    let current = value;
    for (const part of path) {
        if (!current || typeof current !== 'object' || !hasOwn(current, part)) {
            return { found: false, value: undefined };
        }
        current = current[part];
    }
    return { found: true, value: current };
}

function resetQuestionPath(question, baseline, dottedPath) {
    const parts = String(dottedPath ?? '').split('.').filter(Boolean);
    if (parts.length < 1) throw new Error('Verification question reset path is required.');
    const baselineValue = getPathValue(baseline, parts);
    let target = question;

    for (const part of parts.slice(0, -1)) {
        if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
        target = target[part];
    }
    const leaf = parts.at(-1);
    if (baselineValue.found) target[leaf] = cloneCatalogValue(baselineValue.value);
    else delete target[leaf];

    for (let depth = parts.length - 1; depth > 0; depth -= 1) {
        const parentPath = parts.slice(0, depth);
        const parent = getPathValue(question, parentPath);
        if (parent.found && parent.value && typeof parent.value === 'object' && Object.keys(parent.value).length < 1) {
            const grandparent = getPathValue(question, parentPath.slice(0, -1));
            if (grandparent.found) delete grandparent.value[parentPath.at(-1)];
        }
    }
}

function updateCatalogChallengeMetadata(guildId, challengeId, patch, updatedBy, options = {}) {
    return runVerificationWrite(guildId, (normalizedGuildId, finalize) =>
        verificationCatalog.mutateVerificationChallengeCatalogEntry({
            guildId: normalizedGuildId,
            challengeId,
            updatedBy,
            expected: options.expected,
            finalize,
            mutate: (challenge) => ({
                ...challenge,
                ...(hasOwn(patch, 'title') ? { title: patch.title } : {}),
                ...(hasOwn(patch, 'description') ? { description: patch.description } : {}),
                ...(hasOwn(patch, 'color') ? { color: patch.color } : {}),
            }),
        }), options);
}

function mutateQuestionEntries(guildId, challengeId, questionIds, updatedBy, mutate, options = {}) {
    return runVerificationWrite(guildId, (normalizedGuildId, finalize) =>
        verificationCatalog.mutateVerificationQuestionCatalogEntries({
            guildId: normalizedGuildId,
            challengeId,
            questionIds,
            updatedBy,
            expected: options.expected,
            expectedOrder: options.expectedOrder,
            mutate,
            finalize,
        }), options);
}

function updateCatalogQuestionFields(guildId, challengeId, questionId, data, updatedBy, options = {}) {
    const normalizedQuestionId = normalizeQuestionId(questionId);
    return mutateQuestionEntries(guildId, challengeId, [questionId], updatedBy, (questions) => {
        const question = questions.get(normalizedQuestionId);
        questions.set(normalizedQuestionId, {
            ...question,
            ...(hasOwn(data, 'label') ? { label: data.label } : {}),
            ...(hasOwn(data, 'text') ? { text: data.text } : {}),
            ...(hasOwn(data, 'separateStep') ? { separateStep: normalizeBoolean(data.separateStep) } : {}),
        });
        return questions;
    }, options);
}

function updateCatalogQuestionPrompt(guildId, challengeId, questionId, text, updatedBy, options = {}) {
    const normalizedQuestionId = normalizeQuestionId(questionId);
    return mutateQuestionEntries(guildId, challengeId, [questionId], updatedBy, (questions) => {
        const question = questions.get(normalizedQuestionId);
        questions.set(normalizedQuestionId, {
            ...question,
            generatedImage: { ...(question.generatedImage ?? {}), text },
        });
        return questions;
    }, options);
}

function updateCatalogQuestionAnswers(guildId, challengeId, questionId, answers, updatedBy, options = {}) {
    const normalizedQuestionId = normalizeQuestionId(questionId);
    return mutateQuestionEntries(guildId, challengeId, [questionId], updatedBy, (questions) => {
        const question = questions.get(normalizedQuestionId);
        questions.set(normalizedQuestionId, {
            ...question,
            answer: { ...question.answer, accepted: normalizeStringArray(answers) },
        });
        return questions;
    }, options);
}

function updateCatalogQuestionImageIds(guildId, challengeId, questionId, roleImageIds, updatedBy, options = {}) {
    const normalizedQuestionId = normalizeQuestionId(questionId);
    const normalizedRoleImageIds = Object.entries(roleImageIds ?? {}).reduce((updates, [role, imageIds]) => {
        if (!ALLOWED_IMAGE_ROLES.has(role)) throw new Error(`Unsupported verification image role: ${role}`);
        updates[role] = normalizeStringArray(imageIds);
        return updates;
    }, {});

    return mutateQuestionEntries(guildId, challengeId, [questionId], updatedBy, (questions) => {
        const question = questions.get(normalizedQuestionId);
        const imageIds = { ...(question.generatedImage?.imageIds ?? {}), ...normalizedRoleImageIds };
        const directionImageIds = new Set([...(imageIds.center ?? []), ...(imageIds.outer ?? [])].map(String));
        const imageDirections = Object.fromEntries(Object.entries(question.generatedImage?.imageDirections ?? {})
            .filter(([imageId]) => directionImageIds.has(String(imageId))));
        questions.set(normalizedQuestionId, {
            ...question,
            generatedImage: {
                ...(question.generatedImage ?? {}),
                imageIds,
                ...(question.generatedImage?.imageDirections ? { imageDirections } : {}),
            },
        });
        return questions;
    }, options);
}

function updateCatalogQuestionImageDirections(guildId, challengeId, questionId, imageDirectionUpdates, updatedBy, options = {}) {
    const normalizedQuestionId = normalizeQuestionId(questionId);
    const normalizedUpdates = Object.entries(imageDirectionUpdates ?? {}).reduce((updates, [imageId, degrees]) => {
        const normalizedImageId = String(imageId ?? '').trim();
        if (normalizedImageId) updates[normalizedImageId] = normalizeDirectionList(degrees);
        return updates;
    }, {});

    return mutateQuestionEntries(guildId, challengeId, [questionId], updatedBy, (questions) => {
        const question = questions.get(normalizedQuestionId);
        questions.set(normalizedQuestionId, {
            ...question,
            generatedImage: {
                ...(question.generatedImage ?? {}),
                imageDirections: { ...(question.generatedImage?.imageDirections ?? {}), ...normalizedUpdates },
            },
        });
        return questions;
    }, options);
}

function updateCatalogQuestionOptions(guildId, challengeId, questionPatches, updatedBy, options = {}) {
    const normalizedPatches = Object.fromEntries(Object.entries(questionPatches ?? {})
        .map(([questionId, patch]) => [normalizeQuestionId(questionId), patch])
        .filter(([questionId]) => questionId));
    const questionIds = Object.keys(normalizedPatches);

    return mutateQuestionEntries(guildId, challengeId, questionIds, updatedBy, (questions) => {
        for (const questionId of questionIds) {
            const current = questions.get(questionId);
            questions.set(questionId, applyQuestionPatch(current, normalizedPatches[questionId]));
        }
        return questions;
    }, options);
}

function resetCatalogQuestionFieldsToTemplate(guildId, challengeId, questionId, fields, updatedBy, options = {}) {
    const normalizedQuestionId = normalizeQuestionId(questionId);
    const baseline = getTemplateQuestion(challengeId, normalizedQuestionId) ?? {};
    return mutateQuestionEntries(guildId, challengeId, [questionId], updatedBy, (questions) => {
        const updated = cloneCatalogValue(questions.get(normalizedQuestionId));
        for (const field of fields ?? []) resetQuestionPath(updated, baseline, field);
        questions.set(normalizedQuestionId, updated);
        return questions;
    }, options);
}

function createCustomChallenge(guildId, data, actorId, options = {}) {
    return runVerificationWrite(guildId, (normalizedGuildId, finalize) =>
        verificationCatalog.createVerificationChallengeCatalogEntry({
            guildId: normalizedGuildId,
            challengeId: data.id,
            title: data.title,
            description: data.description,
            color: data.color,
            createdBy: actorId,
            finalize,
        }), options);
}

function createCustomQuestion(guildId, challengeId, data, actorId, options = {}) {
    return runVerificationWrite(guildId, (normalizedGuildId, finalize) =>
        verificationCatalog.createVerificationQuestionCatalogEntry({
            guildId: normalizedGuildId,
            challengeId,
            question: data,
            createdBy: actorId,
            finalize,
        }), options);
}

function deleteOrResetChallenge(guildId, challengeId, actorId, options = {}) {
    return runVerificationWrite(guildId, (targetGuildId, finalize) =>
        verificationCatalog.deleteOrResetVerificationChallengeCatalogEntry({
            guildId: targetGuildId, challengeId, updatedBy: actorId, expected: options.expected, finalize,
        }), options);
}

function deleteOrResetQuestion(guildId, challengeId, questionId, actorId, options = {}) {
    return runVerificationWrite(guildId, (normalizedGuildId, finalize) =>
        verificationCatalog.deleteOrResetVerificationQuestionCatalogEntry({
            guildId: normalizedGuildId, challengeId, questionId, updatedBy: actorId, expected: options.expected, finalize,
        }), options);
}

module.exports = {
    VERIFICATION_MODES: verificationSettings.VERIFICATION_MODES,
    ensureVerificationDataSchema,
    ensureVerificationGuildSettings,
    loadVerificationSnapshot,
    synchronizeVerificationCatalog,
    verifyVerificationDatabaseConnection,
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
    getCatalogQuestionChanges,
    listVerificationPosts: verificationPosts.listVerificationPosts,
    registerVerificationPost: verificationPosts.registerVerificationPost,
    removeVerificationPosts: verificationPosts.removeVerificationPosts,
};
