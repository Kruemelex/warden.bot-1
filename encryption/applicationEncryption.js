'use strict';

const crypto = require('node:crypto');

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function createApplicationEncryption({
    identity,
    activeVersionEnv,
    encryptionKeyEnvPrefix,
    lookupKeyEnv,
    requireLookup = false,
} = {}) {
    const normalizedIdentity = String(identity ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{2,31}$/u.test(normalizedIdentity)) {
        throw new TypeError('Application encryption requires a stable identity name.');
    }
    for (const [name, value] of Object.entries({
        activeVersionEnv,
        encryptionKeyEnvPrefix,
        ...(lookupKeyEnv ? { lookupKeyEnv } : {}),
    })) {
        if (!/^[A-Z][A-Z0-9_]*$/u.test(String(value ?? ''))) {
            throw new TypeError(`Application encryption requires a valid ${name}.`);
        }
    }
    if (requireLookup && !lookupKeyEnv) {
        throw new TypeError('Application encryption lookup requires a lookup-key environment variable.');
    }

    function parseVersion(value) {
        const version = Number(value ?? 1);
        if (!Number.isSafeInteger(version) || version < 1 || version > 65535) {
            throw new Error(`${activeVersionEnv} must be an integer between 1 and 65535.`);
        }
        return version;
    }

    function decodeKey(value, label) {
        const encoded = String(value ?? '').trim();
        const key = Buffer.from(encoded, 'base64');
        const canonical = key.toString('base64').replace(/=+$/u, '');
        if (key.length !== KEY_BYTES || canonical !== encoded.replace(/=+$/u, '')) {
            throw new Error(`${label} must be a Base64-encoded 32-byte random key.`);
        }
        return key;
    }

    function getEncryptionKey(version) {
        const label = `${encryptionKeyEnvPrefix}${version}`;
        return decodeKey(process.env[label], label);
    }

    function getLookupKey() {
        if (!lookupKeyEnv) throw new Error(`${normalizedIdentity} application encryption does not configure a lookup key.`);
        return decodeKey(process.env[lookupKeyEnv], lookupKeyEnv);
    }

    function normalizeContext(value) {
        const context = String(value ?? '').trim();
        if (!/^[a-z0-9][a-z0-9:._-]{2,127}$/u.test(context)
            || !context.startsWith(`${normalizedIdentity}:`)) {
            throw new Error(`Application encryption context must be namespaced to ${normalizedIdentity}.`);
        }
        return context;
    }

    function encryptJson(context, value) {
        const normalizedContext = normalizeContext(context);
        const keyVersion = parseVersion(process.env[activeVersionEnv]);
        const nonce = crypto.randomBytes(NONCE_BYTES);
        const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(keyVersion), nonce, {
            authTagLength: TAG_BYTES,
        });
        cipher.setAAD(Buffer.from(normalizedContext, 'utf8'));
        const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Object.freeze({
            keyVersion,
            nonce,
            tag: cipher.getAuthTag(),
            ciphertext,
        });
    }

    function decryptJson(context, record) {
        const normalizedContext = normalizeContext(context);
        const keyVersion = parseVersion(record?.keyVersion);
        const nonce = Buffer.from(record?.nonce ?? []);
        const tag = Buffer.from(record?.tag ?? []);
        const ciphertext = Buffer.from(record?.ciphertext ?? []);
        if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || ciphertext.length < 1) {
            throw new Error('Encrypted application payload is malformed.');
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(keyVersion), nonce, {
            authTagLength: TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(normalizedContext, 'utf8'));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return JSON.parse(plaintext.toString('utf8'));
    }

    function createLookup(context, value, { normalize = false } = {}) {
        const normalizedContext = normalizeContext(context);
        const input = normalize
            ? String(value ?? '').trim().toLowerCase()
            : String(value ?? '').trim();
        if (!input) throw new Error(`Application lookup ${normalizedContext} cannot be empty.`);
        return crypto.createHmac('sha256', getLookupKey())
            .update(normalizedContext, 'utf8')
            .update('\0', 'utf8')
            .update(input, 'utf8')
            .digest();
    }

    function assertApplicationEncryptionReady() {
        const keyVersion = parseVersion(process.env[activeVersionEnv]);
        getEncryptionKey(keyVersion);
        if (requireLookup) getLookupKey();
        return Object.freeze({ keyVersion });
    }

    function isApplicationEncryptionConfigured() {
        const version = parseVersion(process.env[activeVersionEnv]);
        return Boolean(
            String(process.env[`${encryptionKeyEnvPrefix}${version}`] ?? '').trim()
            && (!requireLookup || String(process.env[lookupKeyEnv] ?? '').trim()),
        );
    }

    return Object.freeze({
        assertApplicationEncryptionReady,
        createLookup,
        decryptJson,
        encryptJson,
        isApplicationEncryptionConfigured,
    });
}

module.exports = {
    createApplicationEncryption,
};
