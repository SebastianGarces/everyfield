# Backup and recovery runbook (T-627, WP-095)

For the operator of the restricted host, Sebastian's Mac. The contract is `docs/architecture/recovery.md`. The measured
drill is `docs/runbooks/recovery-drill-2026-11-24.md`. Nothing here closes G-RECOVERY; WP-058 does that.

Every command below is `node ops/maintenance/cli.mts <command> --config <directory>` from a checkout with its
dependencies installed. It prints JSON. It exits 0 when its check passes, 2 when it ran and its check fails, and 1 when it
refused or could not run. It never prints a key or a connection string.

## What is proven, and what is not

Proven by the drill and the tests:

- A wiped church comes back from Neon history within the 1-hour and 4-hour targets, on drill data.
- A real encrypted copy in `everyfield-backup` restores and its stored objects hold no known plaintext.
- Deleted logins, sent mail and published issues stay deleted, sent and published after a restore.
- Expired copies leave the bucket with no recoverable version, and the check fails if the bucket would keep them.
- The backup key is refused on the app's buckets, and a copy does not open without the encryption key.

Not proven:

- Anything on production data, size or credentials. No production backup has run.
- The schedule running unattended. Seats ran the job by hand.
- A seven-day Neon history. The project keeps 24 hours.
- Object history of the app's own bucket. If a mistake deletes files too, their bytes come from the newest daily copy.
- Current deletion witnesses when the live database is lost. The five-minute witness synchronization is not built.
- Any recovery from an outage of the one storage provider.
- Item T-627 (the last owner step below).

Owner steps, all still open:

1. Load the schedule ("Schedule").
2. Keep a second copy of the encryption key ("Keys").
3. Approve a production source ("Production source").
4. Restrict the existing keys, then run the probe ("Key restriction"). Until then `backup-status` fails with
   `app_key_restriction_open` and the gate stays blocked.

## Configuration directory

Use `~/.config/everyfield-backup`, mode 700, outside every checkout. Every file in it is mode 600.

| File | What it holds |
|---|---|
| `control.json` | Who may run what, where and until when (below) |
| `tigris.env` | The backup bucket key, `AWS_*` names. `control.json` may name another path in `bucketKey` |
| `backup.key` | The 32-byte encryption key |
| `source.env` | `DATABASE_URL_UNPOOLED`, and `AWS_*` with `AWS_BUCKET_NAME` for the files of the database it names |
| `app-key-probe.json` | Written by `bucket-probe --keys`. Read by `backup-status` |

`control.json`:

    {
      "version": 1, "host": "<hostname>", "uid": 501, "environment": "development",
      "context": "restricted-backup", "expiresAt": "<ISO time>",
      "operations": ["backup-daily", "backup-expire", "backup-status"],
      "database": { "host": "...", "name": "...", "role": "...", "schema": "public" }
    }

`backup-*`, `bucket-*` and `schedule-*` need the context `restricted-backup`. `restore-*` and `deletion-check` need
`restricted-recovery`, so recovery uses its own directory. Use a read-only database role and a read-only file key for
`source.env`. The daily job stops when `expiresAt` passes; renew it before then.

A database is a source or a target by what it is, not by what the file says:

- `127.0.0.1` with the database `everyfield_ci`: disposable.
- A Neon branch named `drill-...` whose ancestors lead to the development branch: drill. The command asks Neon.
- The shared development endpoint: development.
- Everything else: production, which is refused without the owner's approval.

## Keys

The bucket key and the encryption key are separate. The bucket key alone opens nothing.

1. `backup-key-create` writes `backup.key`. It never overwrites one.
2. Make the second copy now. Print it with `xxd -p -c 64 ~/.config/everyfield-backup/backup.key` in a private terminal
   and store the line in the owner's password manager. Check it: compare `shasum -a 256` of the file with that of the
   line turned back into bytes by `xxd -r -p`.
3. To recover the key, write the line back with `xxd -r -p`, set mode 600, then open the newest copy with `restore-copy`.

If both copies are lost, every stored copy is unreadable. If the key leaks, create a new key in a new directory, run
`backup-daily`, and let the old copies expire.

