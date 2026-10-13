# Authentication and domain acceptance

Better Auth is the sole owner of credentials, session cookies, recovery and verification. Application domain grants remain separate. The chosen protocol is **staged credentials followed by atomic domain acceptance**. Better Auth and the domain UoW are not assumed to share an interactive transaction, even though they use the same PostgreSQL database. A later compatible shared-driver optimization cannot change these externally visible guarantees without revising this contract.

## Registration protocol

1. Normalize and validate the intended account/invitation operation, bound rate and body limits, and create or authenticate the Better Auth identity through its supported Next integration. New `app_account` state is `pending_domain`. No seat, Person ownership or organization grant is inferred from credential success.
2. A pending authenticated session may access its own resume/status/cancel, verification and necessary account controls. It cannot read or mutate plant/organization business data, use Evry tools, claim a different person's identity, or treat an invitation preview as a grant. Discovery/self-only features become eligible only after an explicit accepted account domain stage.
3. `acceptRegistrationDomain` begins the short PostgreSQL UoW, locks the account and invitation/target, rechecks current proof, token hash/expiry/revocation and exact recipient/subject, checks the current single-seat rule and inviter authority, and verifies the persisted normalized intent digest. It atomically claims the token, creates the exact seat or permitted discovery relationship, creates/links any required same-plant Person, marks domain activation, and writes the command receipt, platform audit and required security-mail intent.
4. After commit, a fresh authorization lookup sees the new grant. Mail dispatch uses the shared intent ledger. A retry with the same accepted digest returns the original receipt; it cannot create a second seat, Person, phase entry or mail intent.

Credential creation may succeed while domain acceptance fails. The login remains unprivileged and resumable. The UI explains that sign-in exists and setup is incomplete, then resumes only after real authentication or verified mailbox proof. It never treats knowledge of an email address/token preview as account ownership or reveals whether another account exists. There is no compensate-after-success promise that silently deletes a valid pre-existing credential identity.

## Failure and concurrency contract

| Failure point | Persisted state | Authorized next step |
|---|---|---|
| Before credential commit | No new identity | Ordinary retry with non-enumerating response |
| Credential succeeds, app-account/domain stage interrupted | Credential principal; no domain grant | Authenticate, upsert the unique app-account row and resume saved intended operation |
| Token already revoked/expired/wrong recipient | Existing identity remains; no new grant | Safe refusal; authorized ordinary invitation path, never resurrection |
| Person/link/audit/intent insert fails | Entire domain transaction rolls back, token unclaimed | Same digest retry after fault correction; pending identity still has no authority |
| Two accepts or revoke versus accept | Locked invitation/account and unique seat choose one legal winner | Loser receives same receipt or safe conflict/refusal; no partial grant |
| Domain commit succeeds but response/session refresh is lost | One saved receipt and grant | Authenticate/fresh session lookup and return receipt; no repeat provisioning |
| Same idempotency key, changed recipient/role/intent | Original receipt unchanged | `idempotency_conflict`; new reviewed operation required |
| Pending identity abandoned | No durable business authority | Self cancellation through identity proof; normal account lifecycle/purge applies, no customer-grant cleanup fiction |

Actual new plant creation is a separate atomic domain command: lock the account/seat, insert plant, Owner membership, same-plant Person/link, and exactly one creation-origin Phase 1 transition plus receipt/audit/intents. Existing-plant/race-winner retries do not append another creation event. Unsure/skip setup does not invent a prior phase or consume the later existing-journey declaration slot. Discovery reading/readiness is never a prerequisite for creation.

## Sessions and sensitive account changes

Authenticate using Better Auth's actual session verification and revocation, not cookie presence, layout checks, client actor IDs or a stale render cache. At each durable operation re-read live account/grant revisions and relevant lifecycle. One active account seat is enforced by a partial unique index; it does not imply account/Person identity or hierarchy inheritance. Owner/Admin have routine plant parity; Owner alone requests plant deletion. The ordinary ministry lead title adds no grant.

Select PostgreSQL database sessions with adapter transactions enabled, no secondary session store and cookie caching disabled. Preserve 30 day session expiry and renewal after 15 days, with one-hour reset-proof expiry. Password input preserves minimum 8 and maximum 1024 characters; unchanged secret is refused. Login/password-change budgets are five failures per normalized own identifier and 20 per trusted IP in 15 minutes; reset requests are three per normalized identifier and 10 per IP inonehour. Null trusted-IP skips that axis rather than inventing an address; success clears only relevant identifier/kind failure state and throttle rows expire within 24 hours. Concurrent reservations/checks must implement those bounds under actual storage proof, not source check-then-record timing.

