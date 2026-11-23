# Release runbook

Manual checks to run before each release. CI does not run them.

- Reset timing (AC:WP005-API-RESET): run `corepack pnpm --filter @everyfield/domain test:identity:production`, which
  runs `tests/integration/identity/timing.production.mts`. It proves reset and verification requests take the same time
  whether or not the account exists. It starts a managed production preview on the development database. Never point
  it at the production database.

## Production flag reader

The nightly `flag-cleanup` job (`.github/workflows/nightly.yml`) runs `bin/flag stale` against production read-only when
the repository secret `FLAG_READER_DATABASE_URL` is set, and prints its skip line while it is not (D99). The migration
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

## Production broke

Act in this order. A flag turned off ends the incident at step 1; a rollback at step 2 always goes on to step 3.

1. Turn the change's feature flag off. A flagged change goes dark without a deploy.
2. If the change is not behind a flag, first set the repo variable `TRUNK_PROMOTE` to `false`, then use Vercel Instant
   Rollback to the previous production deployment. Pausing promote matters: the bad commit is still on `main`, so the
   next green CI run at any later commit would promote it back into production before the revert lands.
3. Revert the commit on `main`. Keep `TRUNK_PROMOTE` off until CI passes on the revert, then promote the revert's
   production deployment by hand (`vercel promote <deployment>`), and only then set `TRUNK_PROMOTE` back to `true`.
   In that order, a late green run for a commit between the bad one and the revert finds production already ahead of
   it and promotes nothing. An evf auto-revert carries `Evf-Revert-Of: <sha>`, and the fail-forward incident names
   the reverted commit and its task.

### Promote only green main

`.github/workflows/promote.yml` runs after each CI run on `main`. It promotes the Vercel production deployment of
that exact commit only when CI passed, and never one older than what production runs. It does nothing, and says why
in its job summary, until Sebastian sets these at cutover:

- Repo variable `TRUNK_PROMOTE` set to `true`.
- Repo secret `VERCEL_TOKEN`: a Vercel token that can promote deployments of the project.
- Repo variable `VERCEL_PRODUCTION_DOMAIN`: the production host name, with no scheme. The workflow reads
  which commit production runs from it.
- Repo variable `VERCEL_SCOPE`: the Vercel team slug. Leave it unset when the project is on a personal account.
- In Vercel, turn off automatic production domain assignment for new production builds, so a push to `main` builds
  but does not go live until CI passes.

Undo by setting `TRUNK_PROMOTE` to anything other than `true` and turning automatic assignment back on.
