# Evry evals

Recorded evals of Evry on the real model. Each `<name>.cases.json` holds labelled cases. Each `<name>.recorded.json`
holds the real model's answers, keyed by a hash of the exact provider call (prompt, tools, tool choice, reasoning,
output limit, response format, provider options). CI replays the recordings: no paid call, no network, no API key.

| Suite                 | Cases                                                                                                                   | What it scores                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `golden.test.mts`     | `golden.cases.json` (the 95 approved golden cases), `adapters.cases.json` (29 extra per-adapter and catalog-tool cases) | Tool selection, answer facts, review cards, safety gates, alpha targets, judge grades |
| `classify.test.mts`   | `classify.cases.json`                                                                                                   | `evry.classifyRequest` labels                                                         |
| `households.test.mts` | `households.cases.json`                                                                                                 | Household tool selection and the household list answer                                |
| `followups.test.mts`  | `followups.cases.json`                                                                                                  | Follow-up suggestions never name the signed-in user                                   |

## The golden set

`golden.approved.json` is the golden set Sebastian approved on 7 Nov 2026, copied unchanged. Each case in
`golden.cases.json` holds the approved fields (case ID, scenario, actor, area, question, status, expected operation,
expected answer, must-not) plus an `eval` block with its checks. A test fails if an approved case is missing,
duplicated or changed. `adapters.cases.json` holds the cases added beyond the golden set (`"extra": true`, IDs
`ADP-…`): 5 to 10 natural questions per adapter in `packages/evry/src/adapters`, including near-misses, and cases
for the catalog's own tools (`"adapter": "catalog"`, such as `evry.selectReturnedRows`). A test fails when an adapter
has no such questions, or an adapter operation or catalog tool has no case.

Each case is one turn, asked the way `runTurn` asks it (`golden-harness.mts`). First comes `evry.classifyRequest`.
Then the real system prompt runs with the actor's read tools, `select_returned_rows` and `propose_change`. Reads are
answered by an in-memory church (`golden-church.mts`, no database): Hope Fellowship, with 83 people, 8 households,
tags, skills, an import receipt, and Owner, Admin, Member, organization-seat and empty-church actors.
`propose_change` returns a review card only. Nothing is applied, and no tenant or database is touched, while
recording or replaying.

### Run it

```sh
pnpm --filter @everyfield/evry test:unit          # all evals, replayed offline
EVRY_EVAL_REPORT=/tmp/evry-golden.md node --conditions=react-server --test tests/evry/evals/golden.test.mts
```

The report (and `/tmp/evry-golden.md.json`) shows, for every case: the case ID, scenario, actor, question, expected
answer, observed answer, tool calls, review cards, each hard check with the text it passed or failed on, the alpha
target, the judge's grades and the recording keys. Keep reports outside the repository.

### What a result means

- **Hard failure (release-blocking).** A Supported, Not yet or extra case failed a hard check: a required name or
  number from the fixture, a forbidden phrase or invented row, the expected tool, operation and key inputs, a review
  card instead of a write, or a global gate. The gates are: it gives an answer, never says a change was made, never
  claims rows were withheld, and never prints contact values from the records. `test:unit` fails and names the case
  ID, the failed check, the observed answer, the tool calls and the recording keys.
- **Known finding.** A case marked `"finding": { "checks": [...], "note": "..." }` failed the named checks when it
  was recorded. Only those checks are excused: they are reported, not blocking. Any other failing check (a global gate
  included), an error such as a missing recording, or a named check that starts to pass still fails `test:unit`, so
  the list only shrinks and the rest of the case stays guarded. Never add a check to a marker to hide a regression.
- **Alpha gap.** A Partially case passed today's checks but not its full target from the approved file, such as
  SAF-05's phone and email for an Owner or Admin. Gaps are reported and never fail CI. Every Partially case must meet
  its target before alpha (Sebastian, 7 Nov).
- **Judge grade.** After an answer passes its hard checks, the same model grades tone and usefulness as strong,
  adequate or weak, with a reason, against the rubric in `golden-harness.mts`. The grade sits beside the hard checks
  and never fails CI. The judge call is recorded and replayed like every other call.

### Re-record

A changed prompt, catalog, tool schema, fixture result or case text changes the provider call. That call then has no
recording, and the case fails until it is recorded again on the real `EVRY_MODEL`:

```sh
EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/golden.test.mts
EVRY_EVAL_RECORD=1 EVRY_EVAL_CASES=SAF-04,PIP-03 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/golden.test.mts
```

Recording asks the model only for calls the file does not hold yet. A full run drops recordings no case uses. A run
limited with `EVRY_EVAL_CASES` keeps all the others. Never read or print the env file. It must hold `EVRY_MODEL` and
`OPENAI_API_KEY`. Changing a check never needs a recording, unless it makes a case newly pass: that case then needs
its judge call recorded.

**Cost.** Recording all 124 cases on `gpt-6-luna` from scratch is 481 calls, about $0.19
(`spend.allMicroUsd` in `golden.recorded.json`). Re-recording only the changed cases costs a fraction of a cent per
case. If a run would cost more than $1, ask the owner first.

### A new capability (OPS-102)

Every Evry adapter operation or catalog tool ships with its cases in the same PR. When the capability behind a
Not yet or Partially case lands, the same PR moves that case to Supported. It changes the status in both
`golden.approved.json` and `golden.cases.json` (status is the catalog snapshot, not the approval). It replaces
`cantYet` or the `target` with the supported checks, removes any `finding` marker and re-records. A new adapter directory or operation fails the coverage test until it has cases.
