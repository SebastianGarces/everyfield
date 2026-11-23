# bin/flag

Feature-flag operations for Everyfield (T-471). `bin/flag help` lists every command; the design is in
`docs/architecture/patterns.md` ("Feature flags") and QA use in `docs/runbooks/qa-preview.md`.

- `flag.ts`: the commands (`list`, `show`, `set`, `stale`), with the database, `evf` and output passed in so the tests
  in `tests/integration/flags/cli.test.mts` drive them on a throwaway database with a stubbed `evf`.
- `target.ts`: which database a run uses. The shared development database by default (`DATABASE_URL`, which `bin/flag`
  loads from the main checkout's `apps/web/.env.local` when unset), a QA preview's Neon branch with `--qa <id>`, and
  production only with `--production` and `FLAG_PRODUCTION_DATABASE_URL` from Sebastian's production env. No seat,
  test or CI job runs that write path. `FLAG_READER_DATABASE_URL` is the one read-only production route: `stale` alone,
  as a login in the `everyfield_flag_reader` role that reads only the `flag_rollout` view, in one READ ONLY transaction
  (`withTarget` in `main.ts`). The nightly sets it from the repo secret; setup and revocation are in
  `docs/runbooks/release.md` ("Production flag reader").
- `check.ts`: the expiry and dead-flag check (`bin/flag check`). `tests/unit/flags/check.test.mts` runs it on the real
  tree in `apps/web` `test:unit`, so `bin/dev check` and required CI fail on an expired or unread flag.
- `main.ts`: the entry `bin/flag` runs with `--conditions=react-server`.
