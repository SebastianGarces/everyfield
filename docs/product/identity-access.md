# Identity, access and account lifecycle

This is the operative target for IDN-001–028. Stable feature IDs retain their identity when a source mechanism is replaced or a capability is explicitly excluded. Requirements below are sufficient without the older decision/module chain. Better Auth supplies credentials and sessions; application-owned accounts, one current seat, organizations, relationships, People links and permissions remain domain data. All work-package implementation statuses remain `not_started`; every acceptance fixture is future work.

Native account/credential challenges remain native and never send passwords, reset tokens, mailbox proofs or cancellation-only identity evidence to Evry. Ordinary domain reads and nonpersistent drafts may run immediately under current authorization. Every durable Evry domain effect uses the same command as native UI, with exact human-reviewed fields, targets, generated effects and revisions. A title or a client-supplied account/tenant ID cannot create authority.

The physical model uses `app_account`, `organization`, `workspace_membership`, typed affiliation/invitation resources, domain receipts and the shared audit envelope. `organization` is typed plant, sending church or network; affiliation does not merge tenants. An account has at most one active workspace seat. Historical seat/relationship rows may coexist with that single active seat. Discovery is an explicit account profile without a seat, never an inference from a missing seat.


## Shared domain contracts


<a id="req-idn-029"></a>

### REQ-IDN-029 — Current actor and ordinary roles

Derive the actor from a validated current session and active account, then load the current exact tenant membership inside each operation. Same-workspace accepted Owner and Admin have equal routine administration. Owner alone requests church-workspace deletion. Member retains tenant reads and authenticated own-duty actions explicitly listed by the domain; Member does not gain interview/4 Cs/private intake, another account's credentials or broad administration. Exact organization Owner/Admin can edit that organization's profile and end only its own affiliation. Organization readers receive consent-filtered aggregates, never plant CRM. Lead planter is an ordinary visible ministry-role Person and grants nothing; a distinct operating lead receives an ordinary accepted Admin seat. Owner protection checks the actual Owner role, so ordinary Admins remain removable. No con figurable permission grid, title elevation, ownership-claim/designation/transfer/special-rejoin engine or simultaneous active-seat expansion is part of this target.

**Named cases:** TARGET-IDN-029, ROLE43-013.


<a id="req-idn-030"></a>

### REQ-IDN-030 — One resumable registration protocol

Use one explicit staged protocol. Better Auth credential creation may succeed independently. The associated `app_account.registration_state=pending_domain` has no workspace or relationship authority; any session can only prove self identity, read bounded registration status, resume or cancel. After authenticated proof for that credential identity, one short domain transaction locks account and invitation/subject, validates current expiry/address/revision, claims the token, provisions the exact seat or relationship, creates/links the Person where required, records the domain receipt and audit, and enqueues required security/notification mail intent. It changes registration_state to active only after those domain effects succeed together. A failed domain transaction keeps the unprivileged resumable identity and consumes no grant/token. Retrying the same intent resumes and returns the original complete receipt; a different existing account must authenticate instead of receiving a new grant from email equality. Existing-address resume UI asks the person to sign in or use native mailbox recovery without telling an inviter whether the account exists. Revoke/accept/expiry races have one serialized winner. Canceling incomplete registration invalidates its sessions and incomplete credential identity through the same tracked lifecycle; no grant can survive. Security-mail dispatch occurs after commit and its failure never rolls back an already valid account or misreports it as uncreated.

**Named cases:** TARGET-IDN-030.


<a id="req-idn-031"></a>

### REQ-IDN-031 — Private care is author-native only

Native private weekly care requires a current same plant Owner/Admin and immutable originalAuthorAccountId equal to the authenticated account. Account/Person linkage, role/title edits and Person merge never change that author. Only that author reads, records, corrects, or sees their own history/trends/support question. Correction preserves prior revisions and history; individual private-care entry deletion is not authorized. Private-care deletion occurs only through the approved account-lifecycle purge and retention contract in REQ-IDN-032. No private body, note, existence, week/calendar, count, streak, nudge, revision or indirect signal enters Evry tools/context/proposals, model input/output, retrieval, PI, organization DTO s, ordinary exports, notifications/email, shared audit feeds, request logs, traces or evaluation fixtures. Technical logging contains no event that confirms a particular private-care stream exists. Personal deletion purges the private author stream under the account lifecycle; it never transfers to another Owner/Admin. Restricted encrypted recovery must enforce the same author and current-deletion rules before access.

**Named cases:** TARGET-IDN-031, ROLE43-010, ROLE43-011, ROLE43-012.


<a id="req-idn-032"></a>

### REQ-IDN-032 — Finite deletion with restricted cancellation

Personal-login deletion is self-only and separate from Owner-only church-workspace deletion. Request commits active→pending_deletion with subject/request ID/revision, requestedAt and cancelUntil = requestedAt +30 elapsed days. The same commit revokes affected normal sessions/access, hides affected material and stops new reads/writes/signed issuance/dispatch. Retain eligible private identity/data/files solely for native cancellation, not normal content access. Fresh proof of the original account or requesting current workspace Owner permits only bounded status/cancel for that exact request. Cancel strictly before cancelUntil using the same row lock/revision as purge; at/after it refuse even if worker is late. Cancellation restores only still-valid independent grants, with new sessions; it cannot revive revoked affiliations, other pending subjects or canceled/sent provider effects. After the deadline, purge eligible live DB and private bytes coherently; partial failure remains hidden/purging and retryable. Set livePurgedAt only after coherent completion, then recoveryExpiresAt = livePurgedAt +at most 7 days; recopies never reset expiry. Isolated restore reapplies current non-content deletion/access witnesses and refuses expired/uncertain subjects before reopening. Personal deletion preserves church-owned shared records/documents and minimum necessary historical attribution; creator is not owner. Avatar/private care/account-owned files follow personal deletion. Work space deletion hides/purges its scope without affecting unrelated organizations. An Owner leaving a continuing workspace uses the accepted manual exception, with no transfer/rejoin product engine. Show exact deadlines and explain asynchronous provider cleanup, earlier bearer-URL TTL, already accepted mail, and public/downloaded copies: physical erasure at day 37 is not promised.

