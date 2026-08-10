# Logging Settings encryption

Each bot stores logging settings in its own encrypted table. The only queryable
identifier is a keyed HMAC lookup of the guild ID; the guild ID, all channel
IDs, and the administrator ID are inside an AES-256-GCM encrypted payload.

Warden uses the existing Leaderboards key material:

```text
WARDEN_DATA_ACTIVE_KEY_VERSION=1
WARDEN_DATA_ENCRYPTION_KEY_V1=<Base64 32-byte key>
WARDEN_DATA_LOOKUP_KEY=<different Base64 32-byte key>
```

GuardianAI uses separate key material:

```text
GUARDIANAI_DATA_ACTIVE_KEY_VERSION=1
GUARDIANAI_DATA_ENCRYPTION_KEY_V1=<Base64 32-byte key>
GUARDIANAI_DATA_LOOKUP_KEY=<different Base64 32-byte key>
```

The active encryption key version can be advanced when a matching versioned key
is deployed. Keep every historical encryption key configured until every row has
been read and rewritten with the new active version and that result has been
verified; changing the active version alone does not rotate untouched rows. The
lookup key must remain stable while existing settings rows are in use.

This schema is the initial production shape. It intentionally has no plaintext
compatibility or automatic migration path; an existing plaintext table with the
same name must be migrated separately before deploying this version.
