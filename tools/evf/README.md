# Everyfield workflow tools

Intent plans, delegates and records decisions. evf supplies briefs, worktrees, local checks,
case checks, feedback routing, progress and merge guards. Run `bin/evf help` for commands.

## Phase 7

Build in one task worktree and preview it through portless. Use the shared development database,
which may be wiped and reseeded, never production. Vercel builds production from main only.
Include current main, commit and run `bin/evf verify <task>`. Logs and checks.json live under
the Git common directory. Local checks do not prove application acceptance or mint approval.

Author runs check `format` first, before the full check queue and the load wait, so a format error fails in seconds
and names `corepack pnpm format`. An author run stops after its first failed check: `checks.json` holds `stoppedAfter`
and `notRun`, and neither `evf pre-push` nor `evf pr open` accepts that record. A verifier run has no format refusal
and no stop: it runs every check after a failure. It also never takes the `evf test` skip described under tooling
regressions.

An independent verifier (another Claude Code session, verifier seat, Opus model; D82) exercises the real branch, records an exact-head review
on the PR and runs `evf ship`. Ship reads the PR's required GitHub check status, refuses missing
or nonpassing CI, verifies the recorded head and the review's independence and checks the PR body against
the PR standard template. It squash-merges only that head. Branch changes require fresh CI
and review, with one exception: a merge-only head. The verifier or coordinator runs ship; never
arm GitHub auto-merge.

When the latest valid review approves an earlier head A and the PR head H has no review, ship
carries A's approval to H only if every commit from A to H is a merge whose first parent is the
previous head and whose second parent is on main, each merge tree equals the clean
`git merge-tree` result, the PR's paths (A against its base on main) and main's paths since that
base do not overlap, and required CI passes on H. Ship posts the proof as an `EVF-Carry:` comment
before it merges and keeps it in the shipped record. Any other change refuses as before.
Design tasks, P2/P3 feedback and every `evf approve` route keep exact-head review, with one exception below (OPS-146).

Approve merges a clean main (OPS-146): Sebastian's words on a held PR cover a merge of main he did not see. When
`evf approve` finds a held PR behind main, it checks the approved head and the verifier's pass as usual and refuses
before any write on a path overlap (the carry rule above) or a `git merge-tree` conflict. Otherwise it posts his
`EVF-Owner` line and, in the ship queue, runs `gh pr update-branch`, posts `EVF-Owner-Merge: {"quote","approved_head","merged_head","at"}`
and the `evf/verify` status on the new head, waits for required CI there and merges that head. It reads main again
before each update, so a main that moved during the queue or CI wait gets the same stale-code, overlap and conflict checks.
It follows ship's red-main rule below, before any write and before each update: while main's latest finished CI run is
red, it merges main only into a PR whose body says `Fixes #<n>` for the open P0 issue. Only that line lets a
held PR merge a head other than the approved one, and the head must still pass `carryProof`. A merge of main by anyone
else has no line, so it still needs his approval of the new head. A CI wait that runs out names
`bin/evf approve <PR> --owner-approval "<his words>" --head <approved head>`; that rerun finishes on his recorded words.
A Wiki-content task PR cannot finish that way, because the verifier's pass reaches its head over claim-check commits:
it needs a new verifier pass at the merged head. The shipped record keeps the carry proof in `owner_approval`.

A stale home checkout catches up (OPS-146): when `evf ship` or `evf drive` would refuse on stale code and the home
checkout is behind main, evf runs `git merge --ff-only`, starts the same command from the home checkout's new code and
exits with its code. The old process does no more work. It refuses as before when the checkout is on another branch,
has a detached HEAD, has changes in `tools/evf` or `bin/evf`, has its own commits, or when git refuses the fast-forward.
It never stashes or overwrites a local change, including an ignored file at a path main adds. `evf approve` does not catch up; it refuses and names the command.

Owner approval of an ordinary-route PR (OPS-121): a PR that `evf ship` merges by itself can carry Sebastian's
recorded approval of one head. After his OK in chat, run `bin/evf approve <PR> --owner-approval "<his words>" --head <sha>`.
It refuses before any write without `--head` or when the head is not the current PR head. Otherwise it posts one PR
comment with the line `EVF-Owner: {"head":"<40 hex>","quote":"<his words>","at":"<ISO time>"}`, writes an `approvals`
row (gate `owner`) and, when the head has a verifier approval and green required CI, merges through `evf ship`. If
not, it keeps the record, merges nothing and names what is missing. From then on `mergePullRequest` merges only a
head that the latest `EVF-Owner` line covers: the approved head, or a head that `carryProof` reaches from it (the
carry rule above). Any other commit voids the approval: a code commit, a merge with conflict edits, a merge of a
branch that is not on main, a rebase, or a merge where main changed a path the PR changes. `evf ship`, `evf approve`
and the drive's ship stage then refuse with "Sebastian's owner approval is void". The refusal names the approved
head, the `carryProof` reason, each later commit on the PR's own line (oldest first, short SHA and subject) and
the command for a new approval of the current head. `evf approve` with a stale `--head` prints the same commit list.
The drive records `owner_approval_wait` with that text and starts no implement round. A shipped record keeps the
covering approval in `owner_approval` (quote, approved head, time and, after a pure merge, the carry proof). A PR
without an `EVF-Owner` line merges as before. The held classes and the PR #13 routes keep their exact-head rule.

A stale record never leaves a PR stuck (OPS-129). Every `evf approve` route posts the same comment with the
`EVF-Owner` line for the exact head, after its checks and before the merge, so his new approval becomes the latest
record. A route with a task also writes the `approvals` row. A PR with a record for another head that gains a held
path, or a held PR that gains a commit, is refused until he approves the new head: `evf ship` and the drive name
`bin/evf approve <PR> --owner-approval "<his words>" --head <sha>`. On any route, `evf approve` without `--head` on a
PR whose latest record names another head refuses before any write and names that command. On a held route, a stale
`--head` names it too.

Document-template class: a WP part, an OPS task without the design route or a P0/P1 fix joins it when
its exact-head diff touches a path in `mergePolicy.documentTemplates` in `evf.config.json`. The diff runs
from the merge base with main to the head (`git diff --name-only --no-renames`), so splitting commits or
renaming a file out of a template folder does not leave the class. `evf ship` runs the usual review and CI
checks, posts the `evf/verify` status and prints the `evf approve` command with `--head <sha>`; it never queues,
updates the branch or merges, and exits 0. `evf approve <PR> --owner-approval "<his words>" --head <sha>` merges it
after Sebastian approves in chat, only with an independent review of the exact head and the verified status on it.
Then it writes the shipped record with an `owner_approval` field, acknowledges progress and removes the worktree.
`--head` stays optional on a document-template PR with no `EVF-Owner` record for another head.
`evf drive` records the wait and stops; a later pass records the merge. The key is optional: when it is
absent, the built-in default in `tools/evf/policy.ts` applies. A malformed key stops `loadConfig`.

Owner-path class (OPS-111): the landing and marketing site, listed in `mergePolicy.ownerPaths` with the same shape
and matching rules as `documentTemplates`. `heldClasses` in `merge.ts` decides both classes for `evf ship`,
`evf approve` and the merge. An OPS branch may change `evf.config.json` only in its own registration, so the paths, his words and the scope
live in `DEFAULT_OWNER_PATHS` in `tools/evf/policy.ts`, which applies when the key is absent, as for templates.
The held message names up to five paths per class and the command
`bin/evf approve <PR> --owner-approval "<his words>" --head <sha>`; `evf approve` refuses an owner-path PR without
`--head`, without the verifier's `evf/verify` pass on that head, at another head or while the branch is behind.

Stale code (OPS-111): `evf ship` and `evf drive` call `requireCurrentCode` at their start. When the running
`tools/evf` or `bin/evf` tree differs from the base branch, has uncommitted changes or cannot be read, they refuse
before any GitHub write, seat or run row, naming both commits and the update command. A drive that is already
running keeps `shipOnCurrentCode`. Tests claim the code through `setLoadedCode`; evf processes that tests start
make the same claim through the `tests/current-code.ts` preload.

