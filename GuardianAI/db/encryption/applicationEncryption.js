'use strict';

const { createApplicationEncryption } = require('../../../encryption/applicationEncryption');

module.exports = createApplicationEncryption({
    identity: 'guardianai',
    activeVersionEnv: 'GUARDIANAI_DATA_ACTIVE_KEY_VERSION',
    encryptionKeyEnvPrefix: 'GUARDIANAI_DATA_ENCRYPTION_KEY_V',
    lookupKeyEnv: 'GUARDIANAI_DATA_LOOKUP_KEY',
    requireLookup: true,
});
