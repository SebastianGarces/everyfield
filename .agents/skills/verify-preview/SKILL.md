---
name: verify-preview
description: "Apply when you verify a PR as the independent Opus verifier. Run the PR head on its own portless preview against the shared dev database, check UI in Chromium and WebKit and backend with a temporary script, drive interactive checks with agent-browser, publish the evidence, then post one PR comment with the exact-head EVF-Review line."
---

# Verify on a preview

You prove the change works on a running copy of the exact PR head. The author's summary is not
evidence. Scripts are in `scripts/` next to this file. They need Node 22+, `gh`, `portless`, the
local env files of the main checkout and, for `publish.mjs`, the evidence env file (step 5). Every command below runs from any checkout of this repo.

```bash
S=.agents/skills/verify-preview/scripts            # in your own checkout of main
E=$(git rev-parse --path-format=absolute --git-common-dir)/evf-evidence/<task>-verify/<sha7>
mkdir -p "$E"
```

Keep scripts, logs, screenshots and videos in `$E`, never in the repository.

## Browsers and processes

The machine has little CPU and memory. Run one browser job at a time and close every browser you
start (D35). These rules apply to every role that opens a browser.

- Scripted checks run through `bin/evf browser run [--timeout <s>] -- <command>`. It runs the
  command in its own process group with a timeout (default 900 s). When the command ends, fails,
  times out or evf gets a signal, it closes the run's agent-browser session, stops every process
  the run started and deletes the run's temporary directory, where Playwright keeps its profiles.
  It first waits while the machine is above its load limit (see `tools/evf/README.md`).
- Interactive checks use agent-browser (D36), never the Playwright MCP. Give each job its own
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
- `bin/evf doctor` lists headless browsers and agent-browser daemons older than 15 minutes, with
  PID, age and memory. It never stops them. Before you end, it must list none of yours.

Install the pinned tools once per machine. Video needs `ffmpeg` on `PATH`.

```bash
npm install -g agent-browser@0.39.1     # add --prefix "$(dirname "$(dirname "$(command -v node)")")" if npm's prefix points elsewhere
agent-browser install                    # Chrome for Testing for agent-browser
brew install ffmpeg                      # macOS; video recording only
```

agent-browser drives Chrome only. Its Safari backend needs the iOS Simulator and Appium and
cannot take headless 390 and 1440 px desktop shots, so WebKit parity stays in `capture.mjs`.

## 1. Read

Read the task note, the PR body (`gh pr view <n>`) and the diff (`gh pr diff <n>`). Read the
requirements the task names. Write down the behavior you will check before you run anything.
You are a fresh Opus 5.5 high session that never shared context with the author (D82). Your session id must differ from the one in the PR's `EVF-Author` line; `post-review.mjs` and `bin/evf ship` refuse the author's session, a non-verifier role and a non-Opus model. Find your session id with `herdr agent get <your agent name>` (field `agent_session.value`).

## 2. Start the previews

```bash
node $S/preview.mjs --pr <n>      # after: the PR head, in a detached worktree .worktrees/verify-<sha7>
node $S/preview.mjs --main        # before: current origin/main, the same way
```

Each prints `{id, url, head}`. Both are production builds of a clean commit with a two-hour lease.
`preview.mjs` copies `apps/web/.env.local` from the main checkout and refuses to start when its
`DATABASE_URL` is not the shared development database. The supervisor runs four previews at a
time. Stop your own old previews first (`portless preview down <id>`). Stop another agent's
preview only when its PR is merged or closed, and say so in your report.

The development database is shared and may be wiped and reseeded at any time:
`corepack pnpm --filter @everyfield/db reset:dev`. Never point a check at production. Never print
credentials. Do not submit a valid access form unless the task needs it: it sends a real email.

## 3. UI changes

A UI change touches anything a person sees: `apps/web/src`, styles, `design/` tokens or copy.
Write a temporary flow in `$E/flow.mjs` that exercises the changed behavior as a person would:

```js
export default async ({ page, side, engine, width, path }) => [
  { check: "submit shows field errors", pass: (await page.locator('[aria-invalid="true"]').count()) > 0 },
];
```

Return `[]` for paths the flow does not cover. Then capture before and after:

```bash
bin/evf browser run --timeout 900 -- \
  node $S/capture.mjs --before <main url> --after <branch url> --paths /,/access --flow "$E/flow.mjs" --out "$E"
```

