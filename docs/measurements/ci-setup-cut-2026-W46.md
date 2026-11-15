# CI setup cut, 2026-W46

The per-job setup cut for the 7 jobs of `.github/workflows/ci.yml` (T-285), measured against
`setup-costs-2026-W46.md` (T-103). Setup is what `node tools/ci/ci-timing.ts` counts as setup: its `SETUP_STEPS` list.
No CI spending: every job stays on `ubuntu-24.04`, and the caches are GitHub's own Actions cache.

## The cuts

Every job now runs one shared setup step, `.github/actions/setup` (step name `Shared setup (...)`), instead of
`actions/setup-node`, `corepack-install.sh`, a second `actions/setup-node` for the pnpm store, and `pnpm install`.

| # | Cut | Jobs |
|---|---|---|
| 1 | No second `actions/setup-node` call. The first one ran only to put Node on PATH, the second only to restore the pnpm store. | app, tooling, db, census parts 1 to 3 |
| 2 | Node comes back from a cache of the runner's tool cache folder (`node-...` or `node-corepack-...` key on the Node version), so setup-node finds it instead of downloading it, unpacking it and copying it into the tool cache. | all 7 |
| 3 | corepack's home comes back in the same cache (key on `packageManager`), and `corepack-install.sh` first runs `corepack install -g` with `COREPACK_ENABLE_NETWORK=0`, so pnpm reaches PATH with no registry request. On a miss it prints that and runs the old registry retries. | app, tooling, db, census parts 1 to 3 |
| 4 | node_modules comes back from a cache keyed on the lockfiles, `pnpm-workspace.yaml`, Node and pnpm, in place of the pnpm store. `pnpm install --frozen-lockfile` still runs and still checks it against the lockfile; on a hit it prints "Already up to date" instead of linking 802 packages and running bun's postinstall. A miss installs from the registry and saves the cache straight after the install, before any test step. | app, tooling (with `tools/wiki/node_modules`), db, census parts 1 to 3 |

The `ci` job keeps checkout and Node: its one test reads the repository and runs on Node 24. It runs no pnpm, so it uses
the action with `install: "false"`.

### Why this install is safe

- `--frozen-lockfile` stays. pnpm compares the restored `node_modules/.modules.yaml` and `node_modules/.pnpm/lock.yaml`
  with the lockfile and relinks anything that differs, so a stale cache cannot pass unnoticed.
- The key holds every input that changes node_modules: both lockfiles where used, `pnpm-workspace.yaml` (its
  `onlyBuiltDependencies` decides which postinstalls run), the exact Node version and the exact pnpm version.
- The cache is saved right after the install, not at job end, so no test output reaches it. Tooling saves after its
  wiki tool install, the one step that adds to node_modules, and leaves `node_modules/.cache` out.
- Checked locally on 2026-11-14 with this lockfile: `pnpm install --frozen-lockfile --offline` over a restored copy of
  node_modules, with an empty store at the recorded store path, prints "Already up to date" in 2 s and makes no
  network request. The node_modules archive (zstd) is 246 MB against 276 MB for the store it replaces.

## Before

W46 medians are over the 72 runs of `setup-costs-2026-W46.md`, read from its raw JSON. Current main medians are over
the last 20 completed CI runs read with `node tools/ci/ci-timing.ts --last 20 --json` at 2026-11-15T00:20Z (runs
43643468952 to 43656360389, all 7 jobs each). T-216 moved the production build and its Next cache from app to census
part 1 after W46, so app's setup fell and part 1's rose, and two jobs were renamed. Rows match jobs by role.

| Job (now) | W46 name | W46 median setup | Current main median setup |
|---|---|---|---|
| app (lint, types, logs, unit) | app (lint, types, build) | 36.0 s | 24.0 s |
| tooling (docs, workflow, tools, wiki) | same | 31.0 s | 35.5 s |
| db (@everyfield/db, evry) | db (@everyfield/db, reference, evry) | 24.0 s | 24.5 s |
| domain (census part 1) | same | 31.0 s | 35.0 s |
| domain (census part 2) | same | 24.0 s | 24.0 s |
| domain (census part 3) | same | 25.0 s | 26.0 s |
| ci | same | 9.0 s | 9.0 s |
| Per-run sum (median) | | 182.0 s | 179.5 s |

### Where the replaced steps spent their time

From the step times of W46 run 43201298354 and main run 43656360389, on full cache hits:

| Step | app | tooling | db | census 1 | census 2 | census 3 |
|---|---|---|---|---|---|---|
| `Run actions/setup-node@v7` (Node download, unpack, tool cache copy) | 4 s | 4-5 s | 4 s | 4-5 s | 5 s | 5 s |
| `pnpm from corepack` | 2 s | 2 s | 2 s | 2 s | 1 s | 2 s |
| `pnpm store cache` (second setup-node, 280 MB store) | 5 s | 7-8 s | 5 s | 5-6 s | 5 s | 5 s |
| `Run pnpm install --frozen-lockfile` | 7-8 s | 8 s | 7 s | 7-9 s | 7 s | 9 s |

In the app log of run 43201298354, setup-node spent 2.1 s of its 4.5 s copying Node into the tool cache, the store
restore 5 s (2.6 s download, 2.3 s unpack), and `pnpm install` 6.6 s (2.4 s linking, 4 s on dependency builds and
`prepare`). The `ci` job's setup-node pays the same Node download.

## After

Measured on PR #804's CI run 43660777259, attempt 2, at head aad87a89c (2026-11-15), read with
`node tools/ci/ci-timing.ts --last 15 --json`. Attempt 1 was the first run of the new cache keys: every new cache
missed and installed from the registry, which shows the miss path works. Attempt 2 is a rerun of the same run on warm
caches (D-1563): every job logs `Cache restored from key: ...` for each of its caches, ci-timing counts 15 hits and 0
misses, and `corepack-install.sh` prints `pnpm@10.34.6 from the corepack cache, no registry request`. `pnpm install
--frozen-lockfile` prints "Already up to date" and takes 5 to 6.1 s, against 7 to 9 s in W46 run 43201298354.

| Job | W46 median | Current main median | After (run 43660777259, attempt 2) | Saved per job vs W46 | Minutes per week vs W46 |
|---|---|---|---|---|---|
| app (lint, types, logs, unit) | 36.0 s | 24.0 s | 20 s | 16 s | 790 |
| tooling (docs, workflow, tools, wiki) | 31.0 s | 35.5 s | 28 s | 3 s | 148 |
| db (@everyfield/db, evry) | 24.0 s | 24.5 s | 19 s | 5 s | 247 |
| domain (census part 1) | 31.0 s | 35.0 s | 28 s | 3 s | 148 |
| domain (census part 2) | 24.0 s | 24.0 s | 22 s | 2 s | 99 |
| domain (census part 3) | 25.0 s | 26.0 s | 17 s | 8 s | 395 |
| ci | 9.0 s | 9.0 s | 6 s | 3 s | 148 |
| Per-run sum | 182.0 s | 179.5 s | 140 s | 42 s (40 s summed per job) | 1976 summed per job, 2075 from the sum |

No job's setup is above its W46 median or its current main median. The per-job savings add to 40 s because a median
of sums is not a sum of medians; the run's sum is 42 s under the W46 median sum and 39.5 s under current main's.
Against current main the app saving is 4 s and part 1's is 7 s, since T-216 had already moved the build between them.

Minutes saved per week are scaled as in `setup-costs-2026-W46.md`: 72 jobs of each name in its 0.1699-day CI sample,
so each second cut from one job's setup is 72 × 7 / 0.1699 / 60 = 49.4 min per week for that job.

## Cache sizes

GitHub's free Actions cache holds 10 GB per repository and evicts the least recently used entries above it. The
entries this change stops writing are the two `node-cache-Linux-x64-pnpm-*` store entries (293 MB and 294 MB on main).
The new entries, one per key, with sizes from the cache lines in the job logs of run 43660777259:

| Entry | Key prefix | Size |
|---|---|---|
| Node and corepack home | `node-corepack-Linux-X64-` | 51 MB |
| Node only (ci job) | `node-Linux-X64-` | 47 MB |
| node_modules | `pnpm-modules-Linux-X64-` | 257 MB |
| node_modules with tools/wiki | `pnpm-modules-Linux-X64-` (other hash) | 257 MB |

New entries total 612 MB against 587 MB of store entries no longer written, so about +25 MB net. The repository's
cache total was 11.41 GB on 2026-11-15, above the 10 GB line, because of about 10 GB of existing `next-` build caches;
GitHub evicts the oldest entries, and this change adds almost nothing to that total.

## Limits on these numbers

- The W46 figures scale 4.1 h of one busy weekday to a week, like the report they come from.
- Job setup moves by a few seconds from run to run with runner and cache service speed, so one run is compared with
  medians, not with one baseline run.
- Two of the jobs changed between W46 and now for other reasons (T-216), so the current main column is the fairer
  baseline for this change alone.
