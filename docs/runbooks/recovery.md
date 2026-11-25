# Backup and recovery runbook (T-627, WP-095)

For the operator of the restricted host, Sebastian's Mac. The contract is `docs/architecture/recovery.md`. The measured
drill is `docs/runbooks/recovery-drill-2026-11-24.md`. Nothing here closes G-RECOVERY; WP-058 does that.

Every command below is `node ops/maintenance/cli.mts <command> --config <directory>` from a checkout with its
dependencies installed. It prints JSON. It exits 0 when its check passes, 2 when it ran and its check fails, and 1 when it
refused or could not run. It never prints a key or a connection string.

**Production backups are off until go-live.** They are turned on only at go-live and only on Sebastian's words. Until then
nobody loads the schedule, approves a production source or creates a production key. Backups are tested on disposable or
drill data with a throwaway key ("Test on disposable data").

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

Open now: restrict the existing keys, then run the probe ("Key restriction"). Until then `backup-status` fails with
`app_key_restriction_open` and the gate stays blocked.

Only at go-live, and only on Sebastian's words, in this order: create the key and keep its second copy ("Keys"), approve
the production source ("Production source"), then change and load the schedule ("Schedule").

## Configuration directory

Use `~/.config/everyfield-backup`, mode 700, outside every checkout. Every file in it is mode 600.

| File | What it holds |
|---|---|
| `control.json` | Who may run what, where and until when (below) |
| `tigris.env` | The backup bucket key, `AWS_*` names. `control.json` may name another path in `bucketKey` |
| `source.env` | `DATABASE_URL_UNPOOLED`, and `AWS_*` with `AWS_BUCKET_NAME` for the files of the database it names |
| `app-key-probe.json` | Written by `bucket-probe --keys`. Read by `backup-status` |

The encryption key is in none of them. No command reads or writes a key file.

`control.json`:

```json
{
  "version": 1, "host": "<hostname>", "uid": 501, "environment": "development",
  "context": "restricted-backup", "expiresAt": "<ISO time>",
  "operations": ["backup-daily", "backup-expire", "backup-status"],
  "database": { "host": "...", "name": "...", "role": "...", "schema": "public" }
}
```

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

The encryption key is the environment variable `EVERYFIELD_BACKUP_KEY`: exactly 64 hex characters, with no space or line
end. `backup-daily`, `backup-copy` and `restore-copy --copy` need it. Every other command works without it. A missing or
malformed value stops the command before it reads or stores anything, with a message that names the variable and never the
value. Every command drops the variable from its environment before it starts another program. While a command runs, the
same macOS user and root can still see the environment the command started with.

Never put the key in a shell profile, an `.env*` file, a plist, a command argument, the app or Vercel.

### Set it for one command

From the Keychain item made below, one per key, named by the day it was made:

```sh
EVERYFIELD_BACKUP_KEY="$(security find-generic-password -s everyfield-backup-key-<date> -w)" \
  node ops/maintenance/cli.mts backup-daily --config ~/.config/everyfield-backup
```

From the password manager: type this, press Return, paste the key and press Return. The paste is not shown, and the
variable ends with the parentheses. This works in zsh and bash.

```sh
( IFS= read -rs EVERYFIELD_BACKUP_KEY; export EVERYFIELD_BACKUP_KEY
  node ops/maintenance/cli.mts backup-daily --config ~/.config/everyfield-backup )
```

The shell history holds the command, never the value.

### Create it (only at go-live)

Run this in a private terminal on the restricted host. It prints nothing but the check. The key goes to the login Keychain
and, through the clipboard, to the owner's password manager. First turn off clipboard managers and Universal Clipboard.

```sh
item="everyfield-backup-key-$(date +%F)"
printf 'add-generic-password -a %s -s %s -w %s\n' "$USER" "$item" "$(openssl rand -hex 32)" | security -i
security find-generic-password -s "$item" -w | tr -d '\n' | pbcopy
```

`printf` is built into the shell, so the value is no program's argument. `add-generic-password` without `-U` never
replaces an item. A second key on one day needs another name.

