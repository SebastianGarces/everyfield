---
name: verify-preview
description: "Apply when you verify a change as the independent Opus verifier. Run the head on its own portless preview against the shared dev database, check UI in Chromium and WebKit and backend with a temporary script, drive interactive checks with agent-browser, publish the evidence, then record the review with evf review submit."
---

# Verify on a preview

You prove the change works. The author's summary is not evidence, but the author's proof is: read the
diff in full and judge the code (D66), read `evf proof show` and open each proof's evidence.
Spot-check the author's proofs. Re-run an author's check on a preview of the exact head only where a proof is unmet,
missing or looks wrong. App proof is the exception: for a diff that changes app code you capture it yourself (step 3). Run local checks with `bin/dev check --full`: a verifier ignores selection and runs every check. You own the verdict. The Experience section may use the author's recorded
measurements; re-measure where they look wrong or missing. Scripts are in `scripts/` next to this file. They need Node 24+, `gh`, `portless`, the
local env files of the main checkout and, for `publish.mjs`, the evidence env file (step 6). Every command below runs from any checkout of this repo.

```bash
S=.agents/skills/verify-preview/scripts            # in your own checkout of main
E=$(git rev-parse --path-format=absolute --git-common-dir)/evf-evidence/<task>-verify/<sha7>
mkdir -p "$E"
```

Keep scripts, logs, screenshots and videos in `$E`, never in the repository.

## Browsers and processes

The machine has little CPU and memory. Run one browser job at a time and close every browser you
start. These rules apply to every role that opens a browser.

- Scripted checks run through `bin/dev browser run [--timeout <s>] -- <command>`. It runs the
  command in its own process group with a timeout (default 900 s). When the command ends, fails,
  times out or gets a signal, it closes the run's agent-browser session, stops every process
  the run started and deletes the run's temporary directory, where Playwright keeps its profiles.
- Interactive checks use agent-browser, never the Playwright MCP. Give each job its own
  session and a short idle timeout, and close it when you finish, also after a failure:

  ```bash
  ab() { agent-browser --session <task>-verify --idle-timeout 10m "$@"; }
  ab open <branch url>; ab set viewport 390 900; ab snapshot -i; ab click @e3
  ab screenshot "$E/shots/<name>.png"; ab errors; ab console
  ab close
  ```

  Run `agent-browser skills get core` once for the full command guide.
- Stop only processes you started, by PID or process group. Never stop processes by a name
  pattern (`pkill chrome`, `killall`): other agents' browsers run on the same machine.
- Before you end, none of your browsers or agent-browser sessions may still be running.

Install the pinned tools once per machine. Video needs `ffmpeg` on `PATH`.

```bash
npm install -g agent-browser@0.39.1     # add --prefix "$(dirname "$(dirname "$(command -v node)")")" if npm's prefix points elsewhere
agent-browser install                    # Chrome for Testing for agent-browser
brew install ffmpeg                      # macOS; video recording only
```

agent-browser drives Chrome only. Its Safari backend needs the iOS Simulator and Appium and
cannot take headless 390 and 1440 px desktop shots, so WebKit parity stays in `capture.mjs`.

## Shared preview service

These Everyfield rules sit on top of the verbatim `portless-preview` skill and apply to every role that runs a preview.

- An app whose auth trusts one origin sets that origin to `${PREVIEW_URL}` in the preview config `env`; Portless
  replaces it with the preview's own URL.
- Timing previews: D81's quiet timing runner retired with evf v1. Do not time on a shared preview and call it a
  qualifying timing set; report the measurement and what it shared the machine with.
- Slots: the managed launcher sets `PORTLESS_PREVIEW_LIMIT=4`, so four previews run at a time. The supervisor reads the
  limit when it starts; restarting it stops every active preview, so never restart it while another agent's preview
  runs. Builders and verifiers come first. The coordinator may stop Sebastian's review preview at any time and restarts
  it later on main. Never stop another workspace's preview. See D74 in `docs/architecture/decisions.md`.
