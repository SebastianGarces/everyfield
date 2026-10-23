# Everyfield workflow tools

Intent plans, delegates and records decisions. evf supplies briefs, worktrees, local checks,
case checks, feedback routing, progress and merge guards. Run `bin/evf help` for commands.

## Phase 7

Build in one task worktree and preview it through portless. Use the shared development database,
which may be wiped and reseeded, never production. Vercel builds production from main only.
Include current main, commit and run `bin/evf verify <task>`. Logs and checks.json live under
the Git common directory. Local checks do not prove application acceptance or mint approval.

A verifier from another model family exercises the real branch, records an exact-head review
on the PR and runs `evf ship`. Ship reads the PR's required GitHub check status, refuses missing
or nonpassing CI, verifies the recorded head and model families and checks the PR body against
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

Model families are `anthropic` (Opus), `xai` (Grok Build) and `openai` (Sol), not individual
model names. `anthropic` pairs with either other family; `xai` and `openai` never review each other. Authors put
`EVF-Author: <family>` in the body. Verifiers put one JSON line in their PR comment:

```text
EVF-Review: {"head":"<full SHA>","verifierFamily":"anthropic","verdict":"approved","quality":{"verdict":"approved","principles":["laziness-protocol","minimize-reader-load","subtract-before-you-add","test-behavior-not-implementation"]},"experience":{"verdict":"approved","budget":"met"}}
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
runs the same gate before its push. Plain `git push` is not intercepted; use the pre-push command
or let `evf pr open` push. These local records do not replace required CI or independent review.

A failed check that reports Next 16.4.1's `Another next build process is already running.`
message waits ten seconds and retries up to three times. Matching strips ANSI color codes.
The log retains every attempt. Other errors are not retried. evf's launcher selects an
installed Node 24+ from nvm if the shell has Node 22, or refuses with a clear requirement message.
Child commands inherit the selected Node directory first on PATH, including shell and pnpm scripts.

`evf gc` is read-only by default. Removal with `--apply` requires a clean, shipped worktree at
its recorded head, no newer task start, no open PR, and no live Portless preview. A reused task
records its new start outside the repository. Unavailable or malformed provider status keeps the
worktree. Cleanup never stops previews itself.

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
