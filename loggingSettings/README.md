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
is changed accordingly.
