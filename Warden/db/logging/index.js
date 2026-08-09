'use strict';

const database = require('../database');
const { createLoggingSettingsRepository } = require('../../../loggingSettings/repository');

module.exports = createLoggingSettingsRepository({
    database,
    tableName: 'warden_logging_settings',
});
