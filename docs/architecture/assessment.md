# Assessment consistency and publication

Plant Intelligence and Network Intelligence share the adopted assessment storage while retaining different rubrics and projections. [Methodology requirements](../product/methodology-intelligence.md) define evidence meaning and formulas. The intelligence producer owns snapshot consistency, material triggers and publication; the executor supplies durable claims and budgets.

## Stored identities

`assessment` combines demand identity and immutable captured run evidence. Its tenant is an actual plant or organization. Request key/digest, demand kind and refresh window distinguish material, daily, manual and operator requests. `job` owns the finite attempt lease and claim generation. `assessment_fact` owns typed deterministic input evidence; `finding` owns validated results. `assessment_contributor` pins exact source plants, released assessments, recognition operation, sharing and source revisions for an organization run. `reader_feedback` remains the reader's own account-owned feedback with an entitled target.

Current publication is derived from the latest still-authorized complete `assessment`, ordered by `assessment.available_at` and ID. There is no separately mutable current-result pointer or second demand table. Incomplete, deferred or failed work never displaces a valid prior result. Historical results retain their exact original evidence while every read still checks current rights.

## Material revisions come from database triggers

The deterministic intelligence input producer, WP-040, owns database triggers on every assessment input table. Inserts, changes to assessment-relevant input values and deletes bump the affected `plant.material_revision` in the same transaction as the fact change. This includes native, Evry, imports, correction, merge, removal and system writers without requiring each caller to remember a revision helper. The revision is a monotonic freshness fence, not a count of user commands. Multiple changed rows may advance it more than once; exact replay and a real no-op do not change it. Trigger failure rolls back the fact change. Revision-only updates and unrelated fields are not inputs and cannot recursively invalidate themselves.

The assessment input builder determines the required input set. One required integration test compares the installed material-trigger table set with every table read by that builder, including conditional input branches. It also proves a representative input change advances revision and refuses stale publication while rollback leaves both fact and revision unchanged. The producer closes only after the comparison has no missing inputs or unexplained extra tables. There is no separate material-writer registry.

Only affiliation and sharing changes, including category grants, advance `organization.material_revision` atomically. Plant input and released-assessment changes are fenced by each contributor source revision at organization publication; they do not fan out organization material revision updates. Organization invalidation reveals no raw plant roster. Reference activation is a separate monotonic fence. Private care, its existence/calendar/corrections/nudges and private support questions are excluded from both builder and trigger set.

After-commit wake-ups only accelerate work. A periodic sweep sees durable revisions even if wake-up delivery is lost. It selects never-assessed, changed-source/reference and at-least-seven-day-old complete results. Each daily UTC refresh window has its own stable request identity, so quiet time-dependent evidence gets a new fixed as-of instant despite unchanged material revision. Launch countdown and attestation ages use that instant and the saved local calendar.

## Snapshot and model boundary

Capture all typed facts, source revision, reference activation and one as-of instant in one consistent repeatable-read database snapshot. Persist the immutable input and hash before model work. Concurrent changes must not produce a mixed old/new snapshot. No model or embedding request runs under database locks. A new time/input snapshot is a new run; retries may reuse only the exact still-eligible snapshot.

Organization input uses released plant results under exact current recognition, category and geography predicates. Each pattern needs two distinct eligible contributors at its geographic level. Protected lineage stays server-only. The model receives permitted aggregates, windows, quality flags and structured concern counts with the separate portfolio rubric. Bounded named rows are attached by the server under current rights. Raw Person/interview/four Cs/private notes/street addresses and private-care metadata never enter NI input.

PI model-purpose projection drops raw human interview/four Cs scores, judgment, qualification, result, notes and testimony even when a native People read was authorized. It retains only operational evidence and allowed human-record presence/count/date. Removed raw content cannot become a hidden summarized finding. Missing data, false and measured zero remain distinct. Cite actual occurrence, original denominators and immutable formula versions; storage creation time is not evidence of human contact.

## Execution and budgets

Use bounded leases and claim generations from [execution](execution.md), with an assessment lease of 120 seconds and heartbeat at most every 30 seconds while active. Each provider call has a 45-second maximum. Disable implicit SDK retries; the owned handler accounts for each dispatch. Allow at most four provider attempts per draft and three output drafts, sharing a cumulative run budget of 60,000 input and 12,000 output tokens. Reserve before dispatch and reconcile actual usage, including uncertain charged calls. Deadline/budget may stop work before the maximum. Backoff respects Retry-After and never runs beyond the deadline.

Exhausted invalid drafts fail with the final draft's actual violations. Availability/budget limits defer with a due instant. Lost claims retain safe attempt evidence; a new generation may resume only within the same eligible budget or create a new run. Three exhausted scheduled attempts require operator review until a new material/reference/time demand or authorized retry. Diagnostics omit raw inputs/outputs and protected manifests.

Retrieval failure may leave deterministic facts visible with degraded-grounding status and the last valid result's age. It cannot publish ungrounded advice, invented citations or a successful empty/healthy result. Missing mandatory reference fails. NI uses its own whole pinned rubric; schema-valid output alone does not prove semantic truth.

## Publication and current reads

Publication atomically compares source/material revision, current reference activation, rubric/policy identity, claim generation and unexpired lease. Organization publication also compares current recognition, category grants and every contributor/source revision. Deletion or access suspension blocks publication. Validate facts, formulas, citations, denominators and field permissions before completing `assessment`, saving `finding` rows and required notice intent.

A changed fence marks the attempt superseded and leaves newer work eligible, without publishing or notifying. Matching data cannot authorize an expired worker. A reference rollback has a new activation number and rejects workers from either old activation. Failed postcommit wake-up cannot demote a completed result.

Every current/history/export/cache/Evry read reauthorizes contributors. Revoked input withholds the affected whole result or permits a genuinely recomputed projection; removing a name from prose is not recomputation. Shared-findings OFF may retain independently allowed identity/link and Not shared. Ended identity/page reach removes the row. Reads call no model. At source plant purge, all affected mixed runs, facts, findings, contributors, linked feedback and copied artifacts purge; an organization's ownership cannot preserve the deleted source body or reset its copy expiry.

## Future proof

ASMT-001 through ASMT-012 retain quiet-day refresh, paused wake-up correction, input-change race, stale claim refusal, prior-result survival, atomic rollback, reference activation/rollback, contributor revocation, consistent snapshots, bounded provider/output retries, complete second releases and private-care exclusion. The trigger-set comparison is required intelligence-producer proof alongside these behaviors. Driver, provider, model, SQL and trigger execution remain future acceptance; documentation checks prove none of them.
