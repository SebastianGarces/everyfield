# Durable execution

Ordinary asynchronous work runs in the same Next.js application through an authenticated bounded executor. PostgreSQL `job` rows are durable authority. A best-effort postcommit wake-up may reduce latency; due rows and periodic sweeps recover missed invocations. A separate worker deployment or workflow platform needs a demonstrated requirement and review.

## Claims and outcomes

Producer transactions commit required domain facts, history, `operation` receipts and `job`, `effect` or `mail` intent together. Required local consequences stay atomic. Job payloads contain identifiers, versions and bounded checkpoints, never copied authority or private-care metadata. Handlers reload current eligible facts and grants.

Claim eligible rows with short database locks and skip locked rows, increment `job.claim_generation`, assign finite owner/lease and commit before provider/model work. Checkpoints and completion compare the current generation, lease owner and required source revision. Lease extension requires the same generation. Reclaimed or cancelled workers cannot publish, even if their returned output is valid. Cancellation and deletion compare the exact request/source revision and use the database clock for deadline transitions.

Persisted states are ready, claimed, retry_wait, reconcile, succeeded, failed, cancelled and superseded in `job.state`. Display labels do not create new persisted states. Bounded retry handles only known retryable failures. Unknown provider acceptance stays reconcile until actual evidence resolves it; lease expiry or a new key cannot justify repeating the effect. Operator recovery rechecks subject, permissions and lifecycle, records its reason/evidence and resumes a safe checkpoint or leaves the outcome unknown.

Only a configured machine credential may invoke the periodic executor. Missing/empty credentials fail closed; arbitrary caller-supplied kinds/subjects are refused. Manual execution requires fresh restricted operator authority. Preview/test triggers and transports are isolated from production. Invocation limits, finite leases, chunk sizes, concurrency and total retry budgets must fit the measured deployment. The assessment-specific lease/call/usage bounds are in [assessment](assessment.md).

## Closed kinds and uniqueness

This is the complete ordinary handler inventory, matching the literal `job.kind` CHECK. The unique key is `job.kind`, `job.subject_record_id` and `job.producer_key`. Each subject is an exact owned `record`; recipes below describe the producer key. The kind differentiates recipes across handlers. A subjectless sweep uses producer key sweep and is separately unique per tenant/kind, with a durable scan cursor. Every scan must preserve owed tail work rather than drop records beyond a fixed page.

| Kind | Work and one producer-key recipe |
|---|---|
| mail | Dispatch or reconcile one immutable mail intent. Key is the mail ID plus its reviewed payload revision. Original provider key and receipt survive retries and reconciliation. |
| notification | Repair task/meeting reminder intents. Key is entity ID, source revision and logical reminder occurrence. Current audience and cancellation barriers are rechecked. |
| digest | Compile one owed recipient/category interval. Key is recipient ID, category, confirmed zone and interval start/end. Coverage advances only with committed mail intent; empty catch-up sends nothing. |
| assessment | Execute one captured demand/run. Key is assessment ID and its request key, including the daily refresh window where applicable. Source/reference/claim fences govern publication. |
| reference_generation | Derive one approved reference candidate. Key is release ID and manifest hash. Durable passage checkpoints never mutate an active generation. |
| feedback_publication | Publish/reconcile one safe public issue. Key is publication ID and frozen destination/payload hash. Unknown creation searches the original marker and verified repository before any retry. |
| object_cleanup | Finalize/reconcile one upload or orphan. Key is object ID and original upload identity. Current binding/claim CAS prevents deleting concurrently ready bytes. |
| lifecycle_purge | Purge an eligible account/plant. Key is witness request ID and request revision. Bounded cleanup stays hidden until coherent completion. |
| assistant_turn | Resume one approved initiating turn. Key is operation ID and original request key. Reconnect cannot approve or execute new effects. |
| document_render | Render one reviewed generated artifact. Key is generation operation ID and frozen input/template/renderer hash. Retry preserves immutable output identity; failure leaves the prior artifact intact. |

Signed mail callbacks persist and apply `provider_event` facts through the mail boundary; they are not an unregistered callback job type. Duplicate or out-of-order events never resend mail or rewind facts. Mail dispatch/reconciliation share the mail handler and its receipt. Restricted backup, witness sync, copy expiry and restore are outside ordinary job dispatch and ordinary application secrets.

## Build and measured-load gates

During the build, implement finite leases, claim fences, idempotency, bounded retries, durable scan/checkpoint recovery and unknown-outcome reconciliation. Verify actual invocation duration/rate against required timing before enabling production schedules. Vendor selection or a free allowance proves no capacity, price or spending approval.

Per-tenant fairness, reserved security/cancellation slots and per-kind alert tuning are deferred to G-LOAD, the measured-load gate. Close that gate only after representative backlog/burst measurements identify starvation, lag and saturation, and after the selected scheduling/alert changes prove recovery across every affected kind and the scan tail. It does not block building the base executor. Until measured, retain bounded execution and safe operator visibility without prescribed rotation, slot counts or per-kind lag thresholds. This gate grants no additional deployment or spending authority.

Before customer data, [recovery](recovery.md) requires the restricted backup host, encrypted daily copies, current witness synchronization, key recovery and coherent restore evidence. Those jobs are not build kickoff prerequisites.

EXEC-001 through EXEC-012 and relevant schema/assessment/mail/file cases require future real claim-loss, late-worker, callback, crash, current-source and unknown-provider proof. Documentation checks establish only the inventory and schema alignment.