**Named cases:** TARGET-IDN-032.


<a id="req-idn-033"></a>

### REQ-IDN-033 — Stable native private weeks and support display

Native private care uses confirmed personal IANA timezone, distinct from church timezone, and Monday week boundaries. Missing personal-zone preference asks for confirmation, never silently adopts UTC/church/device zone. Each author has a stable week ID/ordinal with frozen start/end Instants, zone and Monday date. Serialize answer/save/correction/roll over/zone-edit against the author calendar revision. A zone edit records a pending transition at the first strictly future Monday boundary in the requested zone; keep the open stable week until that boundary and create exactly one next ordinal when roll over executes. Historical IDs/author/zone/revisions are never rekeyed; multiple date-line edits, retries and concurrent answer saves cannot create a second answer or extra week/streak credit. Current UI previews exact boundary before the native edit, with no private metadata in ordinary audit/log/Evry. Answer up sert requires the exact author/week/revision and unchanged save is no-op. History/trend remain available to the author; twelve recent weeks is the engineering initial view port with paged older history, never a retention limit.

Three truly adjacent answered weeks of Strained or Struggling in the same author/dimension raise a neutral native support question, for example “Would it help to talk with someone you trust?” Mixed Strained/Struggling qualifies; two weeks, cross-author/dimension, missing week or Steady does not. Correction recomputes display from effective records while retaining prior revisions. Date an older streak by its ending week and never label it current distress. No model counsel/pastoral judgment, email/org notice, task, PI invalidation or broad retention/former-author right follows from the question. REQ-IDN-031 governs every private path.

**Named cases:** TARGET-IDN-033, B03-019, B03-020, B03-021, B03-022, B03-023, B03-024, B03-025, B03-026, B03-027, B03-028, B03-029, B03-030, B03-031, B03-032, B03-033, B03-034, B03-035.


## Feature requirements