Wiki content on task branches (OPS-109): the same task PRs join a second held class when the exact-head diff
changes a path under `docs/reference/wiki/`. `evf ship` runs the verifier checks, then sets each `pending` draft's
`claim_check` to `passed` with the verifier's seat, model and session as `reviewer` and
`Approved <UTC>: "<words>"` as `notes` (one commit), runs the home checkout's `bin/wiki promote` for each passed draft
(`--reviewed-sha` is that commit, `--approved-by` the draft's `approver`) and `bin/wiki check-seed`, commits the
result, pushes, posts `evf/verify` on that head and prints `evf approve <PR> ... --head <sha>`. A failed step resets
the branch to its start and pushes nothing. Lint checks a draft's links against the published seed only, so evf
promotes in passes (OPS-122): each pass tries the remaining drafts in path order, and a draft that links to another
draft of the PR passes once that draft is published. A failed draft gets another try only when the pass promoted
another draft and the failed attempt left seed.json, manifest.json and the draft unchanged; a failed attempt that
changed one of them stops ship at once. A pass that promotes nothing stops with each remaining draft's own
`bin/wiki promote` output, lint `ERROR` lines included. Two drafts that link to each other never pass.
`evf wiki claim-check <task> --reviewer "<name>" --approval "<words>"`
records a named reviewer the same way. The review carries to the new head only over those claim checks, the deletion
of the PR's drafts and the seed and manifest changes promotion makes (`wikiCarryProof` in `tools/evf/wiki.ts`).
`evf approve` refuses a head with a pending or unpromoted draft and names the missing step. A claim check is never
an owner approval.

Merge choke point (OPS-83): every PR merge in `tools/evf` goes through `mergePullRequest` in `tools/evf/merge.ts`;
a test fails when another file calls `gh pr merge` or the merge API. Directly before the merge call, on the exact
sha passed to `--match-head-commit` (after any `update-branch`), it holds a document-template PR unless the caller
passes Sebastian's words for that head, which only `evf approve --owner-approval` does; it holds a Wiki-content
PR the same way. It reads the paths from
the base branch's `evf.config.json` (the built-in default when the key is absent), never the running checkout's
copy. Any doubt counts as the class: a failed fetch, merge-base or diff, an unreadable base config or an empty head.
Stale-code refusal: it also refuses to merge when the git trees of `tools/evf` and `bin/evf` in the checkout the
process loaded differ from the base branch, or that checkout has uncommitted changes there. The message names both
commits and the rerun command. A process loads evf once, so without this a rule that lands later never reaches a
long process (this is how PR #375 merged: the drive that merged it started before OPS-80 landed). The drive runs
its ship stage on current base code: when its loaded code is behind, it runs `evf ship` as a child from a detached
checkout of the base commit under `<git common dir>/evf-code/`, created once per commit. After this lands,
restart live drives; they still run their old code.

Ship never merges on red main. Before it merges, it reads main's latest finished `ci.yml` push run,
skipping cancelled and skipped runs. When that run failed, only a PR whose body says `Fixes #<n>`
for the open `P0: CI failed on main` issue may merge. The gate reads the run, not the issue state.
The fail-forward workflow closes that issue when a later main CI run passes on a commit that
contains the failed one. A late success for an older commit leaves it open.

## Work store

The harness keeps its state in one sqlite file, `work.sqlite` under the Git common directory next to
the ship queue and evidence (`evf db path` prints it). Every worktree shares it. Writers open it in WAL
mode with a five-second busy timeout, so `evf status` and the TUI read while a hook writes. The schema
is the numbered SQL in `tools/evf/db/migrations/`; `evf db migrate` (or any writer) applies every file the
store has not recorded, in number order, one transaction each. Numbers may have gaps: an open branch can
apply its migration 7 to the shared store before another branch's 8 merges, and that 7 still applies
later. The views `v_tasks`, `v_seats`, `v_recent` and `v_health` are the read contract: change them with
a new migration, never in place.

`evf goals sync` caches the refocus chain from the plan documents: the project line from
docs/START-HERE.md and one mission per S-row of the Vertical slices table in docs/plan/build-plan.md.
The documents stay the source. `evf db seed-progress` imports the merged milestones of the
docs/build-progress.json committed on main as merged tasks, once each, with a `legacy_milestone` event;
it never reads a checkout's working copy of the ledger. `evf status [--json] [<task>]` lists tasks,
active seats, recent events and the health counters.

`evf events [--since <time>] [--type <name>] [--task <task>] [--json]` reads the full event history from a
read-only store, in id order, with no row limit. `--since` is inclusive and takes any ISO 8601 offset; `--task`
matches the ref, its parts and the slug, as `evf status` does; filters combine. `--json` prints an array of
`{id, ts, type, task, run, payload}` with `payload` parsed. Without it, each event is one line.

### Check signals (OPS-132)

Each `evf verify` run that reaches its checks records these events. `evf status` leaves all four out of `recent`,
because one verify would push out the reopen, nudge and escalation rows.

| Event | Fields |
|---|---|
| `check_start`, `check_end` | `run`, `task`, `head`, `treeHash`, `role`, `mode`, `trigger`, `queuedMs`, `durationMs`, `result` |
| `check_suite_end` | `task`, `head`, `role`, `mode`, `suite`, `startedAt`, `durationMs`, `passed`, `loadStart`, `loadEnd` |
| `test_failed` | `task`, `head`, `attempt`, `suite`, `test`, `touchesTestPaths`, `file`, `touchesOwnPaths` |
| `check_invalidated` | `task`, `head`, `role`, `mode`, `reason`, `oldBase`, `newBase`, `wastedMs` |

`check_start` has `durationMs` and `result` null. `run` is `EVF_RUN` when the store holds that run, otherwise null.
`trigger` is `pr-stage`, `evf-check`, `seat` or `manual`. `queuedMs` is the time spent in the full check queue plus the load wait. `result` is
`passed`, `failed`, `invalidated` or, when verify throws, `error`. Each `checks` entry in `checks.json` holds the same
`startedAt` and `durationMs` as its `check_suite_end`.

`check_invalidated` has `reason` `tree_changed` or `inputs_changed` for a run that cannot count, with `wastedMs` the time
the run spent. It has `reason` `base_moved` with `wastedMs` 0 for a run that stayed valid while main moved. `oldBase` and
`newBase` are main at the start and at the end, and `checks.json` holds the same fields as `invalidated`.

`test_failed` has a limit: only a check that reports test names can record it. `bin/evf test` writes names to its own
`EVF_FAILED_TESTS` file, never to `EVF_TEST_REPORT`, because its `AC:OPS-*` markers would turn on case coverage for a
WP task (D19). `package-unit-tests` and `local-app` get the reporter through `EVF_NODE_TEST_FLAGS`, and it appends to the
same file, because Node truncates a reporter's destination at each start and one check runs many commands. Their `spec`
output stays in the check's log. `local-app` also gives the names of `scripts/test-workflow.mjs` through `EVF_TEST_REPORT`.
A check with an `EVF_TEST_REPORT` file gives the names of its `failed` tests. A step that is not a test, such as typecheck,
lint, build or `schema:check`, records no name, and a command that never ran after an earlier failure records none. Any
other failed check records no `test_failed`, and its `check_suite_end` has `passed` false. A checkout path that holds a
space or a shell character gives these two checks no reporter, so they record no name. One check records each test name
in each file once. `postgres://` and `npg_` values in a name are stored redacted.
`file` is the test's path in the checkout, and `touchesOwnPaths` says whether the branch changed the test's paths (see
"Broken-main brake"). Both are null when the reporter gave no file.

Before the first check of a rerun at one head, role and mode, evf copies the earlier evidence to
`<evidence dir>/attempt-<n>`, with the next free number:

```text
.git/evf/evidence/<task>/<sha>/author-full/
  checks.json, *.log          the newest run; hasVerifiedHead and evf pre-push read only this path
  attempt-1/checks.json, *.log  the first run; its evidenceDir and log paths point inside attempt-1
  attempt-2/...                 the second run
```

These folders are never pruned. The `ac` evidence folder has no attempts. Signals only observe: when the store is
missing, locked or read-only, does not know the task, or the copy fails, verify prints one warning line on stderr and
returns the same result.

## Owner queue

`evf owner-queue [--json]` lists what waits for Sebastian, urgent items first and then the oldest. An item that blocks
2 or more tasks is urgent. An item older than 48 h carries the question "Keep, abandon or reopen?". The command opens
the store read-only and sends nothing: Jonah sends the digest (`.agents/roles/coordinator.md`).

The blocked count is the item's own task, plus each follow-up row with this task as `parent_task_id` that is not
merged or abandoned, plus each direct dependent package in `docs/plan/dag.json` that is not merged. A package is
merged when the ledger marks it done or retired, or when its store rows hold a merged row and no open row.

Two events carry the queue. `owner_ask` holds exactly `task`, `pr`, `head`, `kind`, `digestId` and `askedAt`, and evf
builds the ask sentence from the kind. `owner_answer` holds exactly `task`, `pr`, `head` and
`answeredAt`. An open item is a task's latest `owner_ask` with no `owner_answer` after it, on a task that is not merged
or abandoned. A second ask on the same head adds no event and keeps `askedAt`. An ask on a new head adds an event, and
the age restarts.

| Route | Records |
|---|---|
| `evf ship` holds a PR for a document template or an owner path | `owner_ask`, kind `template` or `owner_path` |
| `evf ship` stops on the Wiki route, a design task or P2 or P3 feedback | `owner_ask`, kind `wiki`, `design` or `feedback` |
| A void owner approval | `owner_ask`, kind `void_approval` |
| An escalation, an awaiting pick | `owner_ask`, kind `escalation` or `prototype_pick` |
| `evf owner-queue ask <task> --kind parked` | `owner_ask`, for a PR no route recorded |
| `evf approve` on either route, a merge through `evf ship` | `owner_answer` |
| `evf task pick`, `compare-passed`, `reopen`, `abandon` | `owner_answer` |
| `evf owner-queue answer <task>`, such as a keep decision | `owner_answer`; it refuses with no open item |

Recording never changes a merge. A failed write prints a warning on stderr, and the command goes on with the same exit
code and the same GitHub calls. Migration 014 gives each task that already waits an `owner_ask`: `askedAt` is the time
of its latest wait event, `head` and `digestId` are null, and the queue prints an unknown head as `unknown`. An
`escalated` task gets kind `escalation` and an `awaiting_pick` task gets `prototype_pick`. An old `owner_approval_wait`
does not name a route, so its kind is `parked`.

The optional `ownerQueue` key in `evf.config.json` holds the time zone, the digest times and the owner hours. An invalid value makes `evf owner-queue` refuse with a
message that names the key.

```json
"ownerQueue": {
  "timeZone": "America/Chicago",
  "digestTimes": ["09:00", "13:00", "17:00"],
  "ownerHours": { "start": "08:00", "end": "18:00" }
}
```

`digestTimes` must be 3 ascending `HH:MM` values, and they default to 09:00, 13:00 and 17:00. `timeZone` defaults to
the system time zone. `digestId` is the next digest slot at or after `askedAt`, in local date and time, such as
`2026-11-04T13:00`.

Sebastian sets `ownerHours`, because evf does not track sleep and never guesses it. An OPS branch cannot add the key,
because it may change only its own `maintenanceTasks` entry. He adds the key himself to `evf.config.json` in the home
checkout, which is the file evf reads, near the top of the file and away from `maintenanceTasks`. `start` must come
before `end`, so a window that crosses midnight is refused. While it is unset, the queue says so and shows no split.
With it set, each item shows its age split into minutes inside and outside the hours (`insideMinutes` and
`outsideMinutes` in `--json`).

The key has a cost: no merge route carries it, so it stays an uncommitted edit in the home checkout. Each OPS task that
registers changes `evf.config.json` on main, and `git merge --ff-only` then refuses to update the home checkout. When
`tools/evf` or `bin/evf` also changed on main, the catch-up of `evf ship` and `evf drive` cannot run, so both refuse until the home checkout is current.
`evf doctor` also warns that the workspace root has uncommitted changes. To update the home checkout with the key in
place, from the home checkout:

```sh
git diff -- evf.config.json > /tmp/owner-queue-key.patch
git restore evf.config.json
git merge --ff-only origin/main
git apply /tmp/owner-queue-key.patch
```

The last step refuses and changes nothing when main changed the lines next to the key. Add the key again by hand then.
Between `git restore` and `git apply`, the queue shows no split. `machineLoad` has the same cost.

## Weekly metrics

`evf metrics --week [--json]` (OPS-142, `metrics.ts`) reports the last 7 days, ending now, from evf's own records. It
opens the store read-only and reads `.git/evf/load.jsonl`, so it writes nothing. `--json` returns `{from, to, metrics,
lines, alarms}`, and the text is rendered from that same object. It always exits 0.

**No data.** A metric with no signal prints `no data`, and its JSON `value` is null. It prints 0 only when a record
shows that the thing it counts could have happened: a week with merges can show 0 escalations. A signal that started
inside the week only counts its own time, so full runs per merge counts merges from the first `check_start`, and
coordinator share counts seats from the first coordinator run.

**Alarm lines.** Each breached threshold prints one line after the metrics. `ALARM <metric>: <text>` is an alarm
threshold, and `ALARM <metric> (target missed): <text>` is a target. An alarm replaces the target line of the same
number. In JSON, each entry of `alarms` has `level` set to `alarm` or `target`.

Percentiles use nearest rank. A straight run counts one tick as one minute, and a gap over 2 min ends it.

| Metric | Definition | Target and alarm |
|---|---|---|
| Seat time split | `turn_end` totals: `modelMs`, `checkMs`, `waitMs`, and `toolMs` as other. Time outside a turn is not in `turn_end`, so it is not here. | Checks under 35%. Alarm over 50%. |
| Full check runs per merge | `check_start` with mode `full`, killed runs included, divided by `merged`. | 4 or fewer. |
| Rounds per merge and non-code share | `round` events divided by `merged`. Non-code is the share of `round_start` with `nonMergeCommits` 0, out of those with a count. | Under 1.0 and under 20%. |
| Owner wait inside ownerHours | p90 of the time inside `ownerHours` from `askedAt` to `answeredAt`, for asks answered this week and asks still open. An ask on a new head restarts the age, as in the owner queue. A merged or abandoned task has no open ask. `no data` until `ownerHours` is set. | p90 under 4 h. Alarm at an open ask older than 24 h, whatever `ownerHours` says. |
| Queue idle time | Share of `queue_tick` minutes with `runnable` over 0, `slotsFree` over 0 and `load` under the load limit. | Under 5%. Alarm at 10 straight min. |
| Flake and invalidation rate | Flake: `check_end` failed with a later pass on the same task, `treeHash` and mode, out of passed and failed runs. Invalid: `invalidated` out of all `check_end`. | Flake under 1%, invalid under 2%. Alarm at invalid 5%, or one `test_failed` name on 3 tasks in 24 h. |
| Load-throttled minutes | Sum of `load_wait` from `startAt` to `endAt`, so two commands waiting together count twice. The worst day is the worst 24 h period counted back from now, by `endAt`. A week with `check_start` and no wait reads 0. | Worst day under 60. Alarm when `load1` in `load.jsonl` stays above 72 for 5 min. |
| Start to merge | First `stage_start` of the task row to its `merged`, for merges this week. | p90 under 10 h. |
| Full run p90 | `check_end` `durationMs`, mode `full`, result `passed`. A failed author run stops early, so it would shorten this. | Under 15 min. |
| Suite p90 week on week | `check_suite_end` p90 per suite against the 7 days before. A suite in only one week is left out. | Alarm at up 50%. |
| Dead-drive minutes | For each `drive_restart`, `drive_death_alert` or `drive_restart_refused`, the gap from the last `drive_heartbeat` before it to the earliest of the next heartbeat, the task leaving active (`merged`, `abandon`, `held_external`, `handoff`, `awaiting_pick` or `escalation`) and now. One gap counts once. A death no watcher saw is not here. | Alarm at 5 min. |
| Body handoff p50 | Start of each `body` run minus the latest end of an earlier run of the task. | Under 5 min. |
| Escalations per 10 merges | `escalation` events times 10, divided by `merged`. | Alarm over 1. |
| Refusals per path | `ship_refused` total, and a count per path in `overlapPaths`. A refusal with no paths counts only in the total. | Alarm at 3 for one path. |
| Registration per OPS task | Closed runs of role `registration`, summed per OPS ref. The target applies to the worst task. | Under 15 min. |
| Coordinator share of seat time | Closed run time of role `coordinator`, out of closed run time of every role but `evf`. | Under 10%. |
| Median run time by overlap | Median `durationMs` of passed full runs, grouped by how many other `check_end` runs overlap each one. | None. |
| Digest before and after | Inside-hours p90 of answered asks, 14 days before and after the first ask with a `digestId`. Before also counts each `owner_approval_wait` closed by a `merged` or `owner_answer`, since the owner queue did not exist then. A task's overlapping records count as one wait. | Keep digests at a cut of 20% or more. No alarm. |

## Usage and seat models

`evf usage` reports what each seat run used. Nothing is billed: Sebastian is on a subscription, so every cost
is an estimate at API list prices, from the one price table in `usage.ts` (per million tokens: input, output,
cache read, 5-minute cache write, 1-hour cache write). Check that table against the pricing page when a model
changes. Nothing goes over the network.

**Where the numbers come from.** When a seat run closes (`evf run done`, the session-end hook, a drive abort
or a failed launch), evf reads the run's Claude Code transcript, `<claude dir>/projects/*/<session id>.jsonl`
(`$CLAUDE_CONFIG_DIR` or `~/.claude`), plus the session's `subagents/*.jsonl`. It counts each `message.id`
once, skips `<synthetic>` entries and unparsable lines, and stores only token counts and model names in
`runs`: `tokens_in` (uncached input), `tokens_out`, `cache_read_tokens`, `cache_write_tokens` and
`cost_est`. No message text, prompt or tool output enters the store or the report. The session-end hook
refills a run that already closed, so the final turns count. A missing or unreadable transcript leaves the
columns null and never fails the close. Only the session id the run holds at close counts: a `/clear` or
resume that gives the seat a new id leaves the earlier session uncounted. A model missing from the price
table keeps its tokens and leaves `cost_est` null.

**Backfill.** `evf usage --backfill` fills the five columns of every run with a session id and a readable
transcript, writes nothing else, prints how many runs it filled and skipped (no session id, no transcript)
and gives the same rows when run again.

**Report.** `evf usage [--json] [<task>]` prints, per task, tokens and estimated cost by role and model,
rounds, verify fails and CI fails. Without a task it adds a by-model summary that splits *build* (plan,
implement, ui and simplify runs in round 0) from *review and rework* (evidence and verify runs in any round,
and implement, ui and simplify runs in round 1 or later). Prototype stages are their own group. `pr`, `ci` and
`ship` have no Claude session and no usage. A run with no data counts as "no data", never as zero.

**Config.** `evf.config.json` may set the model and effort of each role; a role without an entry keeps the
default in `seats.ts`. evf refuses a config before it launches anything when a model contains "fable", does
not start with `claude-`, an effort is not one of low, medium, high, xhigh or max, a role is unknown, or the
verifier model is not an Opus model (D82). `seatTrial` applies a model and effort to the named roles on every
second task: the odd task numbers (OPS-69, WP-021, FB-13), so all seats of one task use one arm in every round.
`launchPlan`, `evf launch --dry-run` and the `runs` row record the resolved model and effort.

```json
"seats": { "simplifier": { "effort": "low" } },
"seatTrial": { "roles": ["implementer", "ui"], "model": "claude-opus-5-5", "effort": "medium" }
```

**Per-task override.** The coordinator or a human shell can run one task on its own model and effort:

```
evf task seats OPS-82 --model claude-opus-5-5 --effort high   # set, or change either field
evf task seats OPS-82 --effort xhigh                          # change one field; the other stays
evf task seats OPS-82 --clear                                 # back to the global resolution
```

The override lives in `tasks.seat_model` and `tasks.seat_effort` of that task row (schema 4), not in config. It
wins over `seats` and `seatTrial` for every role, every round and all three idea seats of that row; a field you
leave out keeps its normal order (`seatTrial`, then `seats`, then the defaults). Config `seats` and `seatTrial`
stay global and every other task resolves as before. A model gets the config checks: it starts with `claude-`,
never names Fable, and the effort is one of the list above. A seat cannot set it: the command refuses when
`EVF_RUN` is set. It also refuses a ref with no open row and a merged, done or abandoned row. A later `evf task
new` that reopens a merged ref starts without an override. `evf task handoff` copies the override from the
prototype row to the implement row it creates. A non-Opus override model does not apply to the verifier: the
verifier keeps its Opus model and effort (D82), and the command prints one line that says so. Each call records a
`seat_override` event with the new and previous values. `evf status` shows the override per task, or "default".

To read a trial, run `evf usage` after a few tasks of each arm. In the by-model summary compare the
`claude-sonnet-5-5` and `claude-opus-5-5` lines: their build cost, their review and rework cost, and in the
per-task lines the rounds, verify fails and CI fails of odd against even task numbers. evf gives the numbers;
it states no verdict.

## Seats

A seat is one fresh top-level Claude Code session in its own Herdr pane and task worktree. `evf launch <task>
--role <role>` creates the worktree when it is missing (the task start rules apply), splits a new pane off the
Herdr workspace that runs the evf TUI (label `evf TUI`, found by that label and by the pane that runs the TUI
process; `EVF_TUI_LABEL` overrides the label for a test or a scratch workspace) and starts
`claude --plugin-dir <run dir> --agent evf:<role>` in it with the session id evf chose, the role's model and effort and
`--dangerously-skip-permissions` (the owner's `ccd` alias; a herdr pane loads no shell aliases, so evf passes the flag). The pane's shell carries `EVF_TASK`, `EVF_RUN`, `EVF_ROLE`, `EVF_STAGE`,
`EVF_WORKTREE` and `EVF_SESSION`. evf records the run and a `stage_start` event in the work store:
`runs.herdr_pane` is the seat's pane and `tasks.herdr_workspace_id` is the TUI workspace. `--dry-run` prints every
step. The role files are `.claude/agents/<role>.md`: planner, verifier and prototype-merger on Opus 5.5 medium,
implementer, ui, simplifier on Sonnet 5.5 medium (D85). The implementer seat does UI work too and proves its own work; the ui seat is opt-in with the spec line `Seat: ui`. Every seat has the advisor and the update prompt disabled.

The seat's agent definition comes from the evf checkout that runs the launch, never from the task worktree. Launch
reads `<evf root>/.claude/agents/<role>.md`, sets its `model` and `effort` lines to the resolved seat values and writes it into a
per-run plugin directory `<runtime>/seat-<run>/` (`.claude-plugin/plugin.json` plus `agents/<role>.md`; `<runtime>` is
`.git/evf/runtime/<task slug>`, outside every worktree). The seat starts with `claude --plugin-dir <that directory>
--agent evf:<role> ...`, so the typed line carries a path, not the definition. A plugin agent is namespaced, so a task
branch that deletes, renames or edits `.claude/agents/<role>.md` cannot shadow or change the seat its own drive
launches. `--agents <file>` would keep the line short too, but Claude Code reads a file there only with `--print`; a
seat runs interactive, so launch uses `--plugin-dir`. Plugin agents ignore `permissionMode`; seats already run with
`--dangerously-skip-permissions`. `evf launch --dry-run` prints the source file, the plugin directory and the byte
count of the typed line; no copy of a role file belongs in `~/.claude/agents/`.

Herdr types `claude <args>` into the pane's shell, and the terminal refuses a line of 1024 bytes or more
(`agent_start_input_failed`). Launch measures the exact line (`claude`, then each argument with the shell quoting Herdr
uses) before it creates a run row or a pane. At 1024 bytes or more it throws `LaunchLineTooLong` naming the role, the
byte count and the limit; retrying cannot help, so the drive escalates the task at once with that message and does not
spend the three-failure cap. The line does not depend on the size of a role file; every role stays under 768 bytes in
a normal checkout (a test grows the role files to 20 KB and compares).

The agent files set `permissionMode: bypassPermissions`. The repository's `permissions.deny` rules and its hooks
stay in force under the flag; `ask` rules may not prompt. `dontAsk` is never used.

Seats tile as a grid so Sebastian sees them all on one screen. `panes.ts` reads the pane rectangles in cells
(one cell is 10 x 20 px) and always splits the largest pane along its longer side: `right` when it is at least as
wide as tall in pixels, otherwise `down`. A split that would leave the TUI pane under 120 x 30 cells is skipped.
When no workspace has the TUI label, launch falls back to a new workspace named after the task (the root pane is
the seat.

A launch that fails does not kill the drive. When `herdr agent start` fails or times out, launch reads the pane
(`herdr pane read --lines 80`) and puts its last meaningful lines in the error, for example `Error: agent "evidence"
not found`, not only "timed out waiting for agent startup". It then closes the dead pane (or workspace), opens a new
pane with a new Claude session id and tries once more under the same run. A second failure closes the run as
`aborted` with the pane excerpt in its summary and throws; `evf drive` logs that line and goes on to its next
transition, where the three-failures cap applies as usual. Between two launch aborts the drive waits 30 s after the
first and 60 s after the second (`DriveTiming.abortBackoffMs`, doubling) and logs each wait; the abort that reaches the
cap escalates without a wait. A launch with a prompt sends it only after the run's
`session_start` event exists (the Claude session-start hook ran; 60 s bound, else the launch fails as above). It
then confirms that a turn began: the agent left `idle`, or a later event of the run shows activity. If none
begins within 15 s, launch sends the prompt once more and records `prompt_resent`; it never resends twice.

When a run reaches a terminal status (`evf run done`, a drive failure path or the session-end hook), evf closes
that run's pane after the store update, then rebalances the TUI workspace with `herdr pane resize`: every column
and row gets the same share. evf never closes the TUI pane, a pane the run does not own or a pane another open run
records. A fallback seat closes its workspace only when the workspace has no other pane.

The hooks in `.claude/settings.json` route to `bin/evf hook <event>`. They do nothing unless `EVF_RUN` is
set, so an ordinary session in the repository is untouched. In a seat, session start writes the session id
on the run and injects `evf refocus` (the goal chain, the ask, the spec and the proof rule, also after a
compaction). Claude Code cuts hook context at 8,000 characters and 200 lines, so refocus fits itself under
that: the Done criteria and Non-goals always appear, and any cut is named in a SHORTENED line at the top
that points to `evf task spec <task> --show`, which prints the stored ask and spec in full. The path guard denies an
Edit or Write outside `EVF_WORKTREE` (symlinks and `~` resolved), stop and session end are recorded and a
seat that exits without closing its stage is marked aborted. A session end with reason `clear` or `resume`
keeps the run open, because the seat continues in the same pane. If Herdr fails before the agent is up,
the run is aborted at once, so the store never lists a seat that does not exist. The path guard is a rail,
not a sandbox: it covers the edit tools only, and a seat with shell access can still write elsewhere.
`evf session` prints the pane's Claude Code session id from Herdr, for the EVF-Author and EVF-Review lines.

### Headless sessions (OPS-134)

`evf headless <task> --role coordinator|registration --prompt-file <file> [--model <id>] [--effort <level>]` starts
one `claude -p` session that a coordinator needs, and gives it a `runs` row. The row ends `passed` on exit 0 and
`failed` on any other exit, whatever the session-end hook wrote first. No permission flag is passed, so a tool that
needs a prompt is denied. These roles are not Herdr seats: `evf launch` refuses them and the drive ignores them
(`runsOf`). `evf usage` shows them in their own by-model group.

## Turn time and the long run check (OPS-134)

`turn-time.ts` divides time into model, tool, check and wait, from the session transcript. Overlapping tool calls count
once, with check over wait over tool. Check is `evf verify`, `check`, `test`, `ac run`, `timing` and `browser run`,
also after `cd x &&` or an environment prefix. Wait is `sleep`, `herdr agent wait`, `gh pr checks --watch`,
`gh run watch` and the Monitor tool. Any other tool call, an Agent call included, is tool time. The rest is model time.

`evf hook stop` records one `turn_end` event per turn: `run`, `session`, `startedAt`, `endedAt`, `toolMs`, `checkMs`,
`waitMs` and `modelMs`, never text. A turn starts at the last user prompt, or at the previous `endedAt` after a
stop-hook continuation, and ends at the last transcript entry. A missing or unreadable transcript records no
`turn_end` and changes nothing else in the hook.

The drive runs the long run check (`long-run.ts`) while it watches a seat. Its split covers the time since
`runs.started_at`; time outside any turn is wait, and a call with no result runs to the present.

- **Nudge, once per run.** A seat that Herdr reports as working gets one `herdr agent prompt`, sent without `--wait` so
  that Claude Code queues it, when the run is open 60 min or more, the worktree HEAD's committer time is over 60 min old
  and over 70% of the elapsed time is check or wait. It records `long_run_nudge` with `delivered`. A failed send does
  not retry. It is apart from the close nudge of the idle rule.
- **Notice, once per run.** A run open 120 min or more records `long_run_notice`, sends a Herdr notification and shows
  as an `evf status` recent line, each with the elapsed minutes and the split. It has no other condition. With no
  readable transcript there is no nudge, and the notice says the split is not available.

The check only informs. It closes no run or pane, changes no task status and never escalates. While the drive blocks
in the close nudge's `--wait`, the check does not run.

## Drive loop

`evf drive <task>` runs implement mode as a stage machine kept in the work store: plan → implement →
simplify → pr → verify → ci → ship → merged, with a body stage between verify and ci after a `body_only` review
(see Body-only fix path below). Seat stages launch a fresh session through
`evf launch` with a stage prompt, wait on it through Herdr and expect it to close with
`evf run done <run> --status passed|failed --summary-file <file>`; the Stop hook blocks a seat that
tries to end its turn with the stage open, and a seat that goes idle twice without closing is aborted.
evf runs pr, ci and ship itself and records them as runs of role `evf`. The ci stage (OPS-121) uses the
required-check rule of `evf ship`: the names come from the base branch's protection and rulesets
(`requiredCheckNames`) and are matched on the exact PR head (`requiredCi`). Only a pass counts; skipped and cancelled
count as failed. It is green only when each required check passed, and the summary lists them. A failed required
check ends it at once; a missing or pending one waits, but a PR that GitHub reports as conflicting fails at once and
names the missing checks and the conflict. When the wait runs out it fails and names each missing and pending check.
A check that no rule requires, such as Vercel, never makes it green. The pr stage runs the author checks
(`evf verify <task>`) at the current head, then opens or updates the PR from the body the implementer wrote to
the task's runtime dir. A simplifier commit therefore never costs a round: when the checks fail at a head that
followed a passed simplify, the next stage is simplify with the failure in its prompt, and no implement run starts.
The implementer proves its own work before it closes: tests, 390 and 1440 px screenshots of each UI state it
changed and one `evf proof add` per `owner` or unchecked Done criterion it built or changed. For a spec with
`AC:` criteria, a passed implement close runs `evf ac run` at the head and refuses while any `AC:` row is not met
(see "Answer key" below); otherwise evf adds no proof gate on that close, and the verifier covers a missing proof. The PR body is gated (OPS-113): an implement run closes passed only when the body
file in the runtime dir exists and passes the `evf pr body` check, and the refusal names the failed check, so a body
fault shows up before verify. UI work runs in the implementer seat unless the spec has the line `Seat: ui`.
The verifier reads the full diff, except in a merge-only review (OPS-145), reads the proof table and re-runs a flow only where a proof is unmet,
missing or looks wrong; it captures a missing screenshot itself. A failed verify, ci or ship costs a round, except a
failed verify at a head where an earlier verify of the task already closed (a second review of an unchanged head
records `review_repeat` and costs no round; it still counts toward the three-failure cap). The fourth
round sets the task to escalated, records `loop_cap_hit` and `escalation`, shows a Herdr notification
and launches nothing more. Any other failure costs no round, but three failures in a row without a
passed stage escalate the same way, so no loop runs unattended forever. `evf task reopen <task> --reason
"<two words or more>"` answers an escalation: it sets an escalated task to `pr_open` (it has a PR) or
`active` and records a `reopen` event holding the highest run id. Later failure counts start after that
run, so the task gets three more failures before it escalates again. It resets only the trailing-failure
count, never the round (a task at the loop cap escalates again on its next failed verify, ci or ship), and
it edits no run, event, approval or proof. It replaces the hand-written sqlite UPDATE. It refuses a task
that is not escalated and refuses inside a seat (`EVF_RUN` set). The reason goes into the prompt of the first
seat that launches afterwards, for every stage and verbatim, and into `evf refocus`; neither presents the failure
summary from before the reopen as the current instruction, and the `evf next` reason reads `reopened by the
coordinator: <reason>` until a seat has run since. The prompts carry the reason until a seat passes after the
reopen. The loop cap and the three-failure cap never escalate while another seat of the same task still works
(its run is `started` and its Herdr agent exists). evf records `escalation_deferred` with the reason it would have
used, the TUI shows the task as active, the drive keeps waiting on that run, and the escalation happens when the
last open run closes, with that reason. The drive waits on a seat in slices of one seat-poll interval and reads the run
status from the store before each slice, so a run that already passed, failed or aborted ends the wait at once.
A seat whose Herdr agent no longer exists, while its run is still started, gets its run closed as aborted, and the
next transition launches that stage again with the same round. A blocked seat is notified once per
blocked episode and polled every few seconds until it leaves `blocked`; an `idle` report before the launch prompt
began its turn is not a finished turn. `evf launch` waits until the new pane is a shell at its prompt (Herdr
`pane process-info`: `foreground_process_group_id` equals `shell_pid` and `foreground_processes` lists only the shell,
on two polls 100 ms apart; 30 s) and retries `agent_pane_busy` and `agent_start_input_failed` three times with
doubling backoff (1, 2, 4 s) in the same pane. Before each retry it reads the agent list, so a seat never starts
twice, and waits for the quiet shell again. The group check alone passes while zsh still loads its profile, because
the shell is already the foreground group then and its subshells (`brew shellenv`, `uname`) belong to that group;
Herdr has no prompt flag, and `pane read` shows the prompt only after the fact. After the retries launch fails with
the error code, the attempt count and the seconds waited, and the usual one-new-pane retry applies. Each launch gets its own Herdr agent, `<role>-<slug>-<run>`,
so a later round never waits on an earlier seat. `evf next <task>` prints the next stage without acting
and writes nothing; `--once` performs one transition; `--detach` runs the loop in the background with a
log under the Git common directory; either way the drive needs no `EVF_FOREGROUND=1` (see Foreground checks). One drive per task: a second `evf drive` refuses while the first
process is alive (pid file under `evf/drive/`). The start grace for a seat whose first turn has not begun (30 s)
counts from the moment the drive starts to watch that run, not from the launch prompt, so a seat watched late, after
other launches, still gets all of it. If a drive dies inside its own pr, ci or ship stage, the
next drive aborts that run without a round and performs the stage again; a PR GitHub already merged is
recorded, not shipped twice. Jonah polls `evf status --json`.

**Circuit breaker (OPS-115).** The loop cap counts only verify, ci and ship failures, and a passed run resets the
three-failure count, so neither stops a seat that closes `passed` again and again with nothing changed. When a seat
closes a plan, implement, simplify or verify run itself with `evf run done`, evf records a progress fingerprint on the
run: the worktree HEAD (`progress_head`) and a sha256 of the stored spec (`progress_spec`; migration 009). Run B is
the newest fingerprinted run after the latest reopen marker; run A is the fingerprinted run of B's stage before it.
When A and B closed with the same status at the same HEAD and spec hash, `evf run done` escalates the task at B's close.
The cause names the stage, both run ids, the short head and the first summary line of each run; the `escalation`
event, the Herdr notification, `evf status` and `evf next` show it, so the drive launches no third seat. A new commit
or a changed spec is progress; uncommitted edits, the PR body and proofs are not. Only runs a seat closed itself
count: aborted runs, evf's own pr, ci and ship runs, and runs the drive closed for the seat (no Herdr agent, idle
twice, wait timeout, launch failure) carry no fingerprint, and neither do runs closed before migration 009. Two
closes with different statuses never trip it; the loop cap and the three-failure cap still apply. Like those caps,
the breaker records `escalation_deferred` while another seat of the task works and escalates when the last one
closes. Restart after an outside fix with `evf task reopen <task> --reason "<words>"`: runs before its marker are
never run A, so the next seat runs. Prototype mode keeps its own same-headline rule.

**Body-only fix path (OPS-113).** About 15 failed rounds and four loop-cap hits came from PR bodies, not code. A
verifier that approves the code and the experience, and whose every open finding is a PR body fix it can state as an
exact text, posts `post-review.mjs --verdict body_only --body-items <items.json>` and closes verify with
`evf run done <run> --status body-only`. Each item is `{"present": "<text>", "why": "<reason>"}` or
`{"absent": "<text>", "why": "<reason>"}`; the poster refuses an empty list, an item without exactly one non-empty
`present` or `absent` text and a non-empty `why`, and a quality or experience verdict that is not approved. The
EVF-Review line holds `"verdict":"body_only"` and a `"body"` array with the items. The close applies the passed
proof gate, refuses any stage but verify, records a verify approval with decision `body_only` at the head and
costs no round. `evf next` then names the `body` stage in the implementer seat, same round. Its prompt lists each
item and the body file path, and tells the seat to edit only that file, make no commit and close with
`evf run done`. When the seat closes passed, evf runs the body check itself: it pushes the body with
`evf pr open --body-file` at the same head, reads the GitHub body with the `evf pr body` code (`checkGithubBody`)
and checks each item of the review at that head (`unmetBodyItem`). It passes only when the head equals the
reviewed head, the standard passes and every item is met; then the next stage is ci and no verify runs. A failed
check closes the body run failed with the reason, and the body stage runs again with it in the prompt, with no
round; three failures in a row escalate under the retry cap. A commit after the review voids the path: the next
stage is pr and then a full verify. Ship (`checkPr`) takes the latest `body_only` review at the exact PR head as
the code approval only when its quality and experience verdicts are approved and the GitHub body meets every
item; it names the first unmet item otherwise. A later review at the same head replaces it. Independence (D82), the
recorded sessions, required CI and the "PR changed during merge checks" refusal still apply, and `evf approve`
reads it through the same `checkPr`, with the owner words and the exact head as before. Decisions taken under
Sebastian's delegation, which he can revert:

- D-a (report section D.1, approved): the Opus verifier does not read the final body. A deterministic check reads it.
- D-b: the verdict value is `body_only`, with an underscore like `changes_requested`.
- D-c: each body item is an exact substring rule, met when the body contains (`present`) or does not contain
  (`absent`) the text. Line endings do not count. No semantic or model-based check.
- D-d: the body stage runs in the existing implementer seat with a body-only prompt; no new seat role or agent file.
  The item list limits its scope, and a head change sends the task to a full verify.
- D-e: a `body_only` approval carries over merge-only commits under the EVF-Carry rule, the same as `approved`, and
  ship checks the items on the merged head's body. A code commit after the review gets "does not carry".

**Simplify skip.** After a passed implement, evf reads the last passed simplify run after the reopen marker. When
`git diff --quiet <its progress_head> HEAD` finds no change in the worktree, no simplifier launches: evf records a
`simplify_skipped` event that names that run and its head, and pr runs next. The PR body and the proofs live outside
the repository, so a round that changed only those skips simplify. Round 0 and every round with a new commit still
run it. When the author checks fail in the pr stage after a skip, the task goes back to implement, not to simplify.
In round 1 or later, a passed implement whose commits since that run are only clean merges of main also skips, and the
event carries `reason: "merge_only"`. One new non-merge commit, or a merge with a conflict resolution (non-empty
`git show --cc`), runs simplify. A merge-only branch in round 0 runs it.

**Round routing.** Before a failed ci or ship starts a round, the drive reads the checks on the PR head and classifies
the failure:

- `this_pr`: a required check fails on the PR head, does not fail on main, and the head has no earlier ci or ship
  failure after the reopen marker. A conflict with main, no failing check anywhere, required checks all green and an
  unreadable GitHub are also `this_pr`. With several failing checks, one `this_pr` check makes the whole failure
  `this_pr`. The task starts a round as before. A verifier's changes request is always `this_pr`.
- `main`: each failing required check that is not the PR's fails in its latest finished result on main. Main is read
  over its last 10 commits, as check runs and commit statuses.
- `external`: a required check fails again at the head of the previous failure, or required checks are missing or
  pending and a non-required check fails. Required checks green with a non-required check red still pass ci.

`main` and `external` hold the task. Its status is `held_external`, one `held_external` event records
`{cause, checks, head, summary}`, the run closes `aborted`, no seat launches, `tasks.round` and the retry count do not
change, and one Herdr notification names the cause, the checks and the way out. A poll or restart during the hold writes
nothing. `evf next` prints stage `held` with the cause. The drive looks again every `holdPollMs` and resumes with one
`hold_released` event when the cause clears, then runs ci:

- `main`: the checks no longer fail on main. The drive runs `gh pr update-branch` and fast-forwards the worktree. A
  failed update leaves the conflict for ci to report as `this_pr`.
- `external`: the PR head moved, or the named checks no longer fail.

`evf task reopen` also ends a hold. Failures before it no longer count, so a check that still fails at that head with
main green starts a round; a check that still fails on main holds again. `evf ship` reads the same checks as before and
refuses a held task while a required check fails.

**Broken-main brake (OPS-141, `brake.ts`).** One test that fails on 2 or more branches that do not touch its paths,
within 60 min, starts a brake. A test's paths are its app, package or tool folder (`packages/db/`), or else the folder of
its file. A test under `tools/evf/tests/` has only its own file as its path, because the evf suite runs mostly on branches
that change `tools/evf/`. A branch counts while its latest finished verify still fails the test. `test_failed` needs a
test file, so a failure with no file and a failure in a check that reports no names, such as GitHub ci, never counts.

- The drive that reaches the threshold records one `brake_tripped` event with `{test, file, branches, summary}` and sends
  one Herdr notification with the test name. No other event summary and no other notification names the test.
- Each branch holds at `held_external` with cause `test` and the field `brake`: in its failed pr stage, or at its next pass
  between stages. A seat that works already closes first. The failed pr run closes `aborted`, so it costs no retry and no
  round.
- The coordinator files one OPS fix. After it merges, `bin/evf brake fixed <brake> --commit <sha>` records `brake_fixed`
  and refuses a commit that is not on main. The brake never ends by itself: a commit that touches the test's paths may
  fix nothing.
- A brake writes only events and the status. It never marks a check passed. A released task merges main and runs its pr
  stage again, so its checks run at the new head. A test that still fails on one branch goes to the implementer, and on two
  branches it starts a new brake.
- `evf task reopen` of a task this brake holds overrules the brake for that task until the brake ends: the task's next failure of that test goes to
  a seat, while the other branches stay held. A later brake can hold it again. A reopen from `escalated` or from another hold exempts nothing.

**Staged release.** A task released from a brake, or a drive that starts new work, takes a slot first and records
`release_start`. 2 tasks may hold a slot in any 5 min. A new slot also needs load under 24 and fewer than 3 checks
waiting in the full check queue. A drive looks again each `holdPollMs`. A held task stays `held_external` until its slot.
A task that holds a slot keeps it, so a restart costs none. A drive's first look, with no other start in the last 5 min,
reads no load or queue, because one drive is no burst. Each later look reads them, so a drive that waits stays held at high
load after the 5 min run out. `evf drive --once` and a drive with an open seat take no slot.

**`round_start`.** Each new round records `{cause, nonMergeCommits, diffLines, round, stage, head, summary}`. The counts
cover what the previous round added: non-merge commits and added plus deleted lines from the head of the previous
`round_start` (the merge base with `origin/main` for the first) to HEAD, without main's commits. They are null when the
worktree is gone. A hold, a repeat review of a reviewed head and a loop cap stop record none.

**Stopping a drive.** The drive loop runs in a worker thread, so the main thread can answer SIGTERM and SIGINT while a
stage blocks in a child process or a seat wait. Stop a drive with `evf drive <task> --stop`. It records
`drive_stop_requested` with `{pid, summary}`, sends SIGTERM to the live drive and tells the dead drive watcher not to
restart it. It exits 0 with a message when no drive runs, and it still records the request, so a drive that died just
before the stop also stays down. A pid file whose pid now runs another command gets no signal, and that pid blocks no new
`evf drive` or `evf task abandon`. When `ps` cannot read the command of a live pid, `--stop` sends no signal, records
nothing and exits non-zero, and a new `evf drive` or `evf task abandon` refuses. SIGKILL cannot be caught and leaves the
run `started`; `evf status` and `evf doctor` report it (below).

Each SIGTERM or SIGINT records exactly one `drive_stopped` event, in a pr, ci or ship stage, in a seat wait and between
stages. The drive removes its pid file and ends by the signal, which a shell reads as exit 128 plus the signal number
(143 for SIGTERM). An open `evf` run closes `aborted` with `drive stopped by <SIGNAL> during <stage>`. A seat's run stays
open, because the seat goes on working. The event's `run_id` column names the closed `evf` run, else it is null.

| Field            | Value                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `pid`, `ppid`    | The drive's process id and its parent's process id                                            |
| `parentCommand`  | The parent's command line, read at the signal with a 2 s limit, at most 200 characters, or null |
| `run`            | The open `evf` run, else the open seat run, else null                                         |
| `stage`          | That run's stage, else null                                                                   |
| `lastMergeAt`    | The time of the newest `merged` event of any task, else null                                  |
| `mergeWithin60s` | True when the stop came 60 s or less after `lastMergeAt`                                      |
| `signal`         | `SIGTERM` or `SIGINT`                                                                         |
| `summary`        | What `evf status` recent shows                                                                |

`ppid` and `parentCommand` describe the parent of the drive. They do not name the sender of the signal: Node does not
report a sender, and no record claims one. When `mergeWithin60s` is true, the summary says so and tells the coordinator
to consider an OPS task. Nothing files that task automatically.

**Drive records.** Three more events tell what a drive did. The drive's main thread writes the first two, so no
heartbeat can come after the drive's own end.

- `drive_heartbeat` `{pid}`: one at the start, when the drive holds its pid file and has pinned its row, and then one
  per minute, on that row with a null run. Heartbeats go on while the loop blocks in a stage, a seat wait or a hold. A
  failed write costs one heartbeat, never the drive. A drive that refuses to start records none. Heartbeats stay out of
  `v_recent`, so of `evf status` recent and the TUI feed. `evf events --type drive_heartbeat` reads them.
- `drive_ended` `{stage, code, summary}`: each normal exit, which is an owner wait, `pick`, `blocked`, `escalated`,
  `abandoned`, `done` and `--once`. An uncaught failure in the loop records none, so the watcher counts that as a death.
- `drive_stop_requested` (above).

`last_event` and `last_event_at` in `v_tasks` skip all three, so the TUI still shows `awaiting owner` after them.

**Orphaned `evf` runs.** A `started` run of role `evf` whose task has no live drive (the pid file under `evf/drive/`
is missing or names a dead pid) is orphaned. `evf status` (text, and `--json` under `orphanRuns`) and `evf doctor`
print one line for each: the ref, the run id, the stage, the age and one repair that never ships. A ship stage is
repaired with `evf approve <PR>` once Sebastian approved, or `evf task reopen`; any other stage with
`evf drive <task> --once`, whose restart recovery only aborts the run. A task already merged is repaired through the
same merge check. Migration 005 closes the runs of tasks already merged. `markMerged` (ship, the drive's merge
check and `evf approve`) closes every open `evf` run of the merged row `passed` with `<ref> merged as <sha10>`, and
closes a seat run `aborted`. `evf approve` finds the row from the PR head branch and records the merge after the
squash-merge; a branch with no row (a Wiki article) writes nothing.

**A drive ends by itself (OPS-123).** No watchdog script is needed to stop a drive; the drive stops itself. At start the drive
pins one row: the ref's current row (a released follow-up slice included, with its own ask and seats), or a new row
only when the ref has none. It reads that row by id on every pass and never creates or switches to another row
while it runs. Each pass starts with an end check. An abandoned pinned row stops the drive with exit 2 and the line
`drive <ref>: abandoned (store row <id> of <ref> was abandoned: <reason>; …)`. A pinned row that has a PR number
and is not yet merged gets one `gh pr view` call: a PR GitHub merged (by hand, or by `evf approve` while the drive
waited) is recorded with its merge commit. A merged pinned row, recorded by this drive's ship stage, by `evf ship` or
`evf approve` in another process or by that GitHub check, ends the drive with exit 0 and the line
`drive <ref>: done (merged as <sha>)`; no further stage runs. An unreadable GitHub does not end the drive; the pass
goes on. The merge releases the next queued slice, but the running drive never starts it: a fresh `evf drive <ref>`
pins and drives that slice. A failed ship does not end the drive either. It costs a round like a failed ci: evf
records a `round` event with cause `ship` and the ship summary, and the next pass launches implement for that round
with the summary in its prompt. A failed ship that takes the round past the loop cap escalates with that summary
(`loop_cap_hit`, exit 2). An owner route ship still stops the drive at the wait (exit 0); after `evf approve`, a fresh
drive ends at the merge. A standalone `evf ship` writes the same record: the ref's current row becomes `merged`
with its merge commit and one `merged` event, or one merged row when the store had none, so `evf next` prints
`done` (reason `merged`). Rewriting a row already merged with that commit changes nothing.

`evf task new` records the verbatim ask, `evf task spec` the spec with its hash (`tools/evf/spec.ts` reads its
sections; the Done list starts at a Done header such as `Done when:` or `## Done criteria`), `evf proof add` one
proof row per Done criterion bound to the worktree head, `evf check` the author checks as an event when
the store knows the task, and `evf ask planner` forks the planner's session in plan mode for a question.
A verify run closes passed only when the latest proof row of every numbered Done criterion is `met` or `n/a`
and that row's head is the worktree head or one of its ancestors. Proof carries forward across a later commit; a
row at a head outside the branch history does not count, and `evf proof show` marks carried rows. For a driven task (one with an evf run), ship also refuses an EVF-Author
or EVF-Review session that evf never launched; a task row alone, from `evf check` or a launch by hand,
changes nothing for an ordinary PR.

A ref has one current row: its latest row that is not `abandoned`, in any status. Every command that starts
work (`evf drive` at its start, `evf task spec`, `evf launch`, `evf proof add`) uses that row and never inserts a row
for a merged ref; `evf drive` prints stage `done`, and `evf task spec` and `evf launch` fail. Only `evf task new
<ref> --ask-file <file>` reopens a merged ref: it inserts one `new` row and its `task_new` event names the
merged row it reopens (`reopens`).

### Overlap check before verify (OPS-140)

The drive runs this check before each verifier launch. It logs one `verify_overlap` event per choice; `choice` names it.

| Case | Choice | What the drive does |
|---|---|---|
| Main changed a path the PR changes | `merge_main` | Runs `gh pr update-branch`, then continues the check at the new head. |
| That merge conflicts | `merge_conflict` | Starts no verifier. A failed pr run sends the task to the implementer, at no round. |
| That merge fails on GitHub for another reason | `merge_failed` | The verifier starts. The PR head did not move. |
| GitHub merged, but the worktree cannot reach the new head | `sync_failed` | Tries 3 times, then starts no verifier. A failed pr run sends the task to the implementer, at no round. |
| A ready PR changes a path the PR changes | `wait`, then `start_after_limit` if it never lands | Looks again each minute for up to 30 min (`OVERLAP_WAIT_MS`), then the verifier starts. A drive restart keeps the same limit. |
| No overlap | `start` | The verifier starts at once. |
| Git or GitHub is unreadable | `check_failed` | The verifier starts. |

A ready PR is an open, non-draft PR whose latest review approves its head, directly or through a carry. A PR with no
review never holds a verifier, so two PRs at the verify stage cannot wait on each other. A PR that lands during the wait
moves main, so the next look merges main when the paths overlap.

The check uses the same path comparison as the Fresh gate of `evf ship` and does not change that rule.

Each refusal of `evf ship` records one `ship_refused` event: `{kind, overlapPaths, main, head}`. `kind` is `fresh_gate`
for a Fresh gate refusal or an approval that does not carry because main overlaps, and `refused` for any other refusal.
Read them with `evf events --type ship_refused`.

### What the verifier reviews (OPS-145)

After the overlap check, the drive classifies the head against the latest verify close and records one `verify_start`
event per launch attempt: `{head, priorApprovedHead, deltaKind, deltaLines, changedInputs, reviewInputs}`. `deltaLines`
counts lines added plus removed since the prior approved head, or since the branch's base with none.

| `deltaKind` | When | Review |
|---|---|---|
| `merge_only` | Every proof in the list below holds. | The prompt names the prior head and the merge result and limits the review to them. |
| `simplify` | The non-merge commits came from the simplify seat: no implement run since the approval added code. Nothing in `changedInputs`. | Full. |
| `code` | Anything else: a first review, a conflict resolution, a hand edit in a merge, a head with no change, any entry in `changedInputs`. | Full. |

`merge_only` fails closed. It needs all of these, and anything evf cannot read or prove gives `code`:

1. A prior approval: the latest verify close is `passed` with no `body_only` decision and no reopen after it.
2. Every commit since that head is a clean merge of main (`cleanMerges`), and there is at least one.
3. Each input below is the same now as when the approved verifier launched.
4. Main's change touches no file the branch changed (`overlap: <path>`). The ask's "any overlap" no longer applies: an overlap gets the full review.
5. Main's change touches no rule file (`rules: <path>`): `AGENTS.md`, `docs/START-HERE.md`, `docs/build-agent-workflow.md`, `docs/architecture/`, `.github/workflows/`, `.agents/`, `.claude/agents/`, `design/` or a `shared_read_paths` entry of the context manifest.
6. A passed full author record exists at the head (`checks`). It holds the local checks CI does not run, such as `ui-escaped`. The overlap check moves a head with no pr stage, so that head has none.
7. The latest review on GitHub approves the prior head, and its verifier is independent of the `EVF-Author` in the PR body (`review`).

The launch stores the input hashes in `verify_start.reviewInputs`, and evf ties that event to its run. A passed close carries
them to its `stage_end` event, with `proofs` read again because a verifier may add one. A change during the run therefore
counts as a change. No linked launch record, or a head that moved during the run, leaves no record, and the next classifier names every input.
An input that reads null always counts as changed.

| Input | `changedInputs` name | What the hash covers |
|---|---|---|
| Ask, Coordinator notes and title | `ask` | The text, plus each `task_new`, `spec_set`, `reopen` and `handoff` event. Storing the same text again counts. |
| Spec | `spec` | The text. |
| Goal chain | `goal` | The project's title and body, and the task's mission as the seat reads it. |
| Follow-ups, which Ask coverage can defer to | `followUps` | Each link's label, status and title, and the task's own parent and slice. |
| Proofs | `proofs` | Rows a seat or person wrote. `AC:` rows that evf wrote do not count, because evf reruns them at each close. |
| PR body | `prBody` | The file evf pushes from, without its `EVF-Author` line: each implementer writes its own, and the `review` proof reads the current one. A direct edit on GitHub does not count; the prompt asks the verifier to read the current body. |
| Task contract at the head | `contract` | `evf.config.json` without other tasks' entries, then for a WP or FB its package, its context, and the full text of each requirement, case, operation, shared contract, feature, table and prerequisite package the context names. A name with no text, or a list evf cannot read, reads null. |

## Answer key (OPS-112)

Each numbered Done criterion may carry one line under it that says how it is checked:

```
3. The `/oversight` page lists every open escalation.
   Check: AC:WP-090/ui-3
4. The empty state reads as calm, not alarming.
   Check: owner — a tone call a person makes.
```

`Check: AC:<task ref>-<n>` names a test marker; `n` is that criterion's number. `Check: owner — <reason>` is a taste
call Sebastian or the verifier judges; the reason is not empty. `tools/evf/spec.ts` (`doneChecks`) parses the lines.
`evf task spec` refuses a spec for a UI task (part `ui`, or a whole package that owns a UI path by `isUiPath`) when a
criterion has no valid `Check:` line, more than one, or an `AC:` marker that names another task or number; the
message lists each bad criterion. A tooling spec may leave `Check:` out, but once it has one the same rule holds for
every criterion. Prototype plan specs and specs stored before OPS-112 keep the earlier rule.

`evf ac run <task>` is the answer key. In the worktree it finds every test whose node:test name carries
`AC:<task>-<n>` (`--test-name-pattern`, with no digit after the number, so `-1` never matches `-10`) in
`tests/ui/**/*.test.mjs` and `tools/evf/tests/**/*.test.ts`. `tools/evf/tests` matches run once. `tests/ui` matches
run once with `UI_ENGINE=chromium` and once with `UI_ENGINE=webkit`, inside `evf browser run`, with `UI_BASE_URL` set
to the worktree's newest ready portless preview. It refuses when that preview serves another head than HEAD, and it
refuses a dirty worktree, because the rows bind to HEAD. `EVF_AC_VIDEO_DIR` points each browser run at
`<git common dir>/evf/evidence/<task>/<head>/ac/criterion-<n>/<engine>/`, outside the repository. Each browser run also loads
`tools/evf/ac-video.mjs` with `node --test --import`: it patches the worktree's Playwright so every context a launched
browser opens records video there, `withPage` and suites with their own contexts alike. `tests/ui/setup.mjs` stays
unchanged, because an OPS task cannot own app test code.

After the run evf writes one proof row per `AC:` criterion at HEAD, `written_by = 'evf'` (store migration 011): `met`
only when at least one test carries the marker and every such test passed on every engine it ran on (a skipped or
todo test does not pass). Otherwise the row is `unmet`; a marker no test carries gets the note
`no test carries AC:<task>-<n>`. Notes name the tests, engines, results and head; the evidence is the video paths, or
the test files when no video exists. `evf proof show` prints `by evf ac run` or `by a seat` for each row.
`evf proof add --status met` and `--status n/a` are refused for an `AC:` criterion and point to `evf ac run`;
`--status unmet` stays open to seats. `owner` criteria and specs with no `Check:` line keep the earlier rule.

The gate: `evf run done --status passed` for an implement run, and `passed` or `body-only` for a verify run, of a task
whose spec has `AC:` criteria runs `evf ac run` at the worktree HEAD first and fails, listing each criterion with its
note, when any row is not met there. An `AC:` row from an earlier head never counts for this check. `--status failed`
runs no test. The verify proof gate stays as it was: every criterion, `owner` rows included, still needs a met or
n/a row at the head or an ancestor of it, and the Opus verifier still reviews and approves.

The video link: publish the `ac` evidence folder with `.agents/skills/verify-preview/scripts/publish.mjs`; its
evidence page gives each video an anchor. In the PR body proof table each row that names an `AC:` marker links its
video (`https://…/index.html#criterion-3/chromium/<file>.webm`). `evf pr body`, the implement close and `evf pr open`
refuse an `AC:` row with no video link and name it. A row that only `tools/evf/tests` tests prove names
`tools/evf/tests` instead, and that waiver holds only while evf's latest row for the marker stores no video.

The close gate and old previews (OPS-147): when the worktree's ready preview serves an old head, `evf ac run` refuses,
and the gate in `evf run done` previews HEAD itself. Portless refuses a second preview of one project at another head,
so the gate adds a detached worktree `.worktrees/gate-<slug>-<sha>-<pid>`, copies a seed's `apps/web/.env.local` there,
starts `preview.mjs` on it, checks that the preview is ready at HEAD, runs the tests and stops only the previews of
that path. It never stops the old preview. With no ready preview at all, the gate still refuses.

All of this runs on this Mac only. No CI job runs `evf ac run` or `tests/ui`, nothing under `.github/` changes, and no
step calls a paid API or e2e.tester.army.

## Later slices (OPS-86)

`evf task spec` files each numbered or bulleted item under `## Later slices` (or a `Later slices:` label) as a
follow-up row with status `queued`, linked to the storing task through `parent_task_id` (schema 5). The row's `ask`
is the slice text, then the parent's verbatim ask under a `Parent task <ref>, verbatim ask:` line. An OPS parent
gets a newly reserved OPS id for each slice (`evf id next ops`); a failed reservation stores neither the spec nor a
row. A WP or FB parent keeps its ref for each slice. A queued row sharing the parent's ref never hides it: `findTask`
returns a queued row only when it is the ref's sole row. A follow-up label is its ref (`OPS-123`) or
`<ref> slice <n>` (`WP-097 slice 2`; the parent is slice 1). Storing the same spec again changes nothing; a changed
slice updates its queued row and a removed slice abandons it.

`evf task link <task> --follow-up <task2> [--id <row>]` (OPS-109) records an existing row as a follow-up of the
task's current row, with a `follow_up_linked` event; `--remove` undoes it. It reserves no id and keeps the row's
status, so the row's label joins `followUpsOf`, the `Partial:` line and the Ask coverage check. `--slice <n>` makes
the row cover later slice n (migration 8: `tasks.slice` and `tasks.linked`); a link without it covers no slice.
Storing the spec again files only uncovered slices and never edits or abandons a linked row. It refuses a self
link, a cycle, a row with another parent and an abandoned or merged row. `migrate` stops when two migration files
share a number or the store applied another migration under this code's number.

A queued row never starts: `evf drive` prints stage `blocked` (exit 2) and `evf task start` and `evf launch` refuse,
naming the row it waits for. Each slice waits for the slice before it, the first for its parent. `markMerged`
moves the waiting queued row to `new` with one `follow_up_released` event. When a stored spec lists a slice that
no follow-up row covers (a spec stored before OPS-86, or rows abandoned), the next stage is `blocked` instead of
`implement`, and a plan run cannot close passed; storing the spec again or `evf task link --slice` files the rows.

For a task with follow-ups, an ordinary PR body (`evf pr body`, `evf pr open`, the `evf ship` body check) needs a
first line under `## Summary` that starts with `Partial:` and names every label. `evf pr body --body-file` takes
the task from `--task <ref>` or the `task/<slug>` branch. `evf ship`, the drive's held-for-approval cause and
`evf status` (text, and `followUps` in `--json`) start with the same `Partial:` line. `post-review.mjs` refuses a
report without a `## Ask coverage` table before its other tables, and an approval with a `missing` row or a
`deferred` label that is not one of the task's follow-ups (`tools/evf/ask-coverage.ts`).

## Prototype mode

`evf task new <task> --mode prototype --ask-file <brief>` starts prototype mode for a package. Its stages:
plan (an Opus planner writes the spec with three "Angle n:" lines), three idea seats at once (Sonnet, each
in its own worktree `<slug>-idea<n>` on branch `task/<slug>-idea<n>`, blind to the others: the read guard
denies Read, Grep and Glob outside the seat's worktree and the role file removes messaging and subagents),
compare (a Sonnet seat builds the comparison artifact in the task's runtime dir: a toggle page for UI, a
compare script plus one diagram per idea for backend), pick (the task waits as `awaiting_pick` until
`evf task pick <task> <n> --owner-approval "<Sebastian's words>"`), merge (an Opus seat writes the handoff
and runs `evf task handoff <task> --file <spec>`, which marks the prototype task done and creates the
implement task for the same package with that spec). Idea branches are left for `evf gc`; the harness
deletes nothing.

A rerun of an idea resumes. When an idea stage launches again after a failed or aborted run of the same idea, its
prompt quotes that run's summary and tells the seat to resume in the existing worktree and `IDEA.md` and to clear
the named blocker first. When the newest two failed runs of one idea have the same first line (hex ids, digits and
spacing normalized), or one idea fails three times in a row, the task stops retrying: no further seat starts, and it
escalates with that reason once the seats still working have closed. The idea prompts and the compare prompt carry
the ask's `Coordinator note` paragraphs, and `evf refocus` pins those paragraphs and the reopen reason so it never
cuts them. `evf run done --status passed` refuses an idea stage whose summary, or `IDEA.md` at the idea worktree
root, has a line that names a Done criterion (`criterion 9`, `Done 9`) and says `unmet` or `not met`; the message
quotes the line and says to finish the criterion or close failed.

When one idea is stuck and every other idea passed, the escalation message names `evf task compare-passed <task>
--owner-approval "<his words>"`. It needs Sebastian's words, refuses inside a seat (`EVF_RUN` set) and a task that
is not an escalated prototype with exactly one missing idea. It records a `compare_passed` event, sets the task
active and the drive runs compare with only the passed ideas; the compare prompt lists their worktrees and names the
missing idea and why. `evf task pick` refuses the missing idea.

## Preview slots

Portless allows `PORTLESS_PREVIEW_LIMIT` live previews (4, per D74). `evf stack up` and the verify-preview skill's
`preview.mjs` share one check, `.agents/skills/verify-preview/scripts/preview-slots.mjs`, before `portless preview up`.
`evf stack up` runs the check from the driving checkout before the configured stack command when that command is
`scripts/stack.mjs`; `corepack pnpm stack:up` by hand skips it.
A worktree that already has a live preview reuses it and never waits. When the pool is full, the check first
releases previews nobody needs: previews portless reports as expired or failed (`portless preview gc --apply`), previews
whose project path is gone, and previews of a task worktree whose store row is merged, done or abandoned with no
`started` run and no live drive. It never stops the main checkout's preview, a review preview or a task that
works. If the pool is still full it waits and polls (`EVF_PREVIEW_POLL_MS`, 15 s), prints `waiting for a preview slot
(n/4 in use)` once a minute and, inside a seat, records it as a `preview_wait` run event that the TUI shows and
the drive log repeats. After `EVF_PREVIEW_WAIT_MS` (20 min) it fails with the wait, the limit and the projects that
hold the slots.

`scripts/preview.json` sets `IDENTITY_ORIGIN` to `${PREVIEW_URL}`, so each `corepack pnpm stack:up` preview trusts its own
URL and sign-in works on any new preview id without env file edits. The verify-preview launcher does the same. A preview
started before this change keeps its old env until you run `stack:down` and `stack:up`.

## Stale task rows

`evf task abandon <task> [--id <store id>] --reason "<two words or more>"` sets a stale row to `abandoned` and records
an `abandon` event with the reason (it prints the event id). `--id` picks one store row when a ref has several; without
it the newest open row is used. It refuses a merged row, a row with a `started` run, a task whose drive is alive and
any call from a seat (`EVF_RUN` set). The TUI already hides abandoned rows.

## Live TUI

`evf tui` opens one read-only screen of the harness: every open task and running seat (task, stage, seat,
model, effort, Herdr state, round of three, proof rows met, gate, last event), the event feed in Eastern
Time and the health counters, with an explorer by stage and task on the left. It is the Rust crate in
`tools/evf-tui/` (ratatui, rusqlite bundled, notify), outside the pnpm workspace. `evf tui` runs
`cargo build --release` with the target directory under the Git common dir when the cached binary at
`<git-common-dir>/evf/bin/evf-tui` is missing or older than the crate sources, then starts it with `--db`
set to the work store path; `--dry-run` prints those paths and the build decision, `--once` prints one
plain-text report. The binary opens the store read-only in WAL mode with a 200 ms busy timeout, re-reads
when the file watcher or the 250 ms fallback poll sees `PRAGMA data_version` move, polls
`herdr api snapshot` every second and joins agents to runs by the Claude session id, and lists worktrees
every ten seconds for head SHAs. `t` runs `herdr agent focus <agent>` (the task's workspace as the
fallback), `Enter` opens the ask, spec and proof rows, `/` filters. It writes nothing: HEALTH names the
evf command for every human gate (`awaiting_pick`, `escalated`, a PR waiting for Sebastian) and every blocked seat.

TABLE shows one row per ref: the latest row by id that is not abandoned, with `+N` after the label for the N other
rows (the detail lists them with id, status, PR and merge time). The STATE column reads: the Herdr status of a seat
(`working`, `idle`, `blocked`); `no pane` in red only for a seat role (planner, implementer, ui, simplifier,
verifier, ideator, comparer, prototype-merger) whose session Herdr does not know; `evf <stage>` in the neutral
style for a run evf itself works (it has no pane by design); `awaiting owner` in the attention style, with the
gate `PR #<n>`, for a `pr_open` task with no open seat whose latest event is `owner_approval_wait` or a
`drive_stopped` at stage `ship` (it counts as needs you); and `merged`, dim, for 24 hours after the `merged` event
(never `updated_at`), never red and never needs you. The EXPLORER groups those rows by current stage: `queued`
(status new or specced), `plan`, `implement`, `simplify`, `pr`, `verify`, `ci`, `ship`, `awaiting owner`,
`needs pick`, `escalated`, `other`; a group shows only with tasks, and merged rows are not in it. `queued` is
collapsed: `z` opens it, and while it is collapsed `all tasks` hides queued rows and the header says
`queued N hidden`.

## Ship queue

Any session may run `evf ship` at any time; nobody orders ships by hand. Merging routes wait in one
machine-wide queue under the Git common directory (`evf/ship-queue/`). Each waiting ship holds a
ticket, and the oldest live ticket creates `lock.json` exclusively, so ships run one at a time in
arrival order. A waiting ship prints one line per minute and gives up after 60 minutes without
changing anything. A ticket or lock whose process has stopped (crash, kill) loses its place, and
the lock goes away when ship returns, refuses or exits.

Inside the queue, a PR that is behind main gets a plain merge of main through
`gh pr update-branch`, never a rebase or force push. Ship first refuses with "Fresh gate needed" when
main changed a path the PR changes, before it touches the branch. After the update it waits up to
30 minutes for required CI on the new head (one line per minute), then applies the carry rule above
and merges with `--match-head-commit`. Failed CI or a carry that does not hold also refuses with
"Fresh gate needed": the author fixes the branch and a verifier reviews the new head. Owner routes
(design tasks, P2/P3 feedback, `evf approve`) do not queue and never update the branch.
The ship skill defines the review record and owner approval exceptions.

Independence is by session (D82). Authors put
`EVF-Author: {"session":"<Claude Code session UUID>","model":"<model id>","role":"<seat role>"}` in the body.
The verifier's session must differ from the author's, its role is `verifier` and its model is Opus
(`claude-opus-*`). Ship stores the check time as `verification.checkedAt`. Shipped records written before
D82 carry model families and keep the rule that shipped them. Verifiers put one JSON line in their PR comment:

```text
EVF-Review: {"head":"<full SHA>","verifier":{"session":"<verifier session UUID>","model":"claude-opus-5-5","role":"verifier"},"verdict":"approved","quality":{"verdict":"approved","principles":["laziness-protocol","minimize-reader-load","subtract-before-you-add","test-behavior-not-implementation"]},"experience":{"verdict":"approved","budget":"met"}}
```

Every review includes a "Code quality" section with concrete simplifications, or why none are needed,
and a quality verdict. Ship requires an approved quality verdict and all four named principles above,
plus reviewers check any other applicable principles.

Use `changes_requested` for failure. The latest valid review record at that head wins.
These unsigned statements rely on the coordinator assigning the actual models correctly.
They do not authenticate a model provider. GitHub comments allow agents sharing the owner's
account to record independent review without GitHub's self-review restriction.

Every review requires `experience: {verdict, budget}` next to `quality`. Verdict is `approved`
or `changes_requested`; budget is `met`, `exceeded` or `not_applicable`. UI reviews record
production-preview times for changed reads and writes (simple actions under 1 second), optimistic
updates and main-action request counts without needless refetch or refresh. Non-UI reviews explain
`not_applicable`. Ship refuses missing experience, a rejected verdict or an exceeded budget.
Only the approved reports/analytics timing categories can waive an exceeded budget: the review
adds `exception: "reports"` or `"analytics"`, and the PR includes the matching standalone
`EVF-Experience-Exception: reports` or `EVF-Experience-Exception: analytics` line and explains why.
This never waives a rejected experience verdict. Quality reviews judge the diff against
`docs/architecture/patterns.md`.

The required section list for ordinary PRs is `.agents/skills/everyfield-pr/template.md`.
Wiki article and prototype PRs already use separate owner routes in
`.agents/skills/ship/SKILL.md`; they use the class templates in `tools/evf/templates/`.
All formats require EVF-Author and host attribution. Keep the Wiki template's screenshot
markers inside Verification so `bin/wiki pr-images --update-body` updates images in place.
`bin/evf pr body --body-file <file>` checks a local ordinary body; add `--class wiki` or
`--class prototype` to preview another format. `bin/evf pr body <PR>` reads the body and PR
metadata from GitHub. A `wiki/<slug>` branch qualifies only when every changed file is under
`docs/reference/wiki/`. A prototype requires a `task/fb-<number>` branch and the `prototype`
label. Other PRs keep the ordinary format. Missing metadata never selects a lighter format.
These formats grant no merge authority; Wiki articles and prototypes still need Sebastian's
approval through `evf approve`. Neither body check needs CI or a review, so the light
PR-open/edit/label CI job can use it. The template comes from the current checkout; missing
or empty templates fail. `evf pr open --body-file` resolves relative paths from the caller's
working directory before invoking GitHub in the task worktree.

A body names the current head with `{{EVF_HEAD}}` (OPS-147). `evf pr open` fills it with the head it pushes, and the
body file keeps the placeholder, so the next head fills it again and the verifier's body hash does not move. A lint,
`staleHeadFault`, refuses a verification section that names an old head of this branch as verified or as the head. An
old head is an ancestor of the head that is not on the base branch, so main's commits and another PR's head pass. It runs in
`evf pr open` before the push, in `evf pr body --body-file`, at the implement close and before a verifier launches.
Before a verifier launches evf also fills the GitHub body again, because the overlap check can merge main. A claim is
history, and passes, only when a history word (`round <n>`, `earlier`, `old`, `previous`, `prior`, `former`, `before`)
stands next to the head word in its sentence, or `round <n>` follows the SHA. A sentence that describes a commit also
passes: `reviewed`, `since`, `past`, `moved` or `moved from` directly before the head word, `not verified at <sha>`,
`verified that <sha> fixes it`, `Head <sha> is a plain merge`, `Head <sha> changes` or `merges`. `Test results from head
<sha>`, `Head <sha> is passing` and `Verified that all tests pass at <sha>` are claims. An honest statement that the current verification ran on
an old head, such as `Author, on head <sha> plus merged main`, is refused by design: use the placeholder. "Verified head <sha>, with before and
after screenshots" is a claim. CI's `pr-body` check does not run the lint: a push reaches GitHub before the body edit, so it would fail each new head for a moment.

## Stable verification, pushes and cleanup

`evf verify <task>` checks the author's task worktree. A verifier runs from its own checkout:

```sh
bin/evf verify OPS-9 --role verifier --head <full-40-character-SHA>
```

Verifier mode always uses the caller's Git checkout, including its committed check definitions.
`--head` refuses a different HEAD; without it, the command pins the caller's current HEAD.
A dirty checkout refuses before checks. A checkout behind main refuses with "Include current main".

During checks, a watch process polls the checkout every 10 seconds. A commit, a modified, staged or untracked
file (`tree_changed`), or a changed `.env*` file or dependency install (`inputs_changed`) must hold on two polls in a
row, so a temporary file a check removes stops nothing. The watch then stops the check and each process it started,
with SIGTERM and after 5 seconds SIGKILL. evf prints `INVALIDATED` and requires a fresh run on stable inputs. The watch
reads only the size and time of an env file, never its content. It also stops the check on a signal, and on its next
poll after evf is killed. `EVF_CHECK_POLL_MS` overrides the poll for tests.

A move of main during checks does not invalidate the run. The next run refuses until it includes main, and `evf ship`
applies the overlap check and required CI to the merge, so a run that used a slightly older main cannot merge unchecked.

Local checks see what CI sees. A clean checkout has no modified, staged or untracked files, even when
the user's git config hides untracked files. OPS tasks run their own checks plus the configured
`format` and `package-unit-tests` checks, which include the db schema check, because CI runs them
on every PR. Task start installs dependencies for OPS tasks too. A full application verify also
type-checks a fresh detached checkout of HEAD, so ignored local files such as Next's generated
`next-env.d.ts` cannot hide a CI failure (PR #175). Each run uses its own temporary worktree under
`.git/evf/fresh/` and removes only that one, so parallel author and verifier runs of one head cannot collide.

Before a manual push, run `bin/evf pre-push <task>`. It checks for a full passing author report at
that exact clean HEAD. Quick checks and verifier reports do not satisfy this gate. `evf pr open`
runs the same gate before its push. These local records do not replace required CI or independent review.

Authors push only through `evf pr open`, also for fixes after review (OPS-52). The project's
`.claude/settings.json`, which Claude Code and Grok Build both read, allows `bin/evf pr open` and
`cd` without a prompt, asks before a raw `git push` and denies force and mirror pushes. Rules match
each segment of a chained command, so `cd <home checkout> && bin/evf pr open <task> --body-file <file>`
runs at once. Both tools apply project rules only in a folder the user trusts, and trusting a parent
folder does not cover the folders inside it (Claude Code 2.1.302). Trust each workspace folder once,
or copy the `allow` entries into `~/.claude/settings.json`. Codex sessions do not read that file. Give them the same rule in a file under
`~/.codex/rules/` and check it with `codex execpolicy check --rules <file> bin/evf pr open OPS-1`:

```text
prefix_rule(pattern = ["bin/evf", "pr", "open"], decision = "allow")
prefix_rule(pattern = ["git", "push"], decision = "prompt")
```

A failed check that reports Next 16.4.1's `Another next build process is already running.`
message waits ten seconds and retries up to three times. Matching strips ANSI color codes.
The log retains every attempt. Other errors are not retried. evf's launcher selects an
installed Node 24+ from nvm if the shell has Node 22, or refuses with a clear requirement message.
Child commands inherit the selected Node directory first on PATH, including shell and pnpm scripts.

`evf gc` is read-only by default. Removal with `--apply` requires a clean, shipped worktree at
its recorded head, no newer task start, no open PR, and no live Portless preview. A reused task
records its new start outside the repository. Unavailable or malformed provider status keeps the
worktree. Cleanup never stops previews itself.

## Timing sets

`evf timing <task> --set <file> [--head <sha>]` measures a declared timing set (D81, OPS-52). It
takes the author's clean task head, or a verifier's `--head`, into a detached `timing-<sha7>`
worktree, starts a quiet Postgres in Docker, migrates it, gives the app its own logins and fresh
identity keys, and starts a production preview whose env is only that database. The set runs inside
`evf browser run`, beside an independent probe on its own connections: SELECT 1 every 100 ms, and for
`write: true` sets a one-row update and COMMIT in one protocol call. Labels (C108, C114, C118): load
above the machine limit at the start or end of a sample; a probe round trip above 150 ms in its
window (database spike, database write stall), or no probe answer within 2 s after it;
self-interference the set reports. Each non-qualifying sample, a replacement included, adds exactly
one labeled replacement. More non-qualifying samples than declared ones stop the run as not
measured. Only one set samples at a time on the machine; setup runs outside that lock. The report
goes to `.git/evf/evidence/<task>/<sha>/timing-<set>/report.json` and holds no connection string.
evf removes the preview, the database and the worktree at the end; a crashed run's database goes at
the next start. The verify-preview skill describes the set file.

## Task and ruling IDs

Workspaces share the GitHub remote, not one checkout, so the remote holds ID reservations.
`bin/evf id next ops` or `bin/evf id next decision` takes the number after every one in use (main's
maintenance tasks or `## D<n>` rulings, remote `task/ops-<n>` branches and reservations), pushes a
new parentless commit to `refs/evf/ids/<ID>` and prints the ID. A plain push to an existing ref
cannot fast-forward to a parentless commit, so the remote rejects it; the caller then tries the
next number. Two concurrent callers always get two different IDs. The reservation commit message
records the time, the git user name and the host.

`evf task start OPS-<n>` on a new branch keeps a reservation that `id next` made, reserves a free
ID itself, and refuses an ID whose `task/ops-<n>` branch already exists on the remote. An ID that
main already registers needs no reservation.

## Migration numbers

A branch takes the next migration number on main when it generates a migration. When main gains a
migration first, include main and run `bin/evf migrations renumber <task>`, during the merge or after
committing it. It moves the branch's new migrations after main's last number, restores main's
journal and snapshot bytes, and rebuilds each branch snapshot as main's latest schema plus the
branch's own changes, chained to main's last snapshot. SQL bytes do not change. It refuses when
main and the branch change the same table; generate those migrations again on current main.
`evf verify`, `evf pr open` and `evf ship` refuse new migration numbers that main already uses (D76).

## Foreground checks and CI test coverage

`verify`, `pre-push`, `stack up` and `test` wait for their child commands and print an expected
duration before starting. Verification prints each check's start and result. Duration ranges
are planning estimates, not measured promises. Keep the calling turn open until the final result.

A command outside the terminal's foreground process group, including a piped agent shell,
refuses before starting work. For a synchronous tool call, use `EVF_FOREGROUND=1 bin/evf verify
OPS-n` and keep waiting in the same turn. This is an explicit promise to wait, not a monitor.
For a genuinely monitored job, first register its watcher and then set `EVF_MONITOR` to that
watcher's name. CI sets it to the GitHub Actions job. Neither variable creates a watcher.
The same check applies when `task start` starts a stack.

evf passes the promise to the processes it waits on. Its check runner (`verify`, `check` and the
drive's pr stage) sets `EVF_MONITOR` to `evf verify <task>` for each check child, so a check that
runs `evf test` or `evf check` does not refuse. A seat that `evf drive` launches carries
`EVF_MONITOR=evf drive <task>`, because the drive watches that run. A seat from `evf launch` or
`evf seat` does not. A background drive (`nohup bin/evf drive <task> &` or `--detach`) needs no
`EVF_FOREGROUND=1`. A top-level call from a shell that no evf process supervises still refuses.

`bin/evf ci-tests` follows the pnpm scripts called by `.github/workflows/ci.yml`, including
recursive package scripts and package-name filters, and expands Node test globs. `evf test`
runs it before the tooling regressions. A new `.test.mts` file under `tests/integration` or
`packages/*/test` must be included by a CI command. The check reads root, package and app scripts;
it does not execute application tests or claim that an included test passes.

CI runs `test:db` as a matrix with one job and one Postgres service per package
(`pnpm --filter "${{ matrix.package }}" test:db`). Only `@everyfield/domain` builds the app, for
the statement census. ci-tests reads the job's `matrix:` values and refuses when the list misses
a package that defines the script or names an unknown package, so a new package with `test:db`
cannot drop out of CI. The required check stays the aggregate `ci` job.

`ci-test-exceptions.json` lists exact local-only files, with reasons and local commands.
D63a retains suites whose helpers require the shared development database, plus the platform
request proof that needs a preview and S3. Their CI helper changes belong to a WP-087 follow-up.
No wildcard exceptions are allowed. Deleted tests and tests newly included in CI make their
exceptions stale and fail the check. Local-only suites remain acceptance work for a verifier.

## Task and case checks

Briefs use the current catalog and context manifest. Missing context fails explicitly.
A brief for a task that owns server paths (an api part or a single-part package) prints the
Performance rule from `docs/architecture/patterns.md` and asks for statement-count tests before
the PR opens (test-standard), so budget findings no longer wait for the verifier.
Task starts retain kickoff gates and producer dependencies. OPS tasks use reviewed title,
owning paths and tooling checks in `maintenanceTasks`; they cannot authorize application code.
evf reads that entry from the commit under check, never from the home checkout's file: the task
branch for `task start`, `verify`, `pr open` and `ship`, and the PR head for the verifier and
`evf approve`. A new task registers on its own branch. `task start` creates the worktree and
names the missing entry; commit it there and run `task start` again for the brief. A start refuses
an invalid entry that main or the task branch already carries before it creates the worktree.
The branch may change `evf.config.json` only in its own entry, even when it owns the file; the verifier
reviews that entry.
The only design file they may own is `design/handoff/screens.md`, the generated package-owner map.
An entry with `"route": "design"` is a design task instead: it owns only `design/` paths and does not
change `design/everyfield-ui.html`, the approved prototype that the app tokens come from, with one
exception. The file may change only when the entry has `"route": "design"`, a valid
`"prototypeApproval": {"quote": "...", "approvedAt": "2026-10-31T17:07:00Z"}` (Sebastian's verbatim chat
words and the UTC time, `YYYY-MM-DDTHH:MM[:SS[.fff]]Z`) and an `owningPaths` item equal to
`"design/everyfield-ui.html"`; a folder item such as `"design/"` does not count. evf reads the entry from
the commit under check (task branch for `evf verify`, PR head for the verifier and `evf approve`), never
from the home checkout. Its
`evf ship` checks CI and the different-family review, posts the verified status and stops.
Sebastian approves it in chat, then `evf approve` checks that status and the changed files and merges.
An owning path naming an existing folder must end in `/`; paths without it name exact files.
`taskRisks` can mark sensitive work, which requires an owner decision. Paid services retain
concrete spending approval. Doctor reports readiness without executing checks or changing settings.

For WP tasks, `evf verify` writes `scope.json` beside checks.json and prints a summary. It lists
each changed path as owned (from the base DAG), accepted by one narrow ruling, or outside. The
rulings are: the package's new lock importer and nothing else in `pnpm-lock.yaml` (D14); the
package.json, tsconfig.json and eslint.config.mjs of a new package folder (D16); appended cases
for the package's own `case_requirements_at_start` (D16); and the context manifest, DAG and build
plan only when the generators reproduce them from base inputs plus those cases (D16). The report
is advisory (D18): `evf verify` and `evf pr open` print one line per accepted and outside path,
and the verifier checks every outside path against a recorded ruling. `task start`
fails when `stack up` fails. Stack and check commands named `node` run on evf's Node 24.
`evf principles --apply OPS-<n>` writes into that task's worktree, never the home checkout.
Milestones carry the four case and gate portion lists that the build explorer reads; evf leaves
them empty (D20). `node tools/evf/progress.ts --reconcile <root>` adds them to older milestones.

Use `AC:<case-id>` in passing test names or annotations. Each check gets its own EVF_TEST_REPORT path
(also `{testReport}`), `<position>-<name>.tests.json`, so names that slug alike never share a file. Case coverage runs only when some report has an `AC:` marker (D19):

```json
{ "tests": [{ "name": "AC:CASE-ID observed behavior", "status": "passed" }] }
```

A supplied report must cover selected cases. The verifier independently checks real behavior,
including applicable database, browser and failure paths. Broad temporary checks stay outside
the repo; permanent tests follow test-standard. Before building, check owned cases and action
ordering with docs/acceptance/check.py and docs/package-context.py --check-case-actions.

Run tooling regressions with `bin/evf test`. Disposable repositories and fake GitHub responses
exercise workflow behavior only. Tests contact no real GitHub or application database.
`bin/evf test` first runs the branch-diff lint (`branch-diff-lint.ts`), which refuses a test that reads the current
checkout's branch diff, and timing tests pass a fake `Clock` (`timing.clock`, `fakeClock` in `tests/fixtures.ts`) so
that machine load cannot fail them.

`bin/evf test` runs the tooling tests only when the checkout changes evf work (OPS-172, `test-scope.ts`). The changes
are the commits since the merge base with main, plus uncommitted and untracked files. Evf work is `tools/evf/`,
`bin/evf`, any `evf.config.json` setting other than `maintenanceTasks`, and the listed files that evf runs or that its
tests read, such as `.github/workflows/` and `.claude/agents/`. Otherwise the command prints why, starts nothing and
exits 0, so `workflow-regressions` in `evf verify` and the `evf` job in CI pass at once. Under `evf verify` the
command writes its reason to the `EVF_SKIP_REASON` file, and the check's `checks.json` entry holds it as `skipped`.
With `EVF_ROLE=verifier`, set by `evf verify --role verifier` and by a verifier seat, the command always runs the suite. The branch-diff lint and
`evf ci-tests` still run first, because they guard the other tasks too. A checkout with no commits of its own runs the
suite. The push to main runs all of it, because `ci.yml` passes `--all` on a push, and fail-forward reports a failure there. A checkout whose merge base git cannot find runs the suite.
`bin/evf test --all` always runs it.

## Mutation audit

`evf audit` (OPS-116) checks the answer key itself. A task's `AC:` tests can pass and still check
nothing, so the audit plants one bug in code a merged task wrote and sees whether a test fails.

```sh
bin/evf audit --list --task WP-033                 # the candidates of one merged task
bin/evf audit --task WP-033 --seed 42 --dry-run    # one run; prints the ask it would file
bin/evf audit                                      # pick the task and the candidate
```

Flags:

- `--list` prints the candidates: stable id, operator, file, line and a one-line diff.
- `--task <task>` audits one task. It refuses a task with no merged row whose merge commit is on main,
  and a task with no marked test, and names the reason.
- `--mutation <id>` plants that candidate. `--seed <n>` repeats a seeded pick; every run prints its seed
  and the command that repeats it.
- `--dry-run` runs everything, prints the ask a survivor would file, and reserves no id and files nothing.
- `--ignore-load "<reason>"` skips the machine load wait, which works as it does for `evf verify` (D80).

Candidates come only from lines on current main that the task's merge commit last changed
(`git blame`), in non-test source files under `apps/` and `packages/`. There are three operators.
`off-by-one` swaps `<` and `<=` or `>` and `>=`, or moves an integer literal of a comparison or a
`slice` bound by 1. `dropped-call` removes one whole call statement such as `setOpen(false);`.
`removed-route` deletes a `page.tsx` or `route.ts` under `apps/web/app/` or `apps/web/src/app/`.

The tests are every test on main whose node:test name carries `AC:<marker>` for one of the task's
markers, plus every test in `tests/ui/escaped/*.test.mjs`. The markers are the package case IDs of a WP
task and the `Check: AC:<task>-<n>` marker of each Done criterion of its stored spec (OPS-112's answer
key, read with `acCriteria`). evf finds the files whose text carries a marker and runs each with
`--test-name-pattern`, so a test whose name carries no marker never runs. A task whose files carry
markers only in comments has no marked test: the run stops after the baseline and plants nothing.
Files named `*.production.*` never run. Each file runs with `node --test` in the audit worktree (a
TypeScript file through the `tsx` a workspace package installed, and outside `tests/ui/` and `tests/contracts/`
with `--conditions=react-server`, as the package test scripts run them),
with `NODE_ENV=test` and the home checkout's `apps/web/.env.local` (the development database); a
`DATABASE_URL` in the shell does not reach it.
When a selected `tests/ui` file opens a browser (it reads `setup.mjs` or `UI_BASE_URL`) and one of
its tests will run (it is escaped, or a test name carries a marker), each tree gets a production
preview through the configured stack, and both engines run because `UI_ENGINE` is unset.

With no `--task`, the audit picks among tasks merged in the last 30 days that have a marked test and
a candidate. Never-audited tasks go first, then the oldest last audit. The candidate is a seeded
random pick.

Each run creates a detached worktree of current main under the system temp folder. It creates no
branch, pushes nothing and opens no PR. It runs the tests on main first, then plants the mutation,
commits it on the detached HEAD and runs them again. The outcomes:

- `killed`: a test failed on the mutant. Nothing is filed.
- `survived`: no test failed. evf reserves an OPS id, files a `new` task titled
  `Answer key for <task> missed <operator> in <file>:<line>` with the diff, the tests and a Done
  template, and prints the `maintenanceTasks` entry to commit on that task's branch. It does not edit
  `evf.config.json`. The same task, candidate and main SHA files once; a repeat prints the first id.
- `invalid`: the mutant did not build or start (a test file failed to load, or its preview did not
  start). It proves nothing and files nothing.
- `baseline-red`: a test failed on main before any mutation. evf names the tests, plants nothing,
  files nothing and exits 1.

The worktree and any preview go away on success, failure and SIGTERM. A crashed run leaves its
worktree; `evf doctor` reports it and the next `evf audit` removes it. The work store's `audit_runs`
table records each run: task, merge commit, main SHA, candidate, operator, file, seed, outcome, each
test's result, the filed task and the start and end times. `evf doctor` prints one warning when no
audit ended `killed` or `survived` in the last 31 days, with the command to run. That warning is the
monthly cadence; evf has no scheduler. The audit runs only on this Mac, starts no model seat and calls
no paid API. A `--with-verifier` step waits for Sebastian's answer to report decision D.2.

## Machine load limit

Agents share one Mac. `evf task start`, `evf verify`, `evf test`, `evf ac run`, `evf timing`, `evf audit` and
`evf browser run` wait while the 1-minute load average is above 2 × CPU cores (24 on Sebastian's 12-core Mac, rulings C51 and C81). A waiting
command prints one line per minute with the load and the limit, and gives up after 30 minutes
without starting work. An optional `"machineLoad": {"maxPerCore": 2, "maxWaitMinutes": 30}` in
`evf.config.json` overrides the default in `tools/evf/load.ts`; an OPS branch cannot add it,
because it may change only its own `maintenanceTasks` entry.
`--ignore-load "<reason>"` runs at once and appends the time, command, load, limit and reason to
`load-overrides.jsonl` under the Git common directory's `evf/` folder. `evf doctor` shows the
current load and limit. A command inside one that passed this gate does not wait again: `evf verify`, `evf test` and
`evf ac run` pass that on to what they start. `evf ac run` that `evf run done` starts is ungated at its own start, and
its browser runs keep their gate. In CI, `evf test` with `CI` set does not wait, so a required GitHub job never depends
on this gate.

A full check also has a process budget and a memory wait (OPS-151). `testBudget` in `tools/evf/budget.ts` gives each full
check cores / 3, the cap of the full check queue: on 12 cores, 4 test processes, 4 packages at once under `pnpm -r` and 4
Next workers. Each package runs 1 test process, because `pnpm -r` multiplies by it. `evf test` and the node tests of
`evf ac run` pass `--test-concurrency`; an explicit `--test-concurrency=<n>` on a direct `evf test` comes later and wins.
`evf verify` gives its check children `npm_config_workspace_concurrency`, `EVF_NODE_TEST_FLAGS` and `EVF_NEXT_WORKERS`.
For `package-unit-tests` and `local-app`, `EVF_NODE_TEST_FLAGS` also adds the `spec` reporter and the failed-test reporter
(see "`test_failed`" above).
Package scripts carry `${EVF_NODE_TEST_FLAGS:-}` or their own `--test-concurrency=1`, and `apps/web/next.config.ts` reads
the worker count. With these unset, each command behaves as it did before.

A full check that holds its slot also waits while free memory is under 15% or swap used is over 12 GB, the
`memoryFloorPct` and `swapCeilingGb` code defaults, read with the probes of the minute sampler. It prints the reading once
per minute. This wait shares the 30-minute limit of the load wait, and the give-up message names the reading.
`--ignore-load` skips it and logs one line. A probe that fails, or a platform with no probe, prints one line and does not
block. A `machineLoad` entry replaces the whole default, so one without these two keys has no memory or swap wait.

In GitHub CI (`GITHUB_ACTIONS=true`), `evf test` uses the whole runner: its test processes equal the core count, it takes
no queue slot and it reads no load, memory or swap.

## Full check queue

At most 3 full checks run at once on this machine, a code default with no `evf.config.json` key. The queue covers every
full-mode `verify` (`evf verify`, `evf check` and the pr stage) and a direct `evf test`. `evf verify --quick` and
`evf ac run` take no slot. An `evf test` inside a full `evf verify` uses the slot of its parent and repeats no wait: the
parent passes `EVF_CHECK_SLOT`, its ticket path, which counts only while the holder lives in this queue folder. An
`evf test` inside `evf verify --quick` takes its own slot. A refusal that needs no check (dirty checkout, wrong `--head`, main not included, a path outside the owning paths, a blank `--ignore-load` reason)
comes before the queue. The refusals run again when a slot is free, and the check list is read again, because main or
the checkout can move during the wait.

Waiters start in arrival order. A waiter prints its position when it starts to wait and then once per minute. A process
that stops, also by SIGKILL, loses its place, and a slot frees when the checks pass, fail or throw. After 120 minutes in
the queue the command fails, names the queue and says that no check ran. It writes no `check_start` event and leaves no
ticket.

A full check takes its slot first and then runs the load wait while it holds the slot, so waiters keep their order under
high load. `--ignore-load` skips the load wait and not the queue. When the pr stage's `verify` gives up in the queue or
in the load wait, the drive closes that run as `aborted` and reruns the pr stage, with no implement run and no round.

## Check alarm

`evf check-alarm [--json]` (OPS-139) reads the checks at the current head of each open PR, drafts too, and prints the
names it first saw, the red non-required checks and the alarms it raised. An alarm blocks nothing and closes nothing:
the ci stage, `evf ship` and the required checks do not read it, and a poll writes no task status, run or stage event.

| Alarm | Raised when | Event | In the owner digest |
| --- | --- | --- | --- |
| New check | a name not seen in the last 7 days has reached 2 PRs, also across polls, within 7 days of its first sighting | `ci_new_check_alarm` | yes, 24 h, apart from the open items |
| Red check | one non-required check is red (`fail` or `cancel` bucket) on 2 open PRs | `ci_nonrequired_red_alarm` | no |

- Each alarm sends the Herdr notification that `holdTask` sends, once. Its event holds `check`, `prs` and
  `notified`: true or false for the send, null when the poll was killed before the send ended. A failed send does not
  fail the poll.
- `ci_nonrequired_red` {check, pr, head, firstSeenAt} records each red non-required check once per PR and head.
  `evf events --type ci_nonrequired_red` lists them.
- A red alarm is raised once. It can be raised again only after a poll that finds the check red on no open PR.
- A check that is new and red on 2 PRs raises one alarm of each kind. Any name can be new, required or not.
- A baseline poll records names and raises no alarm: the first poll on a store with no names, and any poll after more
  than 7 days with no successful poll. Otherwise the checks that exist would all alarm as new. It still records
  `ci_nonrequired_red` events, and a check that is still red on 2 PRs raises its red alarm on the next poll.
- A failed GitHub read, also of the required-check list, ends the poll with a message and exit 1. That poll records no
  sighting and no event, and it does not count as the last successful poll.
- A name that ran only on PRs closed before the first poll can raise one false new-check alarm later.

The state is in the store: `check_names` holds one row per name, and `check_poll` holds the last attempt and the last
successful poll.

The minute sampler is the only clock. A tick starts one poll when the last poll is 5 min old or more, and a manual poll
counts. The poll runs in its own process with a 2 min timeout, and the tick does not wait for it. A new check waits at
most 6 min for a poll and the poll takes at most 2 min, so the alert arrives within 10 min. A sampled poll prints to no one, so
a repeated read failure is silent: run `evf check-alarm` to see the message.

Limit: polls run only while the sampler runs. `evf sampler stop` stops the polls, and the next `evf drive` or
`evf sampler start` starts them again. A sampler keeps the code it started with, so it starts polling only after a
restart at code that holds this section.

### Outside settings

No seat or coordinator creates or links a Vercel project, repo setting or integration until Sebastian's words are
recorded (`.agents/roles/coordinator.md`). `evf outside-setting approved --what "<what>" --words "<his words>"` records one
`outside_setting_approved` event {what, words, at} with the words unchanged. It refuses an empty value and refuses to
run from a seat. evf does not watch those settings and does not block a call to them.

## Minute sampler

One detached process (OPS-133) records load, CPU share by class and queue state once per minute, so a bottleneck
review reads numbers. These records are only history. No gate, scheduler, report or doctor line reads them, and the load
limit above does not change. The same process also runs the dead drive watcher (below), which reads none of them. A tick
also starts the poll of the check alarm (see "Check alarm"), which reads none of them either.

`evf sampler start` starts it. A second start exits 0 and says a sampler already runs. `evf sampler stop` ends it with
SIGTERM, removes its lock and exits 0 when none runs. `evf drive` starts it if none runs, and a sampler failure never
stops a drive. There is no start at login: the sampler lives until `evf sampler stop`, a reboot or its own crash, and
the next drive starts it again. The lock is `sampler.lock` in the same folder. A lock whose pid is dead or now runs
another command does not block a start.

Retention: 30 days. At start and then once per hour the sampler removes lines and
events older than 30 days from all four record kinds. That is at most 43,200 lines per file. It rewrites each file
through a temporary file and a rename, so a reader never sees half a file. A line with an unreadable `at` stays.
The same pass removes `drive_heartbeat` events older than 7 days, and it keeps every other drive event.

| Record       | Where                          | Fields                                                                                |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| Load line    | `.git/evf/load.jsonl`          | `at`, `load1`, `load5`, `swapUsedGb`, `freeMemPct`, `seats`, `fullChecks`, `previews` |
| CPU line     | `.git/evf/cpu.jsonl`           | `at`, `next`, `node-test`, `browser`, `tsc`, `claude`, `macOS`, `other`               |
| `queue_tick` | `events` table, null `task_id` | `runnable`, `held`, `holdReasons`, `seats`, `slotsFree`, `load`                       |
| `load_wait`  | `events` table                 | `command`, `task`, `startAt`, `endAt`, `maxLoad`                                      |

- `freeMemPct` is the figure `memory_pressure` prints as free percentage (`sysctl kern.memorystatus_level`).
- `fullChecks` counts live full `evf verify` calls through a mark under `.git/evf/full-checks/`, because the drive's pr
  stage runs verify inside its own process and `ps` cannot see it.
- `previews` counts portless previews that are not removed, failed or expired.
- A CPU value is that class's part of the CPU in use at that tick, from `ps` `pcpu`, which macOS reports as a decayed
  average. The parts sum to 1 apart from rounding. `cpu.jsonl` holds class names only, never command text.
- A failed or timed-out probe writes null in its fields for that tick. A busy store costs the `queue_tick` and leaves
  both files written, with `seats` still the real count. `seats` is null only when the store cannot be opened or read.
- `queue_tick` is left out of the recent feed of `evf status` and the TUI, which it would otherwise fill within an hour.
- `load_wait` is one event per wait the gate caused, whether the wait ended under the limit or gave up. `maxLoad` is the
  highest load seen. A command under the limit on its first read or run with `--ignore-load` records none. `task` is
  null for a caller with no task (`evf browser run`), and the event has the task's row id when the task has a store row.

A slot is one seat up to the top of the seat target: `slotsFree` is `max(0, 12 - seats)`, and `seats` counts started runs
whose role is not `evf`. The counts come from `nextStage`, applied to each open task with no started run:

- Runnable: the next stage names a stage to perform. This includes stages evf runs itself (pr, ci, ship).
- Held: `blocked`, `escalated` and `waiting`, counted by those names in `holdReasons`, plus `queued` for a queued
  follow-up. A prototype at `pick` counts as `waiting`, because it waits for Sebastian and no free slot can take it. A
  `held_external` task (stage `held`) counts as `blocked`, because no seat can change the failure that holds it.
- In neither: a task with a started run, and merged, done and abandoned tasks.

`runnable` ignores package dependency order: a WP task whose dependency has not merged counts as runnable if `nextStage`
names a stage for it. Later analysis must allow for that.

Read a free slot together with `load`, which `queue_tick` carries. A free slot with runnable work and load under the
limit is idle time. The same slot with load above the limit is a machine with no room, and a seat started there waits at
the gate.

### Dead drive watcher

The watcher (OPS-137, `tools/evf/drive-watcher.ts`) ticks once per minute in the sampler process, in its own function.
A failed watcher tick leaves the sampler's records whole, and a failed sampler probe does not stop the watcher tick.
With `EVF_NO_SAMPLER` set, no watcher runs. It schedules no new work and only restores a drive that was already running
(D86). The events table holds all its state.

It looks at each `active` or `pr_open` task (`pr_open` is the status of an active task with a PR) and leaves the task
alone in each of these cases:

- The task has no `drive_heartbeat` in the store. It never had a drive that the watcher knows, or its drive runs old code.
- The latest drive record is `drive_ended`, so the drive ended by itself.
- A `drive_stop_requested` has no later heartbeat from another pid, or the last stop was a SIGINT. A SIGTERM from any
  other sender does not protect the task: it restarts like any other death.
- The pid file names a live `evf drive` process, for example after the Mac wakes from sleep. The tick starts nothing,
  records nothing and uses no restart. A live pid whose command `ps` cannot read counts the same until a later tick. A
  dead pid, or a pid that another command now holds, counts as dead, and the restarted drive takes over the pid file.

Each event's payload is its `summary`, which names the last heartbeat or the refusal text.

| Event                   | When                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `drive_restart`         | The first tick with no heartbeat for 5 min. It goes in before `evf drive <ref> --detach` runs from the home checkout, so a crash cannot cause two restarts. |
| `drive_death_alert`     | One restart is already used, and 5 min have passed with no heartbeat since the later of the last heartbeat and that restart. There is one Herdr notification with the task, the last heartbeat and the command. Later ticks add nothing. |
| `drive_restart_refused` | `evf drive --detach` exits non-zero, which is the `requireCurrentCode` refusal of the new process. There is one Herdr notification. |

The allowance is one restart since the last alert for the task row. It has no counter column. A drive that lives for
days after a restart and then dies still counts as a second death, which errs toward alerting a person. A drive that a
person starts after an alert gets a new allowance.

A refusal uses no restart. The tick deletes the `drive_restart` row it just wrote and creates no seat and no run row. The
sampler loads evf once, so only a new process can test the code on disk, and the watcher tries that start each minute.
One `drive_restart_refused` and one notification cover all the tries since the last heartbeat, so a long stale period does
not fill the recent feed. The first tick after the code is current restarts the drive once.

The watcher does not flag a death that records no stop, such as SIGKILL: it restarts that drive, but it has no stop time
to compare with a merge. A kill that also takes the sampler leaves no watcher until the next drive starts one.

Rollout after this change merges:

1. Run `evf sampler stop`. The next drive starts a sampler on the new code.
2. Restart each live drive with `evf drive <task> --stop` and `evf drive <task> --detach`, so that it records heartbeats.
   Until then its task has no heartbeat, so the watcher does not watch it.

## Browser checks and process hygiene

`evf browser run [--timeout <s>] [--session <name>] -- <command>` runs a browser check in its own
process group (D35). Every process it starts carries an `EVF_BROWSER_RUN` token in its environment,
so cleanup also finds browsers that leave the group, as Playwright browsers and the agent-browser
daemon do. After a pass, a failure, a timeout (exit 124) or a signal to evf, it closes the run's
agent-browser session, stops the tagged processes (SIGTERM, then SIGKILL) and deletes the run's
TMPDIR, which holds Playwright profiles. It fails when a process survives SIGKILL.
`evf doctor` lists headless browsers and agent-browser daemons older than 15 minutes
(`--browser-age <minutes>`) with PID, age and tree memory. It reports only; owners close their own.
`evf verify` reminds the caller to keep the turn open, and warns when a terminal runs it as a
background job. Agent shells look the same in both modes, so the reminder prints every time.

## Escaped bugs (OPS-114)

A bug that Sebastian catches after review becomes a permanent local check. Everything here runs on this
machine only. No CI workflow names `tests/ui/escaped` or `ui-escaped`, and no step calls a paid API.

`evf escape <PR> --what "<his words>" --task <WP-NNN/ui> [--head <sha>]` stores the escape on an existing
WP /ui task that the coordinator names. OPS tasks do not own `tests/ui/escaped/`, so the command reserves no
OPS id and prints no `maintenanceTasks` entry. It appends one escape block to the task's ask and records an
`escape_filed` event on that row. The block holds the `--what` text byte for byte, the PR number, the escaped
head and the Done template: a test in `tests/ui/escaped/` fails on the escaped head and passes on the fix (or
on main when main never had the bug), the test passes the 20-run soak, and one `evf proof add` records each of
the two runs. The escaped head is `--head` when given, else the merge commit of a merged PR, else the PR's
current head. The command never edits `evf.config.json`. It refuses a missing or empty `--what`, a missing
`--task`, a task that is not a WP /ui part, a task with no row or a merged row, and an unknown PR, and it
writes nothing in those cases. A second call for the same PR and head stores nothing and prints the task that
already carries the escape.

`evf escape soak tests/ui/escaped/<name>.test.mjs [--task <task>]` runs one escaped test 20 times in a row
against the task's stack, with `UI_BASE_URL` set. The first failed run ends the soak. The record goes to
`.git/evf/evidence/<task slug>/soak/<sha256 of the file>.json`, with the run log beside it.

The `ui-escaped` check is built into `evf verify` (`verify.ts`). A check named `ui-escaped` in `checks`
replaces the built-in command. It runs `node --test tests/ui/escaped/*.test.mjs` with `UI_BASE_URL` set to the
task's stack URL. `evf verify` runs it for WP `/ui` parts and for any task that changes a file under
`tests/ui/escaped/`. It skips other tasks with one line that gives the reason, and it skips with one line
while the folder holds no test. It fails without a running stack (the message names
`bin/evf stack up <task>`), and it fails for a changed escaped test that has no 20-green soak record for its
current bytes.

Example, for a UI task that adds an escaped test:

```bash
bin/evf escape 393 --what "<his words>" --task WP-037/ui   # coordinator: store the escape on WP-037/ui
bin/evf stack up WP-037/ui
bin/evf escape soak tests/ui/escaped/<name>.test.mjs --task WP-037/ui   # only for a new or changed test
bin/evf verify WP-037/ui                        # ui-escaped runs every tests/ui/escaped/*.test.mjs on the stack
```

## Feedback and human ownership

The original P0/P1 immediate, P2/P3 Monday, small-feature draft-prototype, large-feature idea, duplicate/question/spam rubric remains in `.agents/roles/feedback-desk.md`. No new severity rubric replaces it.

Configure verified numeric `botAuthorId`, `triageActorIds` and `ownerActorIds`. P0/P1 fixes merge through the verifier (`mergePolicy.feedbackVerifierMerge`). P2/P3 fixes are verified by `evf ship` and then wait (`feedbackOwnerAfterVerifier`); `evf approve` merges them after Sebastian approves in chat. Prototypes merge through `evf approve` only. Use separate agent and human credentials. Direct mutation paths validate bot provenance and explicit actor trust; the currently authenticated account is never automatically trusted. Source repository numeric/node IDs, issue number/node ID, original public summary and locator are frozen. A changed repository cannot reinterpret an existing FB number; the private internal repository is bound too. Repository renames with the same immutable identity preserve the original locator.

The inbound public issue must match the reviewed closed publisher title/body templates, approved public-area list and opaque UUID marker; bot authorship alone does not authorize arbitrary raw text. Those adapter protocol fields are empty until the actual publisher contract is reviewed. Nonconforming/richer public text is held for authorized human triage; the automated model path receives only the closed projection.

Automatic public triage contains a fixed class/status, optional verified public duplicate number and opaque token. Private reason, area, feature/package routing and actor ID stay private. HTML comments are public. An arbitrary reply is blocked unless a configured owner approves the exact source/body SHA-256 in `replyApprovals`; the reviewed question-answer path then posts that exact reply and closes the question. Without a reviewed reply, a question remains open. Large ideas retain demand ranking and owner-approved promotion via `promotionApprovals`; promotion creates private planning evidence, not implementation permission.

Feedback starts require a reviewed current package/context and matching feature scope. P0/sensitive work and over-limit P0 exceptions require recorded owner approval; severity itself grants no authority. Tasks may record sensitive risk in `taskRisks` or their maintenance entry. Nonordinary tasks stop before implementation or merge and escalate through Intent’s existing owner channel; the scoped owner-approval receipt adapter remains unconfigured. The definitive sensitive-scope policy and approved start records must be supplied at the external handoff; this task does not decide broader autonomous authority. A native private-original/reproduction bridge remains unconfigured. Purpose-filtered reproduction access must preserve private-care/security exclusions before any model/runtime access.

Daily slots count actual starts plus current reservations, never triage-cache presence. Reusing a completed start consumes one slot; a historical reservation must charge the actual new start day. The quiet-day queue includes new intake, due P2/P3 Monday work, immediately due backlog and unresolved reservations. Previously budget-held work returns when a later day has room. Concurrent local mutations fail on the lock; stale/incomplete lock ownership requires explicit reconciliation rather than a racing takeover.

Internal creation is source-marker keyed in a verified private repo. A lost response becomes `unknown`; retry first searches for the exact marker and reconciles a single existing issue, refusing zero/ambiguous unknown outcomes. Public shipped updates record pending/unknown/complete outcomes and never report closure after a failed call. Inspect provider evidence and record a reviewed reconciliation before retrying unknown writes; do not delete caches or blindly repeat them.

## Progress and recovery

Only evf writes canonical progress. Ship acknowledges a milestone that passes the reviewed-milestone checks; `evf shipped --clear <task>` is for records ship left unacknowledged (failed checks, package closures, older records). Read
[the coordinator workflow](../../docs/build-agent-workflow.md). Retained records preserve CI,
review, merge and owning-path evidence. Full package closure belongs to integration.
WP-097's documentary fast-track import remains available with its original owner go-live record.

The home checkout owns `docs/build-progress.json`. Ship, acknowledgement and reconcile write it
there, and task worktrees read it there. Only a transfer task that owns exactly that file (OPS-7)
may commit it, so plan PRs leave it alone and the home checkout fast-forwards past them.
Reconcile plan membership in the home checkout with Node 24+ `tools/evf/progress.ts --reconcile`;
it refuses a task worktree. Transfer the result through OPS-7. Never discard dirty shared checkouts or change their
branches while another agent is working. Configure GitHub settings only with current owner
approval. W2 owns the CI workflow, branch protection and GitHub auto-merge setup.
