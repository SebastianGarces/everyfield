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
| D5 | Skipped. | Not run. The two-church seed with Riverside QA comes from T-255, which is not on main, so there is no second church to send from. Rerun once T-255 lands. | n/a | n/a |
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
