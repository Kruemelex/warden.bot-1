'use strict';

const database = require('../database');
const { createLoggingSettingsRepository } = require('../../../loggingSettings/repository');

module.exports = createLoggingSettingsRepository({
    database,
    tableName: 'guardianai_logging_settings',
});
