# T-241 QA run: unsubscribing stops emails that are already scheduled (T-256)

**This run was local, not on a hosted QA preview.** The delivery rows come from a **fake Resend log**, not the
Resend dashboard. The owner chose this on Nov 11, 2026 (evf question D-667), for three reasons:

- `bin/qa up` could not run in this seat, because `neonctl` and `vercel` are not installed or logged in here.
- Since T-241, a scheduled Messages email waits until the minute runner `/api/cron/jobs` sends it. Vercel runs no cron
  on preview deployments, and the route needs the `CRON_SECRET` bearer, which this seat may not read. On a hosted
  preview, no scheduled email would ever go out.
- This seat has no Resend dashboard access and may not read the Resend API key.

This run does not judge pass or fail. That call is Nora's.

## Setup

| Item | Value |
|---|---|
| Commit run | `87036c8a4860e1efb418f40db6471934ca30a136` (main when the task started; contains T-241, `d9d2a33e`) |
| App | Production build (`next build`, `next start`) through a portless production preview, id `ba88d0f9-cf48-4ef8-b315-99477f8e6fc9`, `https://t256-qa-run-t-241-unsubsc-ba88d0f9.localhost:1355` |
| Database | Throwaway local Postgres (Docker `pgvector/pgvector:0.8.7-pg17`), migrated with `pnpm db:migrate` and seeded with the QA seed `tools/qa/qa-seed.ts`, the same seed `bin/qa up` runs |
| Keys | New random identity, mail, opt-out and webhook keys made for this run only, not printed and not stored in proof. `VERCEL_ENV` unset, so only `delivered+…@resend.dev` addresses reach the provider. `EMAIL_TEST_RECIPIENTS` unset. No Vercel, Neon or Resend setting was read or changed. |
| Cron | A local loop called `GET /api/cron/jobs` with a local test bearer at the top of each minute, as Vercel cron does in production (`cron.log` in the evidence) |
| Fake Resend | A Node preload in the app process that answers the `https://api.resend.com` calls (`POST /emails/batch` and others) and logs each email, then posts signed `email.sent` and `email.delivered` webhooks back to the app, as Resend does for `delivered+` addresses |
| Staff login | Harvest Point (QA) Owner `delivered+qa-owner@resend.dev` (Daniel Reyes), as Church A staff |
| Browser time zone | America/New_York (times in the app are ET, which is UTC−5) |
| "Ana" | Ana Lee, `delivered+qa-ana@resend.dev` (seeded) |
| Other recipients | D1: Tom Baker, `delivered+qa-tom@resend.dev`. D7: Maria Santos, `delivered+qa-maria@resend.dev` (both seeded) |
| How Ana opted out | With the Unsubscribe link from an earlier Church A email. At 17:23:21 UTC staff sent "T-256 earlier email (Ana's unsubscribe link)" to Ana with Send now. The link came from that email's body in the fake Resend log. Ana opened it in a signed-out browser and pressed Unsubscribe. Before D7, she pressed Undo on the same page, which allows it within one hour, and later unsubscribed again from the same link. |

## Results

All times are UTC on Nov 11, 2026. Evidence paths are inside the proof archive `t256-evidence.tgz` (folder `evidence/`).

