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
3. Revert the commit on `main`. With `TRUNK_PROMOTE` off, `deploy-production.yml` puts the revert's build live as
   soon as it builds; if it built before you turned promote off, promote its production deployment by hand
   (`vercel promote <deployment>`). Keep `TRUNK_PROMOTE` off until CI passes on the revert, and only then set it back
   to `true`.
   In that order, a late green run for a commit between the bad one and the revert finds production already ahead of
   it and promotes nothing. An evf auto-revert carries `Evf-Revert-Of: <sha>`, and the fail-forward incident names
   the reverted commit and its task.

### Promote only green main

`.github/workflows/promote.yml` runs after each CI run on `main`. It promotes a Vercel production deployment only when
that push CI run passed, and never one older than what production runs. It does nothing, and says why in its job
summary, until Sebastian sets these at cutover:

- Repo variable `TRUNK_PROMOTE` set to `true`.
- Repo secret `VERCEL_TOKEN`: a Vercel token that can list and promote deployments of the project. It is the same
  secret `deploy-production.yml` deploys with.
- Repo variable `VERCEL_PROJECT_ID`: the Vercel project id. `deploy-production.yml` already reads it.
- Repo variable `VERCEL_PRODUCTION_DOMAIN`: the production host name, with no scheme. The workflow reads which commit
  production runs from it.
- Repo variable `VERCEL_SCOPE`: the Vercel team slug. Leave it unset when the project is on a personal account.

Promote reads nothing else. It does not read `VERCEL_ORG_ID` and runs no Vercel CLI. It sends every request straight
to the Vercel REST API with `Authorization: Bearer $VERCEL_TOKEN` and `slug=$VERCEL_SCOPE`: it reads the production
domain, lists deployments with `GET /v7/deployments`, and promotes with
`POST /v10/projects/$VERCEL_PROJECT_ID/promote/<deployment>`. That endpoint is the one `vercel promote` calls. It does
not use the CLI because `vercel promote` always loads the token's user (`GET /v2/user`) first, and this token has no
user: Vercel answers `User not found. (404)` (T-684). `vercel deploy` never needs that call, because it takes the team
from `VERCEL_ORG_ID`.

No Vercel dashboard setting is required. The automatic production domain assignment setting can stay as it is,
because `--skip-domain` overrides it for these deploys.

How it works while `TRUNK_PROMOTE` is `true`:

- `deploy-production.yml` builds each push to `main` with the Vercel CLI and runs
  `vercel deploy --prebuilt --prod --skip-domain --meta githubCommitSha=<sha>`, so the build does not take the
  production domain. Pushes no longer cancel each other's builds (one concurrency group per commit), so every
  deploying commit gets its own deployment. With `TRUNK_PROMOTE` off it deploys straight to the domain and cancels
  older builds, as before.
- Promote finds the deployment through the Vercel API: a deployment of `VERCEL_PROJECT_ID` whose
  `meta.githubCommitSha` is the green commit, target `production`, state `READY`. It reads the commit's
  `deploy-production.yml` push run to know whether a build is coming. While the build is queued or building, or the
  run has not finished, it waits up to 40 minutes, longer than the deploy job's 30-minute timeout.
- A build that ended in `ERROR` or `CANCELED`, a run that finished with no deployment, or no `READY` deployment after
  the wait fails promote with a summary line naming the commit and why. Nothing is promoted, so production stays on
  the last good commit until a later commit deploys and passes CI, or Sebastian promotes one by hand.
- A green commit with no `deploy-production.yml` run of its own (its paths are filtered out, such as a docs-only
  commit) does not fail. Promote takes the deployment of the latest earlier deploying commit it contains and promotes
  it when production does not already contain that commit. Otherwise it ends green with a line saying nothing
  deployable changed and production stays.
- When production already contains the commit it would promote, it promotes nothing and says so. A late green run
  for an older commit never moves production back.
- After Vercel accepts the promote request, promote reads the production domain until it serves the new deployment,
  for up to 5 minutes. A refused request, or a domain that still serves the old deployment after that, fails promote
  with a summary line naming the deployment and the commit.

Undo by setting `TRUNK_PROMOTE` to anything other than `true`. Promote then stops, and the next push to `main` that
`deploy-production.yml` builds goes live straight away, with older builds cancelled, as before cutover. To go live
sooner, run `deploy-production.yml` by hand (`gh workflow run deploy-production.yml`) or promote a ready deployment
with `vercel promote <deployment>`.
