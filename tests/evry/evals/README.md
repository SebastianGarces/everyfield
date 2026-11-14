# Evry evals

Recorded evals of Evry on the real model. Each `<name>.cases.json` holds labelled cases. Each `<name>.recorded.json`
holds the real model's answers. CI replays the recordings: no paid call, no network, no API key. The golden, household
and follow-up suites also need Postgres: they run in `@everyfield/evry`'s `test:db`, which CI runs with its own
Postgres service. The classify suite runs in `test:unit`.

All four suites replay through `recorder("<name>")` in `golden-harness.mts`. Its `model()` is the replay model: it
serves the recorded `doGenerate` and `doStream` calls and throws `MissingRecording` for a call the file does not hold.
Its `save()` writes the file on a recording run. Every call is keyed by `callKey`: a hash of the exact provider call
(prompt, tools, tool choice, reasoning, output limit, response format, provider options). Every file has one shape:
`model`, `recordedAt`, `spend` and `calls` (key to a recorded generate or stream call with its token usage).

| Suite                 | Cases                                                                                                                    | What it scores                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `golden.test.mts`     | `golden.cases.json` (the 95 approved golden cases), `adapters.cases.json` (118 extra per-adapter and catalog-tool cases) | Tool selection, answer facts, review cards, safety gates, alpha targets, judge grades |
| `classify.test.mts`   | `classify.cases.json`                                                                                                    | `evry.classifyRequest` labels                                                         |
| `households.test.mts` | `households.cases.json`                                                                                                  | Household tool selection and the household list answer                                |
| `followups.test.mts`  | `followups.cases.json`                                                                                                   | Follow-up suggestions never name the signed-in user                                   |
| `settings.test.mts`   | `settings.cases.json`                                                                                                    | Seat, Settings, sharing, connection, account and organization tools (scripted model)  |

## The settings suite (scripted model)

`settings.test.mts` scores the seat, church settings, sharing, connection, account and organization tools (T-327) on the
scripted model (`packages/evry/src/runtime/scripted-settings.ts`), not a recording: their ask allowed no new spend. Each
case in `settings.cases.json` is a real turn (`runTurn`) in Hope Fellowship with the real catalog, reads and review
cards; a case with `approve` is approved and its effect run with the native services the Settings screens use
(`settings-ports.mts`), and the change is read back as Settings shows it. The golden, household and follow-up suites
offer the model only the operations they were recorded with (`RECORDED` in `golden-harness.mts`, ruling D-1137), so
their recordings stay valid until the next recording run adds these tools.

## The household and follow-up suites

Each asks its cases with Evry's real system prompt and read tools (`readTools` and `compileContext`), and every read
the model calls runs the real adapter through `invokeRead` against its own small church, which `small-church.mts`
seeds as real records into an isolated, migrated schema (`tests/support/test-database.mts`), as `golden-church.mts`
seeds Hope Fellowship. The prompt's clock and every id the model sees are pinned, and one step's reads run in call
order, so a replay sends exactly the recorded calls.

- Households: one plant whose only household is "Okafor household" in North Ridgeville, OH, with James Okafor (Head)
  and Ruth Allen (Spouse), read by a plant Owner.
- Follow-ups: one plant with 5 live people. Daniel Reyes (the planter, an Owner) and Lena Park (an Admin) are linked to
  their accounts, so the real row path marks each one's own row `you: true`; they are the strongest candidates (no
  next step, the oldest activity, no open task). Maria Lopez, Tom Baker and Priya Shah are the others. Inactivity and
  coverage come from seeded activity (audit) and task rows read by the real pipeline board, placed relative to the
  database clock so they read the same on every day the suite runs.

Each suite first reads its seed back through the real reads, then scores its cases.

## The golden set

