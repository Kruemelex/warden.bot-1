'use strict';

const CHANNEL_COLUMNS = Object.freeze({
    general: 'general_log_channel_id',
    users: 'user_log_channel_id',
    messages: 'message_audit_channel_id',
    error: 'error_log_channel_id',
    staff: 'staff_log_channel_id',
    approvals: 'leaderboard_approval_channel_id',
});

function createLoggingSettingsRepository({ database, tableName }) {
    if (!database?.query) throw new TypeError('Logging settings require a database query adapter.');
    if (!/^[a-z][a-z0-9_]*$/u.test(String(tableName))) {
        throw new TypeError('Logging settings require a safe table name.');
    }

    let schemaReady;

    function ensureSchema() {
        if (!schemaReady) {
            schemaReady = database.query(`
                CREATE TABLE IF NOT EXISTS ${tableName} (
                    guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
                    general_log_channel_id VARCHAR(32) NULL,
                    user_log_channel_id VARCHAR(32) NULL,
                    message_audit_channel_id VARCHAR(32) NULL,
                    error_log_channel_id VARCHAR(32) NULL,
                    staff_log_channel_id VARCHAR(32) NULL,
                    leaderboard_approval_channel_id VARCHAR(32) NULL,
                    settings_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    updated_by VARCHAR(32) NULL,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            `).catch((error) => {
                schemaReady = undefined;
                throw error;
            });
        }
        return schemaReady;
    }

    function mapRow(row) {
        if (!row) return undefined;
        return Object.freeze({
            guildId: String(row.guild_id),
            channels: Object.freeze(Object.fromEntries(Object.entries(CHANNEL_COLUMNS).map(([key, column]) => [
                key,
                row[column] == null ? null : String(row[column]),
            ]))),
            settingsRevision: Number(row.settings_revision),
            updatedBy: row.updated_by == null ? null : String(row.updated_by),
            updatedAt: row.updated_at ?? null,
        });
    }

    async function read(guildId) {
        await ensureSchema();
        const rows = await database.query(
            `SELECT * FROM ${tableName} WHERE guild_id = ? LIMIT 1`,
            [String(guildId)],
        );
        return mapRow(rows?.[0]);
    }

    async function seed(guildId, channels) {
        await ensureSchema();
        await database.query(
            `INSERT IGNORE INTO ${tableName} (
                guild_id, general_log_channel_id, user_log_channel_id, message_audit_channel_id,
                error_log_channel_id, staff_log_channel_id, leaderboard_approval_channel_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                String(guildId), channels.general, channels.users,
                channels.messages, channels.error, channels.staff, channels.approvals,
            ],
        );
        return read(guildId);
    }

    async function update(guildId, patch, expectedRevision, updatedBy) {
        const assignments = [];
        const values = [];
        for (const [key, value] of Object.entries(patch.channels ?? {})) {
            const column = CHANNEL_COLUMNS[key];
            if (!column) throw new Error(`Unknown logging channel setting: ${key}`);
            assignments.push(`${column} = ?`);
            values.push(value || null);
        }
        if (assignments.length < 1) return read(guildId);
        assignments.push(
            'settings_revision = settings_revision + 1',
            'updated_by = ?',
            'updated_at = CURRENT_TIMESTAMP',
        );
        values.push(updatedBy ? String(updatedBy) : null, String(guildId), Number(expectedRevision));
        const result = await database.query(
            `UPDATE ${tableName} SET ${assignments.join(', ')}
             WHERE guild_id = ? AND settings_revision = ?`,
            values,
        );
        if (result?.affectedRows !== 1) {
            const error = new Error('Logging settings were changed by another administrator. Reopen the panel and try again.');
            error.code = 'LOGGING_SETTINGS_CONFLICT';
            throw error;
        }
        return read(guildId);
    }

    return Object.freeze({ ensureSchema, read, seed, update });
}

module.exports = {
    CHANNEL_COLUMNS,
    createLoggingSettingsRepository,
};
