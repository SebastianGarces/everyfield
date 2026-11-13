# QA preview runbook (OPS-106)

A QA preview is a Vercel preview of one branch with its own database. It gives Nora a working copy of the app to test,
with seeded data, eight known logins and the same shared credentials as every preview. Nothing builds on a normal push
or PR. A preview exists only when someone asks for one, and the lead removes it when the testing ends.

`bin/qa` is the only sanctioned way to make a Vercel preview deployment (AGENTS.md). The code is in `tools/qa/`.

## 1. Nora asks for a QA preview

Nora posts one message to the engineering lead (Jonah) in the team thread:

> QA preview please: `<branch name or PR link>`. What I want to test: `<one line>`.

When the test needs mail to reach an inbox she can read, she names those addresses in the same message (see
"Real test inboxes" below).

She never pastes a password, key or bypass secret into the request. The lead answers in the same thread with the URL
and the preview id.

## 2. The lead creates the preview

Run this on Sebastian's Mac, from the home checkout. `neonctl` and `vercel` must already be logged in.

1. Make sure the branch is pushed and contains current main. The QA seed (`tools/qa/qa-seed.ts`) runs from the
   branch's own code, so a branch made before OPS-106 merged must merge main first. A branch made before the seed moved
   still works: `bin/qa` runs the older seed path that branch still carries.
2. Run `bin/qa up <branch>`, or `bin/qa up <branch> --test-recipients a@example.com,b@example.com` when Nora named
   inboxes (below). It takes 5 to 10 minutes. It does these steps in order:
   1. Finds the development Neon branch (endpoint ep-autumn-dew). It stops before it creates anything if that branch
      is missing or also serves production (ep-gentle-dust).
   2. Creates a Neon branch named `qa-<branch>-<4 hex>` off development.
   3. Installs the branch's dependencies in a temporary checkout and runs its `db:migrate` on the Neon branch.
   4. Makes the preview's mail keys (`IDENTITY_MAIL_KEY` and `IDENTITY_ADDRESS_KEY`) and runs the QA seed on the Neon
      branch with them. The seed seals and hashes the seeded mail addresses under these keys, so the preview must use
      the same two. No key is printed.
   5. Deploys the branch head with `vercel deploy --target preview`. Only the database and identity settings are set
      for this deployment, with the same mail keys the seed got. Everything else comes from the Vercel Preview
      environment.
   6. Points the alias `everyfield-<id>.vercel.app` at the deployment. The app trusts only this origin, so always give
      Nora the alias URL, not the deployment URL.
   7. Starts the preview's scheduled-send driver on this Mac and waits for its first run (see "Scheduled sends"
      below).
3. The command prints two lines: `QA preview <id>` and the URL. Send both to Nora. Below them it prints which extra
   addresses this preview mails for real, or that it mails none. Check that line against Nora's request first. The
   last line starts with `Scheduled sends:`. It must say `on` before you send the URL.

If a step fails, the command removes what it made and prints the error with every secret masked.

### Logins on every QA preview

| Role                    | Email                                       | Password                  |
|-------------------------|---------------------------------------------|---------------------------|
| Owner                   | `delivered+qa-owner@resend.dev`             | `Everyfield-QA-preview-1` |
| Admin                   | `delivered+qa-admin@resend.dev`             | `Everyfield-QA-preview-1` |
| Member                  | `delivered+qa-member@resend.dev`            | `Everyfield-QA-preview-1` |
| Network Admin           | `delivered+qa-network-admin@resend.dev`     | `Everyfield-QA-preview-1` |
| Sending-church director | `delivered+qa-sending-director@resend.dev`  | `Everyfield-QA-preview-1` |
| Second Member           | `delivered+qa-member-2@resend.dev`          | `Everyfield-QA-preview-1` |
| Sign-up                 | `delivered+qa-signup@resend.dev`            | `Everyfield-QA-preview-1` |
| Riverside Owner         | `delivered+qa-riverside-owner@resend.dev`   | `Everyfield-QA-preview-1` |

