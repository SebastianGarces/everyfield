---
name: verify-preview
description: "Apply when you verify a PR written by the other model family. Run the PR head on its own portless preview against the shared dev database, check UI in Chromium and WebKit and backend with a temporary script, drive interactive checks with agent-browser, publish the evidence, then post one PR comment with the exact-head EVF-Review line."
---

# Verify on a preview

You prove the change works on a running copy of the exact PR head. The author's summary is not
evidence. Scripts are in `scripts/` next to this file. They need Node 22+, `gh`, `portless` and the
local env files of the main checkout. Every command below runs from any checkout of this repo.

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
Your family must differ from the PR's `EVF-Author` line.

## 2. Start the previews

```bash
node $S/preview.mjs --pr <n>      # after: the PR head, in a detached worktree .worktrees/verify-<sha7>
node $S/preview.mjs --main        # before: current origin/main, the same way
```

Each prints `{id, url, head}`. Both are production builds of a clean commit with a two-hour lease.
`preview.mjs` copies `apps/web/.env.local` from the main checkout and refuses to start when its
`DATABASE_URL` is not the shared development database. The supervisor runs two previews at a
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
Use the PR task ID as `<task>`, for example `OPS-W3` or `WP-012`, so its evidence can be deleted
together.

Everything you publish is public to anyone with the link. Upload only synthetic data or data from
the shared development database. Never upload:

- credentials, tokens, API keys, cookies or connection strings;
- real personal data (names, emails or messages of real people);
- anything read from the production database or production services.

Before you publish, open every screenshot and video and read every log and JSON file in `$E`.
Remove or redact anything in the list above, then capture again if a screenshot shows it.
`publish.mjs` refuses a text file that contains a value from the local env files or a connection
string with a password. It cannot read images or video, so the visual check is yours.

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
## Verification of <task> at <sha7> (<family> verifier)

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
```

Post it once:

```bash
node $S/post-review.mjs --pr <n> --report "$E/report.md" --family <your family> \
  --verdict approved --head <40-char sha> --results "$E/ui-results.json" --results "$E/backend-results.json"
```

Pass only the results files you produced.

The script appends `EVF-Review: {"head":...,"verifierFamily":...,"verdict":...}` and posts one
comment. It refuses a head that is not the PR's current head, your own family, results captured on
another head, and an approval when any results file or the report shows a failure. Use
`--verdict changes_requested` when anything fails, then send the failures to the coordinator.
A new head needs a new verification and a new comment. `ship` describes the merge.

## 7. Clean up

```bash
agent-browser --session <task>-verify close
portless preview down <id>          # both previews
git worktree remove <project>       # both verify worktrees, paths printed by preview.mjs
bin/evf doctor                      # lists no browser of yours
```
