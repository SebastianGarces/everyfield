# Typecheck shadow, 2026-W46: `bun check` beside `tsc`

T-109 collects the shadow data that T-53 started, so that T-110 can decide the gate. This report reads and counts only. It
changes no script, check or CI step, and it does not chase a mismatch.

`pnpm typecheck` (`tools/ci/typecheck.ts`, landed on main in a335defb) runs `tsc` in every package, then `bun check` in
the same packages, and prints one `typecheck-shadow {json}` line per run. Outside CI it also appends the line to
`~/.local/state/everyfield/typecheck-shadow.jsonl`. A line has `mismatch: "yes"` when bun's diagnostics differ from tsc's
by file, line and code, when the two outcomes differ, when tsc's status for a package could not be read (`unknown`), or
when bun gave no verdict (crash, timeout or missing).

## Window

| | |
|---|---|
| Window | 2026-11-09T07:42:01Z (a335defb lands) to 2026-11-12T16:00:00Z, 80 h 18 min |
| First shadow line | 2026-11-09T07:46:00Z (CI, run 42580973563 on main at a335defb) |
| Last shadow line | 2026-11-12T15:59:54Z (CI) |
| Data span | 80 h 14 min, more than the 72 h the task asks for |
| Local lines | 2026-11-10T01:35:09Z to 2026-11-12T12:27:45Z. This Mac ran no `pnpm typecheck` on 2026-11-09 after the landing |
| CI runs | created 2026-11-09T07:42:04Z to 2026-11-12T15:58:30Z |

The window ends at 2026-11-12T16:00:00Z, so that every CI run counted had finished or stalled before collection
(2026-11-12, between about 16:27 and 16:47 UTC).

## Totals

| Source | Runs | Shadow lines | `mismatch: yes` |
|---|---:|---:|---:|
| Local | 69 | 69 | **17** |
| CI | 1052 `ci.yml` runs | 1039 | **0** |
| **Together** | | **1108** | **17** |

