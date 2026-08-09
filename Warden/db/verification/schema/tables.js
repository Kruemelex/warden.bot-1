'use strict';

const CATALOG_TABLE_NAMES = Object.freeze([
    'verification_challenge_catalog',
    'verification_question_catalog',
]);
const REQUIRED_GUILD_SETTINGS_COLUMNS = Object.freeze([
    'guild_id', 'verification_role_id', 'mode', 'active_challenge_ids_json',
    'verification_posts_json', 'challenge_expiry_seconds', 'cooldown_seconds',
    'autokick_enabled', 'autokick_enabled_since_ms', 'autokick_seconds',
    'settings_revision', 'updated_by', 'updated_at',
]);
const REQUIRED_AUTOKICK_QUEUE_COLUMNS = Object.freeze([
    'guild_id', 'user_id', 'joined_at_ms', 'phase', 'deadline_stage', 'active_slot', 'kick_due_at_ms',
    'countdown_seconds', 'next_attempt_at_ms', 'lease_token', 'lease_expires_at_ms',
    'attempt_count', 'unknown_attempt_count', 'dm_attempted_at_ms', 'kick_intent_at_ms',
    'authorized_role_id', 'kick_succeeded_at_ms', 'terminal_at_ms', 'terminal_reason',
    'dead_lettered_at_ms', 'last_error_code', 'report_status', 'report_nonce',
    'report_dispatched_at_ms', 'report_message_id', 'report_attempt_count',
    'report_next_attempt_at_ms', 'report_lease_token', 'report_lease_expires_at_ms',
    'report_last_error_code', 'report_user_tag', 'report_display_name', 'created_at', 'updated_at',
]);
const REQUIRED_AUTOKICK_QUEUE_INDEXES = Object.freeze({
    PRIMARY: [0, 'guild_id,user_id,joined_at_ms'],
    verification_autokick_active_idx: [0, 'guild_id,user_id,active_slot'],
    verification_autokick_member_idx: [1, 'guild_id,user_id,joined_at_ms'],
    verification_autokick_available_idx: [1, 'guild_id,phase,next_attempt_at_ms,lease_expires_at_ms,user_id'],
    verification_autokick_lease_idx: [1, 'lease_token'],
    verification_autokick_cleanup_idx: [1, 'terminal_at_ms,dead_lettered_at_ms'],
    verification_autokick_report_idx: [1, 'guild_id,report_status,report_next_attempt_at_ms,report_lease_expires_at_ms'],
});

function throwOutdatedSchema(tableName, detail) {
    const error = new Error(`Verification table ${tableName} has an outdated schema: ${detail}.`);
    error.code = 'VERIFICATION_DATABASE_SCHEMA_OUTDATED';
    throw error;
}

async function readTableColumns(database, tableName) {
    const rows = await database.query(
        `SELECT COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable, GENERATION_EXPRESSION AS generationExpression
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [tableName],
    );
    return new Map((rows ?? []).map((row) => [String(row.columnName), row]));
}

function assertRequiredColumns(tableName, columns, requiredColumns) {
    const missing = requiredColumns.filter((columnName) => !columns.has(columnName));
    if (missing.length > 0) throwOutdatedSchema(tableName, `missing ${missing.join(', ')}`);
}

async function assertVerificationAutokickQueueSchema(database) {
    const tableName = 'verification_autokick_queue';
    const columns = await readTableColumns(database, tableName);
    assertRequiredColumns(tableName, columns, REQUIRED_AUTOKICK_QUEUE_COLUMNS);

    const phaseType = String(columns.get('phase')?.columnType ?? '').replace(/\s/g, '').toLowerCase();
    const deadlineStageType = String(columns.get('deadline_stage')?.columnType ?? '').replace(/\s/g, '').toLowerCase();
    const reportType = String(columns.get('report_status')?.columnType ?? '').replace(/\s/g, '').toLowerCase();
    const activeSlotExpression = String(columns.get('active_slot')?.generationExpression ?? '').toLowerCase();
    if (phaseType !== "enum('waiting','verifying','kick_intent','terminal')"
        || deadlineStageType !== "enum('onboarding','verification')"
        || reportType !== "enum('none','pending','sending','sent','delivery_unknown','dead')"
        || columns.get('phase')?.isNullable !== 'NO'
        || columns.get('deadline_stage')?.isNullable !== 'NO'
        || columns.get('report_status')?.isNullable !== 'NO'
        || !activeSlotExpression.includes('phase')
        || !activeSlotExpression.includes('terminal')) {
        throwOutdatedSchema(tableName, 'durable state columns are incompatible');
    }

    const indexRows = await database.query(
        `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequenceNumber, COLUMN_NAME AS columnName
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [tableName],
    );
    const indexes = new Map();
    for (const row of indexRows ?? []) {
        const index = indexes.get(String(row.indexName)) ?? {
            nonUnique: Number(row.nonUnique),
            columns: [],
        };
        index.columns[Number(row.sequenceNumber) - 1] = String(row.columnName);
        indexes.set(String(row.indexName), index);
    }
    for (const [name, [nonUnique, expectedColumns]] of Object.entries(REQUIRED_AUTOKICK_QUEUE_INDEXES)) {
        const actual = indexes.get(name);
        if (!actual || actual.nonUnique !== nonUnique || actual.columns.join(',') !== expectedColumns) {
            throwOutdatedSchema(tableName, `index ${name} is incompatible`);
        }
    }
}

