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

## Seats

A seat is one fresh top-level Claude Code session in its own Herdr pane and task worktree. `evf launch <task>
--role <role>` creates the worktree when it is missing (the task start rules apply), opens a Herdr workspace
whose shell carries `EVF_TASK`, `EVF_RUN`, `EVF_ROLE`, `EVF_STAGE`, `EVF_WORKTREE` and `EVF_SESSION`, starts
`claude --agent <role>` with the session id evf chose, the role's model and effort and `acceptEdits`, and
records the run and a `stage_start` event in the work store. `--dry-run` prints every step. The role files
are `.claude/agents/<role>.md`: planner and verifier on Opus 5.5 high, implementer, ui, simplifier and
evidence on Sonnet 5.5 medium. Every seat has the advisor and the update prompt disabled.

The hooks in `.claude/settings.json` route to `bin/evf hook <event>`. They do nothing unless `EVF_RUN` is
set, so an ordinary session in the repository is untouched. In a seat, session start writes the session id
on the run and injects `evf refocus` (the goal chain, also after a compaction), the path guard denies an
Edit or Write outside `EVF_WORKTREE` (symlinks and `~` resolved), stop and session end are recorded and a
seat that exits without closing its stage is marked aborted. A session end with reason `clear` or `resume`
keeps the run open, because the seat continues in the same pane. If Herdr fails before the agent is up,
the run is aborted at once, so the store never lists a seat that does not exist. The path guard is a rail,
not a sandbox: it covers the edit tools only, and a seat with shell access can still write elsewhere.
`evf session` prints the pane's Claude Code session id from Herdr, for the EVF-Author and EVF-Review lines.

## Drive loop

`evf drive <task>` runs implement mode as a stage machine kept in the work store: plan → implement →
simplify → pr → evidence → verify → ci → ship → merged. Seat stages launch a fresh session through
`evf launch` with a stage prompt, wait on it through Herdr and expect it to close with
`evf run done <run> --status passed|failed --summary-file <file>`; the Stop hook blocks a seat that
tries to end its turn with the stage open, and a seat that goes idle twice without closing is aborted.
evf runs pr (from the PR body the implementer wrote to the task's runtime dir), ci (polls the PR checks)
and ship itself and records them as runs of role `evf`. A failed verify or ci costs a round; the fourth
round sets the task to escalated, records `loop_cap_hit` and `escalation`, shows a Herdr notification
and launches nothing more. Any other failure costs no round, but three failures in a row without a
passed stage escalate the same way, so no loop runs unattended forever. A blocked seat is notified every
10 minutes until someone answers its pane. Each launch gets its own Herdr agent, `<role>-<slug>-<run>`,
so a later round never waits on an earlier seat. `evf next <task>` prints the next stage without acting
and writes nothing; `--once` performs one transition; `--detach` runs the loop in the background with a
log under the Git common directory. One drive per task: a second `evf drive` refuses while the first
process is alive (pid file under `evf/drive/`). If a drive dies inside its own pr, ci or ship stage, the
next drive aborts that run without a round and performs the stage again; a PR GitHub already merged is
recorded, not shipped twice. Jonah polls `evf status --json`.

`evf task new` records the verbatim ask, `evf task spec` the spec with its hash, `evf proof add` one
proof row per Done criterion bound to the worktree head, `evf check` the author checks as an event when
the store knows the task, and `evf ask planner` forks the planner's session in plan mode for a question.
A verify run closes passed only when every numbered Done criterion has a `met` or `n/a` proof at the
worktree head (guard rail 3). For a driven task (one with an evf run), ship also refuses an EVF-Author
or EVF-Review session that evf never launched; a task row alone, from `evf check` or a launch by hand,
changes nothing for an ordinary PR.

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

## Live TUI

`evf tui` opens one read-only screen of the harness: every open task and running seat (task, stage, seat,
model, effort, Herdr state, round of three, proof rows met, gate, last event), the event feed in Eastern
Time and the health counters, with an explorer by mode and task on the left. It is the Rust crate in
`tools/evf-tui/` (ratatui, rusqlite bundled, notify), outside the pnpm workspace. `evf tui` runs
`cargo build --release` with the target directory under the Git common dir when the cached binary at
`<git-common-dir>/evf/bin/evf-tui` is missing or older than the crate sources, then starts it with `--db`
set to the work store path; `--dry-run` prints those paths and the build decision, `--once` prints one
plain-text report. The binary opens the store read-only in WAL mode with a 200 ms busy timeout, re-reads
when the file watcher or the 250 ms fallback poll sees `PRAGMA data_version` move, polls
`herdr api snapshot` every second and joins agents to runs by the Claude session id, and lists worktrees
every ten seconds for head SHAs. `t` runs `herdr agent focus <agent>` (the task's workspace as the
fallback), `Enter` opens the ask, spec and proof rows, `/` filters. It writes nothing: HEALTH names the
evf command for every human gate (`awaiting_pick`, `escalated`) and every blocked seat.

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
An entry with `"route": "design"` is a design task instead: it owns only `design/` paths and never
changes `design/everyfield-ui.html`, the approved prototype that the app tokens come from. Its
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

Only evf writes canonical progress on ship and coordinator acknowledgement. Read
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