| Item | What was done | What was seen (word for word where quoted) | Timestamps | Evidence |
|---|---|---|---|---|
| D1 | Staff scheduled "T-256 D1 scheduled (Ana + Tom)" to Ana Lee and Tom Baker for 12:30 PM ET. Then Ana opted out with the Unsubscribe link. At send time + 1 min, the fake Resend log was read. | Nothing was handed to the fake Resend when the email was scheduled. At 17:30:00 the runner sent one batch with one email, to `delivered+qa-tom@resend.dev`, status `delivered` at 17:30:02.518, id `55dbd34f-7556-48ae-884d-2b2f5367345a`. The log has no row for `delivered+qa-ana@resend.dev` for this email. Her only row is the earlier Send now email from 17:23:21. The cron answered `"messages":1` at 17:30:00. | Scheduled 17:24:44 for 17:30:00. Ana opted out 17:25:01. Send 17:30:00.975. Log read 17:31:19, screenshot and timeline entry at 17:31:26. | `d1-fake-resend-log-1440.png`, `fake-resend-rows.json`, `cron.log`, `00-ana-unsubscribe-confirm-1440.png`, `01-ana-unsubscribed-done-1440.png`, `timeline.txt` |
| D2 | Before the send, staff opened the scheduled D1 email in Messages. | Next to Ana: "Unsubscribed, won't receive this". Tom: "Scheduled". Header: "1 recipient" and "Scheduled. 0 delivered of 1 reachable (0%)." Schedule box: "It goes to 1 person then. Anyone who unsubscribes before then gets nothing. Unsubscribed 1." Counts: Selected 2, Reachable 1, Unsubscribed 1. The history row reads "For Nov 11, 2026, 12:30 PM · 1 recipient". | Screenshots at 17:25:26 (1440) and 17:25:28 (390), before the 17:30:00 send | `d2-scheduled-staff-1440.png`, `d2-scheduled-staff-390.png`, `d2-staff-view-text.txt` |
| D3 | After the send, staff opened the sent D1 email. | Next to Ana: "Skipped: unsubscribed", then "Sent Not recorded · Delivered Not recorded · Opened Not recorded · Clicked Not recorded". Tom: "Delivered", "Sent Nov 11, 2026, 12:30 PM · Delivered Nov 11, 2026, 12:30 PM". Header: "Sent. 1 delivered of 1 reachable (100%)." Not delivered: Bounced 0, Failed 0, Suppressed 0, Unsubscribed 1, Unknown 0. The top tiles read "1 Reachable", "1 Delivered", "0 Opened", "1 Not delivered". | Screenshots at 17:31:40 | `d3-sent-staff-1440.png`, `d3-sent-staff-390.png`, `d3-staff-view-text.txt` |
| D5 | Skipped in this run. Rerun in T-257, see "D5 rerun (T-257)" below. | Not run here. The two-church seed with Riverside QA comes from T-255, which was not on main yet, so there was no second church to send from. | n/a | See "D5 rerun (T-257)" |
| D7 | Ana pressed Undo first (17:31:50). Staff scheduled "T-256 D7 scheduled (Ana + Maria)" to Ana Lee and Maria Santos for 12:35 PM ET, 2 minutes out. Ana unsubscribed again 1 minute before the send time. At send time + 1 min, the fake Resend log was read and staff opened the email again. | Before the opt-out, Ana was shown as "Scheduled". After the opt-out and before the send, Ana: "Unsubscribed, won't receive this"; "It goes to 1 person then. Anyone who unsubscribes before then gets nothing. Unsubscribed 1." At 17:35:00 the runner sent one email, to `delivered+qa-maria@resend.dev`, status `delivered` at 17:35:01.768, id `92563702-5286-47d6-a866-e2817789a6fe`. The log has no row for Ana for this email. After the send, Ana: "Skipped: unsubscribed". Maria: "Delivered". Header: "Sent. 1 delivered of 1 reachable (100%)." Bounced 0, Failed 0, Unsubscribed 1. | Scheduled 17:32:58 for 17:35:00. Staff screenshots before the opt-out at 17:33:18. Ana opted out at 17:34:00. Staff screenshots after the opt-out at 17:34:16. Send at 17:35:00.219. Log read at 17:36:10. Screenshots after the send at 17:36:20. | `d7-00-ana-undo-1440.png`, `d7-a-scheduled-before-optout-{1440,390}.png`, `d7-b-scheduled-after-optout-{1440,390}.png`, `d7-c-sent-{1440,390}.png`, `d7-fake-resend-log-1440.png`, the matching `d7-*-text.txt`, `fake-resend-rows.json` |

## Fake Resend rows (whole run)

