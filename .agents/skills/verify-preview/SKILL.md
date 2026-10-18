---
name: verify-preview
description: "Apply when you verify a PR written by the other model family. Run the PR head on its own portless preview against the shared dev database, check UI in Chromium and WebKit and backend with a temporary script, publish the evidence, then post one PR comment with the exact-head EVF-Review line."
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
node $S/capture.mjs --before <main url> --after <branch url> --paths /,/access --flow "$E/flow.mjs" --out "$E"
```

It runs headless Chromium and WebKit at 390 and 1440 px. For each page it records the HTTP status,
page and console errors, a full-page screenshot per side, an axe WCAG 2.2 AA scan and the pixel
difference into `$E/ui-results.json`. The flow runs on both sides with a video. A shot fails on
a non-200 status, a page or console error, an axe violation that main does not have, or a failed
flow check on the branch.

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
Read the probe log before you publish: it must not contain a credential.

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
portless preview down <id>          # both previews
git worktree remove <project>       # both verify worktrees, paths printed by preview.mjs
```
