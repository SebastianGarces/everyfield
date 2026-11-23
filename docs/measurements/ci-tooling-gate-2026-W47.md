# CI tooling gate on a docs-only pull request, 2026-W47

T-461 (CI speed step 1, PR #1305) gated the slow self-tests of the `tooling (docs, workflow, tools, wiki)` job of
`.github/workflows/ci.yml` behind `tools/ci/tooling-gate.ts`: a pull request that touches none of a self-test's paths
skips it. T-461 landed on main as 46fbcfa4e; its push-to-main CI run is 45109712951, created 2026-11-23T04:05:19Z.
T-461 landed with an estimate of about 2 min for a docs-only pull request, because a seat cannot push one. This record
is the T-461 follow-up (T-582): this task's own pull request changes only files under `docs/measurements/`, so its CI
run is the measurement.

## Method

- Command: `node tools/ci/ci-timing.ts --last 50 --json`, which reads the 50 latest completed ci.yml runs and splits
  each job into queue (created to started), setup (steps matching its `SETUP_STEPS`) and run (every other non-skipped
  step).
- Before = runs created before 2026-11-23T04:05:19Z (main before T-461). After = runs created after it: main pushes
  and pull requests, whose CI merges current main.
- The raw captures sit beside this file: `ci-tooling-gate-2026-W47.before.json` and
  `ci-tooling-gate-2026-W47.after.json`. The figures below are recomputed from their `runs[].jobs[]` entries: sums and
  medians of `queueMs`, `setupMs` and `runMs`, whole seconds.
- The required `ci` job is the roll-up that waits for the others. Its own time is the roll-up's setup and a few
  seconds of run, not the run's wall time.

## Before

Captured 2026-11-23T04:15:52Z. All 50 runs fall before the cut: runs 45088302026 to 45108774333, created
2026-11-23T00:21:32Z to 2026-11-23T03:55:25Z. First attempts: 46 succeeded, 4 had a failed job.

| Job (50 jobs each) | Sum setup | Sum run | Sum queue | Median setup | Median run | Median setup + run | Median queue |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `tooling` | 1437 s | 30515 s | 914 s | 27 s | 557.5 s | 591 s | 2 s |
| `ci` | 543 s | 143 s | 145 s | 12 s | 3 s | 14 s | 2 s |

Before T-461 the `tooling` job took about 9.9 min (median setup plus run) on every pull request.

## The docs-only run

Pending: this pull request's CI run is added here once evf opens the pull request and its CI completes (owner ruling
D-2288). It will give the run and `tooling` job links, the job's queue, setup and run times as
`node tools/ci/ci-timing.ts` prints them, and the `tooling-gate.ts` step's lines.

## After

Pending, with the docs-only run: the after capture, its time, and how many runs of the `--last 50` window fall after
the cut.

## Verdict

Pending, with the docs-only run.
