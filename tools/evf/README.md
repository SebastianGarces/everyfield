# Everyfield workflow tools

Intent plans, delegates and records decisions. evf supplies briefs, worktrees, local checks,
case checks, feedback routing, progress and merge guards. Run `bin/evf help` for commands.

## Phase 7

Build in one task worktree and preview it through portless. Use the shared development database,
which may be wiped and reseeded, never production. Vercel builds production from main only.
Include current main, commit and run `bin/evf verify <task>`. Logs and checks.json live under
the Git common directory. Local checks do not prove application acceptance or mint approval.

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
Design tasks, P2/P3 feedback and every `evf approve` route keep exact-head review.

Document-template class: a WP part, an OPS task without the design route or a P0/P1 fix joins it when
its exact-head diff touches a path in `mergePolicy.documentTemplates` in `evf.config.json`. The diff runs
from the merge base with main to the head (`git diff --name-only --no-renames`), so splitting commits or
renaming a file out of a template folder does not leave the class. `evf ship` runs the usual review and CI
checks, posts the `evf/verify` status and prints the `evf approve` command; it never queues, updates the branch
or merges, and exits 0. `evf approve <PR> --owner-approval "<his words>"` merges it after Sebastian approves
in chat, only with an independent review of the exact head and the verified status on it. Then it
writes the shipped record with an `owner_approval` field, acknowledges progress and removes the worktree.
`evf drive` records the wait and stops; a later pass records the merge. The key is optional: when it is
absent, the built-in default in `tools/evf/policy.ts` applies. A malformed key stops `loadConfig`.