Better Auth documents configurable model/field names and UUID generation, before hooks that can alter/refuse a write, and after hooks that run after commit. Server-owned extra fields must reject input and be withheld from returned DTOs. These API facts support the chosen integration boundaries; they do not establish the custom stale-generation fence. [Better Auth database integration](https://better-auth.com/docs/concepts/database).

For database sessions with adapter transactions enabled, documented password-change/reset paths can combine credential update and session revocation; cookie cache can delay observed revocation. This target therefore disables cookie cache and secondary session storage. [Better Auth session management](https://better-auth.com/docs/concepts/session-management), [password reset options](https://better-auth.com/docs/reference/options). Actual pinned-driver hooks/SQL behavior remains AUTH-005/008 proof.

Sensitive credential, recipient-address, suppression-restoration and deletion-cancellation operations require fresh actual account/mail proof. The implementation freezes supported Better Auth freshness, renewal and verification settings and proves them under AUTH-005/AUTH-008 before use. CRM email changes are explicit domain policy, never an implicit identity merge.

## Adapter-owned security mutation protocol

Better Auth auth-user/account/session/verification rows do not use blanket application command CAS or PI material revisions. For a significant credential operation, a short domain transaction saves an `operation_execution`/`operation_effect` security intent, the expected credential generation and any eligible current-session reference, sets `app_account.auth_mutation_state=pending`, and records `identity.credential_change_intended`. Intent stores no password or proof token. Pending/uncertain state denies ordinary domain authority; only the native actual identity-proof/status/resume path is eligible.

The request calls the supported Better Auth adapter outside that domain transaction. Its selected hook/SQL integration atomically binds credential change to a new `auth_account.credential_revision` and `security_operation_id` in the adapter-owned statement/transaction, and issues/updates sessions with the credential generation actually verified. It must reject stale password/reset/email-change proof and stale concurrent sign-in before granting a session of the new generation; merely stamping the current epoch after old-password verification is forbidden. This supported mapping/fence is a hard AUTH-005/008 compatibility gate, not a claim that the adapter presently implements it and not a second credential owner.

On verified success, a short domain transaction checks the exact operation marker/generation, adopts it into app-account authority, records the truthful credential/session outcome and security-mail intent, saves its receipt and clears the pending fence. On known unchanged failure it records failure and clears the fence against the original generation. Lost/ambiguous outcome stays `reconcile`; the restricted reconciler reads the adapter marker/generation and session/proof state before recording any success. It never stores or blindly replays a password asynchronously. Marker/hook/epoch incompatibility blocks the affected credential slice before deployment; an unverified failure does not restore stale session authority. Initial registration may have a credential identity before the app-account row; all domain access denies until authenticated resume creates the unique pending row and records a truthful observed/reconciled outcome.

| Operation | Session authority after verified completion | Verification and race requirement |
|---|---|---|
| Password change with correct current proof | Preserve/rebind only the explicitly authenticated current session; revoke/deny every other old-generation session | Invalidate stale reset and email-change proofs; old-password concurrent login cannot obtain a new-generation session |
| Mailbox password reset | Revoke/deny all prior sessions; new sign-in/proof issues only against the new generation | Single-use mailbox token and expected generation; stale competing reset/change cannot overwrite the winner |
| Email change after exact mailbox proof | Preserve/rebind only eligible initiating current session if still valid; revoke/deny other prior sessions | Normalize unique new address; require current credential generation and verified intended mailboxes; invalidate stale recovery/email-change proofs and deliver required security notices |
| Logout | Revoke the addressed live session; repeated logout is a safe no-op | Does not clear another account/session or invent a credential rotation |
| Account/plant deletion request | Revoke/deny all affected ordinary sessions immediately | Separate narrow cancellation proof only; cancellation never revives prior sessions |

Security notices use the same mail intent/attempt ledger and omit credential/address/token values from audit metadata. Any adapter revocation still pending is fenced by generation/operation state so old sessions cannot exercise app authority while cleanup/reconciliation completes.

Recovery and invitation sender endpoints remain non-enumerating under malformed/expired tokens, repeated requests, unknown accounts and limiter bursts. Trusted ingress determines client IP; a caller cannot choose forwarding/actor headers. Throttle state is bounded and expiring, segregated by normalized identifier, trusted-IP key and operation kind; success clears only the relevant own identifier/kind state. Credential hashes, token/session secrets and auth cookies never enter user DTOs, model context or telemetry.

## Deletion-only proof and shared records

At an account or Owner-authorized plant deletion request, the transaction records the request ID/revision and exact 30 day deadline, revokes normal affected authority/sessions, hides the retained cancellation-only material, stops new reads/writes/signing/dispatch and cancels/reconciles existing effects. A narrow native proof path can show status or cancel strictly before the deadline. It cannot open ordinary business data, private histories or Evry. Cancel and purge fence the same request revision; cancellation after the deadline is refused even if purge is delayed.

Cancellation restores only currently valid own access and separately revalidated grants. It does not revive old sessions, independently revoked roles/affiliations or canceled provider sends. At eligible live purge private documents/chats/check-ins/credentials/objects are removed; shared Person, training, meeting and Launch history survives with minimal scoped deleted-account attribution. The last required plant Owner is a real blocker requiring approved manual resolution, not a new transfer/claim-vacancy product. Completed live purge starts the seven further days of recovery-copy eligibility; a current witness prevents resurrection after restore.

The physical auth-table mapping is a target schema contract. WP-003/004/005 must validate that the pinned Better Auth adapter/hooks can implement it, including session renewal/revocation, value/token storage and verification atomicity. If the mapping fails, stop the affected auth slice and repair this design within the selected Better Auth stack; never substitute a second credential system or claim an untested shared transaction.

Future proof: AUTH-001–008, SCHEMA-002, TEN-002/005/007, SEC-03/06/07 and DEL 58 cases. All remain unrun.