async function assertInnoDB(database, tableNames, {
    code = 'VERIFICATION_DATABASE_ENGINE_UNSUPPORTED',
    message,
} = {}) {
    const names = [].concat(tableNames);
    const placeholders = names.map(() => '?').join(', ');
    const rows = await database.query(
        `SELECT TABLE_NAME AS tableName, ENGINE AS engine
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`,
        names,
    );
    const engines = new Map((rows ?? []).map((row) => [
        String(row.tableName),
        String(row.engine ?? '').toUpperCase(),
    ]));
    const invalidTables = names.filter((tableName) => engines.get(tableName) !== 'INNODB');
    if (invalidTables.length < 1) return;

    const error = new Error(
        message?.(invalidTables)
        ?? `Verification persistence requires ${invalidTables.join(', ')} to use InnoDB.`,
    );
    error.code = code;
    throw error;
}

async function createVerificationGuildSettingsTable(database) {
    await database.query(`
        CREATE TABLE IF NOT EXISTS verification_guild_settings (
            guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
            verification_role_id VARCHAR(32) NULL,
            mode VARCHAR(16) NOT NULL DEFAULT 'challenge',
            active_challenge_ids_json TEXT NULL,
            verification_posts_json TEXT NULL,
            challenge_expiry_seconds INT NULL DEFAULT NULL,
            cooldown_seconds INT NULL DEFAULT NULL,
            autokick_enabled TINYINT(1) NOT NULL DEFAULT 0,
            autokick_enabled_since_ms BIGINT UNSIGNED NULL,
            autokick_seconds INT NULL DEFAULT NULL,
            settings_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
            updated_by VARCHAR(32) NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `);
    await assertInnoDB(database, 'verification_guild_settings');
    assertRequiredColumns(
        'verification_guild_settings',
        await readTableColumns(database, 'verification_guild_settings'),
        REQUIRED_GUILD_SETTINGS_COLUMNS,
    );
}

function buildVerificationAutokickQueueTableSql() {
    return `
        CREATE TABLE IF NOT EXISTS verification_autokick_queue (
            guild_id VARCHAR(32) NOT NULL,
            user_id VARCHAR(32) NOT NULL,
            joined_at_ms BIGINT UNSIGNED NOT NULL,
            phase ENUM('waiting', 'verifying', 'kick_intent', 'terminal')
                CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'waiting',
            deadline_stage ENUM('onboarding', 'verification')
                CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'onboarding',
            active_slot TINYINT GENERATED ALWAYS AS
                (CASE WHEN phase = 'terminal' THEN NULL ELSE 1 END) STORED,
            kick_due_at_ms BIGINT UNSIGNED NULL,
            countdown_seconds INT NULL,
            next_attempt_at_ms BIGINT UNSIGNED NULL,
            lease_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
            lease_expires_at_ms BIGINT UNSIGNED NULL,
            attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
            unknown_attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
            dm_attempted_at_ms BIGINT UNSIGNED NULL,
            kick_intent_at_ms BIGINT UNSIGNED NULL,
            authorized_role_id VARCHAR(32) NULL,
            kick_succeeded_at_ms BIGINT UNSIGNED NULL,
            terminal_at_ms BIGINT UNSIGNED NULL,
            terminal_reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
            dead_lettered_at_ms BIGINT UNSIGNED NULL,
            last_error_code VARCHAR(64) NULL,
            report_status ENUM('none', 'pending', 'sending', 'sent', 'delivery_unknown', 'dead')
                CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'none',
            report_nonce VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
            report_dispatched_at_ms BIGINT UNSIGNED NULL,
            report_message_id VARCHAR(32) NULL,
            report_attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
            report_next_attempt_at_ms BIGINT UNSIGNED NULL,
            report_lease_token VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
            report_lease_expires_at_ms BIGINT UNSIGNED NULL,
            report_last_error_code VARCHAR(64) NULL,
            report_user_tag VARCHAR(128) NULL,
            report_display_name VARCHAR(128) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id, joined_at_ms),
            UNIQUE INDEX verification_autokick_active_idx (guild_id, user_id, active_slot),
            INDEX verification_autokick_member_idx (guild_id, user_id, joined_at_ms),
            INDEX verification_autokick_available_idx
                (guild_id, phase, next_attempt_at_ms, lease_expires_at_ms, user_id),
            INDEX verification_autokick_lease_idx (lease_token),
            INDEX verification_autokick_cleanup_idx (terminal_at_ms, dead_lettered_at_ms),
            INDEX verification_autokick_report_idx
                (guild_id, report_status, report_next_attempt_at_ms, report_lease_expires_at_ms)
        ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `;
}

