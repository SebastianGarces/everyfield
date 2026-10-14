# People and qualification evidence

This is the current target for PPL-001–023. People are tenant-owned contacts, distinct from accounts, seats, households and ministry roles. Use [current identity policy](identity-access.md#req-idn-029), exact reviewed durable Evry commands and bounded permission-filtered DTOs. Current tenant readers retain ordinary operational People reads; full interviews/4Cs/commitment intake and private documents require current Owner/Admin. Organization audiences receive only authorized aggregate projections. Credential identity and immutable private-care author identity are never rewritten by a CRM operation.

The seven recruitment stages are `prospect`, `attendee`, `following_up`, `interviewed`, `core_group`, `launch_team`, `leader`. Recording evidence and choosing a stage are distinct actions. Human-recorded person qualification uses the unchanged four C’s—Committed, Compelled, Contagious, Courageous—and interview criteria Maturity, Gifted, Chemistry, Right Reasons, Season. No model supplies pastoral judgment, assessment scores or testimony. These person assessments differ from the immutable SME Plant Intelligence rubric. Background-check capture/display/import/export/tool fields and coach workflows are explicitly excluded.

The target schema uses `person`, typed qualification/commitment history, `event`, and `person_merge`. Successful material mutations, history, receipt/audit and plant source-revision advancement commit together; an outbox wake-up may follow commit. Native and reviewed Evry commands use the same domain policy. Expected revisions and operation IDs prevent stale edits or retries from silently losing history.


## Shared domain contracts


<a id="req-ppl-024"></a>

### REQ-PPL-024 — Incremental Person-reference contract

Publish a static `person_references` manifest in the target schema catalog, not a new runtime registry table. Each Person-bearing consumer registers resource/field, exact tenant FK, current versus historical meaning, source/survivor lock order, retirement treatment, merge rewrite rule, uniqueness/collision refusal, private ownership/authorship restriction, reviewed inverse policy and named fixtures. Every writer locks/validates the active Person within its transaction before adding a reference, so a merge racing an insert cannot leave a new current reference on the retired source. WP-015 closes only then-present People/account/household/qualification consumers. Later team/training, attendance/RSVP/card/kit, follow-up/task/contact, communication, Launch guest, documents and Evry proposal/artifact owners add registrations and real merge/retirement/inverse fixtures before their own closure. Immutable historical actor/event/document snapshots retain original provenance with authorized identity lineage rather than arbitrary rewrite. Private-care account-author references are excluded from Person movement. Final WP-056/057 closure verifies the full manifest against the actual schema and every later producer; early merge is not a whole-target claim.

**Named cases:** TARGET-PPL-024.


<a id="req-ppl-025"></a>

### REQ-PPL-025 — Reviewed merge and required Unmerge

 `people.getMergeReview` returns exact current revisions, all differing stored field choices, account/household/photo/current-lifecycle effects, moved/deduplicated references and named blockers. Lock both live same plant Persons in stable ID order and their consumer subjects; one atomic merge updates survivor/reference projections, retires source, records original snapshots/choices plus typed moved-row IDs/pre-post revisions/inverse constraints in `person_merge`, appends history/audit/receipt and advances source revision. Two account-linked Persons cannot merge; the linked Person must survive, account grants/author identity cannot move, and no arbitrary storage/user ID enters the payload. Conservative collisions include same-meeting attendance/card, active training assignment/completion, pending RSVP, distinct live obligation, referral cycle and conflicting household/leadership state; disclose exact conflicts rather than silently dropping records. Repeated same merge returns original receipt; conflicting destination or stale review refuses; source redirects follow recorded acyclic lineage.

Retain the required Unmerge capability through `people.previewUnmerge`/`people.unmergePeople`, both native and exact-reviewed Evry. The preview names the original merge and full inverse. Execute only when recorded survivor/field/photo/account/reference revisions are unchanged and every manifest inverse/uniqueness/tenant check proves restoration without discarding later facts. Under the same locks/CAS restore source and recorded moved/deduplicated references, restore prior survivor values, append a new reversal receipt/history/audit and advance source revision; retain the original merge receipt. Retrying reversal converges. A source-row-only restore is never Unmerge. A chained merge, new/corrected reference, credential/author conflict, sent-mail/disclosure or other irreversible effect whose attribution cannot be safely reversed causes exact conflict refusal with zero inverse effects. Offer separately reviewed manual correction/split of named records within ordinary domain authority, preserving later history and original authorship; operator recovery is not a substitute for the safe native inverse and never unsends mail. No universal undo promise.

**Named cases:** TARGET-PPL-025.


<a id="req-ppl-026"></a>

### REQ-PPL-026 — Current adult size and genuine acquisition history

Record explicit adult_classification=adult|child|unknown with dated attributable correction history; DOB is optional and never required. Maintain authoritative per-person/plant commitment lifecycle active|withdrawn|unknown, separate from signature rows and stage. At frozen asOf/source revision, count each live same plant classified adult with currently active supported core-group or launch-team commitment once, regardless of repeated cards, ministry roles or account link. Two eligible household adults count two; role/stage/account alone supplies no evidence. Known children, current withdrawal, retired/merged-away sources and foreign records are excluded with lineage. Unknown classification/state is visible. Exact count is available only with complete evidence; 30 established adults meet≥30 even with a partial cohort, 29 plus a consequential unknown yields Unknown, reliably bounded below 30 may fail while exact count stays unknown; unavailable read is never zero. No blanket classify-every-contact or renewal gate.

Historical genuine acquisition is independent from current size. Use each canonical person's earliest valid actual eligible commitment occurrence, not recorded/corrected/classified/rejoined time. A real withdrawal decreases current size but preserves its genuine acquisition and the latest-first acquisition clock; later genuine reactivation restores current size without a new person or clock reset. Correcting an invalid historical event/date may remove/move that acquisition and recompute current windows/clock with old/new/actor/reason history. The 2026-10-13 15:32 semantic ruling expressly settles this difference. Deduplicate through explicit merge lineage, never similar name/email. Preserve trailing 28 day versus prior 28 day first-acquisition counts: net current headcount and growthDelta do not define the flat clock. 20 days permits neither slowed nor stalled, 21–27 permits slowed only,≥28 permits stalled and fails the established growth-trajectory test. Missing/invalid/future consequential occurrence evidence leaves timing Unknown, independently of known size. All date/window boundaries use frozen church-local LocalDate, with windows [ asOf -27, asOf ] and [ asOf -55, asOf -28]; no UTC-midnight reinterpretation. Old assessments retain their formula/asOf/source lineage.

**Named cases:** TARGET-PPL-026, CA001, CA002, CA003, CA004, CA005, CA006, CA007, CA008, CA009, CA010, CA011, CA012, CA013, CA014, CA015, CA016, CA017, CA018, CA019, CA020, CA021, CA022, CA023, CA024, CA025.


## Feature requirements

| Feature | Requirement | Target disposition | Owning packages |
|---|---|---|---|
| PPL-001 | [REQ-PPL-001](#req-ppl-001) | retained | WP-011 |
| PPL-002 | [REQ-PPL-002](#req-ppl-002) | retained | WP-011, WP-012 |
| PPL-003 | [REQ-PPL-003](#req-ppl-003) | retained | WP-011 |
| PPL-004 | [REQ-PPL-004](#req-ppl-004) | retained | WP-011 |
| PPL-005 | [REQ-PPL-005](#req-ppl-005) | retained | WP-012 |
| PPL-006 | [REQ-PPL-006](#req-ppl-006) | retained | WP-011, WP-014 |
| PPL-007 | [REQ-PPL-007](#req-ppl-007) | retained | WP-011, WP-023 |
| PPL-008 | [REQ-PPL-008](#req-ppl-008) | retained | WP-011 |
| PPL-009 | [REQ-PPL-009](#req-ppl-009) | retained | WP-012 |
| PPL-010 | [REQ-PPL-010](#req-ppl-010) | retained | WP-012 |
| PPL-011 | [REQ-PPL-011](#req-ppl-011) | retained | WP-012 |
| PPL-012 | [REQ-PPL-012](#req-ppl-012) | retained | WP-014 |
| PPL-013 | [REQ-PPL-013](#req-ppl-013) | retained | WP-014 |
| PPL-014 | [REQ-PPL-014](#req-ppl-014) | retained | WP-014 |
| PPL-015 | [REQ-PPL-015](#req-ppl-015) | retained | WP-015 |
| PPL-016 | [REQ-PPL-016](#req-ppl-016) | retained | WP-015 |
| PPL-017 | [REQ-PPL-017](#req-ppl-017) | retained | WP-015 |
| PPL-018 | [REQ-PPL-018](#req-ppl-018) | retained | WP-013 |
| PPL-019 | [REQ-PPL-019](#req-ppl-019) | retained | WP-013 |
| PPL-020 | [REQ-PPL-020](#req-ppl-020) | retained | WP-014, WP-022, WP-023 |
| PPL-021 | [REQ-PPL-021](#req-ppl-021) | retained | WP-019, WP-029 |
| PPL-022 | [REQ-PPL-022](#req-ppl-022) | consolidated-partial-source-alias | WP-023 |
| PPL-023 | [REQ-PPL-023](#req-ppl-023) | retained-internal-authorized-query | WP-011, WP-048 |


<a id="req-ppl-001"></a>

### PPL-001 — Directory, search, filters and stable pagination

**REQ-PPL-001.** Preserve list/card/pipeline views, search of display name/email/phone, closed status/source filters and all-selected-tags AND semantics in navigable URL state. Hide retired contacts from active directory. Bound requests 1–100 with 24 row default UI pages; changing filter/search/view resets cursor while preserving sibling filters. Use deterministic createdAt +ID keyset and tenant-scoped validated cursors; invalid/foreign cursor cannot disclose rows. Treat search metacharacters literally. Inactive badges use current church-local threshold and effective confirmed-contact date, not email opens or administrative tasks. Full basic contact/address fields remain operationally available only under current tenant DTO policy.

**Target operations:** `people.listPeople`, `people.getPerson`.

**Acceptance:** AC-PPL-001--PPL-001. **Named cases:** TARGET-PPL-001.

**TARGET-PPL-001 fixture:** 25 People with equal createdAt; AND 2 tags; search literal%/_; retired and foreign cursor; switch card/filter/load more; unresolved adult classification. **Expected:** No duplicates/skips/leaks; URL filters roundtrip, active set excludes retired and uncertainty appears without DOB guess.


<a id="req-ppl-002"></a>

### PPL-002 — Profile creation, quick named guests and explicit nullable edits

**REQ-PPL-002.** Preserve contact, independent address/source/sourceDetails/summary notes and stage fields with server validation after trim. Normal full form names allow bounded 255 character components; reject wholly blank display identity. A minimum named guest may supply one real display name with optional phone/email and no fabricated surname. Quick defaults are prospect, source other (meeting quick-add uses meeting_guest_list), and optional US country default shown/editable. Explicit null clears nullable fields rather than blank→undefined losing the edit. Account link/storage key/creator/revision are server-owned. Create/edit writes actor/version/history/audit atomically and do not imply account, adult, commitment, consent or safety clearance. Background-check fields are excluded from every current form/DTO/import/export/tool.

**Target operations:** `people.createPerson`, `people.updatePerson`.

**Acceptance:** AC-PPL-002--PPL-002. **Named cases:** TARGET-PPL-002.

**TARGET-PPL-002 fixture:** Whitespace name, single-name Launch guest, nullable clear, forged account/storage key, valid partial address; request background field. **Expected:** Real name and nullable clear work; blank or forged/excluded field denied, no fabricated identity/grant/qualification appears.


<a id="req-ppl-003"></a>

### PPL-003 — Retire and deliberately restore Person

**REQ-PPL-003.** Use attributable soft retirement, preserving authorized CRM relations/history and private file references; remove from active queries/selectors and prevent new current references. Review actionable assigned duties and household/leadership/assignment effects before committing; unresolved work remains explicitly Needs owner rather than disappears. Native/reviewed restore rechecks tenant/revision, restores only an ordinary retired Person and recomputes current eligibility; it does not restore account seats or transfer private care. Merged sources are denied ordinary restore and routed to reviewed Unmerge. Retired history remains discoverable under current permission.

**Target operations:** `people.deletePerson`, `people.restorePerson`.

**Acceptance:** AC-PPL-003--PPL-003. **Named cases:** TARGET-PPL-003.

**TARGET-PPL-003 fixture:** Retire assigned Person and concurrently insert attendance; restore ordinary retired versus merged source; foreign ID. **Expected:** No current new reference escapes retirement, history survives, duties remain visible and merged source cannot resurrect outside Unmerge.


<a id="req-ppl-004"></a>

### PPL-004 — Account-linked contact identity

**REQ-PPL-004.** Maintain one live same plant Person per account through a partial uniqueness arbiter. Owner bootstrap and accepted ordinary seat link reuse an exact already-linked identity; otherwise show/select a same-email active unlinked contact only when verified non ambiguous, or create a new linked Person. Never choose the oldest ambiguous email match as identity proof or steal another link; client cannot set accountId. Seat removal/email change retains stable account-link history and independently editable CRM email. Recruited-contact source composition remains distinct from all-currently-committed adult size: bootstrap alone is no recruitment/commitment evidence, while a login holder with real adult active commitment may count.

**Target operations:** `people.ensureAccountPerson`, `people.getOwnAccountPerson`.

**Acceptance:** AC-PPL-004--PPL-004. **Named cases:** TARGET-PPL-004, ROLE43-003.

**TARGET-PPL-004 fixture:** Two active unlinked same-email contacts; linked contact email changed; concurrent accept; removed seat; Owner with and without actual commitment. **Expected:** One stable link per account/plant, ambiguity requires explicit review, no authority is stolen and metrics use the correct cohort.


<a id="req-ppl-005"></a>

### PPL-005 — Private Person photo

**REQ-PPL-005.** Apply 3 MiB verified JPG/JPEG/PNG/WebP private image policy and same plant live Person authority. Save generated key/reference/version atomically before old unreferenced cleanup; return authenticated Person/version image route without raw key or signed bearer URL. Foreign/retired photo access returns unavailable. Merge may choose only stored source/survivor photo and keeps referenced bytes until manifest/inverse retention no longer needs them. Failure cleanup cannot delete another currently referenced blob; failed write keeps old reference.

**Target operations:** `people.setPersonPhoto`, `people.removePersonPhoto`, `people.getPersonPhoto`.

**Acceptance:** AC-PPL-005--PPL-005. **Named cases:** TARGET-PPL-005.

**TARGET-PPL-005 fixture:** Foreign/retired Person; failed save and cleanup; replace cached photo; merge chooses source photo and safe inverse. **Expected:** Authorized versioned photo works, no raw key escapes and referenced merge/source bytes remain usable.


<a id="req-ppl-006"></a>

### PPL-006 — Explicit stage changes, warnings and handoff

**REQ-PPL-006.** Allow all 7 closed stages, deliberate forward skips and backward moves with shown skipped-stage guidance, actor/date/reason and expected revision. Same-stage is a no-op receipt. Use one change-stage command from profile and pipeline so profile edit cannot bypass warnings. Leaving committed statuses core_group/launch_team/leader offers exact open-duty handoff to current eligible owner or explicit decline/Needs owner; no hidden partial loop. Stage change alone never withdraws commitment, changes adult classification or revokes earned training/seat. Recording interview/commitment or correction never incidentally demotes an advanced stage.

**Target operations:** `people.changeStatus`, `tasks.planHandoff`.

**Acceptance:** AC-PPL-006--PPL-006. **Named cases:** TARGET-PPL-006.

**TARGET-PPL-006 fixture:** Skip prospect→leader, backward leader→attendee, same-stage retry, concurrent edits and declined open-duty handoff. **Expected:** Warnings and attributable history persist, explicit demotion works, decline keeps Needs owner and other lifecycles do not change implicitly.


<a id="req-ppl-007"></a>

### PPL-007 — Five-column pipeline and actionable warnings

**REQ-PPL-007.** Preserve five visible pipeline columns with final core-group column also containing launch_team/leader milestone badges. Reorder only current active same plant IDs under column/version lock; empty request no-op and foreign/stale order refuses rather than changes unrelated contacts. Read-only viewers have no drag mutation. Cards display only active parent follow-up work and due-local-day overdue/missing warnings. Complete/no_longer_needed/deleted obligations do not show open urgency; a contact without any explicitly created duty may be uncovered but is not invented urgent work. Page/bound queries without dropping full filtered result semantics.

**Target operations:** `people.getPipelineData`, `people.reorderPipeline`.

**Acceptance:** AC-PPL-007--PPL-007. **Named cases:** TARGET-PPL-007.

**TARGET-PPL-007 fixture:** All 7 stages; foreign ID reorder; stale column order; completed/waived/overdue/undated task and uncovered sans duty. **Expected:** Exact 5 columns and milestone badges; current actionable warnings only, no invisible foreign reorder or automatic urgency.


<a id="req-ppl-008"></a>

### PPL-008 — Attributable timeline and authored notes

**REQ-PPL-008.** Typed activity timeline uses event Instant+ID cursor, preserving tied timestamps and visible performer/provenance. Notes validate nonblank bounded 5000 characters; author alone edits/deletes their own note under exact Person/kind/tenant/revision. Edit preserves original occurrence and actor, appends old/new/current author/editedAt/reason correction; delete removes current note body with attributable tombstone/history subject to shared-record deletion policy. Summary profile notes remain separate fields. System audit/qualification events are not user-editable notes. Meeting-linked note must validate actual meeting/attendance relation server-side.

**Target operations:** `people.getActivities`, `people.addNote`, `people.editNote`, `people.deleteNote`.

**Acceptance:** AC-PPL-008--PPL-008. **Named cases:** TARGET-PPL-008.

**TARGET-PPL-008 fixture:** 3 activities at one instant; author A/B; forged personId with valid note ID; edit and delete; ordinary audit row. **Expected:** All timeline entries paginate, exact author/Person scope holds, correction/tombstone explains change and immutable events refuse edit.


<a id="req-ppl-009"></a>

### PPL-009 — Households and explicit address propagation

**REQ-PPL-009.** Tenant household name/address and head/spouse/child/other membership roles are operational facts, not adult classification. Create household+initial head coherently; join validates live same plant Person/household and copies household address only if Person lacks meaningful address. Leaving preserves Person address. Address propagation previews exact active members/current revisions and deliberately overwrites them in one bounded transaction, returning actual count. Empty-household deletion refuses active members; retired member references detach from current household while immutable old membership snapshots retain provenance. Lock Person/household consistently against retire/join/delete to avoid orphan records.

**Target operations:** `people.createHouseholdWithHead`, `people.updateHousehold`, `people.addToHousehold`, `people.removeFromHousehold`, `people.setHouseholdRole`, `people.propagateAddress`, `people.deleteHousehold`.

**Acceptance:** AC-PPL-009--PPL-009. **Named cases:** TARGET-PPL-009.

**TARGET-PPL-009 fixture:** Person retired while household create; concurrent join/delete; own meaningful address versus blank; preview propagation then stale edit; empty with retired history. **Expected:** No orphans/cross tenant links; joining/leaving address rules hold, stale bulk refuses all and history does not block safe empty delete.


<a id="req-ppl-010"></a>

### PPL-010 — Tenant tags and assignment

**REQ-PPL-010.** Keep church-defined tags with a name trimmed of leading and trailing spaces, 1–100 characters. Normalize names with lower(btrim(name)); names differing only by case or surrounding spaces share the same plant-local unique key (plant_id, normalized_name). Internal spaces remain significant. Color is nullable: omission on update keeps the saved color, null clears it, and a supplied color must be a supported named or hex color. There is no archived-tag state or archived-tag filter. Assignment validates live Person and tag in the same plant and a unique pair. Retried assign/remove returns one semantic activity or the original no-op receipt. Rename updates views/export; deletion previews linked count, removes current links and preserves attributable history without becoming a global taxonomy.

**Target operations:** `people.listTags`, `people.createTag`, `people.updateTag`, `people.deleteTag`, `people.assignTag`, `people.removeTag`.

**Acceptance:** AC-PPL-010--PPL-010. **Named cases:** TARGET-PPL-010.

**TARGET-PPL-010 fixture:** Foreign tag/Person; same-name race; repeated assign/remove; nullable color; linked tag delete. **Expected:** One owned label/link semantic result, no false events and linked views/export follow renames with audited deletion.


<a id="req-ppl-011"></a>

### PPL-011 — Skills, gifts and bounded proficiency

**REQ-PPL-011.** Preserve categories worship/tech/admin/teaching/hospitality/leadership/other, optional proficiency beginner/intermediate/advanced/expert, trimmed skill name 1–100 and bounded 5000 character notes. Add/edit/remove have expected revision and atomic activity/correction; category grouping and null clear roundtrip. Retire removed current item while preserving owned history. Recorded skill search/organization is allowed; it does not replace human Gifted interview criterion or infer calling/readiness.

**Target operations:** `people.getPersonSkills`, `people.addSkill`, `people.updateSkill`, `people.removeSkill`.

**Acceptance:** AC-PPL-011--PPL-011. **Named cases:** TARGET-PPL-011.

**TARGET-PPL-011 fixture:** Every enum/null clear; foreign skill ID; stale edit/remove; role qualification record referencing historical skill. **Expected:** Valid recorded skills group correctly, revision/history holds and removal neither rewrites interview nor creates AI judgment.


<a id="req-ppl-012"></a>

### PPL-012 — Human four C’s assessments

**REQ-PPL-012.** Record dated human Committed/Compelled/Contagious/Courageous assessment, each integer 1–5 and optional bounded 5000 character lens notes. Compute total 4–20 server-side and enforce score/total integrity. Preserve all records, actor/occurrence date/recorded instant and latest ordering by assessment LocalDate, recordedAt, ID; late historical entry cannot become latest merely by recording time. Advisory early-stage warning is not a hard gate. Recording does not change stage. Correction is REQ-PPL-015 and never supplies model person judgment.

**Target operations:** `people.createAssessment`, `people.getAssessments`.

**Acceptance:** AC-PPL-012--PPL-012. **Named cases:** TARGET-PPL-012.

**TARGET-PPL-012 fixture:** Four 1/5 scores+forged total; same/out of order dates; prospect assessment; Member/org read; corrected historical score. **Expected:** Computed totals/latest history correct, human provenance intact, early warning advisory and full record is Owner/Admin only.


<a id="req-ppl-013"></a>

### PPL-013 — Human interview and nonregressing progression

**REQ-PPL-013.** Keep all five criteria Maturity/Gifted/Chemistry/Right Reasons/Season as pass/fail/concern with dated human notes, next steps and result qualified/qualified_with_notes/not_qualified/follow_up. ANY result means interview occurred; on lower earlier stage record interviewed progression atomically, while an already core_group/launch_team/leader remains advanced. Only explicit stage command demotes. Chronological latest and attributable history match assessments. Next steps remain recorded text; intended-but-undelivered automatic task prompts are not registered as automation. A user can explicitly draft/create named task through ordinary Task command.

**Target operations:** `people.createInterview`, `people.getInterviews`.

**Acceptance:** AC-PPL-013--PPL-013. **Named cases:** TARGET-PPL-013.

**TARGET-PPL-013 fixture:** Each 4 results on prospect and advanced leader; backdated repeat interview; fail activity write; text next step without task review. **Expected:** All human criteria/results persist with correct history; earlier person advances as interview occurred, advanced person never regresses and no task appears without explicit command.


<a id="req-ppl-014"></a>

### PPL-014 — Commitment records, lifecycle and private document

**REQ-PPL-014.** Preserve core_group/launch_team commitment types, actual signed LocalDate, optional witness/notes/private PDF/JPG/PNG≤10 MiB and authenticated document download. Witness is an optional same plant Person selected from valid tenant record; unstructured external witness may be dated text without foreign Person FK. Support 10 MiB through bounded authenticated upload reference flow rather than oversize action body; failure tracks orphan bytes and never links arbitrary keys. Record/signature, person level active commitment projection, history/source revision/audit and lower-stage core_group entry commit together. Advanced stage is not demoted by repeat card. Explicit dated withdrawal/reactivation changes person lifecycle not stage; old signature cannot override withdrawal. Apply REQ-PPL-026 for current adult size/genuine history.

**Target operations:** `people.createCommitment`, `people.getCommitments`, `people.getCommitmentDownload`, `people.withdrawCommitment`, `people.reactivateCommitment`.

**Acceptance:** AC-PPL-014--PPL-014. **Named cases:** TARGET-PPL-014.

**TARGET-PPL-014 fixture:** 10 MiB valid file and failed commit; foreign witness; repeat launch-team card on leader; withdrawal then reactivation; historical signed date. **Expected:** Private bytes/owned witness safe, coherent record/lifecycle with advanced stage preserved and genuine first occurrence unchanged by recording/rejoin.


<a id="req-ppl-015"></a>

### PPL-015 — Typed qualification and lifecycle correction

**REQ-PPL-015.** Correct exact same plant Person/record kind under current Owner/Admin and expected record revision. Reuse original domain validations; recompute assessment total, preserve original recording actor/time and append typed old/new/corrector/time/reason/receipt before commit. Ordinary score/result/notes/occurrence date correction never replays stage automation. Immutable original account/private author cannot be changed. Document/witness/original assessor replacement is outside ordinary correction fields; no arbitrary field patch or universal Undo. Use explicit new evidence record where necessary, retaining previous private document and provenance under ownership/deletion rules. Invalid historical commitment/lifecycle may be voided/corrected with attributable history and recomputed current projection, preserving earlier assessments. Stale foreign/cross-person or replayed conflicting mutation writes nothing.

**Target operations:** `people.correctPersonRecord`, `people.correctAdultClassification`, `people.correctCommitmentLifecycle`, `people.listRecordCorrections`.

**Acceptance:** AC-PPL-015--PPL-015. **Named cases:** TARGET-PPL-015.

**TARGET-PPL-015 fixture:** Same-record two corrections, foreign Person with known record ID, forged total/provenance, invalid first event correction, attempted original document/witness replacement. **Expected:** One version wins and history matches current state; invalid facts recompute without stage demotion or rewriting authorship, opaque unsafe changes refuse.


<a id="req-ppl-016"></a>

### PPL-016 — Duplicate hints and pair review

**REQ-PPL-016.** Return active same plant exact/potential/no-match hints from normalized email/phone/name; ignore empty/short contact signals and escape SQL wildcards literally. Family name/shared mailbox is only hint, never unique human identity or mandatory merge. Import hints redact to ID/display name. Pair review requires current revisions and disclose conservative blocked merge cause. User may intentionally create duplicate with explicit choice; no foreign retired row or model identity judgment leaks.

**Target operations:** `people.checkForDuplicates`, `people.listDuplicatePairs`.

**Acceptance:** AC-PPL-016--PPL-016. **Named cases:** TARGET-PPL-016.

**TARGET-PPL-016 fixture:** Blank/short/wildcard input, email casing/phone format, same family name/shared mailbox, foreign/retired candidate. **Expected:** Documented hints are bounded scoped and non binding; intentional duplicates allowed with no automatic merge.


<a id="req-ppl-017"></a>

### PPL-017 — Exact merge, redirects and reviewed inverse

**REQ-PPL-017.** Implement REQ-PPL-024 and REQ-PPL-025 as the complete merge/retirement/reference/inverse contract. Preserve field choice preview, account-link survivor protection, private photo choice, source and correction history, exact conflict checks, idempotent receipt and acyclic merged-source redirects. The required Unmerge inverse stays available; raw restore cannot replace it. Historical source callable identity is unavailable in current evidence and no implemented source symbol is claimed. Every later consumer's actual reference integration must pass before that package closes.

**Target operations:** `people.getMergeReview`, `people.mergePeople`, `people.previewUnmerge`, `people.unmergePeople`.

**Acceptance:** AC-PPL-017--PPL-017. **Named cases:** TARGET-PPL-017.

**TARGET-PPL-017 fixture:** Conflicting attendance/card/training/RSVP/follow-up and two accounts; safe unchanged merge+inverse; stale/chained/irreversible effects; later consumer registration. **Expected:** Every blocked collision refuses atomically; safe inverse is usable both native/Evry, receipts/history remain, later conflict returns exact reason and zero changes.


<a id="req-ppl-018"></a>

### PPL-018 — Bounded CSV preview and resumable partial import

**REQ-PPL-018.** Use RFC 4180 parser with BOM/CRLF/commas/escaped quotes/quoted multiline and explicit malformed quoting errors. Keep 12 contact input columns(first_name, last_name, email, phone, street, city, state, postal_code, country, source, source_details, notes); normalizer/defaults match People and background fields are absent. Server limits 10 MiB/10000 rows and reparses validated original bytes/row digest, never trusts client-returned parsed rows. Preview all valid/invalid/existing and within-file duplicate rows; resolutions skip/create/create_and_review never overwrite existing Person. Save frozen reviewed row/resolution digest with import intent; per-row short transactions record created/skipped/error and optional new review pair. Retry resumes only unfinished row keys, no duplicate earlier success. Stale review/authority/digest refuses; partial import returns named row reasons and remaining work, not generic failed after commits.

**Target operations:** `people.generateCsvTemplate`, `people.previewImport`, `people.executeBulkImport`, `people.getImportReceipt`.

**Acceptance:** AC-PPL-018--PPL-018. **Named cases:** TARGET-PPL-018.

**TARGET-PPL-018 fixture:** CSV multiline/BOM/bad quote/formula; existing and within-file duplicates; 3 rows with middle DB failure and lost response; changed preview digest; over cap file. **Expected:** Parser/choices are honest, no overwrite/replayed duplicate, exact row receipt resumes partial work and caps fail before effects.


<a id="req-ppl-019"></a>

### PPL-019 — Filtered formula-safe CSV export

**REQ-PPL-019.** Export same current filters as directory with 15 documented columns: first_name, last_name, email, phone, street, city, state, postal_code, country, status, source, source_details, notes, tags, created_at; tags semicolon joined and recorded createdAt UTC. Header-only empty export valid. RFC 4180 escaping preserves comma/newline/quotes; spreadsheet-dangerous leading=,+,-,@, TAB/CR values get documented leading apostrophe neutralization. The exact bytes are CSV not an XLSX claim. Private photo/account/storage/qualification/background/care fields are absent. Tenant read/export authority rechecked; large exports stream/bound rows and include exact filter/count receipt. Narrow 12 column import ignores status/tags/date, so never claim lossless backup/roundtrip.

**Target operations:** `people.exportPeople`.

**Acceptance:** AC-PPL-019--PPL-019. **Named cases:** TARGET-PPL-019.

**TARGET-PPL-019 fixture:** Each filter+AND tags, empty set, multiline quote, formula-like contacts, foreign/org request, >page export. **Expected:** All filtered owned rows match directory semantics, safe CSV does not execute formulas and private/excluded fields never appear; narrower import limits explained.


<a id="req-ppl-020"></a>

### PPL-020 — Exact cross-domain recruitment advancement

**REQ-PPL-020.** Preserve only conditional source transitions: attended Vision prospect→attendee, active ministry membership core_group→launch_team, ordinary ministry leadership launch_team→leader. Interview event advances earlier stage to interviewed, commitment earlier stage to core_group; repeated recording/correction preserves advanced stage. Perform approved progression with original actor/history/source revision in producer transaction; async wake-up cannot be the only critical writer. Retry same event no-ops without duplicate history. No automatic demotion on role leave, training revoke, commitment withdrawal or plant launch date/phase change. No process-local noop handler is a durable feature.

**Target operations:** `people.applyRecordedRecruitmentEvent`.

**Acceptance:** AC-PPL-020--PPL-020. **Named cases:** TARGET-PPL-020.

**TARGET-PPL-020 fixture:** Each allowed prior stage vs advanced stage, retried event, failed audit, removed role/withdrawn commitment and launch date change. **Expected:** Only named conditional forward effects occur coherently once; no incidental regression or lost material revision.


<a id="req-ppl-021"></a>

### PPL-021 — Person team, training and communication tabs

**REQ-PPL-021.** Project own ing Teams/Training/Communication data under exact Person/tenant current permission; merge redirects and retired history consistent. Show distinct current membership plus dated former tenure; explicit assigned training obligations separate from earned/revoked/former completion history. Actual email sent/accepted/delivered/opened/clicked/bounced/failed are distinct from typed human contact logs; contact badge must not claim provider mail delivery. Empty/unavailable states explain truth and read-only user has no send control. Dates use church zone intentionally; tabs never widen scope.

**Target operations:** `people.getPersonTeams`, `people.getPersonTraining`, `people.getPersonCommunications`.

**Acceptance:** AC-PPL-021--PPL-021. **Named cases:** TARGET-PPL-021.

**TARGET-PPL-021 fixture:** Multi-role Person with former team/earned revoked training, typed contact versus delivered email, foreign/deleted/merged Person. **Expected:** Tab sag ree with current own ing projections and history, no duplicated person denominator or false email delivery/privacy expansion.


<a id="req-ppl-022"></a>

### PPL-022 — Deferred follow-up and task-suggestion aliases

**REQ-PPL-022.** The uncalled deferred follow-up-initiation warning and undelivered interview next-step automatic task prompt are not executable target capabilities. Consolidate useful intent into explicit ordinary follow-up create/assign or reviewed task creation, retaining manualfollowing_up stage. No no-op tool, hidden subscriber, automatic qualification or autonomous stage/task side effect is registered. Show recorded next steps as text with option to explicitly open a task draft.

**Target operations:** `tasks.createFollowUp`, `tasks.create`.

**Acceptance:** AC-PPL-022--PPL-022. **Named cases:** TARGET-PPL-022.

**TARGET-PPL-022 fixture:** Ask for noop source helper, save interview next steps, explicit reviewed follow-up draft/creation. **Expected:** No silent automation or false completion; actual shared task/follow-up operation works when explicitly reviewed.


<a id="req-ppl-023"></a>

### PPL-023 — Internal scoped pipeline metrics

**REQ-PPL-023.** Retain the useful source helper behavior as an internal authenticated same-tenant aggregate query. Count distinct active canonical Persons per current stage at a frozen asOf/revision; separately count distinct Persons with each exact adjacent forward transition within an explicit occurrence-date window, deduplicating repeated forward/backward moves. Preserve the actual historical transition source/revision and name the event window and unit. A conversion rate requires a reconstructable distinct source-stage-at-window cohort; when that denominator cannot be established, return Unknown with the known transition count, never combine current stage population with historical event counts. Do not use these rates as readiness or silently substitute them for named Plant Intelligence metrics. No new visible widget, Evry tool, separate analytics service or actorless helper API is added. The source unmounted status is provenance, not authority to remove the internal useful query.

**Target operations:** `people.readPipelineMetrics`.

**Acceptance:** AC-PPL-023--PPL-023. **Named cases:** TARGET-PPL-023.

**TARGET-PPL-023 fixture:** At October 13 asOf, P moved prospect→attendee twice after a backward move, Q once, R is currently prospect but outside the September transition window, and S is retired/merged. Compare reconstructed September source cohort with missing original cohort history, plus foreign tenant request. **Expected:** Distinct current stage counts and September transition count use different labelled units; repeated P counts once, retired/merged source counts once through canonical history, missing denominator gives Unknown and foreign request refuses. No widget/tool is registered.


## Consumer closure and proof

[Canonical build progress](../build-progress.json) records implementation milestones and completion. Execute the named future cases through real domain requests, disposable PostgreSQL constraints/races/fault injection and native/reviewed-Evry browser paths where surfaced. Prove current authorization again at execution; no test/source count or file presence is runtime proof. Include registered Person references, current source-revision writes, exact partial/committed receipts, correction limits and failure outcomes at each owning consumer closure. Domain adapter files are owned by their specific feature packages; shared Evry runtime/catalog/review UI has one integration owner.
