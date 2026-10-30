# Early access site

Use Node 24 and the pnpm version in the root package.json. Run commands from the repository root. Install with `corepack pnpm install`, then use `corepack pnpm dev` or `corepack pnpm build`.

## Environment

Copy `apps/web/.env.example` to `apps/web/.env.local`. Keep values outside Git and logs. Use only the v3 Neon database; the older v2 environment files point to a different database.

- `DATABASE_URL`: v3 PostgreSQL connection string.
- `RESEND_API_KEY`: Resend send permission for the verified sender domain.
- `EMAIL_FROM`: verified sender, including an optional display name.
- `EARLY_ACCESS_EMAIL_TO`: the single owner inbox. Production sets it in Vercel; the address is not kept in the repository.
- `CRON_SECRET`: a random secret for the retention route. Set it in Vercel before deployment.
- `EARLY_ACCESS_EMAIL_SUBJECT_PREFIX`: optional prefix for approved real-mail checks, such as `[EveryField test] `. Leave empty in production.

Next and the database/test scripts load `apps/web/.env.local` themselves. Values already set in the shell take precedence. With Node 24, run:

```sh
corepack pnpm db:migrate
corepack pnpm access:export /tmp/everyfield-access-requests.csv
```

A blank `mailed_at` in the CSV means no successful send to the owner has been recorded. It does not confirm delivery; Resend may have accepted the email before saving its database receipt failed.

The migration is transactional and safe to repeat. The export includes both forms, every submitted field, and request/mail metadata. It quotes CSV cells and prefixes spreadsheet formulas with an apostrophe. A named output file has private permissions and must not already exist. Keep exports outside the repository. Omit the file argument to write CSV to standard output; pnpm also prints its command banner, so use a named file for a clean CSV.

## Request handling

Validation and the public operation live in `packages/domain/src/early-access/`. PostgreSQL, the migration, retention, and export live in `packages/db/`. The Next server action only supplies the form data and trusted Vercel IP address. Locally, requests use the shared unknown-IP limit; client forwarding headers cannot bypass it.

Email is trimmed and lowercased. Valid attempts, including duplicates, count toward rolling limits of five per email in 24 hours and twenty per IP in one hour. Rate limits take precedence over duplicate receipts. A delivered request suppresses another request with the same email and form for 24 hours. A filled honeypot returns received before validation and stores or sends nothing.

The request and original email payload commit together. Resend runs outside database locks with an idempotency key tied to the request ID. Success requires a valid Resend receipt and a saved database mail receipt. A duplicate of a pending request retries the original payload, within 23 hours, and returns unavailable if mail or storage fails. Once a pending request is older than the 23-hour retry window, a new submission creates a new request and email key with the current fields. The owner may receive a second email if the earlier send outcome was unknown. The old row stays unchanged until retention deletes it. No visitor field can change the inbox, sender, or subject prefix. Honeypot values and request headers are never stored or included in mail.

## Retention

`apps/web/vercel.json` schedules `/api/cron/access-retention` daily at 05:00 UTC. Vercel sends `Authorization: Bearer <CRON_SECRET>`. The route refuses a missing or wrong secret. It deletes requests older than twelve calendar months, clears request IPs older than thirty days, and deletes limiter attempts older than 24 hours. Rerunning it is safe. A missing secret or database failure returns HTTP 503, rather than claiming completion.

## Verification

Create a disposable branch in the v3 Neon project. Put its connection string in `apps/web/.env.local` before running these commands, and ensure no shell `DATABASE_URL` points elsewhere. The tests delete early access data and must never run on the v3 main database.

```sh
corepack pnpm db:migrate
EARLY_ACCESS_TEST_DATABASE=1 corepack pnpm test:access
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
```

Tests call the public operation against real Postgres and fake only the Resend HTTP boundary. Delete the Neon test branch and remove its connection string from the app environment file afterward. Apply the migration to v3 main only after the tests pass. The real mail check uses a local production build, the approved test recipient, and the subject prefix above. Cross-model review and owner preview approval remain required before go-live.