**17 mismatches in 1108 shadow runs: 17 local, 0 CI.** In each of the 17, the shadow read no per-package status from
`tsc` (all 7 packages `unknown`). See [Mismatches](#mismatches).

## Local runs

All 69 lines in the local log fall inside the window. None has `ci: true`. Each covers the same 7 packages.

| Day (UTC) | Runs | Clean | Dirty | `mismatch: yes` |
|---|---:|---:|---:|---:|
| 2026-11-09 | 0 | 0 | 0 | 0 |
| 2026-11-10 | 8 | 3 | 5 | 2 |
| 2026-11-11 | 49 | 16 | 33 | 14 |
| 2026-11-12 | 12 | 0 | 12 | 1 |
| **Total** | **69** | **19** | **50** | **17** |

`dirty` is the shadow's own field: the worktree had uncommitted tracked changes. Outcomes: tsc exited 0 in 50 runs and 1
in 19. bun passed in 52, reported errors in 11 and was missing in 6. In 8 runs both sides reported type errors and the
diagnostics matched (`mismatch: no`).

## CI runs

Source: every `ci.yml` run created in the window, read with `gh run list --workflow ci.yml --created <range>` and
`gh run view <id> --job <app job> --log`. The shadow line is taken from the `Types` step (`pnpm typecheck`) of the
`app (lint, types, build)` job. 881 runs are `pull_request`, 168 `push` and 3 `schedule`. 171 ran on main.

| Day (UTC, run created) | Runs | Shadow line found | `mismatch: yes` |
|---|---:|---:|---:|
| 2026-11-09 | 25 | 25 | 0 |
| 2026-11-10 | 30 | 30 | 0 |
| 2026-11-11 | 739 | 726 | 0 |
| 2026-11-12 | 258 | 258 | 0 |
| **Total** | **1052** | **1039** (171 main, 868 PR) | **0** |

In all 1039 lines, the `Types` step succeeded, tsc exited 0 and bun passed in all 7 packages. No run in the window failed
at `Types`. A PR run checks GitHub's merge commit, so its shadow `commit` is that merge commit, not the PR head. The run
index keeps the head.

13 runs have no shadow line. None counts as a match:

| Run | Created | Head | Event | Run result | Reason |
|---|---|---|---|---|---|
| 42987788605 | 2026-11-11T08:32:02Z | `c7a50b065` | pull_request | cancelled | app job cancelled with no steps recorded; job log not found |
| 42994949775 | 2026-11-11T09:24:45Z | `9ca6fae0a` | pull_request | failure | `Types` step skipped after an earlier step failed; no shadow line |
| 42995184273 | 2026-11-11T09:26:24Z | `8f6b0c0e5` | pull_request | failure | `Types` step skipped after an earlier step failed; no shadow line |
| 42996274149 | 2026-11-11T09:34:11Z | `cf7ca4994` | pull_request | failure | `Types` step skipped after an earlier step failed; no shadow line |
| 43024772274 | 2026-11-11T12:57:10Z | `27b58ed55` | pull_request | cancelled | app job cancelled with no steps recorded; job log not found |
| 43095604970 | 2026-11-11T20:22:00Z | `1786da7b2` | pull_request | still queued | run never started; no jobs |
| 43095619381 | 2026-11-11T20:22:08Z | `1194452f0` | pull_request | still queued | run never started; no jobs |
| 43096269934 | 2026-11-11T20:28:32Z | `7cc8ad540` | pull_request | still queued | run never started; no jobs |
| 43096717861 | 2026-11-11T20:33:06Z | `75d2fdbcb` | pull_request | still queued | run never started; no jobs |
| 43096834064 | 2026-11-11T20:34:16Z | `60e4b1c1f` | pull_request | still queued | run never started; no jobs |
| 43097132136 | 2026-11-11T20:37:11Z | `c1a610733` | pull_request | still queued | run never started; no jobs |
| 43097561855 | 2026-11-11T20:41:46Z | `4d80e36c1` | pull_request | still queued | run never started; no jobs |
| 43097833431 | 2026-11-11T20:44:27Z | `bdd3d060e` | pull_request | still queued | run never started; no jobs |

The run index ([`typecheck-shadow-2026-W46.ci-runs.jsonl`](typecheck-shadow-2026-W46.ci-runs.jsonl)) lists all 1052
runs: run id, created time, head commit, event, `on_main`, result, `Types` step result, whether a shadow line was found,
the reason when not, the line number in the CI raw file, and `mismatch`. It leaves out branch names.

## Mismatches

All 17 are local. Each mismatched run lists all 7 packages (`apps/web`, `packages/contracts`, `packages/db`,
`packages/domain`, `packages/evry`, `packages/reference`, `packages/ui`) as mismatched, with tsc `unknown` in each. No
line has a `shadow_error`.

| # | Time (UTC) | Commit | Tree | tsc | bun outcome (per package) | Differences (file, line, code, side) |
|---:|---|---|---|---|---|---|
| 1 | 2026-11-10T01:35:09Z | `02c283172` | dirty | exit 1, 2 ms | pass, all 7 | none |
| 2 | 2026-11-10T03:59:35Z | `3dc9bab0a` | clean | exit 0, 23.3 s | pass, all 7 | none |
| 3 | 2026-11-11T04:48:42Z | `ea79e997a` | dirty | exit 1, 0.2 s | missing (exit 127), all 7 | none |
| 4 | 2026-11-11T05:51:39Z | `16c826d8e` | dirty | exit 1, 0.2 s | missing (exit 127), all 7 | none |
| 5 | 2026-11-11T05:56:49Z | `fb8ef01dc` | dirty | exit 1, 0.3 s | missing (exit 127), all 7 | none |
| 6 | 2026-11-11T06:00:13Z | `254f69e60` | dirty | exit 0, 31.7 s | pass, all 7 | none |
| 7 | 2026-11-11T06:01:11Z | `85f333977` | clean | exit 0, 18.1 s | pass, all 7 | none |
| 8 | 2026-11-11T09:45:09Z | `9f07c17f9` | dirty | exit 1, 0.2 s | missing (exit 127), all 7 | none |
| 9 | 2026-11-11T12:05:41Z | `61845391f` | dirty | exit 1, 0.2 s | missing (exit 127), all 7 | none |
| 10 | 2026-11-11T12:52:47Z | `08cb1b957` | clean | exit 1, 19.7 s | `apps/web` errors (exit 1), 6 others pass | `apps/web`: `.next/dev/types/validator.ts:1160` TS2307, only bun |
| 11 | 2026-11-11T12:53:22Z | `08cb1b957` | clean | exit 0, 22.9 s | pass, all 7 | none |
| 12 | 2026-11-11T13:56:08Z | `4644160e9` | dirty | exit 1, 28.9 s | `apps/web` errors (exit 1), 6 others pass | `apps/web`: `.next/dev/types/validator.ts:1160` TS2307, only bun; `.next/types/validator.ts:1160` TS2307, only bun |
| 13 | 2026-11-11T13:56:40Z | `4644160e9` | dirty | exit 1, 17.0 s | `apps/web` errors (exit 1), 6 others pass | `apps/web`: `.next/dev/types/validator.ts:1160` TS2307, only bun; `.next/types/validator.ts:1160` TS2307, only bun |
| 14 | 2026-11-11T14:02:34Z | `5f668cf51` | clean | exit 0, 19.2 s | pass, all 7 | none |
| 15 | 2026-11-11T14:34:57Z | `8a59e1a1d` | clean | exit 0, 19.1 s | pass, all 7 | none |
| 16 | 2026-11-11T20:29:11Z | `07f78be8b` | clean | exit 1, 0.2 s | pass, all 7 | none |
| 17 | 2026-11-12T12:16:05Z | `20fbc0503` | dirty | exit 1, 0.2 s | missing (exit 127), all 7 | none |

In every mismatch, the per-package `differences` list is complete: `differences_total` equals its length.

## Timings

`tsc.wall_ms` is the whole `pnpm -r typecheck` call, packages in parallel. `bun.wall_ms` is the sum of the 7 `bun check`
runs, one after another.

| Source | Lines | tsc median | tsc max | bun check median | bun check max | Median ratio |
|---|---:|---:|---:|---:|---:|---:|
| Local, all | 69 | 18.9 s | 38.7 s | 2.2 s | 3.5 s | 8.6× |
| CI, all | 1039 | 44.6 s | 81.6 s | 5.9 s | 8.8 s | 7.6× |

tsc got faster partway through the window. Split at 2026-11-11T16:15Z, the local tsc median is 5.0 s over the 17 lines
from then on, against 22.2 s over the 52 lines before. In CI it is 67.7 s over the 564 lines before and 23.0 s over the 475 lines after.
bun check times do not show that drop. The medians in the table mix both periods. This report records the drop and does
not explain it.

## Raw lines

The counts above are rebuilt from these files only:

- [`typecheck-shadow-2026-W46.local.jsonl`](typecheck-shadow-2026-W46.local.jsonl): the 69 local lines, byte for byte as
  the shadow appended them.
- [`typecheck-shadow-2026-W46.ci.jsonl`](typecheck-shadow-2026-W46.ci.jsonl): the 1039 CI lines, the JSON after
  `typecheck-shadow ` in each `Types` log, oldest run first. Line *n* belongs to the run whose `line` is *n* in the index.
- [`typecheck-shadow-2026-W46.ci-runs.jsonl`](typecheck-shadow-2026-W46.ci-runs.jsonl): the index of all 1052 CI runs.

The lines hold commit SHAs, times, package directories, outcomes, counts and the two `.next` file paths above. They hold
no URL, path under a home directory, token or connection string.

To recount mismatches by source: `jq -r .mismatch docs/measurements/typecheck-shadow-2026-W46.local.jsonl | sort | uniq -c`,
and the same for the `.ci.jsonl` file.
