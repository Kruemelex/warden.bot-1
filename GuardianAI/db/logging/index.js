'use strict';

const database = require('../database');
const encryption = require('../encryption/applicationEncryption');
const { createLoggingSettingsRepository } = require('../../../logging/loggingSettings/repository');

module.exports = createLoggingSettingsRepository({
    database,
    encryption,
    tableName: 'guardianai_logging_settings',
    context: 'guardianai:logging-settings:payload',
});
