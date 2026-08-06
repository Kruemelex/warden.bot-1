'use strict';

const {
    createVerificationAutokickQueueTable,
    createVerificationCatalogTables,
    createVerificationGuildSettingsTable,
} = require('./schema/tables');
let database;
let verificationGuildSettingsTableReady;
let verificationAutokickQueueTableReady;
let verificationCatalogTablesReady;

function getDatabase() {
    if (!database) database = require('../database');
    return database;
}

function memoizeSchemaWork(getReady, setReady, work) {
    let ready = getReady();
    if (!ready) {
        ready = Promise.resolve()
            .then(work)
            .catch((error) => {
                setReady(undefined);
                throw error;
            });
        setReady(ready);
    }
    return ready;
}

function ensureVerificationGuildSettingsTable() {
    return memoizeSchemaWork(
        () => verificationGuildSettingsTableReady,
        (ready) => { verificationGuildSettingsTableReady = ready; },
        () => createVerificationGuildSettingsTable(getDatabase()),
    );
}

function ensureVerificationAutokickQueueTable() {
    return memoizeSchemaWork(
        () => verificationAutokickQueueTableReady,
        (ready) => { verificationAutokickQueueTableReady = ready; },
        () => createVerificationAutokickQueueTable(getDatabase()),
    );
}

function ensureVerificationChallengeCatalogTables() {
    return memoizeSchemaWork(
        () => verificationCatalogTablesReady,
        (ready) => { verificationCatalogTablesReady = ready; },
        () => createVerificationCatalogTables(getDatabase()),
    );
}

async function ensureVerificationAutokickTables() {
    await ensureVerificationGuildSettingsTable();
    await ensureVerificationAutokickQueueTable();
}

async function ensureVerificationSchema() {
    await Promise.all([
        ensureVerificationAutokickTables(),
        ensureVerificationChallengeCatalogTables(),
    ]);
}

module.exports = {
    ensureVerificationAutokickQueueTable,
    ensureVerificationAutokickTables,
    ensureVerificationChallengeCatalogTables,
    ensureVerificationGuildSettingsTable,
    ensureVerificationSchema,
};