`golden.approved.json` is the golden set Sebastian approved on 7 Nov 2026, copied unchanged. Each case in
`golden.cases.json` holds the approved fields (case ID, scenario, actor, area, question, status, expected operation,
expected answer, must-not) plus an `eval` block with its checks. A test fails if an approved case is missing,
duplicated or changed. `adapters.cases.json` holds the cases added beyond the golden set (`"extra": true`, IDs
`ADP-…`): natural questions per adapter in `packages/evry/src/adapters`, including near-misses, and cases for the
catalog's own tools (`"adapter": "catalog"`, such as `evry.selectReturnedRows`).
`tests/workflow/evry-evals-coverage.test.mjs` is the one coverage test: it fails when an operation or catalog tool the
package registers (its read domains, its reviewed writes and the catalog's exported tool names) has no case in any
`*.cases.json`. Adding an operation needs its cases and nothing else: no count or list in a test.

Each case is one turn, asked the way `runTurn` asks it (`golden-harness.mts`). First comes `evry.classifyRequest`.
Then the real system prompt runs with the tools the turn gives the actor, built by the same function the turn uses
(`modelTools` in `packages/evry/src/runtime/tools.ts`): the domain read tools, `select_returned_rows` and
`propose_change`. Every read runs the real adapter through `invokeRead` against Hope Fellowship, which
`golden-church.mts` seeds as real records into an isolated schema (`tests/support/test-database.mts`): 84 live people,
2 removed people, 8 households, tags, skills, notes, photos, open tasks, two import receipts (the earlier one left two
open review pairs and one dismissed pair), five current ministries and one archived one with their roles, people,
required training, a Playbook checklist and measured team meetings, and Owner, Admin, Member, organization-seat and empty-church actors with
live sessions and seats. A selection re-checks its rows with the real
`verifyPeople`. `propose_change` prepares a real review card with `prepareProposal` in an open conversation. Nothing is
approved and no effect job runs.

Replay is exact: every id the model can see is pinned in the seed; the prompt's clock is `NOW` (the turn's `deps.now`);
the host clock runs in `NOW`'s frame, because the export's filename carries the host's date; the database clock runs in
`NOW`'s frame too (below); a card's proposal id and expiry, which the database assigns, reach the model pinned; and one
step's tool calls run in call order. Inactivity is the real board's comparison against the database clock, so each live
person's last contact is seeded relative to it (2 days for level none, 10 for warning, none for alert).

### The pinned database clock

The fixtures' times sit in `NOW`'s week (2026-11-09T15:00Z): the Friday volunteer email is scheduled for Friday
2026-11-13 at 9:00 church time, and the schedule cases ask for that Friday. The real date passes them, so the clock
every eval query reads is pinned in one place: `evalDatabase` in `golden-church.mts` creates each eval schema with
`testDatabase({ clock: NOW })`, and `pinSchemaClock` (`tests/support/test-database.mts`) installs schema-local `now()`,
`transaction_timestamp()`, `statement_timestamp()` and `clock_timestamp()` that add a fixed shift to `pg_catalog`'s,
before the migrations run. Every pool's search_path puts the schema ahead of `pg_catalog`, so the adapters' SQL, the
column defaults and the `SET search_path FROM CURRENT` functions read `NOW`'s frame, still advancing. The keywords
`CURRENT_TIMESTAMP`, `CURRENT_DATE` and `LOCALTIMESTAMP` and `pg_catalog.`-qualified calls still read the real clock; no
eval read uses them. The golden church and the small church (households, follow-ups) both seed through
`evalDatabase`. The product keeps the real clock. `clock.test.mts` fails if the eval pool's clock leaves `NOW`'s frame.

The cases whose result depends on the database clock, now pinned:

- The schedule cases, whose times sit on the fixture Friday: ADP-M-03 and ADP-M-04 (`communication.scheduleReviewed`),
  ADP-M-05 (`rescheduleReviewed`) and ADP-M-07 (`replaceScheduledReviewed`), which the review's schedule window
  (`acceptedWindow` in `adapters/communication/commands`) compares with the clock, and ADP-M-06
  (`cancelScheduledReviewed`) and ADP-M-08 (a draft for the fixture Friday), which act on the same scheduled send.
  Unpinned, ADP-M-03, ADP-M-04 and ADP-M-07's review cards carried "That time has already passed" once real time
  passed 2026-11-13.
- Inactivity on the real pipeline board (`people.getPipelineData`): ADP-O-08, COM-06, GST-01, LCH-03, LCH-05, MON-01,
  MON-03, MON-04, MON-05, PIP-01, PIP-02 and PIP-04. Fixed-date activity counts too: Maria Santos's note is dated before
  her clock-relative last contact, so she reads her fixture's warning in `NOW`'s frame.
- The whole follow-up suite (`followups.cases.json`), whose candidates are ranked by inactivity.
- Every case's live session and accepted seat, seeded relative to the database clock.

### Run it