These accounts exist only on QA Neon branches, behind Vercel Deployment Protection. The Owner, Admin, Member and Second
Member land on the test church "Harvest Point (QA)". The church has people, a household, three teams, two meetings,
tasks, two follow-ups, a written document, a draft message, a sent message, the wiki and the Owner's private check-in
history (below).

The church is connected to three organizations. Two of them are sending churches with similar names. They are two
different churches on purpose:

- It has a sending church, "Grace Fellowship (QA)", and a sending network, "Harvest Network (QA)". Both share the wiki
  with Harvest Point (QA) (OPS-127). Grace Fellowship (QA) has no login. It is the wiki source of article A's church
  version (below).
- "Grace Church (QA)" is the other sending church. It holds the sending-church director login (OPS-126). It also
  shares the wiki.
- Both sending churches publish a church version of article C (below).

The Network Admin and Sending-church director logins test the overseeing side. The Network Admin is an Admin of the
network "Harvest Network (QA)". The sending-church director is the Owner of the sending church "Grace Church (QA)".
Each of these two organizations oversees Harvest Point (QA): the church's Owner sent each one a connection request,
and the organization's login accepted it.

- To see the connection, sign in as one of these logins and open `/settings/sharing`. Harvest Point (QA) is in the
  "Connected churches" list.
- `/home` shows "This account is for an organization". The app has no organization home page yet, so this is expected.
- These logins do not see planter-private data such as check-ins. They see the church only through what the
  connection shares.

### Two churches and a shared person (T-255)

The seed makes a second church plant, "Riverside (QA)", in Dallas. It is a real church, not a sending church or a
network. Rachel Moss owns it through the Riverside Owner login, and signing in as that login lands on Riverside (QA).
Riverside (QA) has no other seats and no other data.

Ana Lee is a person in both churches, Harvest Point (QA) and Riverside (QA), with the same email address in each. She
has no login. Her address is the first address given to `--test-recipients`, so mail to her reaches a real inbox. On a
preview made without the flag, it is `delivered+qa-ana@resend.dev`. Every other seeded person keeps a
`delivered+…@resend.dev` address.

The two churches do not see each other. The Harvest Point (QA) logins see no Riverside (QA) people, and the Riverside
Owner sees no Harvest Point (QA) people. The seed adds no message, schedule or opt-out for Ana. Nora sets those up
herself.

### Removable Member seat and sign-up login (T-51)

These cases came from Nora's QA notes of 2026-11-04 (WP-017).

- **Second Member, Owen Price.** `delivered+qa-member-2@resend.dev` holds a Member seat on Harvest Point (QA), and his
  Person is "Owen Price". Use this seat to test seat removal. Sign in as the Owner, open Settings, then Seats
  (`/settings/seats`), and remove Owen Price. Do not remove Ruth Allen: she holds the Member login, so removing her
  breaks it. After the removal, the Owner, Admin and Member logins still sign in and land on Harvest Point (QA). The
  Second Member login then has no church and opens church onboarding. The seed does not give the seat back, so to
  test the removal again, ask for a new QA preview.
- **Sign-up, Hannah Cole.** `delivered+qa-signup@resend.dev` is a new account with a verified email. It holds no seat
  and no organization. Signing in opens church onboarding at "Start your church", not the home screen. Once Nora
  finishes onboarding on a preview, that account owns a new church there, so to test sign-up again, ask for a new QA
  preview.

### Church, network and revised wiki articles (OPS-127)

The seed gives three wiki articles a known state, so Nora can test what a planter sees. Sign in as the owner and open
the Wiki.

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
- **Article C, "Acquiring Portable Church Equipment" (T-51, WP-034).** Grace Fellowship (QA) and Grace Church (QA)
  each published their own church version, and Harvest Point (QA) has chosen no order between them. Signed in as the
  Owner or the Admin, the article shows the "Order needed" callout "Choose which church version comes first" with a
  "Choose the order" button, which opens Settings at Wiki sources over the article. Until an order is chosen, everyone reads the global version. The Member sees no prompt.
  The seed sets no order, so Nora can choose it herself. Each church version starts with "This is the church version
  from" and the church's name.