## Per-task local previews

WP-087 extends the existing workspace scaffold. Use Node 24, the pinned pnpm through
Corepack, and the managed Portless CLI from the `portless-preview` skill. The upstream
npm Portless package does not include `preview` commands. Check `portless preview --help`
before starting. From a fresh task worktree:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm stack:up
corepack pnpm stack:status
corepack pnpm stack:check
corepack pnpm stack:down
```

The commands select the current worktree, including when run from another directory.
`--project /absolute/worktree` selects a different worktree explicitly. Each worktree gets
one preview, its own dependencies, and a loopback-only app port behind a unique Portless
URL. Repeating up reuses the preview; repeating down is safe. Stop before changing mode
or recreating a preview after committing. Down stops only that worktree's preview and
preserves its source and branch. Portless leases expire after one hour; use
`portless preview renew ID --ttl 7200` for a longer review.

Live edits use development mode. For proof tied to a clean commit:

```sh
corepack pnpm stack:up --mode production
corepack pnpm stack:check
```

Production mode builds a disposable local snapshot, not a deployment. It refuses a dirty
worktree. Status prints the preview ID, URL, mode and commit as JSON. Check additionally
asserts readiness, the current commit, and HTTP 200 at the preview URL. It does not prove
application acceptance. Open the returned URL in a browser and exercise the task behavior.
Use `portless preview logs ID` to investigate a failed start. When called by evf, the
commands also keep its `EVF_RUNTIME_DIR/stack.json` receipt current and clear it on down.

Each preview sets `IDENTITY_ORIGIN` to its own URL through `scripts/preview.json`
(`${PREVIEW_URL}`), so sign-in works on any new preview ID without env file edits. A preview
started before this change keeps its old env until you run `stack:down` and `stack:up`.

The configuration lives in `scripts/preview.json`, so no `evf.config.json` change is
needed to run these commands. A separate reviewed OPS task wires the up/status/down
commands and checks into evf after this producer ships. Its stack commands are
`["node", "scripts/stack.mjs", "up"]`, with `status` and `down` in place of `up`.
These commands do not call paid providers, so that stack declares `usesPaidProviders: false`.
The additional local regression check is `["node", "scripts/test-workflow.mjs"]`.

Portless uses HTTPS by default. Trust its CA explicitly before browser review. For a
disposable HTTP test supervisor, set these variables consistently on every preview command:

```sh
export PORTLESS_PREVIEW_DIR=/tmp/everyfield-preview-session
export PORTLESS_PREVIEW_PORT=1457
export PORTLESS_PREVIEW_HTTP=1
```

Choose an unused port and directory for a separate test session. Preserve their values in
the handoff together with the worktree path, preview ID, URL and commit. Stop its previews,
then run `portless preview shutdown` with the same variables when the session is finished.
Never shut down another agent's supervisor. For the HTTPS HTTP check, Node must also trust
the Portless CA, for example through `NODE_EXTRA_CA_CERTS` pointing to the trusted CA file.

No credentials, database creation, migration, seed, email, or provider setup runs as part
of preview startup. Marketing pages can render without provider credentials. For domain
work, use only the shared development database with synthetic data. Set its approved
connection in the shell or this worktree's ignored `apps/web/.env.local`. Production
snapshots do not copy ignored env files; supply approved dev values in the shell or a
private Portless config outside the repository. Never copy production settings into a
preview, print secrets, or submit forms against a production database. Portless isolates
processes and dependencies, not the shared database.

Run the existing lint, TypeScript and build checks with `corepack pnpm check`. Run the
small workflow suite with `corepack pnpm test:workflow`; it uses Node's built-in runner
and a local fake Portless executable, with no database or provider calls. If
`EVF_TEST_REPORT` is set, it writes test names and results there for evf. CI retains the
existing app, domain, documentation, Wiki and cross-model checks, and adds this suite.
