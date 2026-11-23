# Release runbook

Manual checks to run before each release. CI does not run them.

- Reset timing (AC:WP005-API-RESET): run `corepack pnpm --filter @everyfield/domain test:identity:production`, which
  runs `tests/integration/identity/timing.production.mts`. It proves reset and verification requests take the same time
  whether or not the account exists. It starts a managed production preview on the development database. Never point
  it at the production database.

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
