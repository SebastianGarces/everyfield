# Release runbook

Manual checks to run before each release. CI does not run them.

- Reset timing (AC:WP005-API-RESET): run `corepack pnpm --filter @everyfield/domain test:identity:production`, which
  runs `tests/integration/identity/timing.production.mts`. It proves reset and verification requests take the same time
  whether or not the account exists. It starts a managed production preview on the development database. Never point
  it at the production database.

## Production flag reader

The nightly `flag-cleanup` job (`.github/workflows/nightly.yml`) runs `bin/flag stale` against production read-only when
the repository secret `FLAG_READER_DATABASE_URL` is set, and prints its skip line while it is not (D98). The migration
that creates the NOLOGIN role `everyfield_flag_reader` and the `flag_rollout` view it may read must be on production
first. Sebastian does every step; no seat touches production or the secret.

1. In the Neon console, project `everyfield-v3`, branch `main` (production, endpoint `ep-gentle-dust-b8tvq4ha`), open
   the SQL editor as the owner and create the login with a strong generated password:

   ```sql
   CREATE ROLE flag_nightly LOGIN PASSWORD '<generated>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   GRANT everyfield_flag_reader TO flag_nightly;
   ALTER ROLE flag_nightly SET default_transaction_read_only = on;
   ```

   `bin/flag` refuses a login whose sessions do not default to read-only, so keep the last line.
2. Check it as that login: `SELECT * FROM flag_rollout` answers, and `SELECT 1 FROM feature_flag` is refused with
   permission denied.
3. Copy the pooled connection string for `flag_nightly` (Connect, pooled connection, role `flag_nightly`) and store it
   from the main checkout with `gh secret set FLAG_READER_DATABASE_URL`, pasting it at the prompt so it stays out of
   shell history.
4. Run the nightly by hand with `gh workflow run nightly.yml` (its `workflow_dispatch`), then open the run's
   `release flags due for removal (print only)` job. Its target line reads
   `bin/flag: target the PRODUCTION database, read-only (ep-gentle-dust-b8tvq4ha)` and the job exits 0. It lists and
   never files; file removals from your Mac with `bin/flag stale --file`.
5. To revoke, run `gh secret delete FLAG_READER_DATABASE_URL`, then `DROP ROLE flag_nightly;` in the production SQL
   editor. The nightly goes back to its skip line. The NOLOGIN role and the view stay; they grant nothing without a
   login.
