'use strict';

const { createApplicationEncryption } = require('../../../encryption/applicationEncryption');

// This preserves the established Leaderboards environment contract and its
// warden:* AAD contexts while making the primitive reusable by other identities.
module.exports = createApplicationEncryption({
    identity: 'warden',
    activeVersionEnv: 'WARDEN_DATA_ACTIVE_KEY_VERSION',
    encryptionKeyEnvPrefix: 'WARDEN_DATA_ENCRYPTION_KEY_V',
    lookupKeyEnv: 'WARDEN_DATA_LOOKUP_KEY',
    requireLookup: true,
});
