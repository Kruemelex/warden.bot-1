# Leaderboard storage

The normal `/speedrun`, `/ace`, and `/leaderboard` workflows use `speedrun_encrypted` and `ace_encrypted` as their sole runtime authority. Payloads use AES-256-GCM authenticated encryption. Searchable grouping values are stored only as keyed HMAC-SHA256 lookups. The plaintext `speedrun` and `ace` tables may remain as read-only rollback backups during rollout, but runtime code does not read or write them.

## 1. Configure keys

Generate two independent keys in a trusted terminal:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store them in the bot host environment, never in Git or phpMyAdmin:

```text
WARDEN_DATA_ACTIVE_KEY_VERSION=1
WARDEN_DATA_ENCRYPTION_KEY_V1=<first Base64 key>
WARDEN_DATA_LOOKUP_KEY=<second Base64 key>
```

Keep an offline backup. Losing either key makes encrypted records unusable. Rotating the lookup key requires rebuilding the lookup columns.

## 2. Create the tables

The bot creates both tables automatically when Leaderboard storage or migration first runs. To create them manually in phpMyAdmin, open the Warden database, select **SQL**, and run the two `CREATE TABLE IF NOT EXISTS` statements from `schema.js`.

Do not use MySQL `AES_ENCRYPT` to copy the rows. That would be a different, unauthenticated storage format and would require exposing the application key to the database and phpMyAdmin session.

## 3. Copy and encrypt legacy rows

Before switching a production deployment, set `WARDEN_LEADERBOARD_MIGRATION_MODE=true` on every Warden instance and restart them. This blocks Leaderboard submissions and Staff mutations and skips startup approval-post reconciliation while leaving unrelated bot features available.

Run `/leaderboard-migration dry-run`. Its preflight rejects orphan encrypted rows and same-ID rows whose decrypted values differ from the legacy source, preventing old test data from silently becoming authoritative. If it passes, run `/leaderboard-migration execute confirmation:MIGRATE`. The migration reads legacy rows in batches, encrypts each row in Node.js, and preserves both its existing internal `id` and approval-message ID. Matching rows make it safely restartable. A post-copy audit decrypts and compares the final rows and requires exact source/target counts.

After the success response, remove `WARDEN_LEADERBOARD_MIGRATION_MODE` from every instance and restart Warden. Normal startup reconciliation will then refresh or recreate pending Staff approval posts. Do not remove the maintenance flag after a failed or interrupted migration; correct the reported conflict and safely rerun the command.

Any website, SQL view, or other external consumer that still reads the plaintext tables must be identified before cutover. Those rollback tables stop receiving runtime writes once this implementation is active.

Verify counts in phpMyAdmin:

```sql
SELECT 'speedrun' AS source, COUNT(*) AS rows_found FROM speedrun
UNION ALL
SELECT 'speedrun_encrypted', COUNT(*) FROM speedrun_encrypted
UNION ALL
SELECT 'ace', COUNT(*) FROM ace
UNION ALL
SELECT 'ace_encrypted', COUNT(*) FROM ace_encrypted;
```

The encrypted tables intentionally do not expose Discord IDs or submission details as readable SQL columns. Validate application-level readability through the normal `/leaderboard` command after migration.

## Website publishing

Warden can push a public, signed snapshot of approved Leaderboards to the AXI Leaderboards WordPress plugin. This uses the encrypted greenfield `warden_leaderboard_settings` table, created automatically when `/leaderboard-settings` is opened or website publishing starts. It stores the configured guild ID, mode, publishing switch, and revision metadata under the same application-encryption keys above; it has no plaintext or legacy-table fallback.

Configure a separate shared signing secret on the bot host and in the WordPress plugin—not an application-encryption key:

```text
AXI_LEADERBOARDS_SYNC_URL=https://antixenoinitiative.com/wp-json/axi-leaderboards/v1/sync
AXI_LEADERBOARDS_SYNC_KEY_ID=warden-v1
AXI_LEADERBOARDS_SYNC_SECRET=<independent high-entropy secret>
```

If WordPress is installed below a path such as `/wp`, include it in the endpoint URL: `https://example.com/wp/wp-json/axi-leaderboards/v1/sync`. The signed route identity remains `/axi-leaderboards/v1/sync`.

Warden posts HMAC-SHA256 signed HTTPS payloads only after it has fully started, after a newly approved submission, once daily, or when an administrator selects **Sync Website** in `/leaderboard-settings`. The website never receives Discord user IDs, Staff comments, approval-message IDs, encryption keys, HMAC lookups, or encrypted database payloads. A missing complete website configuration leaves ordinary Leaderboard functionality available and simply disables automatic publishing.

`/leaderboard-settings` defaults to Administrator permission and can be overridden in Discord’s Integrations settings. Its **Maintenance** mode blocks new `/speedrun` and `/ace` submissions and Staff approval/edit/deny actions, but keeps read-only `/leaderboard`, website sync, and approval-post reconciliation available. Separate **Speedrun Submissions** and **Ace Submissions** settings can halt every newly submitted entry of one type without pausing the other type or Staff actions; halting Ace submissions does not disable calculation-only `/ace` use. `WARDEN_LEADERBOARD_MIGRATION_MODE=true` remains the higher-priority safeguard and blocks Leaderboard writes, reconciliation, and website publishing.
