# Meetings, attendance and follow-up evidence

This is the target for MTG-001–019, the meeting-derived TSK-011–013 contracts and COM-011 contact evidence. Use [current roles](identity-access.md#req-idn-029), [Person reference registration](people.md#req-ppl-024), [task kernel](tasks.md#req-tsk-017) and [time types](tasks.md#req-tsk-018). Owner/Admin administer meetings. A current own-team leader has only scheduling/attendance scope for its own team; that permission does not grant guest deletion, RSVP/cards or general meeting/evaluation administration. Linked accounts answer only their own RSVP; bearer token reply authority is narrow, independently verified and never a seat.

Guest invitation, RSVP, actual presence, response card, human evaluation, named Launch guest and headcount are separate facts. Neither email engagement nor RSVP means attendance. Cards do not imply consent or commitment. Human meeting quality and prayer responses remain human judgments. Required writes/history/receipts/audit/source revision commit in a short domain transaction; transport dispatch follows durable intent. Every durable Evry proposal shows exact generated obligations/tasks and reviewed correction effects.


## Shared domain contracts


<a id="req-mtg-020"></a>

### REQ-MTG-020 — Atomic finalization with the early obligation kernel

WP-024 first supplies the minimal persistence/uniqueness API for `follow_up_obligation`, managed `task`, history/audit/receipt and source-revision changes using the caller's transaction. WP-022 depends on that kernel and owns one finalize/reconcile unit of work: lock meeting/current guest-attendance revision and affected live Persons, compute exact attended identity snapshot/classification, apply approved People attendance progression, create required first-Vision obligations plus evaluation task, record current actual Attendance/snapshot/marker and audit/receipt/material revision atomically. No after-commit task call or stub weakens this boundary. A zero-attendee Vision still produces evaluation work. Missing lead title/account never suppresses obligations; a currently eligible selected assignee or visible Needs owner is required. Durable review includes all generated work; invalid assignment refuses or uses explicitly reviewed unowned result.

Repeat same finalized revision returns original receipt; concurrent calls converge. Late additions/removals/same-count replacements are reconciled by identity and expected revision, not count. Corrected first-Vision eligibility may add/supersede current obligations through a reviewed delta; completed/waived/outcome history survives and no performed work is silently deleted. A removed attendee's unperformed obligation is marked source-corrected/no-longer-applicable with history, not successful completion. Changing current meeting date does not rewrite immutable original follow-up 48 h origin; a correction to an erroneous origin is separately reviewed with old/new metric lineage. Finalization is independent from setting meeting status completed and from practice occurrence completion. Injected failure rolls back marker+attendance effects+obligations+task+audit; response loss returns saved receipt. WP-022 proves its actual kernel consumer before closure, WP-023 later adds outcomes/contact/ownership projections; WP-056 is additional whole-target regression.

**Named cases:** TARGET-MTG-020.


<a id="req-mtg-021"></a>

### REQ-MTG-021 — Stable obligation and distinct 48 hour/contact measures

Each generated first-Vision obligation has immutable tenant/origin meeting/Person/kind identity and captured resolved originating Instant, LocalDate/zone/formula version, applicability snapshot, assignment and current state/revision. Two distinct same-day meetings never collapse through person/day uniqueness. Source edits/task relation edits/soft deletion/waiver cannot bypass obligation identity or cause regeneration. Due day is originating meeting local date+2 calendar days; the exact 48 elapsed-hour measurement is separate and uses the actual successful originating-task completion Instant against the captured actual originating-occurrence Instant. At a frozen asOf, pending obligations younger than 48 hours are excluded until mature; mature pending obligations are measured misses. A valid successful completion at or after origin and at or before origin+48 elapsed hours enters as an early success. Future actual origins/completions or pre-origin completions are invalid and excluded; waiver is separately excluded. Database createdAt or recordedAt may be later than the actual historical event and never invalidates truthful backdated occurrence/completion evidence. Retiring a genuine originating meeting preserves its obligation and performed history; voiding an invalid origin uses reviewed correction lineage. Untraceable/manual follow-up lacks that measurement lineage and is excluded/Unknown, never guessed. Task-fulfillment timeliness requires an attributable actual originating-task completion event with its typed human follow-up outcome; a raw completed checkbox or provider acceptance alone is insufficient. Contacted, attempted_no_contact, or administrative_completion may fulfill that task; attempted/admin completion never earns actual-contact credit. Confirmed actual-contact count/freshness uses only contacted occurredAt, and absent supported contact evidence stays Unknown. Report task fulfillment and confirmed contact separately. no_longer_needed closes without successful-completion credit and permanently suppresses replay regeneration. Reopening/correcting changes effective current results with attributable history, preserving old receipt/assessment lineage. A post-launch Sunday 48 h measure with no approved origin is unmeasured/Unknown; prelaunch Vision success is never relabelled and no services module is invented.

**Named cases:** TARGET-MTG-021.


<a id="req-mtg-022"></a>

### REQ-MTG-022 — Effective confirmed contact and corrected history

 `follow_up_outcome` records contacted|attempted_no_contact|administrative_completion|no_longer_needed, actual occurredAt, immutable recordedAt/original actor, operation/obligation/task/person links and expected revision. Explicit human-confirmed contacted alone advances actual-contact freshness using occurredAt; email sent/open/click, task administrative completion, attempt or waiver supplies no contact. A contacted outcome with future/invalid time is rejected; historical late entry remains its actual occurrence. Contacted may be recorded independently from task completion when truthful, with the distinction shown. Current freshness is maximum valid effective contacted occurrence after corrections/reopen/void; removing erroneous latest evidence reveals earlier valid date rather than retaining a cached false success. Contact log renders a human-contact badge, never email delivered. Correction appends old/new/reason/actor, updates current outcome/contact projection and source revision atomically, does not resend mail or erase original receipt. Notes remain bounded operational records and cannot become private-care/model pastoral inference.

**Named cases:** TARGET-MTG-022.


## Feature requirements

| Feature | Requirement | Target disposition | Owning packages |
|---|---|---|---|
| MTG-001 | [REQ-MTG-001](#req-mtg-001) | retained | WP-022 |
| MTG-002 | [REQ-MTG-002](#req-mtg-002) | retained | WP-020 |
| MTG-003 | [REQ-MTG-003](#req-mtg-003) | retained | WP-020 |
| MTG-004 | [REQ-MTG-004](#req-mtg-004) | retained | WP-022 |
| MTG-005 | [REQ-MTG-005](#req-mtg-005) | retained | WP-020 |
| MTG-006 | [REQ-MTG-006](#req-mtg-006) | retained | WP-020 |
| MTG-007 | [REQ-MTG-007](#req-mtg-007) | retained | WP-021 |
| MTG-008 | [REQ-MTG-008](#req-mtg-008) | retained | WP-021 |
| MTG-009 | [REQ-MTG-009](#req-mtg-009) | retained | WP-021 |
| MTG-010 | [REQ-MTG-010](#req-mtg-010) | retained | WP-022 |
| MTG-011 | [REQ-MTG-011](#req-mtg-011) | retained | WP-020 |
| MTG-012 | [REQ-MTG-012](#req-mtg-012) | retained | WP-022 |
| MTG-013 | [REQ-MTG-013](#req-mtg-013) | retained | WP-021 |
| MTG-014 | [REQ-MTG-014](#req-mtg-014) | retained | WP-022 |
| MTG-015 | [REQ-MTG-015](#req-mtg-015) | retained | WP-022 |
| MTG-016 | [REQ-MTG-016](#req-mtg-016) | retained | WP-022 |
| MTG-017 | [REQ-MTG-017](#req-mtg-017) | retained | WP-022 |
| MTG-018 | [REQ-MTG-018](#req-mtg-018) | retained | WP-021 |
| MTG-019 | [REQ-MTG-019](#req-mtg-019) | retained | WP-021 |
| COM-011 | [REQ-COM-011](#req-com-011) | retained | WP-023, WP-029 |


<a id="req-mtg-001"></a>

### MTG-001 — Scoped browse/detail/history

**REQ-MTG-001.** Preserve upcoming/past/all windows, closed type filter, stable paging and one derived display title across detail/bread crumb. Browse defaults all; analytics defaults Vision and labels that scope. Unknown/repeated type query gets the documented all default. Cancelled future records remain distinguishable from scheduled; an empty current filter does not claim no historical meetings. Team tab and global list reuse the same records with current tenant projection.

**Target operations:** `meetings.list`, `meetings.get`, `meetings.hasHistory`.

**Acceptance:** AC-MTG-001--MTG-001. **Named cases:** TARGET-MTG-001.

**TARGET-MTG-001 fixture:** Past/upcoming/cancelled records, unknown/repeated type, equal starts At paging, filtered empty with history and foreign detail. **Expected:** Stable scoped rows/title/history and explicit defaults; empty filter never misstates history.


<a id="req-mtg-002"></a>

### MTG-002 — Meeting lifecycle and actual prelaunch practice

**REQ-MTG-002.** Retain vision_meeting/orientation/team_meeting and subtypes regular/training/planning/special/rehearsal; add approved distinct prelaunch_practice type. States planning/ready/in_progress/completed/cancelled; expected-revision transitions are explicit. Type/team linkage cannot change through ordinary edit. Atomically create selected active venue/snapshot, meeting, fresh agenda/kit and reviewed unique roster; lock tenant counter for distinct Vision numbers. Record resolved Instant/zone/offset for entered times. Delete from current list through attributable retirement; void an invalid occurrence separately, preserving history and actual held evidence. Completed practice requires actual nonfuture occurrence; three distinct valid held completed IDs meet practice count, four still meet. Scheduled/future/cancelled/not-held/duplicate/voided records do not count. Practice supports ordinary venue/agenda/guest/notes, but no Vision number/kit/card/evaluation/first-timer work or training credit. Correction/reopen/void changes current facts with history, never auto phase or milestones.

**Target operations:** `meetings.schedule`, `meetings.edit`, `meetings.changeStatus`, `meetings.delete`, `meetings.completePractice`, `meetings.correctOccurrence`.

**Acceptance:** AC-MTG-002--MTG-002. **Named cases:** TARGET-MTG-002.

**TARGET-MTG-002 fixture:** Concurrent Vision numbers, failed venue/kit/roster create; practice 3 distinct+duplicate+future+cancelled; archive genuine versus void invalid; DST fold entry. **Expected:** Coherent create/unique Vision numbers, practice count only actual valid IDs and separate history; no unrelated Vision/phase/training effect.


<a id="req-mtg-003"></a>

### MTG-003 — Locations and venue snapshots

**REQ-MTG-003.** Keep name/address/contact/cost/capacity/notes and active state; capacity≥1 when supplied, valid bounded contact/email/cost input and tenant fields. Selection requires active same plant venue and copies name/address as meeting facts. Current venue edits do not rewrite old meeting snapshots; choosing a new future venue is explicit. Creation from picker joins meeting unit of work. Current list hides archived with explicit history inclusion.

**Target operations:** `venues.list`, `venues.get`, `venues.create`, `venues.edit`, `venues.archive`.

**Acceptance:** AC-MTG-003--MTG-003. **Named cases:** TARGET-MTG-003.

**TARGET-MTG-003 fixture:** Active/foreign/archived selection, capacity 0, historical meeting then venue address edit, failed picker create. **Expected:** Valid owned venues work, old snapshot stays unchanged and failed meeting create leaves no ghost venue.


<a id="req-mtg-004"></a>

### MTG-004 — Location correction and restore

**REQ-MTG-004.** Discover archived venues, restore deliberately and retain all linked meeting records. Expected revision correction/archive/restore writes current state and old/new/corrector/time/reason atomically. Stale edit writes neither row nor history; no-op active-state request converges. Existing unchanged archived selection may remain on a meeting; new/reselected archived location is refused. Restore does not rewrite historical copied venue facts.

**Target operations:** `venues.correct`, `venues.restore`, `venues.history`.

**Acceptance:** AC-MTG-004--MTG-004. **Named cases:** TARGET-MTG-004.

**TARGET-MTG-004 fixture:** Archive venue used by old meeting, unchanged edit versus new selection, restore/retry, two correction tabs. **Expected:** Linked history survives, archived eligibility rule holds and one current revision win swith out false revision.


<a id="req-mtg-005"></a>

### MTG-005 — Ordered agenda and exact default

**REQ-MTG-005.** Agenda sections have stable ID, trimmed title 1–120 and integer duration 0–600 minutes; at most 40 sections, empty valid. Save validates entire payload with named errors, never silently drops/truncates invalid API sections. Vision default is Welcome 10, Worship 15, Vision 25, Q&A 15, Response 10, Fellowship 15 minutes (90 total), fresh IDs and immutable source version. Non Vision starts empty. Add/remove/reorder/retime roundtrip and derived total; later reference revision never overwrites a user's agenda.

**Target operations:** `meetings.readAgenda`, `meetings.replaceAgenda`.

**Acceptance:** AC-MTG-005--MTG-005. **Named cases:** TARGET-MTG-005.

**TARGET-MTG-005 fixture:** Six default sections/90 total, empty, reorder/retime, 41 sections/title 121/negative/fractional minutes and edited agenda after reference update. **Expected:** Exact editable default and order persist; invalid save has zero writes and reference update does not overwrite work.


<a id="req-mtg-006"></a>

### MTG-006 — Vision logistics kit

**REQ-MTG-006.** Retain canonical versioned kit categories essential/materials/setup/av/organization with item text, assigned Person, check state and bounded notes. Seed exact reviewed kit once with meeting create or explicit accepted offer; repeated population converges. Assignee must be live same plant, all FK/current revision checked; uncheck reverses check and summary counts actual checked rows. Non Vision including practice cannot request kit. Read never seeds missing rows silently.

**Target operations:** `meetings.listKit`, `meetings.populateKit`, `meetings.updateKitItem`.

**Acceptance:** AC-MTG-006--MTG-006. **Named cases:** TARGET-MTG-006.

**TARGET-MTG-006 fixture:** Vision create+retry kit, foreign/retired assignee, checked→unchecked summary, orientation/practice request. **Expected:** One canonical kit and accurate counts, valid owned assignment only and non Vision writes nothing.


<a id="req-mtg-007"></a>

### MTG-007 — Unique guest rows, inviter and team snapshots

**REQ-MTG-007.** One meeting/Person guest row, invited initially absent and optional valid same plant inviter distinct from Person. Team roster expands current active memberships to unique live Persons, snapshots at creation/import and does not dynamically follow later joins/leaves. Explicit roster reconciliation previews additions/removals and current revisions. Guest remove cancels pending linked reminders/tokens and removes current card with history, preserving unrelated Person/contact/outcome evidence; performed work cannot be undone by removal. Read joins email tracking without turning engagement into presence.

**Target operations:** `meetings.listGuests`, `meetings.inviteGuest`, `meetings.removeGuest`, `meetings.previewRosterImport`, `meetings.copyTeamRoster`.

**Acceptance:** AC-MTG-007--MTG-007. **Named cases:** TARGET-MTG-007.

**TARGET-MTG-007 fixture:** P has 2 team roles, later Qjoins, retry import, self/foreign inviter, guest remove with card/pending reminder/performed follow-up. **Expected:** Unique absent guest/snapshot, explicit later reconcile, no false presence or history loss and pending effects are canceled truthfully.


<a id="req-mtg-008"></a>

### MTG-008 — Administrative RSVP correction

**REQ-MTG-008.** Owner/Admin may set confirmed/declined or reset null=Pending for exact guest/Person/meeting/tenant under current revision. Use one authoritative guest RSVP projection: admin change appends provenance, synchronizes recognized linked invitation response and supersedes pending bearer tokens so an old token cannot overwrite the correction. Reset returns Pending and invalidates old tokens; a new outgoing invitation explicitly mints a fresh token. It never changes attendance/card/contact/mail delivery. This resolves the source attendance-only inconsistency rather than retaining 2 current truths.

**Target operations:** `meetings.correctRsvp`.

**Acceptance:** AC-MTG-008--MTG-008. **Named cases:** TARGET-MTG-008.

**TARGET-MTG-008 fixture:** Pending token race with admin confirmed/reset, answered token, foreign guest, then reviewed new invite. **Expected:** One current RSVP, old proof cannot overwrite, reset does not resurrect token and independent facts stay unchanged.


<a id="req-mtg-009"></a>

### MTG-009 — Own and public-token RSVP

**REQ-MTG-009.** Authenticated own reply binds current account→live Person→existing guest inside the transaction and accepts only confirmed/declined. No client Person/account ID establishes subject. Public page view is read-only; purpose token must be live addressed meeting/guest, pending, unexpired/unrevoked and single-response. Under guest/token locks set canonical RSVP, claim/supersede pending tokens and update recognized invitation artifact; concurrent own/admin/token response has one current winner. Missing session 401, invalid 400, denied 403, unavailable 404; token links disclose only bounded invite context. Attendance/card/notes/delivery untouched.

**Target operations:** `meetings.getOwnRsvp`, `meetings.saveOwnRsvp`, `meeting.answerRsvpToken`.

**Acceptance:** AC-MTG-009--MTG-009. **Named cases:** TARGET-MTG-009.

**TARGET-MTG-009 fixture:** Wrong account/tenant/not on guest list, malformed body, expired/used token, GET page and own/admin/token concurrent replies. **Expected:** One valid narrow response wins, no self selected Person or view effect and all independent facts remain.


<a id="req-mtg-010"></a>

### MTG-010 — Attendance, chronology and atomic batch

**REQ-MTG-010.** Retain attended/absent/excused and first_time/returning/core_group categories with one guest row. For Vision first-time use prior chronologically earlier actually attended Vision only; team/orientation/practice/RSVP never substitutes. Core-group category remains distinct from first/returning and captures committed-stage evidence basis at recording/finalized snapshot, not later automatic stage edit. Finalized historical classification changes only reviewed correction; late prior Vision correction recomputes affected current eligibility/obligation delta with history. Whole batch validates/locks all Persons and commits all or none; own team leader only its attendance. Leader clear changes presence only, retaining guest/RSVP/card. Unknown row refuses instead of false success; summary counts attended Persons, including actual planter attendance.

**Target operations:** `meetings.setAttendance`, `meetings.captureAttendanceBatch`, `meetings.clearAttendance`.

**Acceptance:** AC-MTG-010--MTG-010. **Named cases:** TARGET-MTG-010.

**TARGET-MTG-010 fixture:** Prior attended team versus Vision, chronological backdated Vision, committed stage versus first, invalid mid batch ID, own team leader clear with RSVP/card. **Expected:** Vision-specific chronology and frozen evidence basis, atomic batch and narrow leader clear, accurate attended summary.


<a id="req-mtg-011"></a>

### MTG-011 — Coherent quick guest and walk-in

**REQ-MTG-011.** Quick existing Person attachment validates live exact tenant and duplicates/merge policy. Quick new named contact uses the People minimal name/contact validation, source meeting_guest_list/prospect and shown country default. Person+guest and optional walk-in presence commit with one operation receipt; failed/foreign/invalid meeting cannot leave orphan new contact. Creating guest/walk in grants no login, consent, adulthood or commitment. Same-name hint does not automatically merge.

**Target operations:** `meetings.createGuestContact`, `meetings.createWalkInContact`.

**Acceptance:** AC-MTG-011--MTG-011. **Named cases:** TARGET-MTG-011.

**TARGET-MTG-011 fixture:** Single-name guest, repeated new intent, existing duplicate selection, foreign meeting and failed attendance attach. **Expected:** One coherent real Person/guest/presence or nothing; no orphan or fabricated identity/consent.


<a id="req-mtg-012"></a>

### MTG-012 — Finalize and identity reconciliation

**REQ-MTG-012.** Implement REQ-MTG-020/021: exact identity snapshot, required People progression/obligations/evaluation task/history/receipt/source revision share one UoW. Outcomes finalized/already_finalized/reconciled distinguish new effect/replay/correction. Late same-count replacements and removal towards 0 are identity deltas. Required generated effects are in exact review and missing assignee shown Needs owner. Meeting completed status is independent; neither means cards/evaluation/contact finished.

**Target operations:** `meetings.finalizeAttendance`, `meetings.reconcileAttendance`.

**Acceptance:** AC-MTG-012--MTG-012. **Named cases:** TARGET-MTG-012, ROLE43-008, ROLE43-015.

**TARGET-MTG-012 fixture:** Zero attendee, duplicate/concurrent finalize, same count replacement/removal to 0, no lead and fault after obligation insert. **Expected:** Required work and marker agree atomically, retries converge and identity delta/history remain honest.


<a id="req-mtg-013"></a>

### MTG-013 — Response cards and honest outcome population

**REQ-MTG-013.** Owner/Admin record/correct/clear one card per existing guest/meeting/Person: ready_commit/interested/prayer_request/stay_informed/not_interested, bounded prayer/question notes and recorder/occurred/recorded time. Clear returns no-card with correction tombstone; no-card is Unknown not negative. Report attended card population separately from absent guest cards and denominator, including zero/missing Unknown; do not infer attendance, email consent or commitment. Sensitive prayer/question notes require purpose-specific authorized projection and no automatic summary or AI counsel; public RSVP never reads or writes them. Non Vision/practice card denied.

**Target operations:** `meetings.recordCard`, `meetings.clearCard`, `meetings.listCards`, `meetings.cardBreakdown`.

**Acceptance:** AC-MTG-013--MTG-013. **Named cases:** TARGET-MTG-013.

**TARGET-MTG-013 fixture:** No-cardvsnot_interested, absent guest card versus attended denominator, correction/clear, malformed value and public/org request for prayer notes. **Expected:** One current card with history, population and Unknown truthful; no consent/commitment/private-notes leak.


<a id="req-mtg-014"></a>

### MTG-014 — Eight-factor human Vision evaluation

**REQ-MTG-014.** Only Vision allows one human evaluation with integer 1–5 for 8 factor keys: attendanceScore (Great Attendance: Core Group actively inviting); locationScore (Acceptable Location: easy to find/welcoming/distraction-free); logisticsScore (Great Logistics: room/AV/materials ready); agendaScore (Clear Agenda: detailed and on time); vibeScore (Great Vibe: warm/inviting/enthusiastic); messageScore (Compelling Message: clear vision); closeScore (Strong Close: nonmanipulative call); nextStepsScore (Clear Next Steps: dates/details). Server computes arithmetic average rounded 1 decimal and records reference version/actor/date. Evaluation insert and managed-evaluation task completion/history/revision commit together, uniqueness handles concurrent submission. No model scores factors.

**Target operations:** `meetings.recordEvaluation`, `meetings.getEvaluation`, `meetings.evaluationTrend`.

**Acceptance:** AC-MTG-014--MTG-014. **Named cases:** TARGET-MTG-014.

**TARGET-MTG-014 fixture:** All 8 scores 1 and 5/forged average, two concurrent evaluations, non Vision, failed managed-task settlement. **Expected:** One complete human record with computed average and coherent task settlement; non Vision or scores outside bounds refuse all.


<a id="req-mtg-015"></a>

### MTG-015 — Evaluation correction

**REQ-MTG-015.** Correct allowed factor/notes under Owner/Admin, current meeting and expected row revision. Append old/new/actor/time/reason atomically, recompute average and source revision; stale edit creates no history. Current comparisons/PI use corrected effective evidence, while old receipts/snapshots remain interpretable. Correction never re-emits first evaluation completion or completes managed task again; task reopen requires separate explicit command.

**Target operations:** `meetings.correctEvaluation`, `meetings.evaluationHistory`.

**Acceptance:** AC-MTG-015--MTG-015. **Named cases:** TARGET-MTG-015.

**TARGET-MTG-015 fixture:** Twocorrection tabs; changes core after managed task complete; wrong tenant/version; previous assessment. **Expected:** One current correction/history, updated derived metrics and no duplicate completion or rewritten old assessment.


<a id="req-mtg-016"></a>

### MTG-016 — Attendance and quality analytics

**REQ-MTG-016.** Preserve attended trend, new-versus-returning, completed meeting summary/growth and quality comparison with labelled type/window. Count actual attended unique Persons, not all guest rows. Zero prior attendance gets defined zero/relative growth Unavailable, never false/missing-missing; no denominator/evidence gives Unknown not 0. Evaluation base line use searlier chronological evaluations, excludes self/same instant and labels at most latest 50 eligible earlier records; query current meeting'searlier window rather than latest global 50 which could hide history. Round base line then delta 1 decimal as retained source calculation. Corrected records feed current comparison with provenance.

**Target operations:** `meetings.readAnalytics`, `meetings.compareEvaluation`.

**Acceptance:** AC-MTG-016--MTG-016. **Named cases:** TARGET-MTG-016.

**TARGET-MTG-016 fixture:** Absent guests, prior attendance 0, current early meeting with>50 later evaluations, same instant/self, corrected quality score. **Expected:** Truthful attended denominators and Unknown/0 distinction; earlier base line finds valid history, excludes self/same instant and rounds consistently.


<a id="req-mtg-017"></a>

### MTG-017 — Meeting-provenance Person note

**REQ-MTG-017.** Validate current meeting/Person/guest-attendance relation within plant before bounded trimmed 1–5000 character note. Derive meeting type/ID from server and append authored Person activity with actual performer, meeting provenance and recorded instant atomically. Own note edit/delete follows People history contract; client metadata cannot forge unrelated meeting or Person link. No privileged broad note edit or private care classification is created.

**Target operations:** `meetings.addAttendeeNote`.

**Acceptance:** AC-MTG-017--MTG-017. **Named cases:** TARGET-MTG-017.

**TARGET-MTG-017 fixture:** Known Person but unrelated meeting, forged type/foreign ID, whitespace/5001 chars and valid authored attendee note. **Expected:** Only true owned relation creates readable provenance note; forged metadata fails and correction rules match People.


<a id="req-mtg-018"></a>

### MTG-018 — Reminder producers and outgoing invitation separation

**REQ-MTG-018.** Retain announcement to linked Core Group accounts and 7/3/1 civil-day-before reminders at same church wall clock to creator+linked guests, deduplicated per logical meeting offset/recipient. Skip already-passed offsets, cancel completed/cancelled/retired meeting intents, and reschedule/reconcile guest sus ing expected source revision and durable intent. Dispatch rechecks actual current audience/status/consent/suppression; removed recipient cannot receive queued new message. Canonical meeting invitation/reminder email templates and purpose RSVP tokens are separate Communication Hub effects with accepted/delivered/unknown outcomes; scheduled notification never claims attendance/card/contact. Use shared automatic DST resolver and one occurrence dedupe.

**Target operations:** `meetings.planNotifications`, `communication.preview`.

**Acceptance:** AC-MTG-018--MTG-018. **Named cases:** TARGET-MTG-018.

**TARGET-MTG-018 fixture:** DST civil offset, creator also guest, add/remove/reschedule before queued dispatch, completed meeting, provider unknown and email open. **Expected:** Current audience and single logical notice only; truthful transport outcome and independent RSVP/presence/contact facts.


<a id="req-mtg-019"></a>

### MTG-019 — Inviter artifact consolidation without tree feature

**REQ-MTG-019.** Preserve valid stored inviter/recognized invitation response provenance and Person merge references in the bounded meeting guest/RSVP artifact model. Current inviter requires live own-plant Person and no self-referral cycle. Legacy invited/confirmed/maybe/declined/attended/no_show historical attribution may remain readable with original meaning, but does not drive presence or replace canonical RSVP. Unwritten legacy create helper/schema is not an approved stand alone invitation tree/name-only prospect subsystem; named real guest creates People through MTG-011. Merge/inverse manifest registers artifact and token ref swith collision checks.

**Target operations:** `meetings.invitationAttribution`, `meetings.setInviter`.

**Acceptance:** AC-MTG-019--MTG-019. **Named cases:** TARGET-MTG-019.

**TARGET-MTG-019 fixture:** Legacy inviter artifact, current guest RSVP, self referral, merge with matching tokens, and request old invitation tree. **Expected:** Attribution/history survive and canonical RSVP holds; no tree feature or untraceable person invention.


<a id="req-com-011"></a>

### COM-011 — Typed human contact log and freshness

**REQ-COM-011.** Implement REQ-MTG-022. Replace source inference from every completed person linked task with typed human-confirmed outcome and actual occurredAt. Preserve Person/contact log/read history and task/meeting links; completed administrative task or attempt get sit sown label, never delivered email/confirmed contact. Correction/reopen/void recomputes current freshness without removing history or resending effects. Communication owns log read projection; follow-up owns outcome writer and People/PI consume the same effective contact fact.

**Target operations:** `followups.recordOutcome`, `followups.correctOutcome`, `followups.listContactHistory`.

**Acceptance:** AC-COM-011--COM-011. **Named cases:** TARGET-COM-011.

**TARGET-COM-011 fixture:** Person linked administrative task, contacted/attempt/waiver, email delivery/open and corrected latest contact. **Expected:** Contact log and 14 day freshness distinguish all four outcomes and transport facts, correction reveals previous valid contact.


## Consumer closure and proof

[Canonical build progress](../build-progress.json) records implementation milestones and completion. Execute the named future cases through real domain requests, disposable PostgreSQL constraints/races/fault injection and native/reviewed-Evry browser paths where surfaced. Prove current authorization again at execution; no test/source count or file presence is runtime proof. Include registered Person references, current source-revision writes, exact partial/committed receipts, correction limits and failure outcomes at each owning consumer closure. Domain adapter files are owned by their specific feature packages; shared Evry runtime/catalog/review UI has one integration owner.
