# QA preview runbook (OPS-106)

A QA preview is a Vercel preview of one branch with its own database. It gives Nora a working copy of the app to test,
with seeded data, three known logins and the same shared credentials as every preview. Nothing builds on a normal push
or PR. A preview exists only when someone asks for one, and the lead removes it when the testing ends.

`bin/evf qa` is the only sanctioned way to make a Vercel preview deployment (AGENTS.md).

## 1. Nora asks for a QA preview

Nora posts one message to the engineering lead (Jonah) in the team thread:

> QA preview please: `<branch name or PR link>`. What I want to test: `<one line>`.

She never pastes a password, key or bypass secret into the request. The lead answers in the same thread with the URL
and the preview id.

## 2. The lead creates the preview

Run this on Sebastian's Mac, from the home checkout. `neonctl` and `vercel` must already be logged in.

1. Make sure the branch is pushed and contains current main. The QA seed (`tools/evf/qa-seed.ts`) runs from the
   branch's own code, so a branch made before OPS-106 merged must merge main first.
2. Run `bin/evf qa up <branch>`. It takes 5 to 10 minutes. It does these steps in order:
   1. Finds the development Neon branch (endpoint ep-autumn-dew). It stops before it creates anything if that branch
      is missing or also serves production (ep-gentle-dust).
   2. Creates a Neon branch named `qa-<branch>-<4 hex>` off development.
   3. Installs the branch's dependencies in a temporary checkout and runs its `db:migrate` on the Neon branch.
   4. Runs the QA seed on the Neon branch.
   5. Deploys the branch head with `vercel deploy --target preview`. Only the database and identity settings are set
      for this deployment. Everything else comes from the Vercel Preview environment.
   6. Points the alias `everyfield-<id>.vercel.app` at the deployment. The app trusts only this origin, so always give
      Nora the alias URL, not the deployment URL.
3. The command prints two lines: `QA preview <id>` and the URL. Send both to Nora.

If a step fails, the command removes what it made and prints the error with every secret masked.

### Logins on every QA preview

| Role   | Email                           | Password                  |
|--------|---------------------------------|---------------------------|
| Owner  | `delivered+qa-owner@resend.dev`  | `Everyfield-QA-preview-1` |
| Admin  | `delivered+qa-admin@resend.dev`  | `Everyfield-QA-preview-1` |
| Member | `delivered+qa-member@resend.dev` | `Everyfield-QA-preview-1` |

These accounts exist only on QA Neon branches, behind Vercel Deployment Protection. Each one lands on the test church
"Harvest Point (QA)". The church has people, a household, three teams, two meetings, tasks, two follow-ups, a written
document, a draft message and the wiki.

### Email on a QA preview

Every seeded person and login uses a `delivered+<label>@resend.dev` address. Resend accepts mail to these addresses
and delivers it to nobody. Use "Send now" in Messages to test a send: the app hands the mail to Resend in the same
request. No cron job is needed, and Vercel does not run cron on previews. Evry turns also run in the request.

## 3. How a bot gets in: Protection Bypass for Automation

Deployment Protection stays on for every preview. A remote-browser bot gets in with Vercel's Protection Bypass for
Automation. Sebastian sets it up once, after he approves it in the OPS-106 PR:

1. In Vercel, open the `everyfield` project, then Settings, then Deployment Protection.
2. Under "Protection Bypass for Automation", create a secret.
3. Sebastian copies the secret into Nora's remote-browser secret store himself, under the name
   `VERCEL_AUTOMATION_BYPASS_SECRET`.

The secret never goes into chat, the repository, a PR, a task note or a screenshot. To replace it, Sebastian creates a
new secret in Vercel and updates the secret store.

The bot opens its first page with two request headers:

- `x-vercel-protection-bypass: <the secret from the secret store>`
- `x-vercel-set-bypass-cookie: true`

Vercel then sets a cookie, so the rest of the session works without the headers. A person with Vercel access can also
open the URL in a browser that is signed in to Vercel.

## 4. Tear-down

When Nora finishes, or once a week:

1. Run `bin/evf qa list`. It shows each open preview with its id, branch, URL, Neon branch and age.
2. Run `bin/evf qa down <id>` for each preview that is done. It removes the alias, the Vercel deployment and the Neon
   branch, then its record. A second run for the same id does nothing and succeeds.
3. Check with `neonctl branches list --project-id cool-math-76767811` that no `qa-` branch is left for that id.

Files that Nora uploads go to the shared development bucket and stay there. QA previews do not expire on their own,
which is why `qa list` exists.