- Tests of Portless itself never touch the shared service. Give the test a new temporary folder in `PORTLESS_STATE_DIR`
  and `PORTLESS_PREVIEW_DIR`, its own `PORTLESS_PORT` and `PORTLESS_PREVIEW_PORT`, and `PORTLESS_PREVIEW_HTTP=1`. Never
  restart, reinstall, `clean` or stop the shared service or its supervisor: at 02:04 UTC on 2026-10-22 one restart
  removed every live preview.

## 1. Read

Read your brief (the ask and the spec) and the full diff against the merge base. Read the
requirements the task names. Write down the behavior you will check before you run anything.
You are a fresh Opus 5.5 medium session that never shared context with the author (D82).

Start from the feature map when the feature has one. For each feature directory the diff touches,
read `docs/feature-maps/<feature>.md` or run `node tools/ci/feature-maps.ts show <surface-id>`. It
names the routes, the QA seed persona that reaches each state, the tests and cases behind each
behavior, and browser steps as agent-browser commands. "Become a persona" in
`docs/feature-maps/README.md` says how to sign in. Follow those steps on a fresh QA seed instead of
exploring the app. When the map and the app disagree, that is a finding.

## 2. Start the previews

```bash
node $S/preview.mjs --pr <n>      # after: the PR head, in a worktree .worktrees/verify-<sha7> on branch verify/<sha7>
node $S/preview.mjs --main        # before: current origin/main, the same way
node $S/preview.mjs --ref <sha>   # any other commit, the same way (for example a PR's old base)
```

Review starts after evf has opened the PR, so `--pr <n>` is the after side. Each prints `{id, url, head}`. Both are production builds of a clean commit with a two-hour lease.
`preview.mjs` builds the preview env from the main checkout's `apps/web/.env.local` and lays the
worktree's own `apps/web/.env.local` over it, so a `tests/ui` seed's `IDENTITY_*` values reach the preview.
`IDENTITY_ORIGIN` is the exception: it is always `${PREVIEW_URL}` unless an explicit `--config` sets it.
It only reads the worktree's file and never creates, edits or deletes it. It writes the composed env to a
mode 0600 config outside the repository, prints no value and refuses to start when the composed
`DATABASE_URL` is not the shared development database.
The supervisor runs four previews at a time. Stop your own old previews first (`portless preview down <id>`). Stop another agent's
preview only when its PR is merged or closed, and say so in your report.

Setup timing: `preview.mjs` and `bin/dev stack up` record each install and build as one JSON file in
`$(git rev-parse --path-format=absolute --git-common-dir)/evf-setup-steps` (or `EVF_SETUP_STEPS_DIR`), with the
build's `.next/cache` state. `node scripts/setup-step.mjs report [--json]` gives weekly totals and hit rates per step.
`node tools/ci/ci-timing.ts --last <n> [--json]` splits GitHub CI jobs into queue, setup and run time with cache hits.

The development database is shared and may be wiped and reseeded at any time:
`corepack pnpm --filter @everyfield/db reset:dev`. Never point a check at production. Never print
credentials. Do not submit a valid access form unless the task needs it: it sends a real email.

## 3. App proof

Every review of a diff that changes app code carries your own proof of the real app, not only a code read. Find what
the diff needs, in the head checkout:

```bash
B=$(git merge-base HEAD origin/main)
pnpm review-proof --base "$B" --evidence "$E"     # add --head <checkout> when you run it from another checkout
```

It reads the diff from the merge base to the head and requires the surface of each changed mapped route, at least one
surface of each changed mapped feature, and at least one surface for any other product code under `apps/web/` or
`packages/*/src/` (tests excluded). A diff of only tooling, docs, tests or agent instructions prints "No app proof
needed"; put that output in the Proof section and go on.

For each surface you prove, read its entry (`node tools/ci/feature-maps.ts show <surface-id>`), sign in as the persona
it names, reach the surface on the head preview the way it says (the rail item or the path, then the state), and
capture it:

