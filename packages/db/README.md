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
