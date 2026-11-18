# Production identity setup

A one-time setup for Vercel Production (project `everyfield`, scope `sebastian-garces-projects-335a0259`). It gives
the app its own database logins and identity keys, which background jobs and sign-in need. Sebastian runs it himself,
on his Mac. No seat runs it against production (T-396).

`bin/prod-identity` (`tools/prod-identity/setup.ts`) does three things. It creates three logins:

- `everyfield_prod_runtime` (granted `everyfield_runtime`)
- `everyfield_prod_auth` (granted `everyfield_auth`)
- `everyfield_prod_cleanup` (granted `everyfield_cleanup`)

Each gets a fresh password and LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS. It then generates
`IDENTITY_SECRET`, `IDENTITY_MAIL_KEY`, `IDENTITY_ADDRESS_KEY`, `NOTIFICATION_OPT_OUT_KEYS` and `CRON_SECRET`.
Last, it writes the `vercel env add ... production` commands for every one of those settings that Vercel Production
lacks, plus `IDENTITY_DATABASE_URL` (direct endpoint), `IDENTITY_AUTH_DATABASE_URL` (pooled), `LIFECYCLE_CLEANUP_DATABASE_URL`
(direct) and `IDENTITY_ORIGIN`. It also lists, by name, every other setting production needs and whether Vercel
already has it.

## Run

1. Put the production owner's connection string in the environment without echoing it or saving it to history. Copy it
   from the Neon console (production branch, role `neondb_owner`), then:

   ```sh
   read -rs PROD_IDENTITY_ADMIN_URL && export PROD_IDENTITY_ADMIN_URL
   ```

2. Dry run. This uses a read-only session and `vercel env ls` (names only), and changes nothing:

   ```sh
   bin/prod-identity --origin https://<production origin>
   ```

   Check the printed target endpoint (`ep-gentle-dust-...`, marked PRODUCTION), the logins, the grants, the settings it
   would generate (masked) and the "set by hand" list. Fix any "Apply would refuse" line first.

3. Apply. Pass `--confirm` with the endpoint id the plan printed, or leave it out and type the id at the prompt:

   ```sh
   bin/prod-identity --origin https://<production origin> --apply --confirm <endpoint id>
   ```

   It creates the logins and grants in one transaction and checks that each new login connects. It prints the setting
   names and the path of the commands file, by default `~/.everyfield/prod-identity/vercel-production.sh` (mode 0600).

4. Run the commands file, then delete it. Each value goes to `vercel env add` on stdin:

   ```sh
   sh ~/.everyfield/prod-identity/vercel-production.sh && rm ~/.everyfield/prod-identity/vercel-production.sh
   ```

5. Set the "set by hand" settings the dry run listed (for example `IDENTITY_MAIL_FROM`, `RESEND_API_KEY`,
   `RESEND_WEBHOOK_SECRET`, `FEEDBACK_*`, `AWS_*`) with `vercel env add <NAME> --environment production`.
6. Redeploy production (`vercel redeploy` on the current production deployment, or push to main), then
   `unset PROD_IDENTITY_ADMIN_URL`.

Rerunning `--apply` is safe. It keeps existing logins and their passwords, re-asserts the grants and generates only
the settings Vercel Production lacks. It refuses while an earlier commands file is still waiting. It also refuses
when a login exists but Vercel lacks its URL, because the password cannot be read back. `--rotate-passwords` then gives
the existing logins new passwords and overwrites their URLs (`--force`). Never regenerate `IDENTITY_MAIL_KEY` or
`IDENTITY_ADDRESS_KEY` once production has mail: stored mail and address hashes depend on them.

## Verify

- Vercel logs for production show `/api/cron/jobs` answering 200 each minute, with no `IDENTITY_*` or database
  authentication error.
- Sign-in works on the production origin: sign in with an existing account, and request a password reset to see mail
  queue and send.
- The dry run now reports each generated setting as "already present" and each login as "keep".

## Roll back

1. Remove the values from Vercel Production, one command per setting the script added:
   `vercel env rm <NAME> --environment production --project everyfield --scope sebastian-garces-projects-335a0259 --confirm-name <NAME>`.
   Then redeploy.
2. Disable the logins (`ALTER ROLE everyfield_prod_runtime NOLOGIN;` and the same for `_auth` and `_cleanup`), or drop
   them (`DROP ROLE everyfield_prod_runtime;`). A disabled login makes the next run refuse until it is dropped.
3. Delete the commands file if it is still there: `rm ~/.everyfield/prod-identity/vercel-production.sh`.
