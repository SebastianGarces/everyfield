# CI app job in parallel, 2026-W47

The `app (lint, types, logs, unit)` job of `.github/workflows/ci.yml` ran its checks one after another (T-464, step 4
of the CI speed report). It now runs its independent work at the same time inside the one job. No check moved out of
the job, and every one still runs on every pull_request, merge_group and push to main. No CI spending: the job stays
on `ubuntu-24.04` (4 vCPU, 16 GB).

## The change

Before, one step after another: Shared setup; Prettier; lint; `check-comments.mjs`; types; server log privacy;
`LibreOffice` cache restore; apt install; cache save (only when the package set changed); fonts and
`soffice --version`; package unit tests.

After (main dropped the separate `check-comments.mjs` step before this landed, since `pnpm lint` runs it, and moved
the apt install into `tools/ci/libreoffice.ts`; it later added a `pnpm knip` step, which joins the parallel step):

1. Shared setup. The installer is TypeScript and needs the job's Node, so it cannot start before setup.
2. `LibreOffice` cache restore, then `tools/ci/libreoffice.sh` starts in the background: `tools/ci/libreoffice.ts`
   (apt install with retries, bounded at 8 min by `timeout`), fonts and `soffice --version`.
3. One step: `node tools/ci/parallel.ts` runs Prettier, lint, types, knip and server log privacy at once. Each output
   line carries its command's label (`[prettier]`, `[lint]`, `[types]`, `[knip]`, `[logs]`), each command ends with its exit code
   and time, and the last line names any failed command and its exit code.
4. A step waits for the background install, prints its log, fails if the install failed and passes on the cache key
   the installer wrote.
5. The cache save, with the same key scheme, only when the package set changed.
6. Package unit tests.

`node tools/ci/ci-tests.ts` follows the runner's `label=command` arguments, so it attributes the same test files to
ci.yml as before.

## Before

`node tools/ci/ci-timing.ts --last 50 --json`, read at 2026-11-18T18:18Z: the 50 completed CI runs from 44351227187
(2026-11-18T16:47:09Z) to 44365766176 (2026-11-18T18:05:02Z). Totals for the app job: 50 jobs, setup 866 s, run
7388 s (mean 17.3 s and 147.8 s; 15 of the 50 jobs were cancelled by a newer push, which shortens them). Over the 35 successful app jobs, from
each job's steps:

| | Median |
|---|---|
| Run (ci-timing's non-setup steps) | 194 s |
| Setup | 21 s |
| Job wall time (start to end) | 225 s |

Median step times, successful jobs: checkout 4 s, Shared setup 16 s, Prettier 21 s, lint 17 s, lint rule coverage
1 s, types 31 s, server log privacy 15 s, `LibreOffice` cache restore 2 s, apt install 24 s, fonts and
`soffice --version` 3 s, package unit tests 57 s.

## After

The app job of this change's pull request CI (PR #1287, head 37998d7f5), two green runs: run 45078016305 attempt 1
(job 137379538009, 2026-11-22T22:29:42Z, pushed) and attempt 2 (job 137385331631, 2026-11-22T22:49:36Z, a rerun of the app
job only, on the same head). `ci-timing.ts --last` takes the latest runs and cannot pick one run, so setup and run
were summed from each job's steps (`gh run view 45078016305 --attempt N --json jobs`, whole seconds) with ci-timing's
own rule: a step is setup when its name matches `SETUP_STEPS`, and every other non-skipped step is run.

Main had changed since the before window: types took 63-92 s instead of 31 s, unit tests 72-102 s instead of 57 s, and
knip was added. So a third column shows current main, still sequential: the 6 latest green push runs of ci.yml on main
(45055038548 to 45072676930, 2026-11-22T18:25:55Z to 2026-11-22T21:32:35Z), read the same way.

| app job | Before (W47 window, median of 35) | Current main, sequential (median of 6) | After, attempt 1 | After, attempt 2 |
|---|---|---|---|---|
| Run (non-setup steps) | 194 s | 242 s | 188 s | 186 s |
| Setup | 21 s | 22 s | 15 s | 24 s |
| Wall time (start to end) | 225 s | 267.5 s | 205 s | 213 s |

Critical path after the change, attempt 1 / attempt 2:

| Step | Time |
|---|---|
| Set up job, checkout, Shared setup | 14 s / 23 s |
| `LibreOffice` cache restore, background start | 1 s / 3 s |
| Parallel step (all 5 commands) | 120 s / 111 s |
| Wait for the background install | 0 s / 0 s |
| Cache save (skipped: package set unchanged) | 0 s / 0 s |
| Package unit tests | 67 s / 72 s |
| Post steps, complete job | 1 s / 1 s |

Each command's own time in the parallel step, from the runner's `[label] exit 0 after T s` lines, attempt 1 /
attempt 2: knip 14.1 / 11.9 s, lint 71.5 / 64.1 s, logs 79.3 / 68.1 s, prettier 90.1 / 76.2 s, types 120.3 /
110.4 s. On current main, run one after another, the same five take (medians) Prettier 23 s, lint 19.5 s, types
65.5 s, knip 3 s, server log privacy 18.5 s: 129.5 s in all.

### What limits it

The job is 55-63 s faster than current main (267.5 s to 205-213 s) and 12-20 s faster than the before window, but it is
still above the 2 min target (3.4-3.6 min). Two things limit it:

- **CPU saturation in the parallel step.** The five commands share the runner's 4 vCPUs, and types, lint and Prettier
  each use several threads. Together they take 111-120 s, against 129.5 s one after another, so running them at once
  saves only 10-19 s. Types alone takes 65.5 s on main, but 110-120 s in the parallel step. The background `dpkg`
  install also runs during this step. Memory was not measured on the runner. No command failed or was killed.
- **The unit tests come after it.** Package unit tests are one 67-72 s command and run after the static checks, so
  the critical path is setup (15-24 s) + parallel step (111-120 s) + unit tests (67-72 s).

Most of the saving comes from the install overlap: on main the cache restore, apt install and fonts take about 35 s
(median 3 + 28.5 + 3.5 s), and here the wait step takes 0 s.

The fallback the spec names is the static/unit split. From these numbers, a `unit` job would take about setup 22 s +
install 35 s + unit tests 74 s ≈ 2.2 min, and a `static` job with all five commands about 22 s + 111-120 s ≈ 2.2-2.4
min. Splitting types into its own job would bring the static side to about 22 s + 65.5 s ≈ 1.5 min. So a split cuts
the app's wall time to about 2.2 min at the cost of one or two more jobs per run under the 20-job cap. This change
does not make that split: it is proposed with these numbers for the re-measure slice (T-466).

## Re-measure after landing

T-466. The change landed on main as ec8856dca at 2026-11-23T00:52:30Z. `node tools/ci/ci-timing.ts --last 50 --json`,
run from ec8856dca and read from 2026-11-23T10:11:39Z to 2026-11-23T10:17:25Z: the 50 completed CI runs from 45120087337
(2026-11-23T05:48:42Z) to 45152260543 (2026-11-23T10:01:19Z), all created after the landing. Pull request runs test a
merge with main, so every run in the window carries the change. Totals for the app job: 48 jobs, setup 1078 s, run
9981 s (mean 22.5 s and 207.9 s). None of the 48 app jobs was cancelled: 3 of the 50 runs were cancelled by a newer
push, 2 of them before their app job started, so those 2 runs have no app job. 2 app jobs failed in the parallel step.
The W47 run mean (147.8 s) is lower mostly because 15 of its 50 app jobs were cancelled part way.

Over the 46 successful app jobs, from each job's steps (`gh run view <id> --json jobs`) with ci-timing's own rule
(`SETUP_STEPS` is setup, every other non-skipped step is run; all 46 sums match ci-timing's `setupMs` and `runMs`):

| app job | Before (W47 window, median of 35) | Main, sequential (median of 6) | PR #1287 after, attempts 1 / 2 | After landing (median of 46) |
|---|---|---|---|---|
| Run (non-setup steps) | 194 s | 242 s | 188 s / 186 s | 193.5 s |
| Setup | 21 s | 22 s | 15 s / 24 s | 22 s |
| Wall time (start to end) | 225 s | 267.5 s | 205 s / 213 s | 222 s |

Wall time spread: 197-323 s, middle half 213-233 s, 12 of 46 above 240 s.

Median step times, successful jobs: Set up job 2 s, checkout 6 s, Shared setup 15 s, `LibreOffice` cache restore 2 s,
background start 0 s, parallel step (Prettier, lint, types, knip, server log privacy) 117.5 s, wait for the background
install 0 s, package unit tests 75 s, post steps and Complete job 0 s. The cache save ran in 1 of 46 jobs. Each
command's own time in the parallel step, from the runner's `[label] exit 0 after T s` lines (medians, range): knip
13.4 s (10.9-20.1), lint 66.3 s (60.2-105.8), logs 72.9 s (62.2-106.6), prettier 81.8 s (73.8-134.1), types 117.0 s
(107.7-181.8).

### Against the target

The app job does not meet the 1.5-2 min target: its median wall time is 222 s (3.7 min). It is 45.5 s faster than main
was while sequential (267.5 s), 3 s faster than the W47 window, and 9-17 s slower than the two PR #1287 attempts, which
sit inside this window's middle half.

What limits it: the critical path is setup 22 s + cache restore 2 s + parallel step 117.5 s + unit tests 75 s + 3 s of
job overhead (median wall minus step sums), about 220 s.

- **types bounds the parallel step.** types finished last in all 46 parallel steps, and the step's median (117.5 s)
  equals types' median (117.0 s). Alone on main, types takes 65.5 s (median above), so in the parallel step it runs
  about 1.8 times slower. The five commands spend 351 s of command time inside 117.5 s on 4 vCPUs, and types, lint and
  Prettier each use several threads, so the slowdown points to CPU contention. Runner CPU counters were not collected,
  so the share each command got is not measured.
- **The unit tests run after it.** Package unit tests are one 75 s command that waits for the parallel step.
- **The install is not on the path.** The wait step takes 0-1 s in every successful job, so the background install
  finishes inside the parallel step.

Ruled out: failed or cancelled jobs (only the 46 successful jobs are in the medians); skipped work (every successful
job ran all five commands with exit 0, the unit tests, and the install; only the cache save is skipped when the package
set is unchanged); a few slow runs (the median sits in a middle half 20 s wide).

### Proposal: split static and unit

The job is above 2 min, so this proposes the static/unit split. Estimates from the medians above, plus the 3 s job
overhead. The install's own time is not a step any more (it runs in the background and its log has no timestamps), so
the `unit` job uses main's sequential medians from the section above: apt install 28.5 s and fonts 3.5 s.

| Job | Estimate |
|---|---|
| `unit`: setup 22 s + cache restore 2 s + install 28.5 s + fonts 3.5 s + unit tests 75 s + 3 s | 134 s (2.2 min) |
| `static` with all five: setup 22 s + parallel step 117.5 s + 3 s | 142.5 s (2.4 min) |
| `types` alone: setup 22 s + types 65.5 s (alone, on main) + 3 s | 90.5 s (1.5 min) |
| `static` without types: setup 22 s + Prettier 81.8 s (slowest of the four, measured with types beside it) + 3 s | at most 106.8 s (1.8 min) |

- Static and unit, two jobs: the app checks finish in about 142.5 s (2.4 min) instead of 222 s, bounded by `static`.
  One more job per run (7 to 8).
- Static, types and unit, three jobs: about 134 s (2.2 min), bounded by `unit`. Two more jobs per run (7 to 9).
- Neither reaches 2 min: the `unit` job's install and unit tests are 109 s before setup. Getting under 2 min would also
  need the install out of the `unit` job's path, for example a package set baked into a cached image or the unit tests
  split, which this measurement does not size.
- Under the 20-job queue cap, a run now uses 7 jobs; 8 or 9 still fits 2 whole runs at once (14, 16 or 18 jobs), so the
  split costs queue room only when more than two runs are queued. Each extra job also pays its own setup (22 s) in
  runner minutes.

The split changes `.github/workflows/ci.yml` and is Sebastian's decision and its own task. This note does not make it.
