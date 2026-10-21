# Durable execution

Ordinary asynchronous work is durable, bounded and authenticated. Missed wake-ups or process restarts do not lose owed work. Storage, scheduling, deployment and worker ownership follow [EveryField patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62).

## Claims and outcomes

A source change and its required local consequences, audit, history and owed external work succeed or fail together. Recoverable work carries only the identifiers and bounded progress needed to resume. It cannot copy authority or private-care metadata. Execution applies current eligible facts and grants.

Only the current authorized worker may advance or complete a work item. Work ownership expires within a bounded interval and can be recovered. Replaced, cancelled or expired workers cannot publish even if they return valid output. Cancellation and deletion use the exact current request, source state and authoritative deadline.

Inspection truthfully distinguishes pending, active, waiting to retry, awaiting reconciliation, successful, failed, cancelled and superseded work. Internal state names are implementation choices. Only known retryable failures retry within the allowed budget. Unknown provider acceptance remains unknown until actual evidence resolves it; worker loss cannot authorize a duplicate effect. Operator recovery rechecks subject, permissions and lifecycle, records reason and evidence, and resumes safe work or leaves it unknown.

Only a configured machine credential may invoke the periodic executor. Missing/empty credentials fail closed; arbitrary caller-supplied kinds/subjects are refused. Manual execution requires fresh restricted operator authority. Preview/test triggers and transports are isolated from production. Invocation limits, bounded work ownership, batch sizes, concurrency and total retry budgets must fit the measured deployment. The assessment-specific call and usage bounds are in [assessment](assessment.md).

## Closed kinds and uniqueness

The inventory below defines ordinary work and the logical identity that must not execute twice. These identities describe product outcomes, not required key encodings, tables or database constraints. A scan must preserve owed tail work rather than dropping records beyond a page.

| Kind | Work and duplicate-prevention outcome |
|---|---|
| mail | Dispatch or reconcile one immutable reviewed mail intent. Preserve the original provider correlation and actual outcome across retries. |
| notification | Deliver each logical task or meeting reminder once. Apply current audience, source state and cancellation rules. |
| digest | Cover each owed recipient/category interval once in its confirmed zone. Advance coverage only when owed mail is saved; empty catch-up sends nothing. |
| assessment | Complete each captured material, daily, manual or operator demand without duplicate publication. Recheck source, reference and execution eligibility. |
| reference_generation | Build one reviewed reference candidate completely. Resuming partial work never mutates an active generation. |
| feedback_publication | Publish one safe issue at its reviewed destination. Resolve unknown creation using the original correlation and verified repository before retrying. |
| object_cleanup | Finish or reconcile upload cleanup without deleting bytes concurrently finalized for authorized use. |
| lifecycle_purge | Complete the exact eligible deletion request. Interrupted cleanup stays hidden until coherent completion. |
| assistant_turn | Resume the initiating account's authorized turn. Reconnect cannot approve or execute new effects. |
| document_render | Produce the reviewed artifact from frozen inputs, template and rendering profile. Retry preserves output identity; failure leaves the prior artifact intact. |
| evry_effect | Run one approved Evry proposal revision once through its owning domain write, under the approver's live authority and before the review expires. A retry with the same effect key returns the saved receipt. |

Authenticated mail callbacks retain and apply actual provider delivery evidence. Duplicate or out-of-order events never resend mail or rewind facts. Dispatch and reconciliation stay correlated with the original reviewed mail and its known outcome. Restricted backup, witness sync, copy expiry and restore are outside ordinary job dispatch and ordinary application secrets.

## Build and measured-load gates

During the build, prove recovery after interruption, duplicate prevention, bounded retries, complete scan-tail handling, stale-worker refusal and unknown-outcome reconciliation. Measure invocation duration and rate against required timing before enabling production schedules. Vendor selection or a free allowance proves no capacity, price or spending approval.

Per-tenant fairness, reserved security/cancellation slots and per-kind alert tuning are deferred to G-LOAD, the measured-load gate. Close that gate only after representative backlog/burst measurements identify starvation, lag and saturation, and after the selected scheduling/alert changes prove recovery across every affected kind and the scan tail. It does not block building the base executor. Until measured, retain bounded execution and safe operator visibility without prescribed rotation, slot counts or per-kind lag thresholds. This gate grants no additional deployment or spending authority.

Before customer data, [recovery](recovery.md) requires the restricted backup host, encrypted daily copies, current witness synchronization, key recovery and coherent restore evidence. Those jobs are not build kickoff prerequisites.

EXEC-001 through EXEC-012 and relevant schema/assessment/mail/file cases require future real claim-loss, late-worker, callback, crash, current-source and unknown-provider proof. Documentation checks establish only the inventory and schema alignment.
