# Release runbook

Manual checks to run before each release. CI does not run them.

- Reset timing (AC:WP005-API-RESET): run `corepack pnpm --filter @everyfield/domain test:identity:production`, which
  runs `tests/integration/identity/timing.production.mts`. It proves reset and verification requests take the same time
  whether or not the account exists. It starts a managed production preview on the development database. Never point
  it at the production database.

## Production broke

Act in this order, and stop at the first step that restores production.

1. Turn the change's feature flag off. A flagged change goes dark without a deploy.
2. If the change is not behind a flag, use Vercel Instant Rollback to the previous production deployment. Instant
   Rollback stops automatic promotion until a later deployment is promoted again.
3. Revert the commit on `main`. When CI passes on the revert, the promote workflow puts it in production and ends the
   rollback. An evf auto-revert carries `Evf-Revert-Of: <sha>`, and the fail-forward incident names the reverted commit
   and its task.

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
