# CI runner cannot reach github.com

How to recognize a `ci` failure that comes from the hosted runner's network, and the record of the failure at
`8895239ccb15e3f630f9b4152d933ee501ea584c` (T-613). No test flaked, so no test was fixed or deleted.

## Root cause of the failure at 8895239ccb

The hosted runner for `domain (census part 1)` could not open a connection to github.com, so checkout failed. No test
and no other repository code ran in that job.

| What | Value |
|---|---|
| Run | [45337959492](https://github.com/SebastianGarces/everyfield/actions/runs/45337959492), attempt 1, T-565's pull request, 2026-11-24 |
| Failed job | `domain (census part 1)`, job 138254422635, 06:06:20 to 06:13:51 UTC |
| Failed step | `Run actions/checkout@v7`, the job's first step after the service container started |
| Runner | AWS us-west-2, image `ubuntu24/20261116.133` |
| Other failed job | `ci`, step `Every check passed`, only because `needs.domain` was `failure` |
| Attempt 2 | Passed at the same head |

The three fetches and their errors:

| Fetch started (UTC) | Failed (UTC) | Error |
|---|---|---|
| 06:06:37 | 06:08:52 | `Failed to connect to github.com port 443 after 135102 ms: Couldn't connect to server` |
| 06:09:05 | 06:11:20 | `Failed to connect to github.com port 443 after 134441 ms: Couldn't connect to server` |
| 06:11:33 | 06:13:47 | `Failed to connect to github.com port 443 after 134444 ms: Couldn't connect to server` |

Read it with the attempt number; without it, `gh run view` shows the latest attempt, which passed:

```sh
gh run view 45337959492 --attempt 1 --log | grep -E 'census part 1.*(Region:|fetch --no-tags|Failed to connect)'
```

What the log proves:

- Every failed step is one of the two above. The `db`, `app`, `tooling` and other `domain` jobs passed in attempt 1.
- All three fetches of merge commit `c235ea6` failed to connect. The job never reached `Shared setup` or `Domain tests`.
- The same runner pulled `pgvector/pgvector` until 06:06:29, so it had some network seconds before the first fetch.
- `app` and `domain (census part 2)`, also in us-west-2 on the same image, checked out `c235ea6` at 06:06:30 and 06:06:41.

What the log only suggests:

- That one runner's route to github.com was down, rather than github.com or the region: other jobs reached it in the same
  seconds. The log does not show why, or whether the fault was the host, the network or GitHub's edge.

## How often it has happened

Once more in the window searched: run
[45302409769](https://github.com/SebastianGarces/everyfield/actions/runs/45302409769), attempt 1, a push to main at
`943ab4a79124cea7fa4b7f3de027c48a4e210d9e`, 2026-11-24 01:05:53 UTC. `domain (census part 1)` (job 138137912839, us-west-2)
failed in checkout after three connect failures of 136332, 134535 and 134537 ms. Attempt 2 passed.

The window is the 1000 newest `ci.yml` runs at the time, from 2026-11-20 14:32:26 to 2026-11-24 06:22:05 UTC. Of those,
23 had a rerun, and 2 of the 23 failed in checkout on attempt 1: this one and 45302409769. The other 21 failed in a later
step or had no failed step. A run that failed and was never rerun is outside the search.

```sh
gh run list --workflow ci.yml --created '2026-11-20T14:32:26Z..2026-11-24T06:22:05Z' --limit 1000 \
  --json databaseId,attempt --jq '.[] | select(.attempt > 1) | .databaseId' |
while read -r id; do
  gh run view "$id" --attempt 1 --json databaseId,jobs --jq '"\(.databaseId) " +
    ([.jobs[] | .name as $job | .steps[] | select(.conclusion == "failure") | "\($job): \(.name)"] | join(" | "))'
done
```

A run rerun after this search adds to the count. Both known failures were census part 1 in us-west-2. That overlap is not
established as a cause: there are only two cases, other us-west-2 jobs in both runs passed, and nothing in `ci.yml` separates
part 1 from parts 2 and 3 before checkout (the matrix differs only in `part` and `build`, which later steps read).

## Why no test or workflow changed

- No test is at fault. None ran in the failed job, so deleting one would change nothing.
- `actions/checkout` already tries the fetch three times, here over about seven minutes, all on the same runner.
  A longer retry would stay on that runner, with no evidence that it would recover.
- The repository cannot choose the host. `runs-on: ubuntu-24.04` takes whichever hosted runner GitHub assigns, and a rerun
  asks for a new assignment.

## When `ci` fails

1. Find the failed step of the failed job (`gh run view <run> --attempt <n> --json jobs`). It is this failure when the step is
   `Run actions/checkout@v7` and its log says `Failed to connect to github.com`. Any later failed step is something else;
   a test failure is never this.
2. Rerun the failed jobs: `gh run rerun <run> --failed`. No test needs a fix or a task.
3. If it recurs often enough to matter, repeat the search above with a newer window and look at it again: count the
   occurrences, regions and jobs before proposing a change.