| Feature | Requirement | Target disposition | Owning packages |
|---|---|---|---|
| IDN-001 | [REQ-IDN-001](#req-idn-001) | retained | WP-005 |
| IDN-002 | [REQ-IDN-002](#req-idn-002) | retained | WP-005, WP-008 |
| IDN-003 | [REQ-IDN-003](#req-idn-003) | retained | WP-008, WP-009 |
| IDN-004 | [REQ-IDN-004](#req-idn-004) | development-only | WP-050 |
| IDN-005 | [REQ-IDN-005](#req-idn-005) | retained | WP-006 |
| IDN-006 | [REQ-IDN-006](#req-idn-006) | retained | WP-004, WP-010 |
| IDN-007 | [REQ-IDN-007](#req-idn-007) | retained | WP-005, WP-010 |
| IDN-008 | [REQ-IDN-008](#req-idn-008) | retained | WP-005, WP-010 |
| IDN-009 | [REQ-IDN-009](#req-idn-009) | retained | WP-005 |
| IDN-010 | [REQ-IDN-010](#req-idn-010) | retained | WP-010, WP-039 |
| IDN-011 | [REQ-IDN-011](#req-idn-011) | retained | WP-007, WP-010 |
| IDN-012 | [REQ-IDN-012](#req-idn-012) | retained | WP-010, WP-030 |
| IDN-013 | [REQ-IDN-013](#req-idn-013) | retained | WP-009, WP-011 |
| IDN-014 | [REQ-IDN-014](#req-idn-014) | superseded-source-mechanism-retained-onboarding | WP-009, WP-017 |
| IDN-015 | [REQ-IDN-015](#req-idn-015) | retained | WP-009, WP-038, WP-045 |
| IDN-016 | [REQ-IDN-016](#req-idn-016) | retained | WP-007, WP-009 |
| IDN-017 | [REQ-IDN-017](#req-idn-017) | retained | WP-008 |
| IDN-018 | [REQ-IDN-018](#req-idn-018) | excluded-by-approved-scope | scope disposition |
| IDN-019 | [REQ-IDN-019](#req-idn-019) | retained | WP-006, WP-008, WP-017, WP-024 |
| IDN-020 | [REQ-IDN-020](#req-idn-020) | retained | WP-007, WP-008 |
| IDN-021 | [REQ-IDN-021](#req-idn-021) | retained | WP-007 |
| IDN-022 | [REQ-IDN-022](#req-idn-022) | retained | WP-007, WP-030 |
| IDN-023 | [REQ-IDN-023](#req-idn-023) | retained | WP-047 |
| IDN-024 | [REQ-IDN-024](#req-idn-024) | retained | WP-047 |
| IDN-025 | [REQ-IDN-025](#req-idn-025) | excluded-by-approved-scope | scope disposition |
| IDN-026 | [REQ-IDN-026](#req-idn-026) | approved-target-addition-and-superseded-exceptions | WP-010, WP-007 |
| IDN-027 | [REQ-IDN-027](#req-idn-027) | consolidated-internal-alias | WP-007 |
| IDN-028 | [REQ-IDN-028](#req-idn-028) | retained | WP-005, WP-006, WP-050 |


<a id="req-idn-001"></a>

### IDN-001 — Sign-in, renewal, logout and safe return

**REQ-IDN-001.** Accept normalized email and native secret, give one invalid-credentials response, renew valid sessions and reject expired/revoked/deleted identities at every domain operation. Better Auth replaces custom session hashing/cookies; preserve 30-day session life with renewal after remaining life falls below 15 days, immediate authoritative revocation and convergent repeated logout. A safe local return path preserves path/query and rejects external, protocol-relative, backslash-leading and control-character attacks. Login remains reachable with an expired cookie, so recovery cannot loop. Use an atomic shared attempt budget: login failure thresholds 5/normalized identifier and 20/trusted IP in a strict 15 minute window; success clears only that identifier/kind's in-window failures. Unknown IP skips only that IP axis, never identifier checks. Deployment must overwrite trusted IP headers. Concurrent attempts reserve/check budget under the same store rather than relying on request-local counts; budget store failure refuses authentication with a retryable message, without authenticating silently.

**Target operations:** `auth.signIn`, `auth.signOut`, `auth.getSession`.

**Acceptance:** AC-IDN-001--IDN-001. **Named cases:** TARGET-IDN-001, ROLE43-018, ORG55-006.

**TARGET-IDN-001 fixture:** Known account; casing variants; 4/5 identifier failures and 19/20 IP failures just before/at 15 minute cutoff; null and forged IP; concurrent bad secrets; expired cookie with safe nested return; repeated logout. **Expected:** Threshold refusals and cleanup affect only intended axes. Concurrent admission respects the atomic limit; forged proxy headers do not select attribution; invalid cookie renders login, valid session redirects safely, revoke removes authority immediately.


<a id="req-idn-002"></a>

### IDN-002 — Registration and exact domain provisioning

**REQ-IDN-002.** Support planter, sending-church, network and explicit Discovery identities. Required normalized email, native password 8–1024 characters, display name and relevant organization name validate before effects. New organization provisioning produces that organization's Owner; planter onboarding produces one plant/Owner/Person; Discovery produces a profile without seat. Ordinary addressed invitations select only their advertised type/seat, never arbitrary user-sup plied grants. Apply REQ-IDN-030, a unique login identifier, one active seat and idempotent provisioning. Registration's IP admission budget counts every submitted registration attempt (including success, duplicate, malformed, beta/refused and concurrent requests) at 3/hour per trustworthy known IP, distinct from login; an unavailable trustworthy IP refuses registration admission with a retryable message instead of bypassing its sole creation axis. Store/query failures refuse before grant. Do not expose account existence to senders.

**Target operations:** `identity.register`, `identity.resumeRegistration`, `identity.getRegistrationStatus`.

**Acceptance:** AC-IDN-002--IDN-002. **Named cases:** TARGET-IDN-002.

**TARGET-IDN-002 fixture:** All 4 account types; concurrent same-email registration; successful, malformed, duplicate and beta-refused attempts sharing IP; credential success followed by failed grant; token revoked during resume. **Expected:** Only the advertised identity/domain exists; duplicate email cannot mint a second identity, failures remain unprivileged/resumable, and all submissions consume the declared atomic budget.


<a id="req-idn-003"></a>

### IDN-003 — Controlled rollout and meaningful invite origin

**REQ-IDN-003.** Retain an optional deployment-controlled beta gate, disabled by default for the fresh target unless explicitly enabled in that environment. An enabled gate accepts a valid configured code or an addressed live pending eligible invitation; forged, unrelated, expired or revoked invitations never bypass it. Account type choices follow the validated invitation subject. Show sufficient inviter/organization identity for informed acceptance, with no gate secret or sender-facing account-existence disclosure. Revalidate token and gate at submission.

**Target operations:** `identity.getRegistrationOptions`, `invitations.describeOrigin`.

**Acceptance:** AC-IDN-003--IDN-003. **Named cases:** TARGET-IDN-003.

**TARGET-IDN-003 fixture:** Gate enabled/disabled; valid/invalid code; all invitation subjects; wrong email, revoked and expired token; expire token while form open. **Expected:** Only configured code or exact live invitation bypasses an enabled gate; source description is meaningful and no secret/account enumeration leaks.


<a id="req-idn-004"></a>

### IDN-004 — Isolated fixture-account switching

**REQ-IDN-004.** Retain reproducible development/managed-preview persona switching only for fresh synthetic allow listed fixture accounts. The server checks explicit environment enablement, supported fixture ID and intended environment before issuing a fixture session. Production defaults disable and exclude the action/surface; flags or client role strings cannot create production privilege. Never clone real/customer accounts into fixtures.

**Target operations:** `development.switchFixtureAccount`.

**Acceptance:** AC-IDN-004--IDN-004. **Named cases:** TARGET-IDN-004.

**TARGET-IDN-004 fixture:** Production with flags absent and forged switch POST; isolated fixture environment with allowed and arbitrary account IDs. **Expected:** Production cannot issue a fixture session; isolated environment switches only seeded personas.


<a id="req-idn-005"></a>

### IDN-005 — Seats, exact tenancy and current guards

**REQ-IDN-005.** Implement REQ-IDN-029 with one active account-seat constraint, typed tenant identity and fail-closed handling of inconsistent membership rows. Enforce authority on the server and in the write transaction, independently of hidden/read-only UI controls. Own seat, Discovery relationship, exact organization oversight and platform allow list are distinct contexts, never pooled grants. Subject/own-duty guards remain narrower than generic routine administration. Return bounded DTO s; foreign/not-found records cannot disclose another tenant through detail, download, aggregate, cache or assistant paths.

**Target operations:** `identity.getActor`, `identity.requireScope`, `identity.readMembership`.

**Acceptance:** AC-IDN-005--IDN-005. **Named cases:** TARGET-IDN-005, ROLE43-001, ROLE43-002, ROLE43-006, ROLE43-009, ORG55-001.

**TARGET-IDN-005 fixture:** Owner/Admin/Member/Discovery/seatless/org/platform actors; malformed multiple-current-seat row; forged client capabilities; stale role after page load. **Expected:** Exact current server-derived context decides the action, inconsistent membership fails closed, and UI/native/Evry outcomes agree.


<a id="req-idn-006"></a>

### IDN-006 — Private account avatar lifecycle

**REQ-IDN-006.** Native self avatar upload accepts nonempty JPG/JPEG/PNG/WebP up to 3 MiB with generated private keys and verified type. Authenticate delivery through an account/version route; no arbitrary raw key or bearer storage URL is returned. Upload new bytes, atomically save version/reference/audit, then cleanup old unreferenced bytes. A failed row update retains old avatar and schedules orphan cleanup; failed old-byte cleanup leaves new avatar usable. Removal clears reference before cleanup. Account deletion follows REQ-IDN-032.

**Target operations:** `account.uploadAvatar`, `account.removeAvatar`, `account.getAvatar`.

**Acceptance:** AC-IDN-006--IDN-006. **Named cases:** TARGET-IDN-006, ORG55-006.

**TARGET-IDN-006 fixture:** A/Bac counts; wrong-type/empty/over 3 MiB uploads; failed reference write, failed old deletion and browser cached previous version. **Expected:** A cannot fetch B through arbitrary key; failure retains the correct current avatar, versioned replacement is visible, and referenced bytes are never cleaned.


<a id="req-idn-007"></a>

### IDN-007 — Mailbox-proved login email change

**REQ-IDN-007.** Native self requests normalized valid different email with current-password proof. Keep one live hashed purpose-bound request expiring after 24 elapsed hours; new request supersedes prior. Confirmation requires the authenticated request owner, live token, current email/credential revision and unique target address. Under one account lock, claim token, swap login email, invalidate outstanding reset/email requests, append audit and old-address security-mail intent exactly once. Preserve account/Person identity. Login-email change does not silently rewrite independently edit able CRM contact email. Throttle outstanding/failed requests by current own login identifier 3/hour and trusted IP 10/hour, so target-address changes cannot evade budget. Delivery failure reports send state while preserving truthful request state.

**Target operations:** `account.requestEmailChange`, `account.confirmEmailChange`.

**Acceptance:** AC-IDN-007--IDN-007. **Named cases:** TARGET-IDN-007, ROLE43-018.

**TARGET-IDN-007 fixture:** Two pending tabs; target address collision; wrong-account/expired/superseded token; password reset/change racing confirm; changing target addresses; non UTC process. **Expected:** One credential revision wins, no stale token resurrects it, identity remains stable, CRM contact remains independently edit able, and only own identifier/kind budget is cleared.


<a id="req-idn-008"></a>

### IDN-008 — Native password change and revocation

**REQ-IDN-008.** Require native current-secret proof for authenticated self, new 8–1024 character secret different from current, and immutable actor/current-session IDs from server. Lock account and compare credential/email revision; write new credentials, invalidate pending reset/email tokens, revoke all other sessions and append audit/security-mail intent atomically. Preserve only actual current session if still valid, report the other-session count. Independent password-change failure budget 5/own identifier and 20/trusted IP per 15 minutes; short/unchanged malformed requests validate without probing the new secret against the old before current-secret proof.

**Target operations:** `account.changePassword`.

**Acceptance:** AC-IDN-008--IDN-008. **Named cases:** TARGET-IDN-008, ROLE43-018.

**TARGET-IDN-008 fixture:** Stale password tabs, forged actor/current Session ID, wrong secret, competing reset/email confirmation and current vs other sessions. **Expected:** Only winning own credential changes; actual current session may remain and all others immediately revoke; stale requests cannot resurrect credentials or spare another account.


<a id="req-idn-009"></a>

### IDN-009 — Native mailbox password recovery

**REQ-IDN-009.** Return the same bounded response/latency class for syntactically valid existing/nonexisting addresses and mail failure. Each consumes the request budget 3/normalized email and 10/trusted IP per hour before lookup. One live hashed purpose-bound token/account expires after 1 elapsed hour; request rotates prior. Redemption binds account from token, checks live/unconsumed token and captured email/credential revision, validates confirmed 8–1024 character new secret, and atomically replaces credentials, consumes all reset/email requests and revokes every session. Do not auto-sign-in. Success remains success if security-notice dispatch later fails; provider/database request failures are bounded and observable internally without enumeration.

**Target operations:** `account.requestPasswordReset`, `account.resetPassword`.

**Acceptance:** AC-IDN-009--IDN-009. **Named cases:** TARGET-IDN-009.

**TARGET-IDN-009 fixture:** Missing/existing addresses; provider outage; expired/reused/foreign-purpose token; 2 concurrent redeemers; credential/email change first; non UTC process. **Expected:** Generic request does not enumerate. One valid redeemer wins, all sessions revoke, old proofs fail and successful reset is not reversed by notice failure.


<a id="req-idn-010"></a>

### IDN-010 — Settings, deep links and draft protection

**REQ-IDN-010.** Expose only known authorized account/church/association/team/organization/notification sections as typed DTO s. Preserve direct section URL s/hash compatibility, back/forward, focus/keyboard access and dirty draft protection across navigation/dismissal; a simpler shell is allowed. Preference auto save reports pending/error and restores server state on failure; rejected explicit save retains the user's draft. Server rechecks section owner/current scope/revision and cached results key exact actor/tenant. Personal timezone and deletion/cancellation native entry points integrate here; restricted deletion sessions cannot load normal settings.

**Target operations:** `settings.getSection`, `settings.saveSection`.

**Acceptance:** AC-IDN-010--IDN-010. **Named cases:** TARGET-IDN-010, ORG55-001.

**TARGET-IDN-010 fixture:** Owner/Admin/Member/org personas, deep link+back+Escape, dirty section switch, forbidden section, failed/stale save and account switching. **Expected:** Authorized sections work accessibly; dirty/rejected drafts survive, forbidden/current actor caches never leak, and cancellation-only session sees bounded deletion controls.


<a id="req-idn-011"></a>

### IDN-011 — Church profile, locality, timezone and inactivity

**REQ-IDN-011.** Owner/Admin edit plant name and independent nullable street/city/region/country/profile fields; validate trimmed nonempty name and bounded fields, IANA timezone, weekday 0–6/hour 0–23, inactivity warning/alert 1–365 with warning<alert. Fresh defaults are America/Chicago and weekly digest Sunday 16:00. Street is excluded from organization directory/oversight; configured locality uses the shared geography contract. Timezone changes preview future schedules/reminders; past instants, LocalDate deadlines and one-time appointments remain. Inactivity/overdue computations use church-local dates. Missing optional locality is not an inferred population/area.

**Target operations:** `churches.getSettings`, `churches.updateSettings`.

**Acceptance:** AC-IDN-011--IDN-011. **Named cases:** TARGET-IDN-011.

**TARGET-IDN-011 fixture:** Partial locality, explicit nullable clears, warning=alert, invalid zone, UTC day differing local day, zone-change future preview and street in oversight. **Expected:** Valid independent fields save with audit; invalid arithmetic refuses atomically; local badges/digest are stable across DST and oversight excludes street.


<a id="req-idn-012"></a>

### IDN-012 — Own notification preferences and suppression

**REQ-IDN-012.** Expose current audience's closed category/channel/daily-weekly cadence preference matrix and truthful suppression state. Save only the authenticated account's allowed preferences, with rollback/visible error on refusal. Self suppression-clear applies only its current proven mailbox and does not grant unrelated consent; enabled org push preference cannot override plant consent. Notification-owned scheduling/digest contracts provide actual delivery, including Sunday 16:00 default weekly digest. No private-care preference/nudge metadata reaches email or assistant.

**Target operations:** `notifications.getPreferences`, `notifications.updatePreferences`, `notifications.clearOwnSuppression`.

**Acceptance:** AC-IDN-012--IDN-012. **Named cases:** TARGET-IDN-012.

**TARGET-IDN-012 fixture:** A/Bus ers and plant/org audiences; unsupported category; plant sharing OFF while org push ON; own old vs current mailbox; failed auto save. **Expected:** Only A current allowable preference/address changes; audience and consent gates still hold, and UI reflects failure or suppressed transport honestly.


<a id="req-idn-013"></a>

### IDN-013 — Plant basics and one account-linked Person

**REQ-IDN-013.** For a proven eligible account create one plant, Owner membership, all-OFF self-start sharing settings and one stable account-linked CRM Person in the domain transaction. Trim required plant name; allow partial independent locality. Repeated intent returns the same plant; simultaneous seat acceptance/creation cannot create a second active seat, orphan authority or stray Person. Account-linked Owner is CRM leader-stage bootstrap history, not proof of commitment/adult eligibility. Actual church creation enters Phase 1, with a once-only church_creation history variant from no previous plant phase; it does not attest an existing journey or mark readiness/reading complete. Retry returns the actual current phase without overwriting later history. A successful basics step cannot be reentered to provision again. Global canonical seed is separate from customer creation.

**Target operations:** `onboarding.createPlant`, `identity.ensureOwnerPerson`.

**Acceptance:** AC-IDN-013--IDN-013. **Named cases:** TARGET-IDN-013, ROLE43-003, ROLE43-004, ROLE43-005, ROLE43-014, ORG55-006.

**TARGET-IDN-013 fixture:** Double-submit basics, failure before Person/settings/audit, seat acceptance race, partial city only, actual creation at 0/6 reading and no journey answer. **Expected:** One coherent plant/Owner/Person/settings set or no domain effects; bootstrap does not count commitment or attest an existing journey; creation enters Phase 1 exactly once.


<a id="req-idn-014"></a>

### IDN-014 — Ordinary lead-role onboarding

**REQ-IDN-014.** Retain the yes/no onboarding question as ordinary CRM/ministry-role data. Yes visibly assigns the ordinary lead ministry role to the existing Owner Person, reusing its role/container or creating only the shown minimal necessary role/container; no whole-template import occurs. A separate optional selected Senior Pastor template fill uses the ordinary membership operation and only a vacant selected role. No leaves routine Owner authority intact and shows no fabricated lead. A separate operating lead is a real Person with ordinary role and independently accepted Admin invitation where needed. The selected role/import preview discloses assignment, preserves an occupied/explicit leader and never copies readers/private care. Source vacant-owner claim/attestation privilege flows are superseded; no target operation activates authority from the answer. Missing lead title never suppresses required evaluation/follow-up: explicit eligible assignment or Needs owner remains visible.

**Target operations:** `identity.answerLeadOnboarding`, `teams.assignRole`.

**Acceptance:** AC-IDN-014--IDN-014. **Named cases:** TARGET-IDN-014, ROLE43-004, ROLE43-005, ROLE43-008, ROLE43-017, ORG55-004, ORG55-007.

**TARGET-IDN-014 fixture:** Owner yes/no/skip; ordinary lead role/container absent or present; optional Senior Pastor role occupied/selected; other CRM lead without account seat; finalization with no lead title. **Expected:** Yes creates only the reviewed necessary ordinary lead-role assignment; no/skip changes no authority or template structure; no account elevation. Required work exists even without a lead label.


<a id="req-idn-015"></a>

### IDN-015 — Attested journey, launch setup, finish and resume

**REQ-IDN-015.** Persist basics/lead answer/journey/People facts and derive resume from them. Optional steps may be skipped; finishing stamps onboarding completion once and material source revision without claiming all facts are complete or generating an assessment synchronously. Existing-journey declaration is optional human attestation, separate from actual creation-entry Phase 1. A saved unsure/discerning/skip answer can complete that setup step but is not an attestation and keeps actual creation Phase 1. It never silently maps back to Phase 0; later explicit validated reasoned phase correction remains available. Native launch plan accepts no-date and cannot clear an existing schedule accidentally during onboarding; phase and launch writes are a single reviewed resumable intent if they cannot share the short transaction. Back/reentry cannot rerun finished provisioning. Missing facts remain visible after finish; no mandatory six-article gate for actual Phase 1 creation.

**Target operations:** `onboarding.declareJourney`, `onboarding.complete`, `onboarding.getResume`.

**Acceptance:** AC-IDN-015--IDN-015. **Named cases:** TARGET-IDN-015.

**TARGET-IDN-015 fixture:** Skip each optional step; back after basics; fail launch/phase between saves; repeat finish; existing launch date+no-date selection; 0/6 reading at Phase 1 creation. **Expected:** Resume reflects durable facts and retries converge; completion/phase/source revision are attributable and no existing launch schedule or missing-fact truth is lost.


<a id="req-idn-016"></a>

### IDN-016 — Explicit Discovery and conversion

**REQ-IDN-016.** Maintain explicit Discovery profile and scoped sending-church/network relationships without any organization seat. Seatless former Member is not automatically Discovery. Conversion by the proven profile owner locks account/profile, creates plant at Phase 1 with once-only creation-entry provenance plus Owner/Person and transfers only chosen disclosed relationships/sharing choices in one domain transaction, retiring the Discovery profile with history. Associated Discovery must resolve/leave incompatible association before ordinary first-seat acceptance; no automatic tenancy move. Race conversion, relationship edit and invitation claim under the same account lock and one-active-seat arbiter.

**Target operations:** `discovery.getProfile`, `discovery.convertToPlant`, `discovery.leaveRelationship`.

**Acceptance:** AC-IDN-016--IDN-016. **Named cases:** TARGET-IDN-016.

**TARGET-IDN-016 fixture:** Discovery owner/foreign actor, seatless former Member, association ON/OFF conversion and conversion racing first-seat acceptance. **Expected:** Only true Discovery owner converts; one consistent seat/profile/relationship result survives and explicitly chosen consent is preserved.


<a id="req-idn-017"></a>

### IDN-017 — Ordinary invitation lifecycle and first-seat acceptance

**REQ-IDN-017.** Owner/Admin invite ordinary Admin/Member into their exact workspace. Keep addressed hashed purpose token, pending→accepted/expired/revoked, 30 elapsed-day expiry, at most 3 new invitation attempts per exact workspace/address in 30 elapsed days, persistent 60 elapsed-second resend cool down and one pending subject/address intent. Resend rotates token after current revision/cool down check; revoke/accept/resend race has one winner. Pending lists/sender responses redact account-resolution data. Proven existing seatless account may accept its first seat; new account uses REQ-IDN-030. Refuse already active-seat accounts, wrong mailbox, malformed target/type, expired/revoked/superseded token and incompatible associated Discovery rather than moving tenancy. Validate inside the claim transaction; mail retry returns the same invitation receipt.

**Target operations:** `seats.createInvitation`, `seats.listInvitations`, `seats.resendInvitation`, `seats.revokeInvitation`, `seats.acceptInvitation`.

**Acceptance:** AC-IDN-017--IDN-017. **Named cases:** TARGET-IDN-017, ROLE43-006, ROLE43-007, ROLE43-009.

**TARGET-IDN-017 fixture:** Plant/sending/network invites; new/existing seatless/already seated/associated Discovery; wrong address; concurrent accept/revoke/resend and response loss. **Expected:** Exactly one addressed valid first-seat claim wins and Person link is coherent; old token dies, no tenancy move or sender enumeration occurs.


<a id="req-idn-018"></a>

### IDN-018 — Coach invitation and assignment disposition

**REQ-IDN-018.** Coach invitation, assignment, acceptance, roster and access are excluded from this product build. Do not create dormant coach grants, tables, routes, assistant operations or DTO allowances. The immutable feature ID is retained as the explicit source disposition; organization affiliation and ordinary seats remain separate approved capabilities. A real external mentoring relationship may be dated human evidence without an in-app coach identity/grant.

**Acceptance:** AC-IDN-018--IDN-018. **Named cases:** TARGET-IDN-018.

**TARGET-IDN-018 fixture:** Forged coach invitation/assignment route or assistant request; external relationship attestation. **Expected:** No coach grant/surface/tool is registered; external human evidence cannot create app authority.


<a id="req-idn-019"></a>

### IDN-019 — Seat roster, ordinary role change and removal

**REQ-IDN-019.** Owner/Admin manage ordinary same-workspace Admin/Member seats under expected current role/revision. Protect actual Owner; deny self-promotion, foreign target, generic Owner removal and role changes that violate one-active-seat integrity. Joined date uses accepted invite provenance or clearly labelled original-account fallback. Removal revokes membership authority/sessions, retains CRM/account link and qualification/team history, clears access-dependent team leadership, and presents exact actionable-duty handoff to a currently eligible recipient or visible Needs owner. Closed/waived/deleted duties remain closed. Role/grant/duty/audit changes commit together, or return durable named moved/remaining outcomes; no generic success after partial hidden work. Removal is not account deletion/ownership transfer.

**Target operations:** `seats.listSeats`, `seats.setRole`, `seats.removeSeat`.

**Acceptance:** AC-IDN-019--IDN-019. **Named cases:** TARGET-IDN-019, ROLE43-001, ROLE43-006, ROLE43-007, ROLE43-008, ROLE43-009, ROLE43-017.

**TARGET-IDN-019 fixture:** Two Admin removals, actual Owner target, own self-promotion, foreign Member, role/leader appointment race, open and waived duties. **Expected:** Owner stays protected while ordinary Admins remain removable; removed access ceases immediately, history survives and only actionable duties enter explicit handoff.


<a id="req-idn-020"></a>

### IDN-020 — Independent typed relationship invitations

**REQ-IDN-020.** Support five scoped subjects: plant→sending church, plant→network, sending church→network, Discovery→sending church and Discovery→network. A plant Owner/Admin initiates its link; one exact receiving organization's Owner/Admin approves that organization, with no delegation or all-affiliate veto. Each link has independent state/consent and typed matching subject IDs. Keep normalized mailable recipient, 30 day expiry, at most 3 new invites/address in the rolling configured 30 day invitation window, no duplicate pending intent and exact readable inviter description. Creation/response/resend/revoke validates current actor/subject/revision. Multiple independent valid affiliations may coexist; competing acceptance cannot silently replace existing links or consent. Accepted receipt queues notice to plant, retries converge and mail failure does not undo a committed relationship.

**Target operations:** `relationships.createInvitation`, `relationships.respondInvitation`, `relationships.resendInvitation`, `relationships.revokeInvitation`.

**Acceptance:** AC-IDN-020--IDN-020. **Named cases:** TARGET-IDN-020, ROLE43-016, ORG55-002, AF-001, AF-002, AF-003, AF-004, AF-005, AF-006, AF-007, AF-008, AF-009, AF-010, AF-011, AF-012, AF-013, AF-014, AF-015, AF-016, AF-017, AF-018, AF-019, AF-020, AF-021, AF-022, AF-023, AF-024, AF-025, AF-026.

**TARGET-IDN-020 fixture:** All 5 subjects; plant has 2 networks+2 sending churches; invite approval by wrong/other affiliate Member; competing accepts+revoke; mail failure. **Expected:** Only initiator/exact receiving authorized actors act; valid independent links survive, receipt/notice is durable and no seat/CRM access or account enumeration is added.


<a id="req-idn-021"></a>

### IDN-021 — Own-link leaving and scoped history

**REQ-IDN-021.** An authorized subject-side Owner/Admin may leave exactly its own affiliation; exact own-org Owner/Admin may end only that organization's link with confirmation and retryable notice to the plant. Preserve other affiliations and independent access paths. Append typed actor/org/subject/source-invite/time/reason history for plant, sending-church and Discovery subjects; do not fabricate missing legacy history. Repeated sever returns the existing/no-effect receipt and no duplicate event. Current entitlement is removed immediately for that link's bodies/results/caches while minimal allowed relationship history remains. Returning through a new ordinary approved invitation preserves history and existing per-org consent; no special rejoin restoration engine.

**Target operations:** `relationships.leave`, `relationships.endOwnAffiliation`, `relationships.readHistory`.

**Acceptance:** AC-IDN-021--IDN-021. **Named cases:** TARGET-IDN-021, ROLE43-016, ROLE43-017, ORG55-002, ORG55-003, AF-001, AF-002, AF-003, AF-004, AF-005, AF-006, AF-007, AF-008, AF-009, AF-010, AF-011, AF-012, AF-013, AF-014, AF-015, AF-016, AF-017, AF-018, AF-019, AF-020, AF-021, AF-022, AF-023, AF-024, AF-025, AF-026.

**TARGET-IDN-021 fixture:** Plant linked 2 orgs; each side endsone; org Member/foreign Admin; repeat sever and queued notice failure; ordinary later invite. **Expected:** Only exact link ends, other valid grants remain, scoped history includes all subject kinds and retry converges without resurrecting old entitlements.


<a id="req-idn-022"></a>

### IDN-022 — Per-organization sharing and push consent

**REQ-IDN-022.** Store each accepted plant/org pair's approved aggregate categories and separate activity push consent. Self-start defaults all OFF; accepted first invitation discloses active categories default ON for that exact organization, with later independent ON/OFF changes. Never reset previous consent on rejoin or another-org acceptance. Retain People/Meetings/Tasks/Teams/Wiki aggregate categories, independent activity push consent, and the existing shared_findings permission for released health/NI findings. The closed category-to-column mapping is people→share_people, meetings→share_meetings, tasks→share_tasks, ministry_teams→share_ministry_teams, wiki→share_wiki, activity→share_activity, shared_findings→shared_findings. Activity remains independently stored push consent in the same sharing command; shared_findings is one existing permission, with no second NI consent. Finance/facility/background/coach/private-care categories are absent. Missing relationship/settings fail closed. Turning a category OFF stops new reads/results/cache reuse/dispatch from it, without hiding the basic relationship directory or unaffected affiliates; coarse relationship notice must not name restricted toggle or body. Org preferences cannot authorize pull data.

**Target operations:** `relationships.getSharing`, `relationships.setSharing`.

**Acceptance:** AC-IDN-022--IDN-022. **Named cases:** TARGET-IDN-022, ROLE43-016, AF-027, AF-028, AF-029, AF-030, AF-031, AF-032, AF-033, AF-034, AF-035, AF-037, AF-038, AF-039, AF-040, AF-041.

**TARGET-IDN-022 fixture:** Twoorgs with mixed category ON/OFF; simultaneous acceptance; rejoin; missing settings; push preference ON while category OFF. **Expected:** Consent is independent and preserved; each org sees only currently allowed aggregates, no CRM/private fields, and relationship listing persists.


<a id="req-idn-023"></a>

### IDN-023 — Organization directory and consent-filtered oversight

**REQ-IDN-023.** List only current own-org related plants. Basic directory gives plant name/partial locality excluding street, attested phase/launch context, provenance and ordinary lead ministry-role Person display name (not assumed Owner); no contacts/private CRM. Aggregate sections distinguish withheld, shared-empty, shared-populated and unavailable: distinct People/status totals, recent 12 meeting cadence/attended totals, top-level actionable task counts/overdue, operational team/staffing/training coverage and Wiki reading counts. Each section uses its current consent and domain denominator; checklist/waived/cancelled tasks cannot inflate open counts. Organization intelligence/health uses its separate exact-org consent/release lineage and published-summary producer; same native/Evry bounded read. Sharing OFF/revoked affiliation removes cached/current/history body access that depends on it; unknown/foreign target is indistinguishable.

**Target operations:** `oversight.listPlants`, `oversight.getPlantOverview`, `oversight.getHealth`.

**Acceptance:** AC-IDN-023--IDN-023. **Named cases:** TARGET-IDN-023, ORG55-003, ORG55-004, ORG55-005, AF-027, AF-028, AF-029, AF-030, AF-031, AF-032, AF-033, AF-034, AF-035, AF-037, AF-038, AF-039, AF-040, AF-041.

**TARGET-IDN-023 fixture:** OrgA/Blinked plants, no lead vs Owner≠lead, each category withheld/empty/populated, revoked link cached result, closed task+checklists, local count down. **Expected:** Exact directory displays ordinary lead name without contacts; aggregates agree with domain and current consent, revoked body never returns and emptiness does not pretend withheld equals zero.


<a id="req-idn-024"></a>

### IDN-024 — Network sending-church roster

**REQ-IDN-024.** Network readers list/detail only sending churches currently associated with that exact network and pending unexpired scoped relationship invitations. Member detail lists only plants that both relate to that sending church and separately have a valid same-network relationship; parent hierarchy does not manufacture plant access. Counts exclude expired/revoked invitations and foreign-network plants. Empty states explain actual scope; links go through current per-plant consent-filtered overview. Sending-church seat does not gain network roster authority.

**Target operations:** `oversight.listSendingChurches`, `oversight.getSendingChurch`.

**Acceptance:** AC-IDN-024--IDN-024. **Named cases:** TARGET-IDN-024.

**TARGET-IDN-024 fixture:** Network A/B, sending church Slinked A, plants Pwith S+Aand Qwith S+B, expired pending invite; Sending church Member request. **Expected:** Asees S/P only and correct pending counts; Qand B remain unavailable, sending-church actor is denied and linked plant still uses consent.


<a id="req-idn-025"></a>

### IDN-025 — Coach read surfaces disposition

**REQ-IDN-025.** Coach plant collections/detail/photo/qualification/document read surfaces and all assignment-based exceptions are excluded from this product build. Preserve this feature's explicit source disposition without allowing it to widen organization aggregate or ordinary Member read scope. No coach-only authenticated context or assistant tools are registered.

**Acceptance:** AC-IDN-025--IDN-025. **Named cases:** TARGET-IDN-025.

**TARGET-IDN-025 fixture:** Guess coach collections/detail/download paths and ask Evry to use an assignment read. **Expected:** No target coach surface/grant/tool resolves; existing org or Member authority is not expanded.


<a id="req-idn-026"></a>

### IDN-026 — Organization profile and separate personal/workspace deletion

**REQ-IDN-026.** Implement the accepted target follow-through for formerly unwired organization settings: exact own sending-church/network Owner/Admin edit bounded name/contact/profile fields with protected org kind/identity, current revision and audit. No billing, ownership transfer, delete-org or wider intelligence/CRM access is implied. Personal self deletion and Owner-only church workspace deletion follow REQ-IDN-032 with explicit review, shared church history/minimal attribution and restricted native cancellation. Admin/Member/CRM lead cannot delete workspace or another login. Leaving Owner who keeps church running uses external manual exception; no claim/transfer/special rejoin UI.

**Target operations:** `organizations.getProfile`, `organizations.updateProfile`, `account.requestDeletion`, `churches.requestWorkspaceDeletion`.

**Acceptance:** AC-IDN-026--IDN-026. **Named cases:** TARGET-IDN-026, ROLE43-002, ROLE43-017, ROLE43-018, ORG55-001, ORG55-006, ORG55-007, ORG55-008.

**TARGET-IDN-026 fixture:** Own org Owner/Admin/Member+foreign org; change org kind; personal self versus another account; plant Owner/Admin deletion; pending cancel. **Expected:** Only allowed own org profile fields change with audit; exact self/Owner deletion rules and finite cancel hold apply without authority expansion.


<a id="req-idn-027"></a>

### IDN-027 — Direct disassociation helper disposition

**REQ-IDN-027.** Uncalled direct-FK-null helpers are not separate user operations. Replace their alias semantics with the actor-bearing, typed, versioned, audited exact-link commands of IDN-021. No unguarded disassociate helper appears in the native or assistant target catalog; every relationship end shares receipt/history/notice and current entitlement removal.

**Target operations:** `relationships.leave`, `relationships.endOwnAffiliation`.

**Acceptance:** AC-IDN-027--IDN-027. **Named cases:** TARGET-IDN-027, ROLE43-016, ORG55-002.

**TARGET-IDN-027 fixture:** Direct helper alias request and ordinary exact-link sever; forged equivalent FKwrite. **Expected:** Alias resolves to guarded typed sever or no public operation; unguarded write cannot bypass audit/consent.


<a id="req-idn-028"></a>

### IDN-028 — Request admission, CSRF and honest session routing

**REQ-IDN-028.** Cookie presence may optimize GET routing but never proves authentication. Login/session recovery remains reachable; every private route/API/action validates current session and subject. Overwrite any internal routed-URL stamp with the real URL; crawler scope is derived from real allow listed public Wiki path plus UA and returns only approved public metadata, never trusted client crawler/stamp headers. Mutating browser requests require configured canonical scheme/host/port Origin, with trusted deployment Host validation; reject missing/malformed/cross origin and HEAD/OPTIONS mutation attempts under the declared allow list. Exact independently authenticated exception routes are Resend raw-body signature webhook and sealed disable-only unsubscribe POST; GET unsubscribe is read only confirmation, wrong/expired/purpose tokens uniformly fail without mutating. Undo uses separate enable-only short proof and normal native origin. Jobs have a distinct bounded signed job end point admission, never a broad origin less prefix bypass. Safe return rejects external/protocol relative/backslash/control chars. Each admitted request still executes authoritative domain policy.

**Target operations:** `identity.validateRequestBoundary`, `identity.safeReturn`.

**Acceptance:** AC-IDN-028--IDN-028. **Named cases:** TARGET-IDN-028.

**TARGET-IDN-028 fixture:** No/forged/expired/revoked cookie every private family; forged Wiki headers/crawler UAon People/settings; same host different scheme/port; origin less look alike webhook/unsubscribe/job; valid signatures/purpose tokens; GET unsubscribe. **Expected:** No cookie/header/crawler trick grants private access; stale login recovers without loop, exact machine proofs admit only their purpose, GET cannot write and domain authority rechecks after admission.


## Consumer closure and proof

Implementation remains `not_started`. Execute the named future cases through real domain requests, disposable PostgreSQL constraints/races/fault injection and native/reviewed-Evry browser paths where surfaced. Prove current authorization again at execution; no test/source count or file presence is runtime proof. Include registered Person references, current source-revision writes, exact partial/committed receipts, correction limits and failure outcomes at each owning consumer closure. Domain adapter files are owned by their specific feature packages; shared Evry runtime/catalog/review UI has one integration owner.

## Affiliation settings category adapter

Affiliation settings use the same exact-organization category policy as privacy.setSharing: teams maps to ministry_teams and activityPush maps to activity; shared_findings is the single released-health/NI permission. An omitted category preserves its stored value. A nonempty closed patch binds current relationship and consent revisions, accepts only actual same-plant Owner/Admin, and commits through the shared organization helper in one domain transaction. Organization roles cannot edit plant consent; stale/missing/revoked policies refuse without reset or partial effects. Exact operation fields and mappings are in `settings.saveSection`; `TARGET-IDN-010` includes the saved-policy, omitted-field, explicit-findings and stale-revision cases.