```bash
mkdir -p "$E/proof/<surface-id>"
ab set viewport 390 900; ab open <url>; ab wait --load networkidle
ab screenshot "$E/proof/<surface-id>/<state>-390.png"
ab set viewport 1440 900; ab open <url>; ab wait --load networkidle
ab screenshot "$E/proof/<surface-id>/<state>-1440.png"
```

Take viewport shots, not `--full`: the app keeps a stable scrollbar gutter, so a full-page shot at a 390 px viewport
comes out 375 px wide and the check refuses it. Scroll and shoot again for more of a long page. When a flow shows the
change better, one recording (`ab record start "$E/proof/<surface-id>/<flow>.webm"`) stands for both widths.

Then run the check with the surface ids you proved:

```bash
pnpm review-proof --base "$B" --evidence "$E" <surface-id>...
```

It fails naming each surface and width that is missing, each PNG that is not exactly 390 or 1440 px wide and each
unknown surface id. Never approve while it fails. A changed surface with no map entry is a blocking finding too:
`node tools/ci/feature-maps.ts --check` refuses a branch that changes a pending route or a feature with no map, and the
author maps it. When it passes it prints one row per proved surface with its feature, how users reach it and what
proves it, next to the files it found. Paste that table as the report's Proof section, with the file links pointed at
the published evidence. When the diff touches a state machine, the output also has a Machines table (step 5): paste it
too.

## 4. UI changes

A UI change touches anything a person sees: `apps/web/src`, styles, `design/` tokens or copy.
Write a temporary flow in `$E/flow.mjs` that exercises the changed behavior as a person would:

```js
export default async ({ page, side, engine, width, path }) => [
  { check: "submit shows field errors", pass: (await page.locator('[aria-invalid="true"]').count()) > 0 },
];
```

Return `[]` for paths the flow does not cover. Then capture before and after:

```bash
bin/dev browser run --timeout 900 -- \
  node $S/capture.mjs --before <main url> --after <branch url> --paths /,/access --flow "$E/flow.mjs" --out "$E"
```

It runs headless Chromium and WebKit at 390 and 1440 px. For each page it records the HTTP status,
page and console errors, a full-page screenshot per side, an axe WCAG 2.2 AA scan and the pixel
difference into `$E/ui-results.json`. The flow runs on both sides with a video. A shot fails on
a non-200 status, a page or console error, an axe violation that main does not have, or a failed
flow check on the branch.

Measure end-to-end time for every changed read and write on the production preview, from the user
action until its confirmed result. Simple actions must finish in under 1 second. Do not time a head
that already has blocking behavior findings. The quiet timing runner of D81 retired with evf v1,
so say what else shared the machine and the database, and do not call a miss proven or a pass
qualifying on one sample. Keep the measurements in `$E`. Record whether writes update the UI
optimistically and roll back clearly on failure. Count requests for main actions and inspect them for needless
refetches or refreshes. Keep request logs in `$E` and summarize them in the Experience section.
Reports and analytics may exceed the time budget only when the PR names that approved category
and explains the slower action.

Then check the changed behavior by hand with agent-browser on the branch preview: open the pages,
use the controls, read `ab errors` and `ab console`, and take screenshots of states the flow does
not reach. When a flow matters more than a still image (an overlay, focus order, a transition, a
multi-step form), record a short video of it on the branch preview:

```bash
ab record start "$E/videos/<flow>-after.webm"
# the steps of the flow
ab record stop
```

Keep each video under 30 seconds. Use synthetic data or data from the shared development
database only. `publish.mjs` adds every video in `$E` to the evidence page.

The script cannot judge quality. Open every after screenshot and compare it with the before
screenshot and the design (`design/everyfield-ui.html` or `design/everyfield-marketing.html`).
Check layout, spacing, type, color, focus states, copy and the phone width with the `better-*`
skills. A visual problem is a failure even when the script passes. A pixel difference on a PR
that claims no visual change is a failure.