| Handed over (UTC) | To | Subject | Status (UTC) | Email id |
|---|---|---|---|---|
| 17:23:21.684 | `delivered+qa-ana@resend.dev` | T-256 earlier email (Ana's unsubscribe link) | delivered 17:23:23.234 | `71ae6ac7-f3f3-419e-bb3c-6a4fb2feadfa` |
| 17:30:00.975 | `delivered+qa-tom@resend.dev` | T-256 D1 scheduled (Ana + Tom) | delivered 17:30:02.518 | `55dbd34f-7556-48ae-884d-2b2f5367345a` |
| 17:35:00.219 | `delivered+qa-maria@resend.dev` | T-256 D7 scheduled (Ana + Maria) | delivered 17:35:01.768 | `92563702-5286-47d6-a866-e2817789a6fe` |

The log holds 3 emails, 3 batches, 6 webhooks (all answered 200) and 3 status rows. It has no cancel, reschedule or
unhandled call. Every email carried the `List-Unsubscribe` header.

## Teardown (17:36:39 UTC)

`portless preview down ba88d0f9-cf48-4ef8-b315-99477f8e6fc9` answered `"state":"removed"`. The cron loop and the log
viewer were stopped by PID, both agent-browser sessions were closed, and the throwaway Postgres `t256-pg` was stopped
and removed (`--rm`). The final checks printed "cron driver and viewer gone", "`t256-pg` gone" and "preview state:
removed".

## D5 rerun (T-257)

D5, word for word: "As Riverside QA staff, schedule an email 5 minutes out to Ana, who opted out of Church A only.
Expect it delivered to Ana."

**This rerun was also local, not on a hosted QA preview** (owner ruling D-718, following D-667 above). The delivery
rows come from a **fake Resend log**, not the Resend dashboard, and no real inbox was used. Nora checks her own inbox on
a hosted preview herself. This section records what happened and does not judge pass or fail. That call is Nora's.

### Setup

| Item | Value |
|---|---|
| Commit run | `e163e89d78bd65a3ab0219e4718256d5fc4e9b93` (main when the task started; contains T-255, `0a0b2da1`) |
| App | Production build (`next build`, `next start`) through a portless production preview, id `0266af01-1901-4ac3-9c02-4f4a7ace72e1`, `https://t257-d5-rerun-once-t-255--0266af01.localhost:1355` |
| Database | Throwaway local Postgres (Docker `pgvector/pgvector:0.8.7-pg17`, container `t257-pg`), migrated with `pnpm db:migrate` (56 migrations) and seeded with main's `tools/qa/qa-seed.ts` |
| Seed check | The seed wrote "church Riverside (QA)", "login delivered+qa-riverside-owner@resend.dev" and "person Ana Lee in Riverside (QA)". The database holds two Ana Lee people: one in Harvest Point (QA) (Austin) and one in Riverside (QA) (Dallas), both at `delivered+qa-ana@resend.dev` (`seed-check.txt`) |
| Keys | New random identity, mail, opt-out, cron and webhook keys made for this run only, not printed and not stored in proof. `VERCEL_ENV`, `EMAIL_TEST_RECIPIENTS` and `QA_TEST_RECIPIENTS` unset, so Ana is `delivered+qa-ana@resend.dev` in both churches. No Vercel, Neon or Resend setting was read or changed. |
| Cron | A local loop called `GET /api/cron/jobs` with a local test bearer at the top of each minute (`cron.log`). It ran 11 times, from 21:54:39 to 22:04:00, each answered HTTP 200 |
| Fake Resend | The T-256 Node preload (`harness/fake-resend.mjs`), loaded in the app process. It answers the `https://api.resend.com` calls, logs each email, and posts signed `email.sent` and `email.delivered` webhooks back to the app, as Resend does for `delivered+` addresses. A local page renders the log for screenshots (`harness/resend-log-view.mjs`) |
| Church A staff | Harvest Point (QA) Owner `delivered+qa-owner@resend.dev` (Daniel Reyes) |
| Riverside staff | Riverside Owner `delivered+qa-riverside-owner@resend.dev` (Rachel Moss), who lands on Riverside (QA) |
| Browser time zone | America/New_York (times in the app are ET, which is UTC−5) |
| "Ana" | Ana Lee, `delivered+qa-ana@resend.dev`, seeded in both churches |

### Results

All times are UTC on Nov 11, 2026. Evidence paths are inside the proof archive `t257-evidence.tgz` (folder
`evidence/`).

| Item | What was done | What was seen (word for word where quoted) | Timestamps | Evidence |
|---|---|---|---|---|
| Opt-out of Harvest Point (QA) only | Harvest Point (QA) staff sent "T-257 earlier Harvest Point email (Ana's unsubscribe link)" to Ana Lee with Send now. The Unsubscribe link came from that email's body in the fake Resend log. Ana opened it in a separate, signed-out browser and pressed Unsubscribe. | Before: "Stop email from Harvest Point (QA)?" "You will stop getting the messages Harvest Point (QA) sends you by email. Nothing changes until you press Unsubscribe." After: "You will no longer get email from Harvest Point (QA)" "Harvest Point (QA) will see that you unsubscribed. Email from other churches stays as it is." "Undo" "You can undo this here for one hour." | Earlier email handed over 21:55:27.997, delivered 21:55:29.560. Ana opted out 21:55:57. | `01-ana-unsubscribe-confirm-{1440,390}.png`, `02-ana-unsubscribed-done-{1440,390}.png`, `01-ana-confirm-text.txt`, `02-ana-unsubscribed-text.txt` |
| Harvest Point (QA) staff check | Harvest Point (QA) staff started a new message. In the To search, Ana Lee was listed but could not be picked. Staff then chose the group "Launch team", which holds Ana, and stayed on the Who step of the draft. | To search: "Ana Lee" "Unsubscribed from this church's email on Nov 11, 2026", shown disabled. Draft with Launch team: "Launch team · 0 people". Counts: "1 Selected, after duplicates", "0 Will get this email", "1 Left out". "Left out, and why": "Ana Lee" "Unsubscribed from this church's email on Nov 11, 2026" "Only the person can undo an unsubscribe, from the link in an email. Staff cannot clear it." Footer: "Choose at least one person who can get email". | Screenshots at 21:56:52, after the 21:55:57 opt-out | `03-hp-draft-ana-left-out-{1440,390}.png`, `03-hp-draft-staff-text.txt` |
| D5 schedule (Riverside) | Signed in as the Riverside Owner. New message to Ana Lee, subject "T-257 D5 Riverside scheduled (Ana)", "Schedule: pick a date and time" set to Nov 11, 2026, 5:03 PM ET (22:03 UTC), then "Schedule email". | In the To search, Riverside staff saw "Ana Lee" "delivered+qa-ana@resend.dev" and could pick her. Who step: "1 Selected, after duplicates", "1 Will get this email", "0 Left out", "Everyone selected can get this email." Dialog: "Schedule for Nov 11, 2026, 5:03 PM?" "1 person gets this email on Nov 11, 2026, 5:03 PM." After: "Scheduled for Nov 11, 2026, 5:03 PM. It goes to 1 person then." | Scheduled 21:57:42 for 22:03:00. | `timeline.txt` |
| D5 before the send (Riverside) | Riverside staff opened the scheduled email in Messages. | Header: "Scheduled", "For Nov 11, 2026, 5:03 PM · 1 recipient". "Recipients 1 recipient". "Delivery Scheduled. 0 delivered of 1 reachable (0%)." Schedule box: "It goes to 1 person then. Anyone who unsubscribes before then gets nothing." Counts: Selected 1, Reachable 1, Attempted 0, Unsubscribed 0. Preview "From Riverside (QA)", footer "You get this email because you are part of Riverside (QA)." Next to Ana: "Ana Lee" "Scheduled" "Address at send: delivered+qa-ana@resend.dev" "Address now: delivered+qa-ana@resend.dev" "Sent Not recorded · Delivered Not recorded · Opened Not recorded · Clicked Not recorded". | Screenshots at 21:58:00, before the 22:03:00 send | `04-d5-scheduled-riverside-{1440,390}.png`, `04-d5-scheduled-riverside-text.txt` |
| D5 fake Resend log | At send time + 1 minute, the fake Resend log and the cron log were read. | A row exists for `delivered+qa-ana@resend.dev`, subject "T-257 D5 Riverside scheduled (Ana)", handed over 22:03:00.914, status `delivered` at 22:03:02.460, email id `c14c66fd-707e-4862-9b3d-b7119b2b829a`, with a `List-Unsubscribe` header. It went in one batch of one email. The cron loop for that minute: `2026-11-11T22:03:00Z ... "messages":1 ... http=200`. The minutes before and after answered `"messages":0`. | Log read 22:04:11 (page rendered 22:04:11.913) | `05-d5-fake-resend-log-{1440,390}.png`, `fake-resend-rows.json`, `cron.log` |
| D5 after the send (Riverside) | Riverside staff opened the sent email. | Header: "Sent", "Nov 11, 2026, 5:03 PM · 1 recipient". "Delivery Sent. 1 delivered of 1 reachable (100%)." Top tiles: "1 Reachable", "1 Delivered", "0 Opened", "0 Not delivered". Counts: Selected 1, Reachable 1, Attempted 1, Accepted 1, Sent 1, Delivered 1; Bounced 0, Failed 0, Suppressed 0, Unsubscribed 0, Unknown 0. "Every recipient record is sent. Provider words: Accepted." Next to Ana: "Ana Lee" "Delivered" "Sent Nov 11, 2026, 5:03 PM · Delivered Nov 11, 2026, 5:03 PM · Opened Not recorded · Clicked Not recorded". | Screenshots at 22:04:29 | `06-d5-sent-riverside-{1440,390}.png`, `06-d5-sent-riverside-text.txt` |

### Fake Resend rows (T-257 run)

| Handed over (UTC) | To | Subject | Status (UTC) | Email id |
|---|---|---|---|---|
| 21:55:27.997 | `delivered+qa-ana@resend.dev` | T-257 earlier Harvest Point email (Ana's unsubscribe link) | delivered 21:55:29.560 | `ebff58fe-f3aa-4e3a-b4d7-246b68b240b0` |
| 22:03:00.914 | `delivered+qa-ana@resend.dev` | T-257 D5 Riverside scheduled (Ana) | delivered 22:03:02.460 | `c14c66fd-707e-4862-9b3d-b7119b2b829a` |

The log holds 2 emails, 2 batches, 4 webhooks (all answered 200) and 2 status rows. It has no cancel, reschedule or
unhandled call. Both emails carried the `List-Unsubscribe` header.

### Teardown (22:04:47 UTC)

`portless preview down 0266af01-1901-4ac3-9c02-4f4a7ace72e1` answered `"state":"removed"`. The cron loop and the log
viewer were stopped by PID, the three agent-browser sessions (`t257-hp`, `t257-ana`, `t257-rv`) were closed, and the
throwaway Postgres `t257-pg` was stopped and removed (`--rm`). The final checks printed "cron loop and viewer gone",
"`t257-pg` gone" and "preview state: removed" (`teardown.txt`).