```sh
pnpm --filter @everyfield/evry test:db            # golden, households and follow-ups, replayed offline on Postgres
pnpm --filter @everyfield/evry test:unit          # classify, replayed offline
EVRY_EVAL_REPORT=/tmp/evry-golden.md node --conditions=react-server --test tests/evry/evals/golden.test.mts
```

The golden, household and follow-up suites need a database `testDatabase` accepts: the shared development database, or a throwaway local
Postgres the way CI runs one (`DATABASE_URL=postgres://ci:ci@localhost:5432/everyfield_ci`, `CI=true`,
`EARLY_ACCESS_TEST_DATABASE=1`, then `pnpm db:migrate`). Each run creates its own schema and drops it afterwards.

The report (and `/tmp/evry-golden.md.json`) shows, for every case: the case ID, scenario, actor, question, expected
answer, observed answer, tool calls, review cards, each hard check with the text it passed or failed on, the alpha
target, the judge's grades and the recording keys. Keep reports outside the repository.

### What a result means

- **Hard failure (release-blocking).** A Supported, Not yet or extra case failed a hard check: a required name or
  number from the seeded church, a forbidden phrase or invented row, the expected tool, operation and key inputs, a review
  card instead of a write, or a global gate. The gates are: it gives an answer, never says a change was made, never
  claims rows were withheld, and never prints contact values from the records. `test:db` fails and names the case
  ID, the failed check, the observed answer, the tool calls and the recording keys.
- **Known finding.** A case marked `"finding": { "checks": [...], "note": "..." }` failed the named checks when it
  was recorded. Only those checks are excused: they are reported, not blocking. Any other failing check (a global gate
  included), an error such as a missing recording, or a named check that starts to pass still fails `test:db`, so
  the list only shrinks and the rest of the case stays guarded. Never add a check to a marker to hide a regression.
- **Alpha gap.** A Partially case passed today's checks but not its full target from the approved file, such as
  SAF-05's phone and email for an Owner or Admin. Gaps are reported and never fail CI. Every Partially case must meet
  its target before alpha (Sebastian, 7 Nov).
- **Judge grade.** After an answer passes its hard checks, the same model grades tone and usefulness as strong,
  adequate or weak, with a reason, against the rubric in `golden-harness.mts`. The grade sits beside the hard checks
  and never fails CI. The judge call is recorded and replayed like every other call.

### Re-record

A changed prompt, catalog, tool schema, read result or case text changes the provider call. That call then has no
recording, and the case fails until it is recorded again on the real `EVRY_MODEL`. A changed seed row a read returns
does too. Each suite records its own file. The golden, household and follow-up suites also need the database variables
above in the shell; they win over the env file's:

```sh
EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/golden.test.mts
EVRY_EVAL_RECORD=1 EVRY_EVAL_CASES=SAF-04,PIP-03 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/golden.test.mts
EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/classify.test.mts
EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/households.test.mts
EVRY_EVAL_RECORD=1 node --conditions=react-server --env-file=apps/web/.env.local --test tests/evry/evals/followups.test.mts
```

Recording asks the model only for calls the file does not hold yet. A full run drops recordings no case uses. A golden
run limited with `EVRY_EVAL_CASES` keeps all the others. Never read or print the env file. It must hold `EVRY_MODEL` and
`OPENAI_API_KEY`. Changing a check never needs a recording, unless it makes a case newly pass: that case then needs
its judge call recorded.

**Cost.** Recording all 213 cases on `gpt-6-luna` from scratch is 950 calls, about $1.18
(`spend.allMicroUsd` in `golden.recorded.json`). The household and follow-up files are 10 calls each, under a cent
each (their `spend`); `classify.recorded.json` holds 26 calls of about 20 millionths of a dollar each, recorded before
token usage was kept, so its `spend` reads 0 until it is next recorded. Re-recording only the changed cases costs a
fraction of a cent per case. A full re-record sends about 2M tokens a minute at the harness's 6 parallel cases, past
the provider's per-minute limit: record in batches with `EVRY_EVAL_CASES`, then one full run to drop unused calls. If a run would cost more than $1, ask the owner first.

### A new capability (OPS-102)

Every Evry adapter operation or catalog tool ships with its cases in the same PR. When the capability behind a
Not yet or Partially case lands, the same PR moves that case to Supported. It changes the status in both
`golden.approved.json` and `golden.cases.json` (status is the catalog snapshot, not the approval). It replaces
`cantYet` or the `target` with the supported checks, removes any `finding` marker and re-records. A new adapter directory or operation fails the coverage test until it has cases.
