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

Once at least 50 CI runs have completed on main with this change, run `node tools/ci/ci-timing.ts --last 50`, compare
the app row with the before number above and append the result here.
