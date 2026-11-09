# evf v2: a seat's question left behind by a re-plan (T-77)

This note records a fix to the evf tool, not to Everyfield. Everyfield code is not touched. The fix lives in `~/dev/evf-v2`.

## What went wrong

T-76's implementer, R-225, asked D-63 ("webhook.json is not there yet. Retry, or close now?") while working from spec v1. A delegate then re-planned the task, and the planner stored spec v2.

R-225 stayed active and parked on D-63. The planner counted it as the implement step's current run, so T-76 waited on D-63 for ever. Neither of its options was true, and `evf decide --option answer` was rightly refused.

## The fix

The planner now finds a run waiting on its own open question whose key comes from an older spec than the task's current one. The store then does two things in one transaction:

- It stops that run.
- It marks the question `superseded`, with the reason on the event log and as a `question_superseded` row in the audit chain.

The question keeps its text, context, options, asker and asked time. No option, words or effect is recorded on it, and a later answer is refused. The next tick starts one new implementer on the new spec.

Three cases are left alone:

- A question asked under the current spec.
- A run that is not waiting on a question.
- A held task, which keeps its questions until it is released.

Approvals, escalations and `evf decide` work as before.

| Item | Where |
| --- | --- |
| Review branch | `fix/stale-seat-question-on-replan` on `build/v2`: `0dca05d`, `29fe8ab`, `770b678` |
| Installed branch | `install/stale-question-on-tailscale` on `3688efa`: `039ffb3`, `68c1615`, `b89e3c6` |
| Rollback copy of the old binary | `~/.cargo/bin/evf-2.0.0-before-t77` |
| Service | `gui/501/dev.evf.8362f61efc` |

## Roll back

```sh
cp ~/.cargo/bin/evf-2.0.0-before-t77 ~/.cargo/bin/evf
launchctl kickstart -k gui/$(id -u)/dev.evf.8362f61efc
```

Rolling back does not undo what the fix recorded. A retired run and question stay stopped and superseded. Those are ordinary audited records, and the old binary reads them.

## Running evf-v2 tests from a seat

A seat's environment sets `EVF_HOME` to the live store. Run evf-v2 tests as follows, or the tick tests try the live loop lock:

```sh
env -u EVF_HOME -u EVF_RUN -u EVF_RUN_TOKEN -u EVF_TASK -u EVF_ROLE cargo test --workspace
```
