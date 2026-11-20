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
the apt install into `tools/ci/libreoffice.ts`):

1. Shared setup. The installer is TypeScript and needs the job's Node, so it cannot start before setup.
2. `LibreOffice` cache restore, then `tools/ci/libreoffice.sh` starts in the background: `tools/ci/libreoffice.ts`
   (apt install with retries, bounded at 8 min by `timeout`), fonts and `soffice --version`.
3. One step: `node tools/ci/parallel.ts` runs Prettier, lint, types and server log privacy at once. Each output line
   carries its command's label (`[prettier]`, `[lint]`, `[types]`, `[logs]`), each command ends with its exit code
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

Pending: the app job's run time on this change's own pull request CI runs (at least 2 green runs), read with
`node tools/ci/ci-timing.ts`, with the per-step breakdown of the critical path.

Locally (Apple silicon, many more cores than the runner), the five checks of the first version (with `check-comments.mjs`) took 14.8 s together, against 13.5 s for
the longest alone. On the 4 vCPU runner the four commands' CPU work is expected to saturate the cores, so the step
should take longer than its longest command (types, 31 s).

## Re-measure after landing

Once at least 50 CI runs have completed on main with this change, run `node tools/ci/ci-timing.ts --last 50`, compare
the app row with the before number above and append the result here.
