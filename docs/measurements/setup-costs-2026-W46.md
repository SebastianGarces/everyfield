# Setup costs, 2026-W46

The five largest setup costs per week, local and GitHub CI ranked together (T-103, from the T-39 timing data).
This report only reads data. It changes no script, check or CI step.

## Data window

- First local record: 2026-11-09T06:19:52.071Z
- Last local record: 2026-11-12T10:41:59.078Z
- Window length: 76.4 h (3.182 days)
- Local records: 271, in `<git common dir>/evf-setup-steps` of the main checkout, read with `node scripts/setup-step.mjs report --json` at 2026-11-12T16:29Z and again, unchanged, at 2026-11-12T16:54Z. Records written after that read are outside this window.
- CI: `node tools/ci/ci-timing.ts --last 100 --json`, read at 2026-11-12T16:41:12Z. CI runs used: 72, created 2026-11-12T06:37:19Z to 2026-11-12T10:32:41Z

### How the CI runs were chosen

- `--last 100` is the largest n ci-timing accepts, and CI ran about 18 times an hour on 2026-11-12. The oldest of the 100 runs was created at 2026-11-12T06:37:19Z, which is inside the window, so no run is dropped for starting too early. The CI sample covers only 4.1 h at the end of the window, not all of it.
- 28 runs are dropped because they started after the last local record (created 2026-11-12T11:03:08Z to 2026-11-12T16:23:35Z).
- ci-timing prints no run end time, so a run's end is estimated as its created time plus its longest job's queue, setup and run time (D-936). The newest run used was created at 2026-11-12T10:32:41Z and ends by about 2026-11-12T10:36:49Z. No run was created between 2026-11-12T10:32:41Z and 2026-11-12T11:03:08Z, so the cut does not depend on the estimate.
- Run ids used: 43201298354, 43201118459, 43200562493, 43199849051, 43198526010, 43197586233, 43197240166, 43194009081, 43193331099, 43192511747, 43192399181, 43191191184, 43190441520, 43188363075, 43187686129, 43187651673, 43186927172, 43186895763, 43186294783, 43185635252, 43184946259, 43183999248, 43183838931, 43183276804, 43183064142, 43182618508, 43182431439, 43182298903, 43181624809, 43181201076, 43181181371, 43181053568, 43180904458, 43180565044, 43180388864, 43180260923, 43180225302, 43179982620, 43179683159, 43179482272, 43179132904, 43179084577, 43178820023, 43178482203, 43178406307, 43177839624, 43177674205, 43176940239, 43176636721, 43176389191, 43176380884, 43176345891, 43175900920, 43175597235, 43173845550, 43173298786, 43172723377, 43172619288, 43172068862, 43172001350, 43171514135, 43171501476, 43171403325, 43170892332, 43170861386, 43170663737, 43170407575, 43170349022, 43170224510, 43170144612, 43169489996, 43169411331.
- A rerun of `--last 100` returns newer runs as CI keeps running. Match the runs by id against the JSON below.

## Top 5 setup costs per week

Cost per week = measured total x 7 / span in days. Local costs use the 3.182-day window. CI costs use the CI sample's own span, 2026-11-12T06:37:19Z to 2026-11-12T10:41:59.078Z (0.1699 days, D-936).

| # | Cost | Source | Count | Measured total | Per week | Cache hit rate |
|---|---|---|---|---|---|---|
| 1 | `app (lint, types, build)` | CI | 72 jobs | 44.3 min | 1826.5 min | 100% (144 hits, 0 misses) |
| 2 | `domain (census part 1)` | CI | 72 jobs | 39.2 min | 1615.7 min | 100% (144 hits, 0 misses) |
| 3 | `tooling (docs, workflow, tools, wiki)` | CI | 72 jobs | 38.6 min | 1590.3 min | 100% (144 hits, 0 misses) |
| 4 | `domain (census part 3)` | CI | 72 jobs | 29.5 min | 1216.7 min | 100% (72 hits, 0 misses) |
| 5 | `db (@everyfield/db, reference, evry)` | CI | 72 jobs | 29.3 min | 1207.8 min | 100% (72 hits, 0 misses) |

A CI hit rate counts the cache-restored and cache-not-found lines in the job logs. Local hit rates come from the setup report. "no data" means no hit or miss was recorded. It never means 0%.

The other costs, in order: `domain (census part 2)` (CI, 72 jobs, 28.9 min measured, 1190.0 min per week, hit rate 100% (72 hits, 0 misses)); `ci` (CI, 72 jobs, 10.5 min measured, 431.2 min per week, hit rate no data (0 hits, 0 misses)); `verify-preview build` (local, 49 runs, 11.3 min measured, 24.8 min per week, hit rate 0%); `stack install` (local, 123 runs, 8.2 min measured, 17.9 min per week, hit rate no data); `verify-preview install` (local, 68 runs, 7.0 min measured, 15.4 min per week, hit rate no data); `stack build` (local, 31 runs, 6.4 min measured, 14.0 min per week, hit rate 0%).

## Costs above 30 min per week

- `app (lint, types, build)` (CI): 1826.5 min per week
- `domain (census part 1)` (CI): 1615.7 min per week
- `tooling (docs, workflow, tools, wiki)` (CI): 1590.3 min per week
- `domain (census part 3)` (CI): 1216.7 min per week
- `db (@everyfield/db, reference, evry)` (CI): 1207.8 min per week
- `domain (census part 2)` (CI): 1190.0 min per week
- `ci` (CI): 431.2 min per week

None of the 4 local costs is above 30 min per week.

Every CI job pays the same per-job setup (runner start, checkout, Node, pnpm install, cache restore), about 26 s a job, and every cache it restores hits. By the owner's decision D-956 they get one grouped OPS task, not one task per job.