It runs headless Chromium and WebKit at 390 and 1440 px. For each page it records the HTTP status,
page and console errors, a full-page screenshot per side, an axe WCAG 2.2 AA scan and the pixel
difference into `$E/ui-results.json`. The flow runs on both sides with a video. A shot fails on
a non-200 status, a page or console error, an axe violation that main does not have, or a failed
flow check on the branch.

Measure end-to-end time for every changed read and write, from the user action until its
confirmed result, with `bin/evf timing` (D81). Simple actions must finish in under 1 second.
Do not time a head that already has blocking behavior findings (C119). Write one timing set per
action in `$E`, then run it on the exact head:

```js
// $E/timing-add-person.mjs: ctx = { url, databaseUrl, env, require, out, index, replacementFor }
export default {
  name: "add a person", budgetMs: 1000, samples: 40, write: true, // write: saves add the write probe
  async setup(ctx) {}, // seed synthetic data in ctx.databaseUrl; sign a session with ctx.env.IDENTITY_SECRET;
                       // open a browser with ctx.require("playwright")
  async sample(ctx) {  // untimed steps first, then the timed action until its confirmed result
    const startedAt = Date.now();
    return { startedAt, endedAt: Date.now() }; // add interference: "<what>" when the set wrote in parallel
  },
  async teardown(ctx) {}, // close the browser
};
```

```bash
bin/evf timing <task> --set "$E/timing-add-person.mjs" --head <40-char sha>
```

It builds a production preview of that head on its own quiet local database, never the shared
one, and runs an independent SELECT 1 probe (and a write probe for saves) every 100 ms. Each sample
is qualifying or labeled non-qualifying: load above the machine limit, a probe round trip above
150 ms in its window (database spike or write stall), or self-interference. Each non-qualifying
sample gets exactly one labeled replacement. The set passes only when every declared sample has a
qualifying result under budget; a qualifying miss is never rerun away. Copy its PASSED or FAILED
line and `report.json` into the evidence. Record whether writes update the UI optimistically and
roll back clearly on failure. Count requests for main actions and inspect them for needless
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

## 4. Backend changes

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

## 5. Publish

```bash
node $S/publish.mjs "$E" --task <task>
```

It writes `index.html` (before and after side by side, videos, checks, all files) and uploads the
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
Use the PR task ID as `<task>`, for example `OPS-W3` or `WP-012`, so its evidence can be deleted
together.

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

## 6. Report

Write `$E/report.md` in this shape. Name what you did not check.

```markdown
## Verification of <task> at <sha7> (Opus verifier, session <first 8 characters of your session id>)

**Verdict:** approved | changes requested
**Evidence:** <index link>

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
changes_requested even when behavior passes. Post it once:

```bash
node $S/post-review.mjs --pr <n> --report "$E/report.md" --session <your session UUID> --model claude-opus-5-5 \
  --verdict approved --head <40-char sha> --quality-verdict approved \
  --experience-verdict approved --budget met \
  --principles laziness-protocol,minimize-reader-load,subtract-before-you-add,test-behavior-not-implementation \
  --results "$E/ui-results.json" --results "$E/backend-results.json"
```

Pass only the results files you produced. Include every applicable principle in --principles.

Use `--budget not_applicable` only when there is no UI experience to measure, and explain why.
For an approved reports or analytics timing exception, pass `--budget exceeded
--experience-exception reports` (or `analytics`); the PR body must contain the matching standalone
line `EVF-Experience-Exception: reports` (or `analytics`) and explain the action and reason.
These categories are the approved timing exceptions in Everyfield patterns. They never waive
failed smoothness or code quality; use `--experience-verdict changes_requested` for those failures.

The script appends `EVF-Review: {"head":...,"verifier":{"session":...,"model":...,"role":"verifier"},"verdict":...,"quality":{"verdict":...,"principles":[...]},"experience":{"verdict":...,"budget":...}}` and posts one
comment. It refuses a head that is not the PR's current head, a verifier ship refuses (the author's session, a non-verifier seat, a non-Opus model), results captured on
another head, and an approval when any results file or the report shows a failure. Use
`--verdict changes_requested` when anything fails, then send the failures to the coordinator.
A new head needs a new verification and a new comment. One exception: do not re-review a head that
only merges main after your approval. Run `bin/evf ship <task>` once required CI is green on it.
Ship carries your approval when the merges are clean and touch no PR path, and refuses otherwise.
Then verify the new head as usual. `ship` describes the merge.

## 7. Clean up

```bash
agent-browser --session <task>-verify close
portless preview down <id>          # both previews
git worktree remove <project>       # both verify worktrees, paths printed by preview.mjs
bin/evf doctor                      # lists no browser of yours
```