Article A keeps its one church version, from Grace Fellowship (QA). Grace Church (QA) has no version of article A.

The seed picks these three articles as the first, second and third article by position, then by slug, in the active
wiki release of the development database. If the development wiki changes, the seed can pick other articles. Its
output names the three titles ("wiki copies of …", "wiki revision of …" and "wiki church versions of …"), so check
them when you send the URL to Nora. The seed stops with an error if the active release has fewer than three published
articles.

### Refused recipient and suppressed address (T-51)

These cases came from Nora's QA notes of 2026-11-04 (WP-028).

- **Refused recipient.** Messages has a sent message, "QA delivery check", to Maria Santos, Sara Nunez and Leo Pratt.
  Leo Pratt's address bounced 10 days before the send, so his address is suppressed and the send refused his mail.
  Sign in as the Owner, open Messages and open the message. Leo Pratt shows "Refused", and Maria and Sara show
  "Delivered". The totals count Leo under "Failed" and "Suppressed", in "Not delivered". No email left the preview:
  the seed handed the two messages to a stand-in for the email service.
- **The Admin's suppressed address and its past restore.** The Admin's own address bounced 30 days ago. Lena Park, the
  Admin, restored it 21 days ago, and it bounced again 6 days ago. Sign in as the Admin, open Messages, then "Your
  address". It shows "This address is suppressed. It does not receive church email." "Past restores" lists one
  restore with its date, "Restored by Lena Park" and the reason "Lena confirmed her inbox works again after the first
  bounce." Nora can restore the address with a reason. It then shows as not suppressed, and "Past restores" lists two
  restores, the new one first.

The Address section shows only the signed-in account's own address, so only the Admin login shows this case.

### Which previews have these cases

A preview made before T-51 merged has none of the T-51 cases: the Second Member and Sign-up logins, the delivery
message, the suppressed addresses and article C. Make a new preview with `bin/qa up` from a branch that contains T-51.
A preview that is already open does not change.

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

Outside production, mail goes only to approved test recipients. The send path enforces this on every send, with or
without a Resend key. Only `VERCEL_ENV=production` lets mail reach any address. An address is approved in two cases:

- The local part starts with `delivered+` and the domain is exactly `resend.dev`. Resend accepts mail to these addresses
  and delivers it to nobody. Every seeded person and login uses one.
- The full address is in `EMAIL_TEST_RECIPIENTS`, a comma-separated list that is empty by default. The list holds full
  addresses. A domain or a wildcard approves nobody. The list adds addresses and it cannot turn the rule off.

Every other address goes to the capture outbox and never appears in a request to Resend, also when a tester types a real
address. Read the outbox at `/api/dev/outbox` on the preview. "Accepted" in Messages does not say which mode ran.

#### Real test inboxes: `--test-recipients`

Use the flag when Nora needs to see mail arrive in a real inbox, for example to check what a recipient gets or that an
opted-out person gets nothing:

    bin/qa up main --test-recipients nora-inbox@example.com

- The value is one or more full addresses, comma-separated. `bin/qa up` refuses before it makes anything when an entry
  is empty, has no `@`, is a bare domain or holds a wildcard, and says which entry to fix.
- It sets `EMAIL_TEST_RECIPIENTS` on this one deployment only, with the same per-deployment setting as the database
  and identity keys. It never changes the Vercel Preview or Production environment, so other previews are not affected.
- These addresses receive real mail through Resend, with the preview's shared Resend key. Only use addresses whose
  owner agreed to get test mail.
- The first address is Ana Lee's address in both churches (above).
- The list is fixed when the preview is made. To change it, make a new preview and remove the old one.
- `bin/qa list` and the preview records do not hold the addresses.

#### See what was delivered

Three places together show what a preview really sent:

- **The real inbox.** Mail to an address given to `--test-recipients` arrives there, like any other email. Check spam
  too.