- OPS task for per-job CI setup: T-285 is filed with `evf task new`. Its ask names the 7 CI jobs above, their per-week figures, their hit rates and this report. It is held and owner-gated for sequencing, because it touches CI files and overlaps T-216 and T-254.
- It duplicates no open task. T-216 (drop the second CI build) and T-254 (heavy db and census jobs only on some events) change which jobs run, not the setup each job pays.

## Limits on these numbers

- The CI figures scale 4.1 h of one busy weekday to a week. They are not a measured week, and a quieter week runs fewer jobs.
- The local figures scale a 76.4-hour window to a week. They are not a measured week.
- ci-timing reads at most 100 runs, so the CI sample covers only the last 4.1 h of the window (D-936).
- CI run end times are estimated from job durations, because ci-timing prints none (D-936).
- A build counts as a hit only when `apps/web/.next/cache` already has content. Production previews always build cold (T-39 risk), and a new worktree starts with no cache, so both local build steps read 0%.
- Local install steps record no cache state (`unknown`), so their hit rate is "no data".
- The `ci` job's log has no cache lines, so its hit rate is "no data".

## Raw inputs

Setup report, `node scripts/setup-step.mjs report --json`, exact output:

```json
{
  "weeks": [
    {
      "week": "2026-W46",
      "pairs": [
        {
          "source": "verify-preview",
          "step": "build",
          "runs": 49,
          "totalMs": 677229,
          "medianMs": 10133,
          "hitRate": 0
        },
        {
          "source": "stack",
          "step": "install",
          "runs": 123,
          "totalMs": 489383,
          "medianMs": 2511,
          "hitRate": null
        },
        {
          "source": "verify-preview",
          "step": "install",
          "runs": 68,
          "totalMs": 419877,
          "medianMs": 7386,
          "hitRate": null
        },
        {
          "source": "stack",
          "step": "build",
          "runs": 31,
          "totalMs": 382594,
          "medianMs": 10177,
          "hitRate": 0
        }
      ]
    }
  ]
}
```

CI timing, `node tools/ci/ci-timing.ts --last 100 --json` read at 2026-11-12T16:41:12Z, exact output:

```json
{
  "runs": [
    {
      "id": 43258151883,
      "createdAt": "2026-11-12T16:23:35Z",
      "jobs": [
        {
          "id": 131321885821,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 117000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131321886440,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 42000,
          "runMs": 147000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131321886445,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 69000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131321886485,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 158000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131321886521,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 218000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131321886597,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 192000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131324549889,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43257258075,
      "createdAt": "2026-11-12T16:18:42Z",
      "jobs": [
        {
          "id": 131318726131,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 40000,
          "runMs": 189000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131318726499,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 210000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131318726588,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 48000,
          "runMs": 185000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131318726607,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 171000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131318726705,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 220000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131318727002,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 74000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131321464083,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43253562987,
      "createdAt": "2026-11-12T15:58:30Z",
      "jobs": [
        {
          "id": 131305633421,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 193000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131305633878,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 63000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131305634021,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 184000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131305634050,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 3000,
          "setupMs": 27000,
          "runMs": 167000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131305634084,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 128000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131305634258,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 154000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131308156667,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43248862789,
      "createdAt": "2026-11-12T15:32:17Z",
      "jobs": [
        {
          "id": 131288861258,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131288861685,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131288861687,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 228000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131288861778,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 134000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131288861781,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 157000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131288861785,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131291613326,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43248063523,
      "createdAt": "2026-11-12T15:27:54Z",
      "jobs": [
        {
          "id": 131286019514,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 138000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131286019853,
          "name": "app (lint, types, build)",
          "queueMs": 3000,
          "setupMs": 42000,
          "runMs": 162000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131286019988,
          "name": "domain (census part 2)",
          "queueMs": 3000,
          "setupMs": 27000,
          "runMs": 197000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131286020070,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131286020541,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 69000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131286020738,
          "name": "domain (census part 3)",
          "queueMs": 3000,
          "setupMs": 20000,
          "runMs": 125000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131288521127,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43247180205,
      "createdAt": "2026-11-12T15:23:01Z",
      "jobs": [
        {
          "id": 131282881655,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 161000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131282882317,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 3000,
          "setupMs": 37000,
          "runMs": 198000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131282882603,
          "name": "domain (census part 3)",
          "queueMs": 3000,
          "setupMs": 29000,
          "runMs": 189000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131282882608,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 179000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131282882618,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 60000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131282882700,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 191000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131285515532,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43244274243,
      "createdAt": "2026-11-12T15:06:54Z",
      "jobs": [
        {
          "id": 131272622106,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 144000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131272622638,
          "name": "domain (census part 2)",
          "queueMs": 4000,
          "setupMs": 22000,
          "runMs": 203000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131272622727,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 135000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131272622889,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 42000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131272622897,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 156000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131272622946,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 3000,
          "setupMs": 26000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131275067469,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43243463499,
      "createdAt": "2026-11-12T15:02:26Z",
      "jobs": [
        {
          "id": 131269782470,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131269782755,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 177000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131269782769,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 182000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131269782892,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 113000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131269782959,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 183000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131269782989,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131272081443,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43239071960,
      "createdAt": "2026-11-12T14:37:11Z",
      "jobs": [
        {
          "id": 131254233988,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 162000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131254234548,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131254234605,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 166000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131254234613,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131254234642,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 208000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131254234693,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 130000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131256681926,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43238816697,
      "createdAt": "2026-11-12T14:35:43Z",
      "jobs": [
        {
          "id": 131253332059,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 29000,
          "runMs": 160000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131253332093,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 141000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131253332135,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 136000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131253332149,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 227000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131253332392,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 40000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131253333072,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 194000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131255986022,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43237868106,
      "createdAt": "2026-11-12T14:30:22Z",
      "jobs": [
        {
          "id": 131250019649,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 158000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131250019671,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 124000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131250019728,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 189000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131250019779,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 191000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131250019798,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131250019799,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 231000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131252758783,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43232040833,
      "createdAt": "2026-11-12T13:55:59Z",
      "jobs": [
        {
          "id": 131229581448,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 176000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131229581809,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131229582014,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 171000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131229582027,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 42000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131229582059,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 147000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131229582193,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 197000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131231679762,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 7000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43231323881,
      "createdAt": "2026-11-12T13:51:32Z",
      "jobs": [
        {
          "id": 131227075421,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131227075753,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 151000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131227075867,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 129000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131227075895,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 188000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131227075924,
          "name": "app (lint, types, build)",
          "queueMs": 3000,
          "setupMs": 31000,
          "runMs": 166000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131227076020,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 125000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131229115100,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 11000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43230544364,
      "createdAt": "2026-11-12T13:46:43Z",
      "jobs": [
        {
          "id": 131224378914,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 207000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131224379270,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 44000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131224379364,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 210000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131224379395,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 108000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131224379479,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 213000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131224379511,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 171000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131226686443,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43228526188,
      "createdAt": "2026-11-12T13:34:03Z",
      "jobs": [
        {
          "id": 131217915109,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 183000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131217915417,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 195000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131217915450,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 81000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131217915517,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131217915797,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 280000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131217916042,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 173000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131220136153,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43227786540,
      "createdAt": "2026-11-12T13:29:32Z",
      "jobs": [
        {
          "id": 131215401099,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 216000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131215401360,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 138000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131215401386,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 45000,
          "runMs": 187000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131215401526,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131215401552,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 29000,
          "runMs": 67000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131215401636,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 177000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131217666573,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43227117880,
      "createdAt": "2026-11-12T13:25:12Z",
      "jobs": [
        {
          "id": 131213030506,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 160000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131213030883,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 193000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131213030917,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131213030996,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 146000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131213031018,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 72000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131213031120,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 220000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131215336873,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43226511206,
      "createdAt": "2026-11-12T13:21:29Z",
      "jobs": [
        {
          "id": 131210964221,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 32000,
          "runMs": 165000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131210964725,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 217000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131210964859,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 150000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131210964876,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131210964963,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 165000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131210965295,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 142000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131213243854,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43226093015,
      "createdAt": "2026-11-12T13:18:50Z",
      "jobs": [
        {
          "id": 131209542951,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 156000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131209543442,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 36000,
          "runMs": 123000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131209543549,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 137000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131209543557,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 178000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131209543709,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 41000,
          "runMs": 71000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131209543821,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 235000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131211963166,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43221160305,
      "createdAt": "2026-11-12T12:47:35Z",
      "jobs": [
        {
          "id": 131197017633,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131197018121,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 177000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131197019714,
          "name": "app (lint, types, build)",
          "queueMs": null,
          "setupMs": 37000,
          "runMs": 134000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131197022775,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": null,
          "setupMs": 29000,
          "runMs": 133000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131197080187,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": null,
          "setupMs": 24000,
          "runMs": 149000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131197090553,
          "name": "domain (census part 1)",
          "queueMs": null,
          "setupMs": 34000,
          "runMs": 71000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131198870517,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 1000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43219922761,
      "createdAt": "2026-11-12T12:39:35Z",
      "jobs": [
        {
          "id": 131188531368,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 199000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131188531604,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 65000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131188531630,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 124000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131188531667,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 153000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131188531691,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 143000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131188531838,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 183000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131190523404,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 11000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43219011509,
      "createdAt": "2026-11-12T12:33:40Z",
      "jobs": [
        {
          "id": 131185457363,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 39000,
          "runMs": 179000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131185457595,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 157000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131185457879,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 161000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131185457923,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 176000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131185457926,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 23000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131185457949,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 38000,
          "runMs": 61000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131187400315,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 11000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43209700752,
      "createdAt": "2026-11-12T11:30:16Z",
      "jobs": [
        {
          "id": 131153861243,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 177000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131153861557,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 3000,
          "setupMs": 25000,
          "runMs": 158000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131153861573,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 205000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131153861605,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 195000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131153861732,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 178000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131153861775,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 59000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131155798064,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43208995363,
      "createdAt": "2026-11-12T11:25:12Z",
      "jobs": [
        {
          "id": 131151357046,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 146000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131151357426,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 218000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131151357448,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 196000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131151357453,
          "name": "app (lint, types, build)",
          "queueMs": 3000,
          "setupMs": 37000,
          "runMs": 139000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131151357521,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131151357543,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131153410704,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43208771639,
      "createdAt": "2026-11-12T11:23:41Z",
      "jobs": [
        {
          "id": 131150595908,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 171000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131150596251,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 60000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131150596272,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 157000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131150596313,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 137000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131150596374,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 237000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131150596491,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 35000,
          "runMs": 154000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131152826893,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43208293500,
      "createdAt": "2026-11-12T11:20:25Z",
      "jobs": [
        {
          "id": 131148976876,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131148977082,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 190000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131148977182,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 170000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131148977194,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131148977309,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 179000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131148977409,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 147000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131150888450,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43208081151,
      "createdAt": "2026-11-12T11:18:58Z",
      "jobs": [
        {
          "id": 131148255545,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 125000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131148256039,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 199000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131148256080,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 45000,
          "runMs": 174000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131148256089,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 50000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131148256157,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 186000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131148256214,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 162000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131150161076,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43205735914,
      "createdAt": "2026-11-12T11:03:08Z",
      "jobs": [
        {
          "id": 131140298481,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 150000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131140298876,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 194000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131140298930,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 48000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131140298981,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 50000,
          "runMs": 169000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131140299080,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 198000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131140299084,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 202000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131142353800,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43201298354,
      "createdAt": "2026-11-12T10:32:41Z",
      "jobs": [
        {
          "id": 131125110242,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 7000,
          "setupMs": 21000,
          "runMs": 126000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131125110540,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 41000,
          "runMs": 113000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131125110670,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131125110744,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131125110776,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131125110835,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 223000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131127230599,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43201118459,
      "createdAt": "2026-11-12T10:31:27Z",
      "jobs": [
        {
          "id": 131131049933,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 196000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131131051314,
          "name": "domain (census part 1)",
          "queueMs": null,
          "setupMs": 37000,
          "runMs": 63000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131131052240,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": null,
          "setupMs": 31000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131131052346,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": null,
          "setupMs": 26000,
          "runMs": 152000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131131109188,
          "name": "app (lint, types, build)",
          "queueMs": null,
          "setupMs": 35000,
          "runMs": 108000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131131134150,
          "name": "domain (census part 2)",
          "queueMs": null,
          "setupMs": 27000,
          "runMs": 175000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131132948387,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 2000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43200562493,
      "createdAt": "2026-11-12T10:27:39Z",
      "jobs": [
        {
          "id": 131122565591,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 106000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131122566102,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 190000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131122566120,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 42000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131122566210,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 233000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131122566240,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131122566475,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 181000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131124832095,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43199849051,
      "createdAt": "2026-11-12T10:22:52Z",
      "jobs": [
        {
          "id": 131120088937,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 167000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131120089228,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 52000,
          "runMs": 133000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131120089397,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 4000,
          "setupMs": 26000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131120089402,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131120089478,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 148000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131120089484,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 155000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131121861795,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43198526010,
      "createdAt": "2026-11-12T10:14:03Z",
      "jobs": [
        {
          "id": 131115590004,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 138000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131115590263,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 57000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131115590285,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 178000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131115590385,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 159000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131115590527,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 210000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131115590587,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 157000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131117626190,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 11000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43197586233,
      "createdAt": "2026-11-12T10:07:46Z",
      "jobs": [
        {
          "id": 131112389140,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 130000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131112389228,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 137000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131112389239,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 151000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131112389274,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 180000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131112389304,
          "name": "app (lint, types, build)",
          "queueMs": 3000,
          "setupMs": 44000,
          "runMs": 137000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131112389388,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131114224615,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43197240166,
      "createdAt": "2026-11-12T10:05:29Z",
      "jobs": [
        {
          "id": 131114725979,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 229000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131114727104,
          "name": "domain (census part 2)",
          "queueMs": null,
          "setupMs": 21000,
          "runMs": 134000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131114727731,
          "name": "domain (census part 1)",
          "queueMs": null,
          "setupMs": 30000,
          "runMs": 58000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131114728043,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": null,
          "setupMs": 22000,
          "runMs": 118000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131114728641,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": null,
          "setupMs": 31000,
          "runMs": 138000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131114801791,
          "name": "app (lint, types, build)",
          "queueMs": null,
          "setupMs": 36000,
          "runMs": 115000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131116928736,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 2000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43194009081,
      "createdAt": "2026-11-12T09:43:38Z",
      "jobs": [
        {
          "id": 131100178605,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 177000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131100178986,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131100179054,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 149000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131100179055,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 182000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131100179058,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 207000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131100179254,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 61000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131102159716,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43193331099,
      "createdAt": "2026-11-12T09:39:04Z",
      "jobs": [
        {
          "id": 131097889483,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 190000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131097889742,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131097889774,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131097889793,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 183000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131097889832,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 111000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131097889992,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 32000,
          "runMs": 48000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131099868683,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43192511747,
      "createdAt": "2026-11-12T09:33:35Z",
      "jobs": [
        {
          "id": 131095107381,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 3000,
          "setupMs": 35000,
          "runMs": 180000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131095112780,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 215000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131095113116,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 159000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131095115970,
          "name": "domain (census part 2)",
          "queueMs": 3000,
          "setupMs": 25000,
          "runMs": 122000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131095122238,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 121000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131095123336,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 63000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131097203317,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43192399181,
      "createdAt": "2026-11-12T09:32:44Z",
      "jobs": [
        {
          "id": 131098217422,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 7000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        },
        {
          "id": 131098218784,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": null,
          "setupMs": 27000,
          "runMs": 154000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131098219450,
          "name": "domain (census part 3)",
          "queueMs": null,
          "setupMs": 39000,
          "runMs": 191000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131098274155,
          "name": "app (lint, types, build)",
          "queueMs": null,
          "setupMs": 39000,
          "runMs": 168000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131098284986,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": null,
          "setupMs": 30000,
          "runMs": 139000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131098287418,
          "name": "domain (census part 2)",
          "queueMs": null,
          "setupMs": 28000,
          "runMs": 209000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131098289130,
          "name": "domain (census part 1)",
          "queueMs": null,
          "setupMs": 28000,
          "runMs": 62000,
          "cacheHits": 2,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43191191184,
      "createdAt": "2026-11-12T09:24:29Z",
      "jobs": [
        {
          "id": 131093532951,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 212000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131093534347,
          "name": "domain (census part 1)",
          "queueMs": null,
          "setupMs": 59000,
          "runMs": 65000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131093534695,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": null,
          "setupMs": 23000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131093535691,
          "name": "domain (census part 2)",
          "queueMs": null,
          "setupMs": 22000,
          "runMs": 148000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131093599398,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": null,
          "setupMs": 39000,
          "runMs": 193000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131093603977,
          "name": "app (lint, types, build)",
          "queueMs": null,
          "setupMs": 33000,
          "runMs": 157000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131095467105,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43190441520,
      "createdAt": "2026-11-12T09:19:27Z",
      "jobs": [
        {
          "id": 131088089124,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 30000,
          "runMs": 143000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131088089392,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131088089656,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 152000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131088089749,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 34000,
          "runMs": 64000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131088089791,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 219000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131088090381,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 129000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131090213405,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43188363075,
      "createdAt": "2026-11-12T09:05:27Z",
      "jobs": [
        {
          "id": 131081126151,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 121000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131081126484,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 175000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131081126565,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 209000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131081126747,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 36000,
          "runMs": 56000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131081126858,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 38000,
          "runMs": 190000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131081126907,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 178000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131083122014,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43187686129,
      "createdAt": "2026-11-12T09:00:47Z",
      "jobs": [
        {
          "id": 131078874787,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 176000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131078874891,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 144000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131078874947,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 52000,
          "runMs": 69000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131078875006,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 234000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131078875076,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 45000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131078875101,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 179000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131081026794,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 13000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43187651673,
      "createdAt": "2026-11-12T09:00:34Z",
      "jobs": [
        {
          "id": 131078763384,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 146000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131078763726,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 53000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131078763850,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 216000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131078763942,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 114000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131078764125,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 133000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131078764287,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 132000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131080726134,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43186927172,
      "createdAt": "2026-11-12T08:55:19Z",
      "jobs": [
        {
          "id": 131076291730,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 102000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131076291972,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 188000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131076292012,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 173000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131076292070,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 164000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131076292113,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 147000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131076292151,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 30000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131077997995,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43186895763,
      "createdAt": "2026-11-12T08:55:07Z",
      "jobs": [
        {
          "id": 131076190111,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 160000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131076190368,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 133000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131076190404,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 235000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131076190413,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 62000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131076190480,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 111000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131076190715,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 176000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131078234310,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43186294783,
      "createdAt": "2026-11-12T08:50:46Z",
      "jobs": [
        {
          "id": 131074165823,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 157000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131074166088,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 140000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131074166149,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 134000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131074166280,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 114000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131074166342,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 187000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131074166364,
          "name": "domain (census part 1)",
          "queueMs": 3000,
          "setupMs": 39000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131075855263,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43185635252,
      "createdAt": "2026-11-12T08:45:58Z",
      "jobs": [
        {
          "id": 131071964984,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 167000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131071965139,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 163000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131071965146,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 191000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131071965149,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 161000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131071965173,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 220000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131071965220,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 49000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131073903497,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43184946259,
      "createdAt": "2026-11-12T08:40:55Z",
      "jobs": [
        {
          "id": 131069686299,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 155000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131069686486,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131069686511,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 37000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131069686572,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 158000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131069686592,
          "name": "app (lint, types, build)",
          "queueMs": 3000,
          "setupMs": 42000,
          "runMs": 205000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131069686593,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 130000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131071581522,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43183999248,
      "createdAt": "2026-11-12T08:34:02Z",
      "jobs": [
        {
          "id": 131066582649,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 146000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131066582943,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 159000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131066582969,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 198000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066582984,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 43000,
          "runMs": 172000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066582999,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 50000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066583037,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 141000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131068346504,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 7000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43183838931,
      "createdAt": "2026-11-12T08:32:52Z",
      "jobs": [
        {
          "id": 131066057355,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 30000,
          "runMs": 127000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066057555,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066057709,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 131000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131066057714,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 158000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066057736,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 220000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131066057754,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 167000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131067960884,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43183276804,
      "createdAt": "2026-11-12T08:28:51Z",
      "jobs": [
        {
          "id": 131064208913,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 165000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131064209227,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 229000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131064209283,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 44000,
          "runMs": 178000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131064209294,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131064209314,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 65000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131064209326,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 131000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131066217338,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43183064142,
      "createdAt": "2026-11-12T08:27:19Z",
      "jobs": [
        {
          "id": 131063510223,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131063510464,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 47000,
          "runMs": 191000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131063510489,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 157000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131063510495,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 188000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131063510632,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 72000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131063510682,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 173000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131065379531,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43182618508,
      "createdAt": "2026-11-12T08:24:03Z",
      "jobs": [
        {
          "id": 131062039033,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 120000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131062039445,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 138000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131062039527,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 161000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131062039550,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131062039616,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 199000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131062039677,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 54000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131063731002,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43182431439,
      "createdAt": "2026-11-12T08:22:41Z",
      "jobs": [
        {
          "id": 131061412400,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131061412567,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 175000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131061412631,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 157000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131061412698,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 157000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131061412732,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 174000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131061412783,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 55000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131063165719,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43182298903,
      "createdAt": "2026-11-12T08:21:42Z",
      "jobs": [
        {
          "id": 131060975076,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 32000,
          "runMs": 161000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131060975254,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 29000,
          "runMs": 130000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131060975289,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 123000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131060975346,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131060975396,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 234000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131060975419,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131062991514,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43181624809,
      "createdAt": "2026-11-12T08:16:43Z",
      "jobs": [
        {
          "id": 131058731749,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 106000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131058731858,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 151000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131058731875,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131058731994,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 191000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131058731997,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131058732099,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 221000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131060645045,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43181201076,
      "createdAt": "2026-11-12T08:13:37Z",
      "jobs": [
        {
          "id": 131057334319,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 196000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131057334530,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 3000,
          "setupMs": 26000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131057334601,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 180000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131057334656,
          "name": "domain (census part 1)",
          "queueMs": 6000,
          "setupMs": 31000,
          "runMs": 55000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131057334681,
          "name": "domain (census part 3)",
          "queueMs": 71000,
          "setupMs": 20000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131057334730,
          "name": "app (lint, types, build)",
          "queueMs": 19000,
          "setupMs": 32000,
          "runMs": 134000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131059127071,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43181181371,
      "createdAt": "2026-11-12T08:13:28Z",
      "jobs": [
        {
          "id": 131057267203,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 41000,
          "runMs": 176000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131057267536,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 208000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131057267549,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 35000,
          "runMs": 69000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131057267628,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 132000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131057267747,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131057267931,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 152000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131059052737,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43181053568,
      "createdAt": "2026-11-12T08:12:29Z",
      "jobs": [
        {
          "id": 131056836761,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 130000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131056836770,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 163000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131056836783,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 193000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131056836792,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 180000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131056836999,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 166000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131056837015,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 41000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131058479322,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43180904458,
      "createdAt": "2026-11-12T08:11:22Z",
      "jobs": [
        {
          "id": 131056339887,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 48000,
          "runMs": 153000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131056340140,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 128000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131056340187,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 177000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131056340233,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 3000,
          "setupMs": 35000,
          "runMs": 191000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131056340289,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 43000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131056340301,
          "name": "domain (census part 3)",
          "queueMs": 3000,
          "setupMs": 27000,
          "runMs": 229000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131058296957,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 7000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43180565044,
      "createdAt": "2026-11-12T08:08:47Z",
      "jobs": [
        {
          "id": 131055211530,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 163000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131055211757,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 232000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131055211771,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 193000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131055211783,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 9000,
          "setupMs": 24000,
          "runMs": 173000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131055211813,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 48000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131055211861,
          "name": "domain (census part 2)",
          "queueMs": 6000,
          "setupMs": 21000,
          "runMs": 118000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131057116904,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43180388864,
      "createdAt": "2026-11-12T08:07:30Z",
      "jobs": [
        {
          "id": 131054640209,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 141000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054640506,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 165000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054640608,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 194000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054640637,
          "name": "domain (census part 3)",
          "queueMs": 8000,
          "setupMs": 24000,
          "runMs": 192000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054640757,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 51000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054640825,
          "name": "domain (census part 2)",
          "queueMs": 3000,
          "setupMs": 27000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131056315744,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43180260923,
      "createdAt": "2026-11-12T08:06:32Z",
      "jobs": [
        {
          "id": 131054227110,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 35000,
          "runMs": 163000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054227360,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 144000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054227575,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 226000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054227642,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 50000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054227727,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054228041,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 203000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131056103457,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43180225302,
      "createdAt": "2026-11-12T08:06:16Z",
      "jobs": [
        {
          "id": 131054111625,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 126000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054111870,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 128000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054111884,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054111904,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054112104,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 220000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054112136,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131055937217,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43179982620,
      "createdAt": "2026-11-12T08:04:27Z",
      "jobs": [
        {
          "id": 131053325204,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 173000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131053325478,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 148000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131053325508,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 133000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131053325614,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 194000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131053325627,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 196000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131053325643,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 49000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131054997561,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43179683159,
      "createdAt": "2026-11-12T08:02:08Z",
      "jobs": [
        {
          "id": 131052349190,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131052349466,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131052349706,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 196000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131052349752,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131052349759,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 146000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131052349787,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 173000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131054000422,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 11000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43179482272,
      "createdAt": "2026-11-12T08:00:39Z",
      "jobs": [
        {
          "id": 131051682814,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 142000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131051683051,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131051683146,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 235000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131051683257,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 111000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131051683278,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 43000,
          "runMs": 180000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131051683297,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 124000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131053572210,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43179132904,
      "createdAt": "2026-11-12T07:57:50Z",
      "jobs": [
        {
          "id": 131050533002,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 127000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050533234,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 156000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131050533314,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050533373,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 43000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131050533412,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 171000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050533444,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 141000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131051998177,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43179084577,
      "createdAt": "2026-11-12T07:57:25Z",
      "jobs": [
        {
          "id": 131050370785,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 135000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131050371004,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 144000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050371068,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 156000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050371073,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 186000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050371162,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 50000,
          "runMs": 168000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131050371279,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 41000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131051927187,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43178820023,
      "createdAt": "2026-11-12T07:55:13Z",
      "jobs": [
        {
          "id": 131049493759,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 199000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131049494113,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 37000,
          "runMs": 173000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131049494158,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 43000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131049494223,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 127000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131049494249,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 142000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131049494348,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 140000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131051081552,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43178482203,
      "createdAt": "2026-11-12T07:52:29Z",
      "jobs": [
        {
          "id": 131048388735,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 169000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131048388977,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 23000,
          "runMs": 136000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131048388979,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131048389062,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131048389091,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131048389201,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131050010243,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43178406307,
      "createdAt": "2026-11-12T07:51:53Z",
      "jobs": [
        {
          "id": 131048143504,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 203000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131048143788,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131048143790,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 198000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131048143809,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131048143844,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 176000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131048143986,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 162000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131049729534,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43177839624,
      "createdAt": "2026-11-12T07:47:17Z",
      "jobs": [
        {
          "id": 131046298289,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 147000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131046298583,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 194000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131046298589,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 157000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131046298630,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 133000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131046298656,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 45000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131046298675,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 113000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131047795006,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43177674205,
      "createdAt": "2026-11-12T07:45:57Z",
      "jobs": [
        {
          "id": 131045764348,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 160000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131045764581,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 158000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131045764590,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 164000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131045764651,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 57000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131045764660,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 195000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131045764777,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 183000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131047307764,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43176940239,
      "createdAt": "2026-11-12T07:40:02Z",
      "jobs": [
        {
          "id": 131043379567,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 107000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131043379591,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 119000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131043379605,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 177000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131043379633,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 47000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131043379638,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 189000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131043379658,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 129000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131044857796,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43176636721,
      "createdAt": "2026-11-12T07:37:29Z",
      "jobs": [
        {
          "id": 131042340960,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 36000,
          "runMs": 194000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131042341259,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 48000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131042341277,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 134000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131042341288,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 187000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131042341309,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 36000,
          "runMs": 111000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131042341388,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 6000,
          "setupMs": 24000,
          "runMs": 164000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131043935046,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43176389191,
      "createdAt": "2026-11-12T07:35:29Z",
      "jobs": [
        {
          "id": 131041528402,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041528547,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 42000,
          "runMs": 146000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041528584,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 185000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041528599,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 74000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041528647,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 166000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041528668,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 185000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131043003324,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 7000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43176380884,
      "createdAt": "2026-11-12T07:35:25Z",
      "jobs": [
        {
          "id": 131041501916,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 33000,
          "runMs": 131000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041502132,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 20000,
          "runMs": 131000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041502146,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041502202,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 33000,
          "runMs": 192000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041502315,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 138000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041502395,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 42000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131043068209,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43176345891,
      "createdAt": "2026-11-12T07:35:09Z",
      "jobs": [
        {
          "id": 131041393548,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 130000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041393695,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041393740,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 181000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041393767,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 20000,
          "runMs": 120000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131041393833,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 44000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041394127,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 204000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131043022233,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43175900920,
      "createdAt": "2026-11-12T07:31:36Z",
      "jobs": [
        {
          "id": 131039958808,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 45000,
          "runMs": 181000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131039958932,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 131000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131039958966,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 204000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131039958997,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 43000,
          "runMs": 58000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131039959023,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 167000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131039959184,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 194000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131041587959,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43175597235,
      "createdAt": "2026-11-12T07:29:11Z",
      "jobs": [
        {
          "id": 131038992452,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 171000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131038992642,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 54000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131038992773,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 3000,
          "setupMs": 28000,
          "runMs": 127000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131038992774,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 184000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131038992798,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 173000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131038992873,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 190000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131040572768,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43173845550,
      "createdAt": "2026-11-12T07:14:54Z",
      "jobs": [
        {
          "id": 131033241409,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 46000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131033241430,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 164000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131033241496,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 198000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131033241538,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 20000,
          "runMs": 132000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131033241593,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 153000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131033241942,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 162000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131034735125,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 7000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43173298786,
      "createdAt": "2026-11-12T07:10:23Z",
      "jobs": [
        {
          "id": 131031462320,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 153000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131031462485,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 184000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131031462511,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 42000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131031462619,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131031462712,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 163000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131031462713,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 203000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131032997951,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43172723377,
      "createdAt": "2026-11-12T07:05:40Z",
      "jobs": [
        {
          "id": 131029585613,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 120000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131029586070,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 126000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131029586083,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 137000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131029586125,
          "name": "domain (census part 3)",
          "queueMs": 3000,
          "setupMs": 25000,
          "runMs": 180000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131029586141,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 145000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131029586164,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 68000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131030989050,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 10000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43172619288,
      "createdAt": "2026-11-12T07:04:51Z",
      "jobs": [
        {
          "id": 131029259371,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 67000,
          "runMs": 177000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131029259602,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 160000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131029259642,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 50000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131029259675,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 195000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131029259759,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 137000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131029259765,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 200000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131030911158,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43172068862,
      "createdAt": "2026-11-12T07:00:20Z",
      "jobs": [
        {
          "id": 131027493330,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 162000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027493664,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 161000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131027493701,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 182000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131027493707,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 37000,
          "runMs": 109000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027493713,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 29000,
          "runMs": 55000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027493760,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 143000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131028900635,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43172001350,
      "createdAt": "2026-11-12T06:59:47Z",
      "jobs": [
        {
          "id": 131027290222,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 192000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027290481,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 155000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131027290620,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 110000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027290662,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 175000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131027290678,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 28000,
          "runMs": 56000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027290694,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 198000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131028792200,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43171514135,
      "createdAt": "2026-11-12T06:55:21Z",
      "jobs": [
        {
          "id": 131025668774,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 43000,
          "runMs": 198000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025668935,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 207000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025668984,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 148000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025669097,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025669142,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 133000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025669248,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 29000,
          "runMs": 82000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027174831,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43171501476,
      "createdAt": "2026-11-12T06:55:15Z",
      "jobs": [
        {
          "id": 131025626906,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025627093,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 135000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025627175,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025627176,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 130000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025627227,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025627282,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 56000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131027060414,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 11000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43171403325,
      "createdAt": "2026-11-12T06:54:25Z",
      "jobs": [
        {
          "id": 131025312411,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 199000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025312623,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 43000,
          "runMs": 170000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025312624,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 32000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025312647,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 31000,
          "runMs": 51000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025312690,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 153000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025312773,
          "name": "domain (census part 3)",
          "queueMs": 7000,
          "setupMs": 24000,
          "runMs": 179000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131026762267,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170892332,
      "createdAt": "2026-11-12T06:49:58Z",
      "jobs": [
        {
          "id": 131023656183,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 149000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023656431,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 56000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131023656490,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 146000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023656492,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 152000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023656574,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 192000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131023656577,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 30000,
          "runMs": 123000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131025095636,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170861386,
      "createdAt": "2026-11-12T06:49:42Z",
      "jobs": [
        {
          "id": 131023558177,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 33000,
          "runMs": 197000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131023558282,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 74000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131023558336,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 41000,
          "runMs": 190000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131023558385,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 172000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023558388,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023558395,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 156000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131025024534,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170663737,
      "createdAt": "2026-11-12T06:47:57Z",
      "jobs": [
        {
          "id": 131022902708,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 39000,
          "runMs": 160000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022902988,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 23000,
          "runMs": 186000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131022902996,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 33000,
          "runMs": 195000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022903012,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 26000,
          "runMs": 63000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022903025,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 140000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131022903182,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131024358879,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170407575,
      "createdAt": "2026-11-12T06:45:44Z",
      "jobs": [
        {
          "id": 131022043904,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 25000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131022044060,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 136000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022044118,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 36000,
          "setupMs": 36000,
          "runMs": 160000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022044134,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 23000,
          "runMs": 174000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131022044192,
          "name": "domain (census part 1)",
          "queueMs": 46000,
          "setupMs": 36000,
          "runMs": 67000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022044227,
          "name": "domain (census part 3)",
          "queueMs": 60000,
          "setupMs": 27000,
          "runMs": 202000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023909836,
          "name": "ci",
          "queueMs": 3000,
          "setupMs": 9000,
          "runMs": 2000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170349022,
      "createdAt": "2026-11-12T06:45:15Z",
      "jobs": [
        {
          "id": 131021865150,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 37000,
          "runMs": 194000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021865409,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 27000,
          "runMs": 56000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021865452,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 171000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021865460,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 38000,
          "runMs": 136000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021865478,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 21000,
          "runMs": 135000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021865556,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 204000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131023372648,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 9000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170224510,
      "createdAt": "2026-11-12T06:44:12Z",
      "jobs": [
        {
          "id": 131021473084,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 36000,
          "runMs": 199000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021473225,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 27000,
          "runMs": 203000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021473235,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 31000,
          "runMs": 195000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021473273,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021473292,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 22000,
          "runMs": 147000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021473798,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 34000,
          "runMs": 85000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022994770,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43170144612,
      "createdAt": "2026-11-12T06:43:32Z",
      "jobs": [
        {
          "id": 131021216014,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 46000,
          "runMs": 173000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021216222,
          "name": "domain (census part 1)",
          "queueMs": 1000,
          "setupMs": 32000,
          "runMs": 65000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131021216243,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 22000,
          "runMs": 148000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021216251,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 182000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021216257,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 26000,
          "runMs": 169000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131021216315,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 36000,
          "runMs": 187000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131022666797,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 9000,
          "runMs": 0,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43169489996,
      "createdAt": "2026-11-12T06:38:00Z",
      "jobs": [
        {
          "id": 131019070842,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 129000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131019071107,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 30000,
          "runMs": 59000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131019071151,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 2000,
          "setupMs": 29000,
          "runMs": 132000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131019071193,
          "name": "domain (census part 3)",
          "queueMs": 2000,
          "setupMs": 21000,
          "runMs": 149000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131019071239,
          "name": "domain (census part 2)",
          "queueMs": 2000,
          "setupMs": 24000,
          "runMs": 151000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131019071367,
          "name": "app (lint, types, build)",
          "queueMs": 2000,
          "setupMs": 38000,
          "runMs": 141000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131020277604,
          "name": "ci",
          "queueMs": 2000,
          "setupMs": 13000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    },
    {
      "id": 43169411331,
      "createdAt": "2026-11-12T06:37:19Z",
      "jobs": [
        {
          "id": 131018804752,
          "name": "db (@everyfield/db, reference, evry)",
          "queueMs": 4000,
          "setupMs": 28000,
          "runMs": 170000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131018805025,
          "name": "domain (census part 1)",
          "queueMs": 2000,
          "setupMs": 35000,
          "runMs": 58000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131018805159,
          "name": "app (lint, types, build)",
          "queueMs": 1000,
          "setupMs": 34000,
          "runMs": 143000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131018805169,
          "name": "domain (census part 2)",
          "queueMs": 1000,
          "setupMs": 25000,
          "runMs": 162000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131018805245,
          "name": "domain (census part 3)",
          "queueMs": 1000,
          "setupMs": 24000,
          "runMs": 192000,
          "cacheHits": 1,
          "cacheMisses": 0
        },
        {
          "id": 131018805391,
          "name": "tooling (docs, workflow, tools, wiki)",
          "queueMs": 1000,
          "setupMs": 28000,
          "runMs": 158000,
          "cacheHits": 2,
          "cacheMisses": 0
        },
        {
          "id": 131020242888,
          "name": "ci",
          "queueMs": 1000,
          "setupMs": 8000,
          "runMs": 1000,
          "cacheHits": 0,
          "cacheMisses": 0
        }
      ]
    }
  ],
  "totals": [
    {
      "name": "app (lint, types, build)",
      "jobs": 100,
      "queueMs": 190000,
      "setupMs": 3719000,
      "runMs": 15128000,
      "cacheHits": 200,
      "cacheMisses": 0
    },
    {
      "name": "domain (census part 1)",
      "jobs": 100,
      "queueMs": 220000,
      "setupMs": 3290000,
      "runMs": 5471000,
      "cacheHits": 200,
      "cacheMisses": 0
    },
    {
      "name": "tooling (docs, workflow, tools, wiki)",
      "jobs": 100,
      "queueMs": 208000,
      "setupMs": 3254000,
      "runMs": 17016000,
      "cacheHits": 200,
      "cacheMisses": 0
    },
    {
      "name": "domain (census part 3)",
      "jobs": 100,
      "queueMs": 319000,
      "setupMs": 2468000,
      "runMs": 18877000,
      "cacheHits": 100,
      "cacheMisses": 0
    },
    {
      "name": "db (@everyfield/db, reference, evry)",
      "jobs": 100,
      "queueMs": 198000,
      "setupMs": 2444000,
      "runMs": 15309000,
      "cacheHits": 100,
      "cacheMisses": 0
    },
    {
      "name": "domain (census part 2)",
      "jobs": 100,
      "queueMs": 178000,
      "setupMs": 2412000,
      "runMs": 17036000,
      "cacheHits": 100,
      "cacheMisses": 0
    },
    {
      "name": "ci",
      "jobs": 100,
      "queueMs": 189000,
      "setupMs": 869000,
      "runMs": 108000,
      "cacheHits": 0,
      "cacheMisses": 0
    }
  ]
}
```