1. Paste into a new entry of the owner's password manager, named like the Keychain item. Then clear the clipboard:
   `pbcopy < /dev/null`.
2. Check the second copy. Copy it back from the password manager, then:
   `[ -n "$(pbpaste)" ] && [ "$(pbpaste)" = "$(security find-generic-password -s "$item" -w)" ] && echo match`, and clear the clipboard again.
3. `match` proves the two copies are the same. Run `backup-daily`, then open its copy with the second copy: `restore-copy
   --copy` with the password manager form above, into a drill target.

### Recover it

If the Keychain item is lost, use the password manager form above with `restore-copy`. To put the key back in the Keychain,
paste it without showing it:

```sh
( IFS= read -rs key; printf 'add-generic-password -a %s -s %s -w %s\n' "$USER" everyfield-backup-key-<date> "$key" |
  security -i )
```

### Rotate it

A copy does not say which key sealed it; only its time does. `--recopy` opens and seals with one key, so it moves no copy
to a new key.

1. Create the new key and check its second copy. Keep the old key in both places.
2. Name the new item in the schedule and reload it. Note the time. Run `backup-daily` by hand; it opens the copy it made.
3. Every copy with a `created_at` before that time needs the old key: run `restore-copy` with the old item, or with the old
   password manager entry. Every later copy needs the new one. The wrong key is refused and restores nothing.
4. Old copies end within 7 days. When `backup-status` lists no copy from before the switch and `backup-expire` shows
   `expiry_proven`, delete the old key: `security delete-generic-password -s everyfield-backup-key-<old date>` and its
   password manager entry. Copies made with `backup-copy --out` are outside `backup-status`: delete their directory first.

If the key leaks, do steps 1 and 2 at once. The leaked key opens nothing without the stored copies, so also replace the
bucket key if it can have leaked. Old copies stay readable with the leaked key until they expire. Do not recopy them.

If both copies of the key are lost, every copy it sealed is unreadable. Create a new key, switch to it and run
`backup-daily` at once. Until it completes there is no daily fallback, only Neon history. The old copies expire as usual.

### A leftover `backup.key`

Earlier drills used a file `backup.key` in the configuration directory. Every command ignores it and leaves it unchanged.
If it sealed a copy that still exists, set the variable for that one `restore-copy` with
`EVERYFIELD_BACKUP_KEY="$(xxd -p -c 64 <directory>/backup.key)"`. Otherwise the owner deletes the file. Also remove
`backup-key-create` from `operations` in an old `control.json`: the command is gone, and a control file that names it is
refused.

## Test on disposable data

This uses a throwaway Postgres, a loopback bucket and a throwaway key, and no live bucket or provider setting. The automated
run of the whole sequence, with the wrong key refused at the end:

```sh
docker run -d --rm --name backup-test -e POSTGRES_USER=ci -e POSTGRES_PASSWORD=ci -e POSTGRES_DB=everyfield_ci \
  -p 127.0.0.1:55999:5432 pgvector/pgvector:0.8.7-pg18
export DATABASE_URL_UNPOOLED=postgres://ci:ci@127.0.0.1:55999/everyfield_ci EVERYFIELD_DISPOSABLE_DATABASE=1
export DATABASE_URL="$DATABASE_URL_UNPOOLED"
pnpm db:migrate
packages/db/node_modules/.bin/tsx --tsconfig packages/domain/tsconfig.json --conditions=react-server \
  --test tests/integration/target/sql/knowledge/backup-cli.test.mts
```

By hand on the same database:

1. Start the two loopback buckets in another terminal. It prints the backup endpoint, then the file endpoint:

   ```sh
   node --input-type=module -e 'import { fakeBucket } from "./tests/support/fake-bucket.mts";
   for (const name of ["everyfield-backup", "drill-files"]) {
     const bucket = await fakeBucket(name); bucket.settings.now = new Date(); console.log(bucket.endpoint); }'
   ```

