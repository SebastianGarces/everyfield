# Deletion and recovery

Cancellation and recoverability are separate rights. An authenticated account requests personal deletion; a plant's current Owner alone requests workspace deletion. Last-required-Owner removal needs separately approved manual resolution. There is no public organization-deletion operation. Provider selection grants no setup, spending or restore authority.

## Current lifecycle witness

Current body-free deletion and access-revocation evidence remains authoritative independently of restored content. Distinguish active access, pending deletion, cleanup in progress, completed purge, cancellation and independent revocation. Preserve the exact subject and deletion request after removing private bodies. Stale cancellation proof cannot affect a later request. Storage follows [Everyfield patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62).

Record the immutable request instant and its 30-day cancellation deadline. Pending hold, successful cancellation and completed live purge remain distinguishable, with actual cancellation, purge-completion and copy-expiry instants. Cancellation occurs strictly before the deadline; completed purge occurs at or after it and establishes copy expiry. Preserve original request/deadline evidence. Cancellation restores only independently valid access and cannot revive revoked affiliation or old sessions.

Request, cancellation and purge agree on the exact current request and authoritative deadline, including concurrent attempts. At request completion, deny affected ordinary reads/writes, streams, model contexts, history, exports, file issuance, organization contributions and new provider handoffs. Hold private bodies solely for cancellation. Account deletion leaves independent plant/organization-owned facts available to their valid readers; workspace deletion hides all its owned content and contributions.

A narrow native identity-proof purpose permits request status and cancellation, without ordinary business/private bodies or Evry. Cancellation stops strictly at the deadline, even if purge is late. It requires original account proof or the requesting current Owner's proof/authority. It restores only still-valid grants and a fresh sign-in opportunity, never another pending subject, old sessions, independently revoked access or cancelled provider mail.

At or after the deadline, purge only the exact eligible current request. Interrupted cleanup keeps normal access denied. Report completed live purge only when eligible database, file, cache and derivative content has actually been removed or scrubbed; an object-delete timeout is incomplete. Distinguish attempted cleanup, logical inaccessibility and confirmed provider cleanup. Copy expiry is at most seven days after completed live purge and never resets through recopy, organization ownership or restore.

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
