# Tasks, recurrence and the obligation persistence kernel

This is the target for TSK-001–016. Owner/Admin administer tasks; a Member acts only on a task currently assigned to their actual account, including its named checklist/outcome operations. Read access, own-duty write, general edit/assignment and team-leader authority are separate. Use [current role policy](identity-access.md#req-idn-029), [Person reference registration](people.md#req-ppl-024) and [follow-up outcome contracts](meetings-follow-up.md#req-mtg-021).

Task states are `not_started`, `in_progress`, manual `blocked`, `complete`, and `no_longer_needed`; soft deletion is separate. Actionable excludes complete/no_longer_needed/deleted. Parent tasks and checklist rows have separate counts. Prerequisite blocking is advisory and differs from manual blocked. Current completion is human duty evidence, not automatic actual contact, commitment, training or readiness. Each accepted change uses a durable operation receipt, expected revisions, attributable domain status history and shared audit with required effects/source revision in the transaction. External reminders dispatch from durable intent and report their actual outcome.


## Shared domain contracts


<a id="req-tsk-017"></a>

### REQ-TSK-017 — Smallest WP-024 kernel before finalize

WP-024 owns a transaction-bound API accepting the caller's database connection: ensure immutable obligation key, ensure managed task, update current task/obligation state, append status history, audit/operation receipt and required reminder intent. It supplies uniqueness `(tenant, originKind, originMeeting, Person, obligationKind)`, protected source identity, one active managed task per obligation, current revision and explicit unowned state. Meeting evaluation tasks use separate meeting/kind identity and do not require Person. A no_longer_needed obligation persists even if its task is edited/soft-deleted and forbids regeneration; current source correction may mark applicability superseded with history. No outcome reporting, generic work flow interpreter, independent task transaction or provider call is required in this kernel. WP-022 invokes it in the same finalization UoW; direct dependency WP-024→WP-022 is mandatory. WP-023 owns later typed outcomes/contact/eligible ownership/handoff. Kernel closure proves physical constraints/replay/fault rollback with actual WP-022 consumer at that consumer's closure, not only a stub or final regression.

**Named cases:** TARGET-TSK-017.


<a id="req-tsk-018"></a>

### REQ-TSK-018 — Time types and deterministic DST resolution

Use distinct LocalDate, entered LocalDateTime +IANA zone+selected offset and resolved UTC Instant. A date-only task remains due throughout its stored church-local day and becomes overdue at next local-day start, even on 23/25 hour DST days. A timed deadline compares resolved Instant; undated stays undated/Unknown. Entered gap time refuses save and asks for a valid choice; entered fold displays both offsets and requires occurrence selection. Automatic recurring wall schedules use resolver version 1: earlier occurrence on fold, shift forward by the actual gap duration on gap, once per logical period/recipient regardless of retry. All-day due notice engineering default 09:00 church-local on due day; overdue notice 09:00 next local day. A timed due notice is at deadline and overdue notice 24 elapsed hours later; reminders do not redefine deadline state. Meeting 7/3/1 offsets are civil days retaining local wall clock, with the same automatic resolver and disclosed labels. Future timezone change previews boundary/recurrence/reminder changes, commits preference+replanning intent under expected revision, preserves all stored LocalDate values/past instants/one-time future appointment instants, and does not resend delivered logical slots. Personal private-care weeks use confirmed author timezone separately; changing church zone never rekeys them. Runtime clock/asOf is injected/frozen and independent of host timezone; expiry/deletion uses elapsed UTC Instants.

**Named cases:** TARGET-TSK-018, B03-001, B03-002, B03-003, B03-004, B03-005, B03-006, B03-007, B03-008, B03-009, B03-010, B03-011, B03-012, B03-013, B03-014, B03-015, B03-016, B03-017, B03-018, B03-036, B03-037.


## Feature requirements

| Feature | Requirement | Target disposition | Owning packages |
|---|---|---|---|
| TSK-001 | [REQ-TSK-001](#req-tsk-001) | retained | WP-024 |
| TSK-002 | [REQ-TSK-002](#req-tsk-002) | retained | WP-025 |
| TSK-003 | [REQ-TSK-003](#req-tsk-003) | retained | WP-025 |
| TSK-004 | [REQ-TSK-004](#req-tsk-004) | retained | WP-023 |
| TSK-005 | [REQ-TSK-005](#req-tsk-005) | retained | WP-025 |
| TSK-006 | [REQ-TSK-006](#req-tsk-006) | retained | WP-025 |
| TSK-007 | [REQ-TSK-007](#req-tsk-007) | retained | WP-025 |
| TSK-008 | [REQ-TSK-008](#req-tsk-008) | retained | WP-025 |
| TSK-009 | [REQ-TSK-009](#req-tsk-009) | retained | WP-026 |
| TSK-010 | [REQ-TSK-010](#req-tsk-010) | retained | WP-026 |
| TSK-011 | [REQ-TSK-011](#req-tsk-011) | retained | WP-023 |
| TSK-012 | [REQ-TSK-012](#req-tsk-012) | retained | WP-023 |
| TSK-013 | [REQ-TSK-013](#req-tsk-013) | retained | WP-023 |
| TSK-014 | [REQ-TSK-014](#req-tsk-014) | retained | WP-024 |
| TSK-015 | [REQ-TSK-015](#req-tsk-015) | retained | WP-024 |
| TSK-016 | [REQ-TSK-016](#req-tsk-016) | retained | WP-026 |


<a id="req-tsk-001"></a>

### TSK-001 — Task queues, filters and keyset paging

**REQ-TSK-001.** Preserve My/All/Assignments, title search, closed status/priority/category/relation filters and sorting due/priority/status/title/created. Page default 50/max 100 with stable sortkey+ID cursor and null due last. Counts use exactly the same current query scope, counting top-level tasks separately from checklist sub tasks. Team filter applies to My/All, not independent Assignments contact-coverage view; foreign/unavailable team reveals no name/rows. Filter navigation/clear retains siblings and resets cursor. Deleted cursor either resumes from signed stored sort tuple or returns explicit reset, never silently skips/leaks.

**Target operations:** `tasks.list`, `tasks.count`, `tasks.followUpCoverage`.

**Acceptance:** AC-TSK-001--TSK-001. **Named cases:** TARGET-TSK-001.

**TARGET-TSK-001 fixture:** 51 equal-key tasks, null due, deleted cursor, 2 sub tasks, My/All team filter and Assignments, foreign team. **Expected:** Stable complete paging/counts, separate child units and truthful filter/Assignments semantics.


<a id="req-tsk-002"></a>

### TSK-002 — Atomic task create/edit/delete

**REQ-TSK-002.** Full/quick task retains trimmed nonempty bounded title, safe description, state/priority/category, optional LocalDate/time, current same plant assignee, person/meeting/team relation, parent, recurrence and prerequisites. Reject facility relation and malformed/mismatched relation pair; explicit null clears. Generated obligation/evaluation relation/source identity is protected from ordinary edit. Validate/lock task, graph, series and related subjects; edit+status+prerequisites/history/receipt/intent commit all or none, with no failed response after hidden title change. Soft-delete parent+children coherently; generated obligation/history persists. Parent deletion reviews consequences and cancels live reminders without erasing already performed evidence.

**Target operations:** `tasks.create`, `tasks.edit`, `tasks.delete`.

**Acceptance:** AC-TSK-002--TSK-002. **Named cases:** TARGET-TSK-002.

**TARGET-TSK-002 fixture:** Whitespace title, invalid date/foreign assignee/facility, failing prerequisite edit, protected generated relation change, parent delete with children. **Expected:** Valid coherent task or zero effects; no partial edit/orphan compensation and protected obligation/history cannot be bypassed.


<a id="req-tsk-003"></a>

### TSK-003 — Completion, reopen and own-duty outcomes

**REQ-TSK-003.** Recheck actual assignee/current authority inside transaction; Member completes/reopens only own duty, Owner/Admin any current same plant task. CAS completion stores effective completion Instant/actor, status history and required successor/outcome effects atomically. Same intent retry returns original receipt and no duplicate event. Reopen clears current completion projection but retains prior history and recomputes current metrics/contact evidence where affected; it does not forge past success or unsend delivery. Recurring older occurrence reopen fails if another open successor exists and names it. Parent completion remains explicit human judgment. Person linked administrative completion never implies contact.

**Target operations:** `tasks.complete`, `tasks.reopen`, `tasks.changeStatus`.

**Acceptance:** AC-TSK-003--TSK-003. **Named cases:** TARGET-TSK-003.

**TARGET-TSK-003 fixture:** Assignee changed after preview, Member other duty, double complete/lost response, reopen older recurrence with open successor and person administrative task. **Expected:** Current own-duty and one completion result; history survives reopen, successor conflict named and no invented contact.


<a id="req-tsk-004"></a>

### TSK-004 — No longer needed without success credit

**REQ-TSK-004.** Retain no_longer_needed as closure distinct from complete. It suppresses open/overdue/due notices and actionable follow-up warnings but earns no successful task/48 h/contact credit. Generated immutable obligation records waiver permanently; edit/soft delete/replay/legacy fallback cannot regenerate waived task. Explicit reopen/correction with current revision changes current state while preserving waiver history and one active obligation task. No bulk complete implicitly converts waiver into success.

**Target operations:** `tasks.waive`.

**Acceptance:** AC-TSK-004--TSK-004. **Named cases:** TARGET-TSK-004.

**TARGET-TSK-004 fixture:** Waive generated task then edit/delete/reconcile; counts/notifications/metric; explicit reopen and bulk complete mixed states. **Expected:** Waiver remains closed without credit/regeneration, explicit history/correction only changes current state.


<a id="req-tsk-005"></a>

### TSK-005 — One-level checklist subtasks

**REQ-TSK-005.** One parent level only: deny nesting/self parent/cycles and turning task with children into child. New child inherits the parent assignee when omitted. Owner/Admin may explicitly choose a currently valid same-plant assignee or null; a Member may create only under their own currently assigned parent and inherits their own assignment, with no other-account or null override. Tick/untick/reopen uses the actual child assignee for Member own-duty. Child tasks have no deadline, recurrence, obligation, completion automation or contact hook; inert template definitions create real child Tasks, with no separately persisted checkbox completion state. Subsequent parent edit previews intended child assignment changes rather than silently moving others. Child tick/untick has own completion history/current own-duty policy; parent never auto completes. Parent delete soft deletes children with history. Recurrent successor copy resets every checklist item, clears child due dates and completion facts, and copies no contact/outcome hooks.

**Target operations:** `tasks.listSubtasks`, `tasks.createSubtask`, `tasks.setSubtaskCompletion`, `tasks.removeSubtask`.

**Acceptance:** AC-TSK-005--TSK-005. **Named cases:** TARGET-TSK-005.

**TARGET-TSK-005 fixture:** Child nesting/self/cycle, implicit versus explicit assignee, tick last child, parent delete and recurring reset checklist. **Expected:** Exactly one level, scoped independent tick and no automatic parent/contact effect; successor has fresh unchecked children.


<a id="req-tsk-006"></a>

### TSK-006 — Advisory prerequisite DAG

**REQ-TSK-006.** Top-level same-tenant tasks only, unique edges and composite FKs. Deny self/foreign/deleted candidate; serialize graph edits under tenant graph lock before longer cycle detection, so concurrent opposite edges cannot both commit. Show derived blocked badge for unfinished actionable prerequisite, distinct from manual blocked status; Complete, no_longer_needed, or an existing prerequisite soft-deleted after the edge was saved releases derived blocking. Deletion supplies no successful-completion/48-hour/contact credit and preserves the predecessor and edge history. Badge is advisory and does not prevent explicit allowed completion. Current/history edge correction is audited and retry-safe; no generalized project work flow engine.

**Target operations:** `tasks.replacePrerequisites`, `tasks.listPrerequisites`, `tasks.prerequisiteCandidates`.

**Acceptance:** AC-TSK-006--TSK-006. **Named cases:** TARGET-TSK-006.

**TARGET-TSK-006 fixture:** A→B→C→A, concurrent A→B/B→A, waived versus open prerequisite, delete an existing predecessor after saving its edge, manual blocked and foreign edge. **Expected:** DAG/integrity enforced atomically; waived or soft-deleted existing predecessor unblocks the dependent without success/contact credit or history loss. Advisory badge differs from status or a hard completion gate.


<a id="req-tsk-007"></a>

### TSK-007 — Atomic recurrence and single open occurrence

**REQ-TSK-007.** Daily/weekly/biweekly/monthly/quarterly/yearly rules retain interval and inclusive end LocalDate, series ID/source version and optional local time. Completion creates exactly one successor by one interval from current due LocalDate, or completion LocalDate when undated, clamping month/year end. Late completion intentionally may produce already overdue successor; no skip-ahead/backfill service calendar. Completion+successor+all reset checklist items/history/reminder intent commit atomically, with unique one open series and predecessor→successor identity as arbiters. Retry converges; failure does not require user reopen/recomplete. Stop recurrence preserves history; older reopen refuses open-successor collision. Zone edit previews future wall recurrence and resolver applies once; inherited due LocalDate remains explicit.

**Target operations:** `tasks.configureRecurrence`, `tasks.completeOccurrence`, `tasks.findOpenOccurrence`.

**Acceptance:** AC-TSK-007--TSK-007. **Named cases:** TARGET-TSK-007.

**TARGET-TSK-007 fixture:** January 31 monthly, leap February/yearly, end date equal/after, late completion, 2 concurrent complete, fail child copy and older reopen. **Expected:** Correct clamp/inclusive boundary, one atomic fresh successor or rollback; late overdue is visible and history/single open invariant remain.


<a id="req-tsk-008"></a>

### TSK-008 — Bounded bulk completion and reschedule

**REQ-TSK-008.** Accept at most 100 deduplicated IDs with frozen reviewed selection and expected per row revision. Prevalidate shared request/date/policy, then run bounded per-task transactions for completion/recurrence or reschedule/reminder intent, returning exact success/noop/missing/deleted/foreign/closed/unauthorized/stale/conflict outcomes and remaining IDs. No generic failure hides committed rows. Own-duty bulk complete rechecks assignee per row; admin reschedule cannot invent due dates on unselected tasks. Replay intent resumes only unsettled rows, completed recurrence cannot duplicate and one bad row does not claim whole batch success.

**Target operations:** `tasks.bulkComplete`, `tasks.bulkReschedule`.

**Acceptance:** AC-TSK-008--TSK-008. **Named cases:** TARGET-TSK-008.

**TARGET-TSK-008 fixture:** 100 IDs including duplicates/missing/foreign/waived/reassigned; fail after 3 commits and lost response; invalid date. **Expected:** Exact per row receipt and resumable pending work, no replayed recurrence or hidden partial success; invalid shared input writes zero.


<a id="req-tsk-009"></a>

### TSK-009 — Versioned task template preview/import

**REQ-TSK-009.** Keep canonical phase/category template keys, descriptions, priorities and relative LocalDate offsets through immutable versioned reference. Preview exact selected count and normalized safe markdown; import ordinary top-level tasks assigned current importer unless explicit reviewed eligible assignee. Reviewed operation ID makes transport retry idempotent; deliberate new import ID intentionally creates another set. Existing task text/dates never change from reference update. Reject stale version/invalid keys whole import; no source-row count substitute for reference content fidelity.

**Target operations:** `tasks.listTemplates`, `tasks.previewTemplate`, `tasks.importTemplate`.

**Acceptance:** AC-TSK-009--TSK-009. **Named cases:** TARGET-TSK-009.

**TARGET-TSK-009 fixture:** Canonical selected keys/offsets, lost response/retry versus new intent, stale version, source plain multiline text. **Expected:** Exact reviewed task set once per intent, deliberate repeat possible, content/date/version truthful and existing work unchanged.


<a id="req-tsk-010"></a>

### TSK-010 — One durable phase-transition offer answer

**REQ-TSK-010.** Latest unanswered actual transition ID offers current phase valid templates; phase event alone creates no tasks. Human may decline or accept any explicit valid subset, which answers that transition. Lock unique answer/transition; selected tasks+answer/history/receipt commit atomically, anchored to actual transition LocalDate. Stale transition/forged keys/authority refuses zero effects. Concurrent devices one winner; response loss returns durable actual inserted IDs, not temporary cookie-only receipt. Optional atomic bounded import failure leaves offer unanswered; no hidden partial claim strands selected templates.

**Target operations:** `tasks.readPhaseOffer`, `tasks.answerPhaseOffer`.

**Acceptance:** AC-TSK-010--TSK-010. **Named cases:** TARGET-TSK-010.

**TARGET-TSK-010 fixture:** Two devices answer accept/decline, subset selection, stale/forged key, fail mid insert and response loss. **Expected:** One coherent answer+exact task set or rollback; decline creates nothing and durable receipt converges.


<a id="req-tsk-011"></a>

### TSK-011 — Generated Vision/evaluation tasks

**REQ-TSK-011.** Use REQ-TSK-017 and REQ-MTG-020/021 for first-Vision obligation and managed-evaluation task production. Capture exact origin/Person/key and resolved 48 hstart; due LocalDate +2 separate. Manual follow-ups and distinct same-day meetings keep distinct identities. Missing eligible assignee is visible Needs owner. Protected source and persistent waiver prevent edit/delete/replay regeneration. Completion metric and contact freshness remain separate, correction history retained.

**Target operations:** `tasks.ensureObligation`, `tasks.ensureManagedTask`, `followups.readObligations`.

**Acceptance:** AC-TSK-011--TSK-011. **Named cases:** TARGET-TSK-011, ROLE43-008, ROLE43-015.

**TARGET-TSK-011 fixture:** Zero Vision evaluation, prior only team attendance, two same-day Vision origins, no lead title, waiver edit/delete and 48 h DST boundary. **Expected:** Required origin work exists coherently with correct unique identity/ownership and separate metrics.


<a id="req-tsk-012"></a>

### TSK-012 — Eligible follow-up assignment and uncovered contacts

**REQ-TSK-012.** Eligible owner is actual account linked live same plant committed stage Person(core_group/launch_team/leader) with current seat; shared email/unlinked contact cannot own. Current demotion/access loss resolves stale assignee Needs owner even if stored ID remains. Assignment validates now under lock, derived labels from stored Person not client name. Manual create+assign may remain undated and has distinct manual origin; no invented due date or 48 h lineage invented. Assignment view shows actionable open tasks, grouped current owners, uncovered contact coverage without claiming urgent task when no explicit duty exists. No lead title-based authorization.

**Target operations:** `tasks.followUpCoverage`, `tasks.assignFollowUp`, `tasks.createFollowUp`.

**Acceptance:** AC-TSK-012--TSK-012. **Named cases:** TARGET-TSK-012, ROLE43-008, ROLE43-015.

**TARGET-TSK-012 fixture:** Linked committed versus demoted/unlinked/shared mailbox; current seat removed; uncovered no-task contact and manual undated create. **Expected:** Only actual currently eligible owner assigned, stale Needs owner visible and no due/urgency/metric facts fabricated.


<a id="req-tsk-013"></a>

### TSK-013 — Explicit demotion/seat-removal handoff

**REQ-TSK-013.** Preview exact actionable parent follow-ups owned by departing/demoted account and currently eligible recipient. Review selection/revisions, then move bounded≤100 tasks in one transaction with history/reminder intent/receipt; larger selection uses durable named chunks and moved/remaining IDs under one intent. Decline writes nothing and all unresolved duties remain visible Needs owner. Foreign/ineligible recipient, stale selection or protected Owner exception refuses before chunk effects. Closed/waived/deleted tasks never reopen. Account/Person and former duty history remain.

**Target operations:** `tasks.planHandoff`, `tasks.executeHandoff`.

**Acceptance:** AC-TSK-013--TSK-013. **Named cases:** TARGET-TSK-013.

**TARGET-TSK-013 fixture:** Demotion with open/complete/waived tasks, decline, recipient loses eligibility after preview, 101 task chunk response loss. **Expected:** Exact reviewed open handoff or no write, durable moved/remaining results and retry without duplicate/reopened closed work.


<a id="req-tsk-014"></a>

### TSK-014 — Versioned due and overdue reminder producer

**REQ-TSK-014.** Schedule due notice and defined overdue notice from REQ-TSK-018; skip settled/deleted/unassigned/undated tasks. Unique logical task/revision/type/recipient delivery intent and notified occurrences avoid resend after retry/zone edit. Status/delete/reassign/reschedule cancels and version-replans pending intents atomically with task. Dispatch rechecks current task state/assignee/version/tenant/consent/suppression and deadline; stale queued notice cannot send to old owner. Failure has durable retry/reconcile outcome, no accepted/delivered claim from mere intent.

**Target operations:** `notifications.syncTaskReminders`, `notifications.cancelTaskReminders`.

**Acceptance:** AC-TSK-014--TSK-014. **Named cases:** TARGET-TSK-014.

**TARGET-TSK-014 fixture:** Date-only DSTdue, timed deadline, undated/unassigned, change assignee before claim, settle after queue and zone edit delivered slot. **Expected:** Correct local deadline/reminder and current recipient only; no terminal/old-owner duplicate and transport reported honestly.


<a id="req-tsk-015"></a>

### TSK-015 — Attributable status history across every writer

**REQ-TSK-015.** All status writers(native/Evry/bulk/generated evaluation/recurrence/correction) append previous/new state, effective Instant, recorded Instant, actual actor or identified system cause, revision and receipt in same UoW. Preserve initial creation state and close/reopen/waiver lineage. No-op retry creates no fake history. Read history requires current owned task scope, retains soft-deleted receipt as allowed and never renders anonymous source trigger rows as full actor evidence. Shared audit is not universal public browser/export or retention exemption.

**Target operations:** `tasks.statusHistory`.

**Acceptance:** AC-TSK-015--TSK-015. **Named cases:** TARGET-TSK-015.

**TARGET-TSK-015 fixture:** User/bulk/system managed completion, no-op retry, corrected outcome, reopen, foreign history request. **Expected:** Every real transition attributable once and current state agrees; no fake anonymous history or cross-tenant read.


<a id="req-tsk-016"></a>

### TSK-016 — Safe Markdown descriptions and previews

**REQ-TSK-016.** Create/edit/template paths normalize bounded≤50000 character description with explicit empty clear. Preserve plain-text paragraphs/newlines/meaning and safe markdown; sanitizer rejects/removes dangerous HTML/script/URL schemes. Preview snippet derives from same canonical text as full render and contains no executable markup. Use shared client-safe contract types without importing database runtime into UI. Description content is data, never agent/tool instructions.

**Target operations:** `tasks.normalizeDescription`, `tasks.previewDescription`.

**Acceptance:** AC-TSK-016--TSK-016. **Named cases:** TARGET-TSK-016.

**TARGET-TSK-016 fixture:** Multiline plaintext, java script link/script HTML, empty clear, long text cap and matching full/preview. **Expected:** Meaningful safe text renders consistently, malicious content cannot execute or grant tool authority and empty clear works.


## Consumer closure and proof

Implementation remains `not_started`. Execute the named future cases through real domain requests, disposable PostgreSQL constraints/races/fault injection and native/reviewed-Evry browser paths where surfaced. Prove current authorization again at execution; no test/source count or file presence is runtime proof. Include registered Person references, current source-revision writes, exact partial/committed receipts, correction limits and failure outcomes at each owning consumer closure. Domain adapter files are owned by their specific feature packages; shared Evry runtime/catalog/review UI has one integration owner.
