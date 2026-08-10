'use strict';

const database = require('../database');

const TABLES = Object.freeze({
    speedrun: 'speedrun_encrypted',
    ace: 'ace_encrypted',
});

let schemaReady;

function ensureLeaderboardSchema() {
    if (!schemaReady) {
        schemaReady = Promise.all([
            database.query(`
                CREATE TABLE IF NOT EXISTS speedrun_encrypted (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    approval TINYINT(1) NOT NULL DEFAULT 0,
                    submitted_at_ms BIGINT UNSIGNED NOT NULL,
                    submission_nonce BINARY(16) NOT NULL,
                    user_lookup BINARY(32) NOT NULL,
                    variant_lookup BINARY(32) NOT NULL,
                    class_lookup BINARY(32) NOT NULL,
                    key_version SMALLINT UNSIGNED NOT NULL,
                    payload_nonce BINARY(12) NOT NULL,
                    payload_tag BINARY(16) NOT NULL,
                    encrypted_payload MEDIUMBLOB NOT NULL,
                    row_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE INDEX speedrun_encrypted_nonce_idx (submission_nonce),
                    INDEX speedrun_encrypted_pending_idx (approval, id),
                    INDEX speedrun_encrypted_user_idx (user_lookup, variant_lookup, class_lookup, approval),
                    INDEX speedrun_encrypted_board_idx (variant_lookup, class_lookup, approval)
                ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            `),
            database.query(`
                CREATE TABLE IF NOT EXISTS ace_encrypted (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    approval TINYINT(1) NOT NULL DEFAULT 0,
                    submitted_at_ms BIGINT UNSIGNED NOT NULL,
                    submission_nonce BINARY(16) NOT NULL,
                    user_lookup BINARY(32) NOT NULL,
                    shiptype_lookup BINARY(32) NOT NULL,
                    key_version SMALLINT UNSIGNED NOT NULL,
                    payload_nonce BINARY(12) NOT NULL,
                    payload_tag BINARY(16) NOT NULL,
                    encrypted_payload MEDIUMBLOB NOT NULL,
                    row_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE INDEX ace_encrypted_nonce_idx (submission_nonce),
                    INDEX ace_encrypted_pending_idx (approval, id),
                    INDEX ace_encrypted_user_idx (user_lookup, shiptype_lookup, approval),
                    INDEX ace_encrypted_board_idx (shiptype_lookup, approval)
                ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
            `),
        ]).catch((error) => {
            schemaReady = undefined;
            throw error;
        });
    }
    return schemaReady;
}

module.exports = {
    TABLES,
    ensureLeaderboardSchema,
};
