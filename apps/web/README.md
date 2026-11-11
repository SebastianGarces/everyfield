# Everyfield web app

The Next.js app for Everyfield: the marketing and legal pages, the sign-in and account pages, and the signed-in
product (People, Meetings, Tasks, Communication, Documents, Ministries, Settings, the Wiki and the rest). Features
live in `src/features/<feature>/`; the files under `src/app/` only re-export their routes. The product frame (nav,
account menu, notification bell) is `src/features/shell/`.

Use Node 24 and the pnpm version in the root `package.json`. Run commands from the repository root: install with
`corepack pnpm install`, then `corepack pnpm dev` or `corepack pnpm build`.

## Environment

Next loads `apps/web/.env.local`; values already set in the shell take precedence. Keep values out of Git, logs and
chat. This list names every variable `src/` reads, never a value.

- `IDENTITY_DATABASE_URL`: the app's Postgres connection, for product reads and writes and the job runner's pool.
- `IDENTITY_AUTH_DATABASE_URL`: the separate Postgres connection the sign-in layer uses.
- `IDENTITY_ORIGIN`: the app's public origin, used to build links in mail and invitations.
- `IDENTITY_SECRET`: the session signing secret, at least 32 characters.
- `IDENTITY_MAIL_KEY`: 64 hex characters; encrypts stored mail payloads.
- `IDENTITY_ADDRESS_KEY`: 64 hex characters; keys the hash that matches email addresses.
- `IDENTITY_MAIL_FROM`: the sender address for product mail.
- `RESEND_API_KEY`: Resend send permission. Without it, mail outside production is captured to the dev outbox.
- `RESEND_WEBHOOK_SECRET`: verifies Resend delivery webhooks at `/api/webhooks/resend`.
- `NOTIFICATION_OPT_OUT_KEYS`: the key ring that seals email opt-out and unsubscribe links.
- `CRON_SECRET`: the bearer secret both scheduled routes require (see Scheduled routes).
- `PLATFORM_PROOF_SECRET`: outside production only, turns on proof mode for a request that sends it in `x-platform-proof`.
- `EVERYFIELD_DEV_OUTBOX`: optional folder for captured dev mail; defaults to a folder under the system temp dir.

Set by the platform, read but never configured here: `VERCEL`, `VERCEL_ENV`, `NODE_ENV`, `NEXT_RUNTIME`, `PGOPTIONS`.

## Database

Local work, tests and previews use the shared development database only. It may be wiped and reseeded, so run the repo
seed and preview scripts freely. Never point a test, check or preview at the production database.

## Scheduled routes

`apps/web/vercel.json` schedules two routes. Vercel calls each with `Authorization: Bearer <CRON_SECRET>`, and both
refuse a missing or wrong secret.

- `/api/cron/access-retention`, daily at 05:00 UTC: deletes early access requests older than twelve calendar months,
  clears request IPs older than thirty days and deletes limiter attempts older than 24 hours. A missing secret or a
  database failure returns HTTP 503. Rerunning it is safe.
- `/api/cron/jobs`, every minute: runs due background jobs (task reminders, digests, queued invitation mail) and
  closes lost ones (`src/server/jobs/scheduled.ts`).

## Checks

```sh
corepack pnpm --filter @everyfield/web typecheck
corepack pnpm --filter @everyfield/web lint
corepack pnpm --filter @everyfield/web test:unit
corepack pnpm test:logs
```

## Per-task local previews

Each worktree runs one preview through `bin/dev stack` and the managed Portless CLI from the `portless-preview` skill.
The upstream npm Portless package does not include `preview` commands; check `portless preview --help` before
starting. From a fresh task worktree:

```sh
corepack pnpm install --frozen-lockfile
bin/dev stack up
bin/dev stack status
bin/dev stack check
bin/dev stack down
```

The commands select the current worktree, including when run from another directory. `--project /absolute/worktree`
selects a different worktree explicitly. Each worktree gets one preview, its own dependencies, and a loopback-only app
port behind a unique Portless URL. Repeating up reuses the preview; repeating down is safe. Down stops only that
worktree's preview and preserves its source and branch. Portless leases expire after one hour; use
`portless preview renew ID --ttl 7200` for a longer review.

Live edits use development mode. For proof tied to a clean commit, run `bin/dev stack up --mode production` and then
`bin/dev stack check`. Production mode builds a disposable local snapshot, not a deployment, and refuses a dirty
worktree. Status prints the preview ID, URL, mode and commit as JSON. Check also asserts readiness, the current commit,
and HTTP 200 at the preview URL; it does not prove application acceptance, so open the URL and exercise the behavior.
Use `portless preview logs ID` to investigate a failed start. With `EVF_RUNTIME_DIR` set, the commands also keep a
`stack.json` receipt there and clear it on down. The configuration lives in `scripts/preview.json`, and the commands
call no paid providers.

Portless uses HTTPS by default. The variables in this paragraph belong to the preview tooling, not the app. Trust its CA
before browser review; for Node, point `NODE_EXTRA_CA_CERTS` at the
trusted CA file. For a disposable HTTP test supervisor, set `PORTLESS_PREVIEW_DIR`, `PORTLESS_PREVIEW_PORT` and
`PORTLESS_PREVIEW_HTTP=1` consistently on every preview command, stop its previews, then run
`portless preview shutdown` with the same variables. Never shut down another agent's supervisor.

Preview startup runs no database creation, migration, seed, email or provider setup. Marketing pages render without
provider credentials. For product work, supply the shared development database's settings in the shell or this
worktree's ignored `apps/web/.env.local`; production snapshots do not copy ignored env files. Never copy production
settings into a preview or print secrets. Portless isolates processes and dependencies, not the shared database.
