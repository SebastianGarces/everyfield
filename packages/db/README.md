# Development database

Neon project `everyfield-v3` has two branches. `main` is production.
`development` is disposable and shared by every agent. It replaces
`early-access-preview`. Local portless previews and Vercel's development
variables use `development`. Vercel builds only Git branch `main`.

Use the ignored `/Users/sebastian/dev/everyfield_v3/.env.v3.local` as the
source for a worktree's `apps/web/.env.local`, with file permissions `600`.
Never copy the legacy v2 database settings or `.env.prod` into a preview.
Each worktree needs its own env file and dependencies. The migration and
reset commands load `apps/web/.env.local`; an already exported
`DATABASE_URL` takes precedence, so unset stale shell values first.

From the worktree root, apply the current schema with the existing command:

```sh
corepack pnpm db:migrate
```

To wipe and reseed the shared development data:

```sh
corepack pnpm --filter @everyfield/db reset:dev
```

Coordinate with other agents before resetting. The command atomically clears
both early-access tables, including rate-limit attempts, and inserts one
synthetic planter and one synthetic network request at `example.test` addresses.
It sends no mail. Synthetic mail receipts mark the fixtures as already handled.
The migration history and schema remain intact. Run migrations first on a fresh
database. Repeating the reset produces the same two sample requests with fresh
IDs and timestamps.

The reset refuses production mode and any host except the development branch's
pooled or direct endpoint, currently `ep-autumn-dew-b8ltidky`. If that branch is
replaced, review the host allowlist in `scripts/reset-dev.ts` before using it.
Production's host fragment is `ep-gentle-dust-b8tvq4ha`; never add it to that list.
Credentials belong only in ignored local files and provider environment settings.

Discovery conversion, first-seat acceptance and relationship ending share the account
row as their arbiter. Use this shared lock order and its non-blocking rules:

1. Lock the subject account first. An organization ending a Discovery relationship
   must lock that account too, before its profile or affiliation.
2. Discovery operations lock the account's Discovery profile next, then affiliation
   rows in UUID order.
3. Resident invitation operations lock the source Person before its invitation.
   This matches Person retirement and removal writers. Acceptance first locks the
   addressed account. Source-only inspection, administration and mail authorization
   do not claim an account; they still lock Person before invitation.
4. Resident acceptance looks up an existing affiliation with `FOR UPDATE NOWAIT`
   after locking the invitation. Contention rolls back the transaction and returns
   the retryable `temporary` result before grants or other effects. It never waits
   for that earlier row while holding Person or invitation locks.
5. Ordinary acceptance checks proof before locking conflicting active seat and
   affiliation rows under the account lock. If either exists, it refuses the whole
   claim. Seat removal locks the target account before the target seat and session
   revocation. Invitation and seat administration take their shared
   `workspace-seats` advisory lock before row locks; it does not replace the
   subject account lock.

Recheck current lifecycle, conversion state, proof, seat and relationship revisions
under the relevant locks. Keep the retirement/revocation/claim and affiliation
contention regressions. The `NOWAIT` rule refuses contention before effects; do not
retry a deadlock as a substitute for the shared order. Extend this list when a
producer adds shared locks, rather than documenting a separate order.

Drizzle declarations in `src/schema/tables.ts` own the modeled database structure.
Append new columns at the end of an existing table declaration: PostgreSQL adds columns
at the physical end, and the drift gate checks the order of live columns. Removing a
column leaves an internal position gap; that gap does not count as schema drift.

Use the pinned Kit through the single generation command, from the workspace root:

```sh
corepack pnpm --filter @everyfield/db generate --name descriptive_change
corepack pnpm --filter @everyfield/db generate --name descriptive_custom_change --custom
# After editing the custom SQL, normalize it before review:
corepack pnpm --filter @everyfield/db generate --normalize
```

Do not run raw `drizzle-kit generate`, `push` or `migrate`. The command generates
SQL and snapshot metadata, removes Kit's default `public` qualifier only from
references to our own tables, then qualifies vector type positions as
`public.vector`. It preserves extension and cross-schema references, comments,
identifiers and string literals. Both steps are deterministic and idempotent and
run before review, commit and checksum calculation. The committed-artifact check
refuses new SQL with public-qualified application tables or unqualified vector
types. The frozen migrations are never normalized or rewritten.

Use `--custom` for GRANTs, triggers, functions, extensions and deferred foreign-key
changes that Kit cannot model. Review those statements and update their explicit
supplemental expectations alongside the migration. Apply all SQL through
`db:migrate`: `schema_migration` remains the only database ledger, with the same
advisory lock, atomic batches, exact-byte SHA-256 checks and explicit adoption.
Kit's file journal describes generation history; it is not a second database ledger.

The initial snapshot describes the exact database after frozen migrations 0001–0005.
`migrations/frozen.json` pins their original bytes. Snapshot and file-journal metadata
live in `migrations/meta/`; no baseline CREATE statements are applied to existing objects.
The next generated migration number is 0006. Runtime SQL goes through the existing
checksum ledger; neither Kit push nor its database migrator is used.

`annotations.json` retains documentary notes separately from physical declarations.
Before generating a migration for a new table, add its table, column and foreign-key
notes there, following the existing entries. Catalog generation requires an annotation
entry for every declared table.
`supplemental.json` records reviewed definitions Kit cannot express, including deferred
foreign-key timing, functions, triggers, capability-role attributes and privileges.
Update those expectations with the custom migration; never refresh them from an
unreviewed database change. `docs/schema/target.json` is generated with:

```sh
corepack pnpm --filter @everyfield/db catalog
```

`schema:check` verifies the generated catalog, frozen bytes, file registry, SQL
normalization and current snapshot offline. Package unit checks run it without a database.
`python3 packages/db/src/schema/generate.py --check` additionally creates an isolated
schema, applies the full migration chain and compares it with the Drizzle declarations
and generated catalog. It checks columns, defaults, keys, CHECK constraints, indexes,
policies, row security and the supplemental definitions. Local checks use only the shared
development database; CI uses its disposable Postgres service. Pass
`--env-file /absolute/approved-dev-env` when needed. All scratch schemas are dropped in
`finally`; this command never migrates public. `test:db` repeats the real comparison and
proves an un-migrated declaration and an unexpected CHECK both fail it.

Applied SQL remains immutable. `generate.py` without flags only exports the current
catalog. Row types are inferred from Drizzle declarations; there is no separate row-type
or target-to-DDL generator. Regenerate the readable schema docs after catalog changes:

```sh
python3 docs/schema/render-docs.py
python3 docs/schema/render-diagram.py
```