2. Make a backup and a recovery configuration directory, `$B` and `$R`, as above. `tigris.env` names the backup endpoint
   with any `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. `source.env` names the database, the file endpoint and
   `AWS_BUCKET_NAME=drill-files`. In `control.json` the database host is `127.0.0.1`.
3. Use one new shell for the rest, so the key ends with it:

   ```sh
   bash
   export EVERYFIELD_BACKUP_KEY="$(openssl rand -hex 32)"
   run() { node ops/maintenance/cli.mts "$@"; }
   mkdir -m 700 copies
   run backup-capture --config "$B" --out snapshot
   run backup-copy --control "$B/control.json" --snapshot snapshot --out copies
   run backup-daily --config "$B"
   run restore-copy --config "$R" --current "$R" --target drill_restore --copy <location from backup-daily>
   EVERYFIELD_BACKUP_KEY="$(openssl rand -hex 32)" run restore-copy --config "$R" --current "$R" --target drill_wrong \
     --copy <location from backup-daily>
   exit
   ```

   Make `copies` and `snapshot` outside every checkout. `backup-daily` uploads, reads the copy back and opens it. The last
   command must be refused.
4. Delete the directories and the container.

When a Neon drill branch exists, the same route runs on it: only `source.env` and the database in `control.json` name the
branch. The backup bucket and the restore's file bucket stay on loopback.

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

The schedule is off until go-live. Loading it is a go-live step, only on Sebastian's words.

`schedule-install` writes `app.everyfield.backup-daily.plist` (03:30 local) and `app.everyfield.backup-expire.plist`
(hourly) to `~/Library/LaunchAgents`. `--agents <directory>` writes elsewhere, for a dry run. The files hold paths only,
no secret. `--load` also loads them into launchd; it is refused from a worktree. `schedule-uninstall --load` unloads and
removes them. Logs go to `logs/` in the configuration directory. Trust `backup-status`, not the log.

Today's daily plist runs `node cli.mts backup-daily` with no key, so loaded as it is, every run only refuses with
`backup_key_missing`. Go-live needs one change in `ops/maintenance/schedule.mts`: the daily job reads the key from the
Keychain and sets it for the backup process alone. Its `ProgramArguments` become `/bin/sh`, `-c` and one line:

```sh
EVERYFIELD_BACKUP_KEY="$(/usr/bin/security find-generic-password -s everyfield-backup-key-<date> -w)" exec /usr/bin/env node <cli> backup-daily --config <directory>
```

The plist and every argument hold the item's name, never the value. Quote the two paths for the shell, then escape the
line for XML. Never use the plist's `EnvironmentVariables` or `launchctl setenv` for the key: the first is a file, the
second gives it to every program of the login. The expiry job needs no key and stays as it is. If the Keychain is locked
or the item is missing, the value is empty and the run refuses; `backup-status` then shows the day as missed.

At go-live, on Sebastian's words: make that change, run `schedule-install --load` from the home checkout, not a worktree,
and check the first run with `backup-status`.

## Production source

Production backups are off until go-live. They are turned on only at go-live and only on Sebastian's words; until then no
`control.json` holds an approval. The job refuses a production database or the `everyfield` bucket with
`production_source_refused`, also when the key is set. At go-live the owner allows one source by adding this to `control.json`. It must name the exact host and bucket in `source.env`:

```json
"production": { "host": "...", "bucket": "everyfield", "approvedBy": "owner", "approvedAt": "<ISO time>" }
```

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

From a daily copy instead, replace steps 2 to 4 with `restore-copy --copy <location from backup-status>`, with
the key that sealed it set for that command ("Keys").

## Check a church deletion

`deletion-check --subject <church id>` with a `restricted-recovery` directory. That directory needs the bucket key: its
own `tigris.env`, or `bucketKey` in its `control.json`. Without it, or when the bucket cannot be read for a church with
a purge time, the check is refused with `backup_bucket_unreadable` and gives no verdict. `purged` means the witness is
purged, no row or file of the church remains, the copy expiry is at most 7 days after the purge, and every stored copy
from before the purge ends by then, and none of them is at or past its own expiry and still stored. Otherwise it lists
what is left and exits 2. `copies_before_purge` gives each such copy's expiry and state; for `expired`, run
`backup-expire` and check again. An upload that has no manifest yet counts as from before the purge, so check again when
it finishes. `cancel_allowed` is true only before the deadline.
