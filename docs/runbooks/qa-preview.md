# QA preview runbook (OPS-106)

A QA preview is a Vercel preview of one branch with its own database. It gives Nora a working copy of the app to test,
with seeded data, five known logins and the same shared credentials as every preview. Nothing builds on a normal push
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

| Role                    | Email                                       | Password                  |
|-------------------------|---------------------------------------------|---------------------------|
| Owner                   | `delivered+qa-owner@resend.dev`             | `Everyfield-QA-preview-1` |
| Admin                   | `delivered+qa-admin@resend.dev`             | `Everyfield-QA-preview-1` |
| Member                  | `delivered+qa-member@resend.dev`            | `Everyfield-QA-preview-1` |
| Network Admin           | `delivered+qa-network-admin@resend.dev`     | `Everyfield-QA-preview-1` |
| Sending-church director | `delivered+qa-sending-director@resend.dev`  | `Everyfield-QA-preview-1` |

These accounts exist only on QA Neon branches, behind Vercel Deployment Protection. The Owner, Admin and Member land on
the test church "Harvest Point (QA)". The church has people, a household, three teams, two meetings, tasks, two
follow-ups, a written document, a draft message, the wiki and the Owner's private check-in history (below). It also has
a sending church, "Grace Fellowship (QA)", and a sending network,
"Harvest Network (QA)". Both share the wiki with Harvest Point (QA). Grace Fellowship (QA) has no login.

The last two logins test the overseeing side. The Network Admin is an Admin of the network "Harvest Network (QA)". The
sending-church director is the Owner of the sending church "Grace Church (QA)". Each organization oversees Harvest
Point (QA): the church's Owner sent each one a connection request, and the organization's login accepted it.

- To see the connection, sign in as one of these logins and open `/settings/sharing`. Harvest Point (QA) is in the
  "Connected churches" list.
- `/home` shows "This account is for an organization". The app has no organization home page yet, so this is expected.
- These logins do not see planter-private data such as check-ins. They see the church only through what the
  connection shares.

### Church, network and revised wiki articles (OPS-127)

The seed gives two wiki articles a known state, so Nora can test what a planter sees. Sign in as the owner and open the
Wiki.

- **Article A, "First Year Budget Planning".** Grace Fellowship (QA) and Harvest Network (QA) each have a published
  version of it. The owner sees the church version: the title ends in "(Grace Fellowship (QA))", the line under the
  title shows the "Church version" tag and the name "Grace Fellowship (QA)", and the body starts with "This is the
  church version from Grace Fellowship (QA)." The source bar above the article shows "Source Grace Fellowship (QA)".
  Open it: "Read this article from" lists Grace Fellowship (QA), Harvest Network (QA) and Global. Harvest Network (QA)
  shows the "Network version" tag and its own title and body. Global shows the Everyfield article with no version tag.
- **Article B, "Setting Up a Not-for-Profit Corporation".** The article has a second revision. Its title ends in
  "(revised)" and its body starts with "Revised for QA". The owner finished the first revision a week ago, so the line
  under the title shows "Read" and "Updated since you read it". The admin and member have not read it, so they see
  no update note.

The seed picks these two articles as the first and second article by position, then by slug, in the active wiki
release of the development database. If the development wiki changes, the seed can pick other articles. Its output
names the two titles ("wiki copies of …" and "wiki revision of …"), so check them when you send the URL to Nora.

### Check-in history on the owner login

Only the owner login has check-in history. Its personal timezone is America/New_York. Weekly check-in
(`/me/check-in`) shows 13 answered past weeks. The last 3 of them are a run of Strained or Struggling answers in Pace,
and that run ends last week. This week is open and unanswered, so a normal save also works. You can open and correct
any past week, as a planter can.

The weeks are relative to the day the preview was made. They do not move forward while the preview stays up, so on a
preview made two weeks ago the run ends three weeks back. The admin and member logins have no check-in weeks and no
personal timezone. A preview made before OPS-125 merged has no check-in history.

The Neon branch is a copy of the development database, so it also holds the development data of other churches. The
QA logins see only Harvest Point (QA).

### Email on a QA preview

Every seeded person and login uses a `delivered+<label>@resend.dev` address. Resend accepts mail to these addresses
and delivers it to nobody. Use "Send now" in Messages to test a send: the app hands the mail to Resend in the same
request. No cron job is needed, and Vercel does not run cron on previews. Evry turns also run in the request.

## 3. How a bot gets in: Protection Bypass for Automation

Deployment Protection stays on for every preview. A remote-browser bot gets in with Vercel's Protection Bypass for
Automation. The project has exactly one bypass secret, made on 2026-11-01 after Sebastian approved it in the OPS-106
PR. Its note starts with "OPS-106 Nora QA remote-browser bot".

1. To read it, open the `everyfield` project in Vercel, then Settings, then Deployment Protection, then "Protection
   Bypass for Automation".
2. Sebastian copies the secret into Nora's remote-browser secret store himself, under the name
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
