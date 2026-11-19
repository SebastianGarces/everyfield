# bin/flag

Feature-flag operations for Everyfield (T-471). `bin/flag help` lists every command; the design is in
`docs/architecture/patterns.md` ("Feature flags") and QA use in `docs/runbooks/qa-preview.md`.

- `flag.ts`: the commands (`list`, `show`, `set`, `stale`), with the database, `evf` and output passed in so the tests
  in `tests/integration/flags/cli.test.mts` drive them on a throwaway database with a stubbed `evf`.
- `target.ts`: which database a run uses. The shared development database by default (`DATABASE_URL`, which `bin/flag`
  loads from the main checkout's `apps/web/.env.local` when unset), a QA preview's Neon branch with `--qa <id>`, and
  production only with `--production` and `FLAG_PRODUCTION_DATABASE_URL` from Sebastian's production env. No seat,
  test or CI job runs the production path.
- `check.ts`: the expiry and dead-flag check that `apps/web` lint runs (`node tools/flag/check.ts`).
- `main.ts`: the entry `bin/flag` runs with `--conditions=react-server`.
