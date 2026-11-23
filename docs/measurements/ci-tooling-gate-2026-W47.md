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

One `tooling` job (137439174933) has a null `queueMs`, so its queue sum and median cover 49 jobs, not 50.

Before T-461 the `tooling` job took about 9.9 min (median setup plus run) on every pull request.

## The docs-only run

PR #1312 (this task), head 8fb157b11, which changes only `docs/measurements/ci-tooling-gate-2026-W47.md` and
`ci-tooling-gate-2026-W47.before.json`:

- Run: https://github.com/SebastianGarces/everyfield/actions/runs/45118607073 (conclusion success).
- `tooling` job: https://github.com/SebastianGarces/everyfield/actions/runs/45118607073/job/137507014004, steps from 2026-11-23T05:34:17Z
  to 2026-11-23T05:35:49Z.
- `node tools/ci/ci-timing.ts` prints for it: queue 1000 ms, setup 21000 ms, run 69000 ms, so setup plus run is 90 s.
  The `ci` job of the same run: queue 1000 ms, setup 9000 ms, run 3000 ms.

The `tooling-gate.ts` step printed:

```
tooling gate: pull_request 7916012c0cab...8fb157b11c22, merge base 46fbcfa4e426
tooling gate: 2 changed paths against the merge base
skip typecheck (INV-typecheck tests in the CI test coverage tool): no changed path matches ...
skip formal (INV-formal (TLC) tests in the local stack step): no changed path matches ...
skip qa (QA preview tool): no changed path matches ...
skip wiki (wiki tool install, Chromium and tests): no changed path matches ...
skip app (app verification tool and agent-browser): no changed path matches ...
skip stack (local stack tests): no changed path matches ...
```

Every gated self-test skipped.

## After

Captured 2026-11-23T05:45:23Z (finished 2026-11-23T05:51:01Z) into `ci-tooling-gate-2026-W47.after.json`. Of its 50 runs, 20
fall after the cut: runs 45110248476 to 45119060608, created 2026-11-23T04:10:41Z to 2026-11-23T05:38:36Z, all
first attempts succeeded. 29 fall before it (runs 45095904424 to 45108774333; 2 had a failed first-attempt job), and
one is the cut itself, push run 45109712951 of 46fbcfa4e, counted on neither side.

| Side, job | Jobs | Sum setup | Sum run | Sum queue | Median setup | Median run | Median setup + run | Median queue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| After, `tooling` | 20 | 518 s | 4706 s | 38 s | 25 s | 72 s | 97 s | 2 s |
| After, `ci` | 20 | 199 s | 59 s | 39 s | 9.5 s | 3 s | 12.5 s | 2 s |
| Before (this capture), `tooling` | 29 | 852 s | 17991 s | 55 s | 28 s | 559 s | 592 s | 2 s |
| Before (this capture), `ci` | 29 | 319 s | 78 s | 62 s | 12 s | 2 s | 13 s | 2 s |

The after side mixes main pushes and pull requests; a pull request that touches a gated path still runs that
self-test, so the after median is an upper bound for docs-only pull requests. The `tooling` median setup plus run fell
from 591 s (before capture) and 592 s (pre-cut runs of this capture) to 97 s. The `ci` roll-up job is unchanged at
about 13 s.

## Verdict

Near 2 min: the docs-only `tooling` job took 90 s of setup plus run (queue 1 s), under the 3 min bar, and every gated
self-test printed `skip`. No follow-up task is filed.
