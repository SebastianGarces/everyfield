# Kill switches

Three `kill` flags in `packages/domain/src/flags/registry.ts` stop a risky external call for everyone at once. Each
defaults on, so with no stored value Everyfield behaves as it always has. Turning one off takes effect on the next
request or cron run, with no deploy or restart, and turning it back on restores the feature the same way.

- A switch reads only its global value. Workspace and account overrides of a kill flag are ignored, so a switch cannot
  be off for one church and on for another.
- Each refusal writes one server log line, `{"component":"kill-switch","switch":"<name>","action":"<action>","outcome":"refused"}`.
  Search the logs for `kill-switch` to see what a switch stopped. Each flip is audited as `flags.changed` (T-470).
- Flipping a switch in production is production access: AGENTS guard 1 applies, so get Sebastian's OK first.

Flip a switch with `bin/flag` (T-471):

```sh
bin/flag set <name> off --all   # stop it for everyone
bin/flag set <name> on --all    # turn it back on
```

## `evry-model-calls`

- **Stops:** every Evry model call. A new conversation, a new message and a retry are refused before anything is
  saved. A turn already queued ends at once with the paused code and no model call. The assessment drafter in the cron
  run makes no model call, and its jobs stay pending until the switch is back on.
- **Users see:** in the Evry panel, a refused message stays in the panel with "Not sent. Evry is paused for now, so
  nothing was saved. Your message is still here. Send it again later." The first
  message of a new conversation says "Evry is paused for now, so no conversation was started and nothing was saved. Your
  message is still here. Send it again later." A turn that was already queued ends with
  "Evry is paused: Evry stopped before it read or changed anything. Your message is saved, so you can try again
  later."
- **Still works:** reading past conversations, and reviewing, approving or cancelling proposals Evry already prepared.

## `outbound-mail`

- **Stops:** every new hand-off to the email service. In Communication, sending now, scheduling and saving a resend
  are refused before anything changes. Evry refuses to prepare or approve an email it would send, and an Evry send
  approved before the flip is refused before it runs (a meeting invitation creates no meeting or guests). One that
  had already reached the email service stays unconfirmed until it is checked or retried. Every cron mail pass is held:
  identity, organization, settings, onboarding, notice, digest and feedback mail, invitation mail and scheduled messages. Held mail stays queued with no
  attempt counted, and goes out once on the first cron run after the switch is back on. The public early access form
  sends nothing and saves nothing.
- **Users see:** in Communication, "Sending email is paused for now. Nothing was sent, and this message did not
  change. Try again later." On an Evry review card, "Sending email is paused for now, so nothing was sent. This change
  is still waiting. Approve it again later." When asked to send, Evry says email is paused and nothing was sent.
  The early access form says "Your request was not sent" and keeps the answers.
  People waiting for identity or invitation mail are told it is delayed, and their request is still accepted and queued:
  - Password reset: "Reset emails are delayed", the same for a known and an unknown address, and to ask for a new link
    if none arrives within an hour.
  - Email verification: the onboarding "Confirm your email first" and invitation "Confirm your email to join" screens say
    "Confirmation email is delayed". Sending the link again says the confirmation email is delayed and to ask for a new
    link if none arrives within an hour.
  - Email change in Settings: the email to the new address is delayed, its link works for 24 hours from the request, and
    they sign in with the current address until they open it.
  - Seat invitations, Connections and resident account links: the invitation is saved, but its email is delayed, after an
    invite and after a resend. The invitation is not refused.

  These messages come from the switch when the request is handled. Nobody is told when mail resumes. Evry review cards do
  not say it yet.
- **Still works:** cancelling or moving an email already handed to the email service, and checking what it holds. The
  cron run still cancels it for anyone who has unsubscribed since.
- **Not stopped:** mail already handed to the email service for a scheduled time still goes out at that time. To stop
  one, cancel it from the message in Communication. Password-reset and verification mail still expires on its usual
  schedule while it is held: mail held past its 1-hour link is cancelled and is not sent, even after the switch is back
  on. Email-change links work for 24 hours and invitations for 30 days from the request.

## `document-exports`

- **Stops:** saving a church document export (`documents.exportNative`, the native PDF and Word render). It is refused
  before rendering, with no saved export and no stored file, including one Evry was approved to save.
- **Users see:** in saved exports, "Saving exports is paused for now, so nothing was saved or downloaded. Exports you
  saved earlier still download. Try again later." On an Evry review card, "Saving exports is paused for now, so
  nothing was saved. Ask Evry to prepare it again later."
- **Still works:** downloading exports saved earlier, and editing documents.