## 5. Backend changes

A backend change touches server code, routes, actions, `packages/`, the schema or a command.
Write a temporary probe in `$E/probe.mjs`. It calls the real endpoints on the preview URL and runs
the real commands against the dev database. Check every business rule and every refusal the task
names: the allowed result, each denied actor or input, and what the database holds afterwards.
Write `$E/backend-results.json` in this shape and keep the output:

```json
{ "after": { "url": "<branch url>", "head": "<40-char sha>" }, "verdict": "pass",
  "checks": [{ "check": "reset refuses a production host", "pass": true, "detail": "exit 1" }] }
```

```bash
node "$E/probe.mjs" <args> 2>&1 | tee "$E/probe.log"
```

A change with both parts gets both. A tooling-only change gets its commands rerun as the probe.

A change that touches a state machine (its table in `packages/contracts/src/machines/`, its column's values in
`packages/db/src/schema/tables.ts`, or a file its writer census lists) also proves the machine: run the proof test its
chart names with `EVF_MACHINE_COVERAGE="$E/<id>.jsonl"`, then `node tools/ci/machines.ts coverage "$E/<id>.jsonl" | tee
"$E/<id>-coverage.txt"`. The coverage file is named `<id>-coverage.txt`. `pnpm review-proof` (step 3) then prints a
Machines table with each touched machine's id, column, table file and generated `docs/machines/<id>.md` chart, and fails
while the chart is stale or missing or the coverage file is missing or has a `missing:` line. A diff that adds or
changes a 4+ state value set (a `status`, `state`, `stage` or `phase` enum column) with no machine table fails
`node tools/ci/machines.ts --check`. Never approve while `pnpm review-proof` or `machines --check` fails.

## 6. Publish

```bash
node $S/publish.mjs "$E" --task <task>
```

It writes `index.html` (before and after side by side, videos, checks, then one section per folder
with every image inline and other files as links) and uploads the
folder to the `everyfield-evidence` Tigris bucket under a random 128-bit prefix. Objects are
public-read and the bucket refuses listing, so only the link opens them. It prints the index link.

`publish.mjs` reads its credentials only from the evidence env file:
`~/.config/everyfield/evidence.env`, or the path in `EVF_EVIDENCE_ENV`. The file is outside the
repository, mode 600, and holds `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`
and `AWS_REGION` for the `everyfield-evidence-upload` key. That key has the Editor role on
`everyfield-evidence` only and default permissions disabled, so it cannot list or write
`everyfield` or `everyfield-dev`. `publish.mjs` ignores `AWS_*` in the shell and never opens
`.env.prod`: it refuses any env file whose path or symlink resolves to it. At start it prints the key file path and what it checks. Before any upload or delete
it lists `everyfield` and `everyfield-dev` with the key and refuses unless both return 403.
Run it as `$S/publish.mjs` from a checkout of this repo. It refuses a copy or an uncommitted
edit, so commit a change to it first. To create the file on a new machine, sign in to the
Tigris CLI and run this. It writes the secret to the file and prints nothing:

```bash
umask 077; mkdir -p ~/.config/everyfield
tigris access-keys create everyfield-evidence-upload --bucket everyfield-evidence --role Editor \
  --default-permissions disable --env ~/.config/everyfield/evidence.env --for aws >/dev/null
```
Use the PR task ID as `<task>`, for example `T-41`, so its evidence can be deleted together.

Everything you publish is public to anyone with the link. Upload only synthetic data or data from
the shared development database. Never upload:

- credentials, tokens, API keys, cookies or connection strings;
- real personal data (names, emails or messages of real people);
- anything read from the production database or production services.

Before you publish, open every screenshot and video and read every log and JSON file in `$E`.
Remove or redact anything in the list above, then capture again if a screenshot shows it.
`publish.mjs` refuses a text file that contains a value from the evidence env file, the dev env
files (`.env.local`, `.env.development.local`, `apps/web/.env.local`) or a connection string with
a password. It cannot read images or video, so the visual check is yours.