Wiki content on task branches (OPS-109): the same task PRs join a second held class when the exact-head diff
changes a path under `docs/reference/wiki/`. `evf ship` runs the verifier checks, then sets each `pending` draft's
`claim_check` to `passed` with the verifier's seat, model and session as `reviewer` and
`Approved <UTC>: "<words>"` as `notes` (one commit), runs the home checkout's `bin/wiki promote` for each passed draft
(`--reviewed-sha` is that commit, `--approved-by` the draft's `approver`) and `bin/wiki check-seed`, commits the
result, pushes, posts `evf/verify` on that head and prints `evf approve <PR> ... --head <sha>`. A failed step resets
the branch to its start and pushes nothing. `evf wiki claim-check <task> --reviewer "<name>" --approval "<words>"`
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
is the numbered SQL in `tools/evf/db/migrations/`; `evf db migrate` (or any writer) applies new files in
order, one transaction each. The views `v_tasks`, `v_seats`, `v_recent` and `v_health` are the read
contract: change them with a new migration, never in place.

`evf goals sync` caches the refocus chain from the plan documents: the project line from
docs/START-HERE.md and one mission per S-row of the Vertical slices table in docs/plan/build-plan.md.
The documents stay the source. `evf db seed-progress` imports the merged milestones of the
docs/build-progress.json committed on main as merged tasks, once each, with a `legacy_milestone` event;
it never reads a checkout's working copy of the ledger. `evf status [--json] [<task>]` lists tasks,
active seats, recent events and the health counters.

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

## Drive loop

`evf drive <task>` runs implement mode as a stage machine kept in the work store: plan → implement →
simplify → pr → verify → ci → ship → merged. Seat stages launch a fresh session through
`evf launch` with a stage prompt, wait on it through Herdr and expect it to close with
`evf run done <run> --status passed|failed --summary-file <file>`; the Stop hook blocks a seat that
tries to end its turn with the stage open, and a seat that goes idle twice without closing is aborted.
evf runs pr, ci and ship itself and records them as runs of role `evf`. The pr stage runs the author checks
(`evf verify <task>`) at the current head, then opens or updates the PR from the body the implementer wrote to
the task's runtime dir. A simplifier commit therefore never costs a round: when the checks fail at a head that
followed a passed simplify, the next stage is simplify with the failure in its prompt, and no implement run starts.
The implementer proves its own work before it closes: tests, 390 and 1440 px screenshots of each UI state it
changed and one `evf proof add` per Done criterion it built or changed. evf adds no gate on that close; the
verifier covers a missing proof. UI work runs in the implementer seat unless the spec has the line `Seat: ui`.
The verifier reads the full diff, reads the proof table and re-runs a flow only where a proof is unmet,
missing or looks wrong; it captures a missing screenshot itself. A failed verify or ci costs a round; the fourth
round sets the task to escalated, records `loop_cap_hit` and `escalation`, shows a Herdr notification
and launches nothing more. Any other failure costs no round, but three failures in a row without a
passed stage escalate the same way, so no loop runs unattended forever. `evf task reopen <task> --reason
"<two words or more>"` answers an escalation: it sets an escalated task to `pr_open` (it has a PR) or
`active` and records a `reopen` event holding the highest run id. Later failure counts start after that
run, so the task gets three more failures before it escalates again. It resets only the trailing-failure
count, never the round (a task at the loop cap escalates again on its next failed verify or ci), and
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

**Stopping a drive.** The drive loop runs in a worker thread, so the main thread can answer SIGTERM and SIGINT
while a stage blocks in a child process. A signal that arrives inside a pr, ci or ship stage closes that `evf` run
`aborted` with `drive stopped by <SIGNAL> during <stage>` and records one `drive_stopped` event with `{stage, signal}`.
The drive removes its pid file and ends by the signal, which a shell reads as exit 128 plus the signal number (143 for
SIGTERM). A signal between stages or inside a seat wait writes no run: only the pid file goes. Stop a drive with
SIGTERM. SIGKILL cannot be caught and leaves the run `started`; `evf status` and `evf doctor` report it (below).

**Orphaned `evf` runs.** A `started` run of role `evf` whose task has no live drive (the pid file under `evf/drive/`
is missing or names a dead pid) is orphaned. `evf status` (text, and `--json` under `orphanRuns`) and `evf doctor`
print one line for each: the ref, the run id, the stage, the age and one repair that never ships. A ship stage is
repaired with `evf approve <PR>` once Sebastian approved, or `evf task reopen`; any other stage with
`evf drive <task> --once`, whose restart recovery only aborts the run. A task already merged is repaired through the
same late-merge path. Migration 005 closes the runs of tasks already merged. `markMerged` (ship, the drive's late
merge and `evf approve`) closes every open `evf` run of the merged row `passed` with `<ref> merged as <sha10>`, and
closes a seat run `aborted`. `evf approve` finds the row from the PR head branch and records the merge after the
squash-merge; a branch with no row (a Wiki article) writes nothing.

A merge ends the drive and the task. The drive exits 0 directly after its ship stage closes passed and makes
no further transition. A standalone `evf ship` writes the same record: the ref's current row becomes `merged`
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
work (`evf drive`, `evf task spec`, `evf launch`, `evf proof add`) uses that row and never inserts a row for a
merged ref; `evf drive` prints stage `done`, and `evf task spec` and `evf launch` fail. Only `evf task new
<ref> --ask-file <file>` reopens a merged ref: it inserts one `new` row and its `task_new` event names the
merged row it reopens (`reopens`).

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
the row cover later slice n (schema 7: `tasks.slice` and `tasks.linked`); a link without it covers no slice.
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

## Stable verification, pushes and cleanup

`evf verify <task>` checks the author's task worktree. A verifier runs from its own checkout:

```sh
bin/evf verify OPS-9 --role verifier --head <full-40-character-SHA>
```

Verifier mode always uses the caller's Git checkout, including its committed check definitions.
`--head` refuses a different HEAD; without it, the command pins the caller's current HEAD.
A dirty checkout refuses before checks. Changes to the checked tree or base during checks print
`INVALIDATED`, stop further checks and require a fresh run on stable inputs.

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

## Machine load limit

Agents share one Mac. `evf task start`, `evf verify` and `evf browser run` wait while the 1-minute
load average is above 2 × CPU cores (24 on Sebastian's 12-core Mac, rulings C51 and C81). A waiting
command prints one line per minute with the load and the limit, and gives up after 30 minutes
without starting work. An optional `"machineLoad": {"maxPerCore": 2, "maxWaitMinutes": 30}` in
`evf.config.json` overrides the default in `tools/evf/load.ts`; an OPS branch cannot add it,
because it may change only its own `maintenanceTasks` entry.
`--ignore-load "<reason>"` runs at once and appends the time, command, load, limit and reason to
`load-overrides.jsonl` under the Git common directory's `evf/` folder. `evf doctor` shows the
current load and limit. CI runners use the same rule with their own core count.

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