## Daily copies

- `backup-daily` captures the database at one consistent point and every ready file, encrypts on the host, uploads, reads
  back and opens the copy. It then deletes expired copies and prints the status. A copy is complete only after the
  read-back.
- `backup-expire` deletes every copy at or past its effective expiry, then lists versions and deleted objects.
  `expiry_proven` is false while a deleted copy could be recovered.
- `backup-status` reads the bucket. It shows each copy's date, age, size and expiry, and each of the last 7 days as
  `complete`, `due`, `failed` or `missed`. A failed or missed day is never a fallback. `daily_fallback_eligible` needs a
  complete copy at most 24 hours old.
- Daily copies cover 7 days. Each expires 6 days 22 hours after its capture point. The 2 hours leave the hourly expiry
  job time to run, so a purged church's data leaves the bucket within 7 days of its purge. If the Mac sleeps past that,
  `backup-status` reports `expired_copy_remains`. Run `backup-expire` at once.
- A copy restores only with the migrations it was made with. Its manifest names the commit; check that commit out when a
  restore is refused with `schema_mismatch`.
- One object, database or file, may be at most 256 MiB.

## Schedule

1. Use the home checkout, not a worktree.
2. `schedule-install` writes `app.everyfield.backup-daily.plist` (03:30 local) and `app.everyfield.backup-expire.plist`
   (hourly) to `~/Library/LaunchAgents`. `--agents <directory>` writes elsewhere, for a dry run. The files hold paths
   only, no secret.
3. `schedule-install --load` also loads them into launchd. Only the owner does this. It is refused from a worktree.
4. `schedule-uninstall --load` unloads and removes them.

Logs go to `logs/` in the configuration directory. Trust `backup-status`, not the log.

## Production source

The job refuses a production database or the `everyfield` bucket with `production_source_refused`. To allow one, the owner
adds this to `control.json`. It must name the exact host and bucket in `source.env`:

    "production": { "host": "...", "bucket": "everyfield", "approvedBy": "owner", "approvedAt": "<ISO time>" }

## Key restriction

- `bucket-probe` asks whether the backup key can list or read the app's buckets. It must print `refused` everywhere.
- `bucket-probe --keys production=<file> --keys preview=<file> --keys development=<file>` takes one private `AWS_*` file
  per app key, kept outside the checkout. It prints only `allowed`, `refused` or `unknown` for list, read, write and
  delete in the backup bucket, and saves the answer. The item closes when all three keys are refused everything. Delete
  the key files afterward.

## Recover from a mistake

1. Stop the live service from taking more work, and note the time of the mistake.
2. Make a branch from history. For a drill:
   `neonctl api /projects/<project>/branches -X POST -d '{"branch":{"name":"drill-<name>","parent_id":"<source branch>","parent_timestamp":"<just before the mistake>"},"endpoints":[{"type":"read_write"}]}'`
3. `backup-capture --history --out <new private directory>` with a `restricted-backup` directory whose `source.env` names
   that branch. The snapshot carries the recovery point Neon reports.
4. `restore-copy --snapshot <directory> --target <new schema> --current <live directory> --incident <ISO time>` with a
   `restricted-recovery` directory whose `source.env` names the isolated target. `--current` is the directory for the
   surviving live database. Its deletion witnesses and receipts win over the snapshot. The result gives the lost work and
   the restore time. The target stays closed.
5. `restore-open --target <schema>` ends every restored session and lets the app logins in. It opens only a schema that
   `restore-copy` left closed, on a disposable or drill database.
6. Sign in, check the data, then delete the branch, the schema and the snapshot.

From a daily copy instead, replace steps 2 to 4 with `restore-copy --copy <location from backup-status>`.

## Check a church deletion

`deletion-check --subject <church id>` with a `restricted-recovery` directory. `purged` means the witness is purged, no
row or file of the church remains, the copy expiry is at most 7 days after the purge, and every stored copy from before
the purge ends by then. Otherwise it lists what is left and exits 2. `cancel_allowed` is true only before the deadline.