To delete evidence, run from any checkout of this repo:

```bash
node $S/publish.mjs --delete <task>             # every upload for that task
node $S/publish.mjs --delete <task>/<prefix>    # one upload, the 32-hex part of its link
```

Keys have the layout `evf-evidence/<task>/<prefix>/<file>`, so the link shows both parts. The
`prefix` value in `$E/published.json` also works as it is:
`node $S/publish.mjs --delete "$(node -p "require('$E/published.json').prefix")"`.
The command prints how many objects it deleted. Then check that the old index link returns 404:
`curl -s -o /dev/null -w '%{http_code}\n' <index link>`.

## 7. Report

Write `$E/report.md` in this shape. Name what you did not check.

Start with the Ask coverage table, before any criterion or check table. Read the verbatim ask
in your brief and list every deliverable it names: routes, pages, sections,
screens, commands, files and similar named outputs. One row for each. A deliverable is `delivered`
(you saw it work), `deferred <T-n>` (a task evf filed for it) or `missing`. A `missing` row
is a blocking finding: ask for changes.

```markdown
## Verification of <task> at <sha7>

**Verdict:** approved | changes requested
**Evidence:** <index link>

## Ask coverage

| Deliverable in the verbatim ask | Status |
|---|---|
| <route, page, section, screen, command or file> | delivered / deferred <T-n> / missing |

## Proof

<The table `pnpm review-proof` printed: one row per changed surface with its feature, how users reach it, what proves
it and links to its 390 and 1440 px screenshots or recording. For a tooling-only review: "No app proof needed", with
the check's output. For a diff touching a machine or a 4+ state value set: the Machines table it printed, linking each
machine's table and `docs/machines/<id>.md` chart, and its `<id>-coverage.txt`.>

## Checks

| Check | How | Result |
|---|---|---|
| <behavior from the task> | <flow, probe or command> | pass / fails: <what you saw> |

**UI:** Chromium and WebKit, 390 and 1440 px, before main <sha7>, after <sha7>. <What you saw.>
New accessibility violations: none. Present on main too: <list or none>.
**Videos:** <link to each flow video on the evidence page, or none>.
**Backend:** <probe link>, <n>/<n> checks pass. <Rules and refusals covered.>
**Not checked:** <list or none>.

## Code quality

**Principles checked:** laziness-protocol, minimize-reader-load, subtract-before-you-add,
test-behavior-not-implementation, <other applicable principles>.
**Patterns checked:** `docs/architecture/patterns.md`.
**Simplifications:** <concrete changes needed, or why none are needed>.
**Quality verdict:** approved | changes_requested.

## Experience

| Changed read or write | End-to-end time | Optimistic update and rollback | Requests |
|---|---|---|---|
| <action> | <milliseconds on production preview> | <observed behavior or not applicable> | <count and purpose> |

**Experience verdict:** approved | changes_requested. <Needless refetch or refresh fails.>
**Budget:** met | exceeded | not_applicable. <For non-UI work explain why this does not apply.>
**Exception:** <reports or analytics, slower action and reason; otherwise none>.
```

Read the diff against those principles. Needless layers, copied patterns or dead code require
changes even when behavior passes. A timing exception covers only reports and analytics: name the
action and the reason in the report. It never waives failed smoothness or code quality.

Record the review once:

```bash
evf review submit --verdict approved --report-file "$E/report.md"   # or --verdict changes
```

Then close your step: `evf run done --status passed` when you approved, and `--status failed --cause change`
when you asked for changes. A new head needs a new verification.

## 8. Clean up

```bash
agent-browser --session <task>-verify close
portless preview down <id> --remove-worktree    # both previews and their verify worktrees
```

The `verify/<sha7>` branch stays after its worktree is gone. Delete it with `git branch -D verify/<sha7>`.