- **The Resend email log.** In the Resend dashboard, open Emails. Every email the preview handed to Resend is listed
  with its recipient, subject, time and status. All previews share one Resend key, so filter by the recipient address.
  `delivered+…@resend.dev` sends show there too.
- **The capture outbox.** Every other address is in `/api/dev/outbox` on the preview, never in Resend. It has the
  one-instance limit described above.

To prove that an opted-out person got nothing:

1. Pick a person whose address is a real test inbox, for example Ana Lee.
2. Opt that person out: send them a message, open it in their inbox and use its Unsubscribe link, or follow the test
   case's own steps. Note the time.
3. Send a message from Messages with "Send now" to an audience that includes that person and at least one other.
4. Check that the other recipients got the message (their inbox, the Resend log or the outbox).
5. Check that nothing new reached the opted-out person's inbox, that the Resend log has no email to that address
   after the opt-out time, and that `/api/dev/outbox` has none either.

The outbox is a temp folder on one server instance. On Vercel, another instance may not see a capture, so the outbox can
miss it and a cancel or time change can answer unknown. Nothing is sent in that case.

"Send now" in Messages hands the mail to Resend or the outbox in the same request. A scheduled send waits for the
scheduled-send job, which the driver below runs. Evry turns also run in the request.

#### Scheduled sends: the cron driver (T-255)

In production, Vercel calls `/api/cron/jobs` every minute (`apps/web/vercel.json`). That route sends scheduled Messages
email at its send time and runs the other background jobs. Vercel does not run crons on previews, so `bin/qa up`
starts a small driver on the lead's Mac that calls the same route on the preview once a minute, a couple of seconds
after the minute starts. A message scheduled for 10:03 goes out by about 10:03:02, through the same code as
production, with no manual step.

- The preview has its own `CRON_SECRET`, made by `bin/qa up` and set on that one deployment like the database
  settings. The driver holds it in memory and in a private temporary file. It is never printed, stored in the records
  or put in the shared Vercel environments.
- The driver calls the route with `vercel curl`, which gets past Deployment Protection with the project's existing
  Protection Bypass for Automation (section 3). The Mac's Vercel CLI must have the `curl` command.
- On the preview, the cleanup login points at the preview's own Neon branch, so the job's purges stay on that branch.
- The driver writes one line per run to `<git common dir>/qa/<id>.cron.log`: the time, the HTTP status and the route's
  counts (`"messages": 1` means one scheduled email went out). To watch it:
  `tail -f "$(git rev-parse --git-common-dir)/qa/<id>.cron.log"`.
- It runs until `bin/qa down <id>`, which stops it first. It also stops on its own when the preview's record is gone.
- It runs only while the Mac is awake. If the Mac sleeps, due messages go out on the first run after it wakes. If the
  Mac restarts, the driver is gone and scheduled sends wait: make a new preview.
- If `Scheduled sends:` says the first run FAILED, the preview is up but scheduled sends are not. The line and the log
  name the HTTP status. A 401 or 403 from Vercel means `vercel curl` could not get past Deployment Protection, and
  a command error means the Vercel CLI needs an update. The driver keeps trying every minute, so fix the cause or
  make a new preview before Nora tests a scheduled send.

A preview built before WP-029 merged keeps the old code and can send to any address. Rebuild an open preview from that
time with `bin/qa up` before you test mail on it.

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

1. Run `bin/qa list`. It shows each open preview with its id, branch, URL, Neon branch and age.
2. Run `bin/qa down <id>` for each preview that is done. It stops the scheduled-send driver, removes the alias, the
   Vercel deployment and the Neon branch, then its record. A second run for the same id does nothing and succeeds.
3. Check with `neonctl branches list --project-id cool-math-76767811` that no `qa-` branch is left for that id.

Files that Nora uploads go to the shared development bucket and stay there. QA previews do not expire on their own,
which is why `qa list` exists.

## 5. Where the records are

`bin/qa` keeps its records in `<git common dir>/qa/previews.json`, one file for every worktree. It holds names, URLs
and the driver's process id, never a connection string, key or password. Each open preview also has its driver's log,
`<id>.cron.log`, in the same folder.
