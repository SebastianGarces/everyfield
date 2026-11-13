# T-266 QA run: 5 MB and 10 MiB People CSV import on hosted QA previews (T-191)

This run was on real Vercel QA previews made with `bin/qa up`, on Nov 13, 2026. Each preview had its own Neon branch,
and the signed-in user was the Owner. It retests T-191 (PR #658), which had local proof only. This run does not judge
pass or fail. That call is Nora's. Screenshots and network logs are in the task's evidence, not in the repository.

## Test files

T-191's `make-csv.mjs` made both files with the 12-column template. Every row is valid.

| File | Bytes | Rows | SHA-256 |
|---|---|---|---|
| `people-5mb.csv` | 5,100,000 | 5,000 | `08311de419cc81e2742f6d4eeecbe9dff3f1147c4fe266854d69072362b5d7da` |
| `people-10mib.csv` | 10,480,000 | 10,000 | `3de2dc50a834d83e040feeefcc572e060a2a4936937470191d7830e028da20dc` |

## Results

| Preview | File | Preview step | Import | Requests |
|---|---|---|---|---|
| Baseline: T-191's parent `0341cf832` plus migration tooling only | 5 MB | Not shown. "We could not check this file." | Not reachable | `POST /api/people/import/preview` sends the whole file and gets 413 `FUNCTION_PAYLOAD_TOO_LARGE` |
| Baseline | 10 MiB | Not shown, same text | Not reachable | Same, 413 |
| Current main `142b53a4a` (with T-191) | 5 MB | 5,000 ready, 0 duplicates, 0 to fix | 5,000 added; People shows them | Signed `PUT` of 5,100,000 B to the private bucket from the QA origin: preflight 200, PUT 200. Largest app request 154,170 B |
| Current main | 10 MiB | 10,000 ready, 0 duplicates, 0 to fix | 10,000 added; People shows them | Signed `PUT` of 10,480,000 B: preflight 200, PUT 200. Largest app request 309,171 B |

The baseline could not be exact `0341cf832`. A QA Neon branch copies the development database, and that database had
already applied the migrations main added later. The older migration runner refuses such a database. The baseline
therefore added main's newer migration files and migration runner, and no People import code.

Both previews were removed with `bin/qa down`.

## Notes for the next QA run

- With Vercel CLI 65, `bin/qa` needs a fix. In a non-interactive shell, `vercel deploy` prints JSON instead of a bare
  URL line. `vercel alias rm` and `vercel remove` no longer accept `--yes` from an agent and need `--confirm-name`.
- On both previews, the scheduled-send driver's first and later runs of `/api/cron/jobs` answered HTTP 500.
