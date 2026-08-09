const { withVerificationTransaction } = require('./transaction');
const { normalizeGuildId } = require('../domain/identity');
const {
    ensureVerificationChallengeCatalogTables,
} = require('../../db/verification');
const {
    ensureVerificationChallengeTemplatesSeeded,
    getVerificationChallengeTemplate,
} = require('./catalogTemplates');
const { catalogRowsToChallenge } = require('./catalogTransforms');
const { createCatalogMutations } = require('./catalogMutations');

let database;

const CATALOG_TIMESTAMP_SELECT = `*,
    UNIX_TIMESTAMP(created_at) AS created_at_epoch_seconds,
    UNIX_TIMESTAMP(updated_at) AS updated_at_epoch_seconds`;

function getDatabase() {
    if (!database) {
        database = require('../../../Warden/db/database');
    }

    return database;
}

function defaultQuery(sql, values) {
    return getDatabase().query(sql, values);
}

const catalogMutations = createCatalogMutations({
    ensureCatalogTables: ensureVerificationChallengeCatalogTables,
    withTransaction: withVerificationTransaction,
});

async function synchronizeVerificationChallengeCatalog(guildId) {
    const normalizedGuildId = normalizeGuildId(guildId);
    await ensureVerificationChallengeTemplatesSeeded(normalizedGuildId, {
        query: defaultQuery,
        defaultQuery,
        ensureCatalogTables: ensureVerificationChallengeCatalogTables,
        withTransaction: withVerificationTransaction,
    });
}

async function readVerificationChallengeCatalog(guildId, query = defaultQuery) {
    const normalizedGuildId = normalizeGuildId(guildId);
    const challengeRows = await query(`SELECT ${CATALOG_TIMESTAMP_SELECT} FROM verification_challenge_catalog
        WHERE guild_id = ? AND deleted_at IS NULL ORDER BY challenge_id`, [normalizedGuildId]);
    const questionRows = await query(`SELECT ${CATALOG_TIMESTAMP_SELECT} FROM verification_question_catalog
        WHERE guild_id = ? AND deleted_at IS NULL ORDER BY challenge_id, question_order, question_id`, [normalizedGuildId]);
    const questionsByChallenge = questionRows.reduce((byChallenge, row) => {
        if (!byChallenge.has(row.challenge_id)) byChallenge.set(row.challenge_id, []);
        byChallenge.get(row.challenge_id).push(row);
        return byChallenge;
    }, new Map());
    const catalog = challengeRows.reduce((result, row) => {
        result[row.challenge_id] = catalogRowsToChallenge(row, questionsByChallenge.get(row.challenge_id) ?? []);
        return result;
    }, {});

    return catalog;
}

module.exports = {
    readVerificationChallengeCatalog,
    synchronizeVerificationChallengeCatalog,
    getVerificationChallengeTemplate,
    mutateVerificationChallengeCatalogEntry: catalogMutations.mutateVerificationChallengeCatalogEntry,
    mutateVerificationQuestionCatalogEntries: catalogMutations.mutateVerificationQuestionCatalogEntries,
    createVerificationChallengeCatalogEntry: catalogMutations.createVerificationChallengeCatalogEntry,
    createVerificationQuestionCatalogEntry: catalogMutations.createVerificationQuestionCatalogEntry,
    deleteOrResetVerificationChallengeCatalogEntry: catalogMutations.deleteOrResetVerificationChallengeCatalogEntry,
    deleteOrResetVerificationQuestionCatalogEntry: catalogMutations.deleteOrResetVerificationQuestionCatalogEntry,
};
