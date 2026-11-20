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
  nothing was saved. Your message is still here. Send it again later." A turn that was already queued ends with
  "Evry is paused: Evry stopped before it read or changed anything. Your message is saved, so you can try again
  later."
- **Still works:** reading past conversations, and reviewing, approving or cancelling proposals Evry already prepared.

## `outbound-mail`

- **Stops:** every new hand-off to the email service. In Communication, sending now, scheduling and saving a resend
  are refused before anything changes. Evry refuses to prepare or approve an email it would send, and an Evry send
  approved before the flip is refused before it runs. Every cron mail pass is held: identity, organization, settings,
  onboarding, notice, digest and feedback mail, invitation mail and scheduled messages. Held mail stays queued with no
  attempt counted, and goes out once on the first cron run after the switch is back on.
- **Users see:** in Communication, "Sending email is paused for now. Nothing was sent, and this message did not
  change. Try again later." On an Evry review card, "Sending email is paused for now, so nothing was sent. This change
  is still waiting. Approve it again later." When asked to send, Evry says email is paused and nothing was sent.
  People waiting for a password reset, verification or invitation email get it late, once the switch is back on.
- **Still works:** cancelling or moving an email already handed to the email service, and checking what it holds.
- **Not stopped:** mail already handed to the email service for a scheduled time still goes out at that time. To stop
  one, cancel it from the message in Communication. Password-reset and verification mail still expires on its usual
  schedule while it is held.

## `document-exports`

- **Stops:** saving a church document export (`documents.exportNative`, the native PDF and Word render). It is refused
  before rendering, with no saved export and no stored file.
- **Users see:** in saved exports, "Saving exports is paused for now, so nothing was saved or downloaded. Exports you
  saved earlier still download. Try again later."
- **Still works:** downloading exports saved earlier, and editing documents.