async function createVerificationAutokickQueueTable(database) {
    await database.query(buildVerificationAutokickQueueTableSql());
    await assertInnoDB(database, 'verification_autokick_queue');
    await assertVerificationAutokickQueueSchema(database);
}

async function createVerificationCatalogTables(database) {
    await Promise.all([
        database.query(`
            CREATE TABLE IF NOT EXISTS verification_challenge_catalog (
            guild_id VARCHAR(32) NOT NULL,
            challenge_id VARCHAR(128) NOT NULL,
            source_type VARCHAR(32) NOT NULL DEFAULT 'admin',
            source_template_id VARCHAR(128) NULL,
            template_version INT NOT NULL DEFAULT 1,
            protected_template TINYINT(1) NOT NULL DEFAULT 0,
            title TEXT NULL,
            description TEXT NULL,
            color VARCHAR(32) NULL,
            fields_json TEXT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            deleted_at TIMESTAMP NULL DEFAULT NULL,
            created_by VARCHAR(32) NULL,
            updated_by VARCHAR(32) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, challenge_id),
            INDEX idx_verification_challenge_catalog_template (source_template_id),
            INDEX idx_verification_challenge_catalog_deleted (deleted_at)
            ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `),
        database.query(`
            CREATE TABLE IF NOT EXISTS verification_question_catalog (
            guild_id VARCHAR(32) NOT NULL,
            challenge_id VARCHAR(128) NOT NULL,
            question_id VARCHAR(128) NOT NULL,
            question_order INT NULL,
            source_type VARCHAR(32) NOT NULL DEFAULT 'admin',
            source_template_id VARCHAR(128) NULL,
            template_version INT NOT NULL DEFAULT 1,
            protected_template TINYINT(1) NOT NULL DEFAULT 0,
            question_label VARCHAR(128) NULL,
            question_text TEXT NULL,
            separate_step TINYINT(1) NULL,
            task_enabled TINYINT(1) NULL,
            task_type VARCHAR(64) NULL,
            task_prompt_text TEXT NULL,
            task_image_ids_json TEXT NULL,
            task_image_directions_json TEXT NULL,
            task_config_json TEXT NULL,
            answer_required TINYINT(1) NULL,
            answer_type VARCHAR(64) NULL,
            answer_input_label VARCHAR(128) NULL,
            answer_input_placeholder VARCHAR(256) NULL,
            answers_json TEXT NULL,
            deleted_at TIMESTAMP NULL DEFAULT NULL,
            created_by VARCHAR(32) NULL,
            updated_by VARCHAR(32) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, challenge_id, question_id),
            INDEX idx_verification_question_catalog_challenge (guild_id, challenge_id),
            INDEX idx_verification_question_catalog_deleted (deleted_at)
            ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
        `),
    ]);
    await assertInnoDB(database, CATALOG_TABLE_NAMES, {
        code: 'VERIFICATION_CATALOG_ENGINE_REQUIRED',
        message: (invalidTables) =>
            `Verification catalog tables require InnoDB: ${invalidTables.join(', ')}.`,
    });
}

module.exports = {
    createVerificationAutokickQueueTable,
    createVerificationCatalogTables,
    createVerificationGuildSettingsTable,
};
