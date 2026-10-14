# Deletion and recovery

Cancellation and recoverability are separate rights. An authenticated account requests personal deletion; a plant's current Owner alone requests workspace deletion. Last-required-Owner removal needs separately approved manual resolution. There is no public organization-deletion operation. Provider selection grants no setup, spending or restore authority.

## Current lifecycle witness

`lifecycle_witness` is the body-free current authority for deletion and access revocation. The live `account` and `plant` roots do not carry a second lifecycle state. Account/plant deletion witnesses use active, pending_deletion, purging, purged or cancelled. Seat/affiliation witnesses use active or revoked. The exact kind, opaque original subject and request ID/revision survive clearing live links on purge. A new request advances the request revision; stale proof cannot affect it.

`lifecycle_witness.requested_at` and `lifecycle_witness.cancel_until` record the immutable request instant and its 30-day deadline. Pending hold, successful cancellation and completed live purge are distinguishable through state and `lifecycle_witness.cancelled_at`, `lifecycle_witness.live_purged_at` and `lifecycle_witness.copy_expires_at`. SQL CHECKs require the request/deadline for deletion states, cancellation strictly before deadline, and completed purge at/after deadline with its copy expiry. Cancellation keeps the original request/deadline evidence and restores only independently valid access. A cancelled witness is not a revoked affiliation's restoration or an old session's revival.

One locked subject/request revision and the database clock arbitrate request, cancel and purge. At request commit, deny all affected ordinary reads/writes, streams, model contexts, history, exports, file issuance, organization contributions and new provider handoffs. Hold affected bodies privately solely for cancellation. Account deletion does not hide independent plant/organization-owned facts from valid readers. Workspace deletion hides all its owned content and contributions.

A narrow native identity-proof purpose permits request status and cancellation, without ordinary business/private bodies or Evry. Cancellation stops strictly at the deadline, even if purge is late. It requires original account proof or the requesting current Owner's proof/authority. It restores only still-valid grants and a fresh sign-in opportunity, never another pending subject, old sessions, independently revoked access or cancelled provider mail.

At/after deadline, the registered lifecycle handler claims the exact pending request. Bounded owned-reference cleanup keeps normal access denied after any failure. Set completed live purge only when eligible database, file, cache and derivative content has actually been removed or scrubbed; an object-delete timeout is incomplete. `lifecycle_witness.cleanup_state` distinguishes attempted work, logical inaccessibility and confirmed provider cleanup. Copy expiry is at most seven days from completed live purge and never resets through recopy, organization ownership or restore.

## Ownership during purge

Account-owned documents, revisions, avatar, personal progress, feedback originals, conversations and private care purge after the hold. Shared plant-owned Person, training, meeting, task, communication and Launch facts survive personal creator deletion with minimal scoped attribution. A creator FK is not ownership. Plant deletion removes its owned rows/files and all source-containing copied intelligence runs, facts, findings, contributors, feedback and artifacts in organizations. Surviving plants and organizations may recompute; a minimum body-free counterpart receipt may remain, not a private source snapshot.

Global approved references remain independently owned. Scheduled external mail is cancelled/reconciled where possible; sent mail, public issues, downloads and issued signed URLs have real provider/TTL limits and no instant recall guarantee. Every FK/resource has an explicit purge, detach or minimal-attribution rule. Neither blanket cascade nor permanent audit retention is valid. Private-care body and existence/calendar/nudge metadata stay excluded from broad audit and other purposes throughout hold, purge and restore.

## Build recovery boundary

During the build, rely on Neon native seven-day database history and Tigris native seven-day object history. Prove the configured retention rather than infer it from a default tier. History is recoverable storage, not normal read authority. Restore during the build uses surviving current lifecycle/access witnesses; if current authority cannot be established, keep service closed. Native history alone provides no independently synchronized disaster fallback.

Encrypted daily copies, dedicated backup credentials, witness synchronization and a restricted scheduled backup host are deferred to the before-customer-data gate, G-RECOVERY. G-SETUP separates ordinary build environment setup from that later restricted setup. None is an implementation kickoff prerequisite.

## Before-customer-data gate

Before customer data, configure expiring daily database snapshots and encrypted dated DB-plus-byte copies in a separate private Tigris backup bucket. Use dedicated scoped credentials and recoverable encryption keys on a positively identified restricted operator host or approved runner. It uses the same approved application artifact and never a customer/model recovery route. Ordinary Next runtime, builds, previews, app object credentials, logs and models receive no backup bucket/decryption access. A separate environment variable in the app process is not isolation. Negative credential/access and key recovery proof is required.

The selected backup destination shares the Tigris provider/account risk. There is no independently hosted disaster guarantee or mandatory second provider. The gate must prove actual host identity, schedule, scoped credential delivery, daily complete-copy freshness and current minimal witness sync at least every five minutes while service runs. Missed schedules remain visible and invalidate unsupported fallback claims.

The external restricted manifest records artifact/source/schema version, consistent database instant/LSN and checksum, exact immutable ready object inventory/version/hash/size, encryption key version, current witness checkpoint, original subject expiry and copy verification/expiry. It is outside the restored database, so restore cannot roll back its own recovery ledger. Missing pages, bytes or checksum mismatches make a candidate incomplete. Only a fully verified DB-plus-byte copy is promoted. Original expiry is the minimum across copies; history/snapshots, retained branches, soft-deleted objects/buckets and restored test endpoints are all cleaned explicitly.

## Coherent restore and targets

Restore requires exact operator authority and an isolated database/object destination with users, jobs, mail and issue publication disabled. Validate schema/source and DB/object hashes at the same recovery point. A daily byte copy alone cannot establish a one-hour recovery point; native object history must supply every ready referenced byte at the selected database point.

Obtain current deletion/access witnesses outside the stale image before reopening. For ordinary mistake recovery use surviving live authority; for fallback use the separately synchronized current journal. Apply pending and purged denial/cleanup and cancelled state with its independent grant revalidation. A restore between request and cancellation must respect the current cancellation; a restore before purge must not resurrect it. Uncertain or stale witness state fails closed.

Reconcile accepted/scheduled/unknown external receipts against actual provider facts and current journal. Restored pending rows cannot authorize duplicate sends/issues. Invalidate stale sessions/proofs/URLs as required, recheck entitlements and prove expired bodies, caches and copied organization results inaccessible. Cancelled sends remain cancelled. Only after coherent verification may an operator reopen fresh authenticated service and record its receipt.

Ordinary recoverable mistakes with live provider access target internal RPO at most one hour and RTO at most four hours, measured to verified DB-plus-byte service recovery. A fresh surviving accessible daily encrypted copy may permit at most 24-hour loss fallback. A scheduled but failed or inaccessible copy proves neither fallback nor availability. There is no disaster RTO, customer SLA or universal physical day-37 erasure promise.

G-RECOVERY remains open until coherent restore, current pending/cancelled/purged witnesses, external non-replay, secret isolation, key recovery, original copy expiry and provider cleanup are demonstrated before customer data. DEL58, REC59 and BKT60 cases remain future runtime/operator proof. A failed drill leaves that gate open.
