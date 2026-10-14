# Teams, staffing and saved training obligations

This is the operative target for TEAM-001–015. Use [current actor and role policy](identity-access.md#req-idn-029) and the [Person reference contract](people.md#req-ppl-024). Owner/Admin administer their plant. An existing accepted Member who is the currently stored linked leader may perform only named own-team membership/role/responsibility/program/meeting/attendance actions. A ministry title or unlinked contact does not create an account seat; linking alone supplies no administrative grant. Churchwide training and global team/leader/program correction require Owner/Admin.

Keep configured ministry teams and role slots distinct from people, responsibilities and the eight advisory SME ministry areas. Optional predefined templates are conveniences; neither onboarding nor reading/phase entry creates them automatically. Every durable native/Evry mutation uses current subject authority, expected revision, exact review, atomic domain history/audit/receipt and material source-revision advancement. No new service rotations, inventory, children’s safety module, reporting-hierarchy editor or recurring-services product is added.


## Shared domain contracts


<a id="req-team-016"></a>

### REQ-TEAM-016 — Saved training assignment episodes

Each required program has explicit saved person/program assignment episodes. Preview a team/leader bulk selector against current source revisions, expand to exact live same plant Person IDs, deduplicate overlaps, and show the whole reviewed selection before one versioned roster change. Persist `training_assignment_episode` with person, program, requirement version, current state/effective dates and reviewed selection manifest; `training_assignment_event` records add/remove/correction and original roster history. Unique active person/program is enforced. Later membership, leader, classification or commitment changes never recompute saved applicability silently. Explicit add/remove/correct changes current obligations and source revision atomically. Requirement/version changes show exact affected obligations and completion compatibility; earned evidence is retained against the version actually earned and never relabelled by a program edit. A reused reading-based requirement preserves genuine credited article/source/version progress without forced rereading solely from an upstream revision. Stale preview or partial validation refuses the whole roster change; retries return the same receipt.

Measure distinct current applicable person/program obligations with valid nonrevoked compatible completion evidence. Assignment does not mean completion; unassigned earned completions do not increase the numerator. Complete means 100% of applicable obligations. Missing applicability, unavailable reads, or an empty required-evidence set is Unknown, never 100%. Removed assignments retain prior roster and earned/revoked/corrected history. People tabs, team matrix/health, plant training lens and advisory phase guidance use the same projection/asOf/revision. Historical assessments retain their recorded roster/version.

**Named cases:** TARGET-TEAM-016, SME53-001, SME53-002, SME53-003, SME53-004.


<a id="req-team-017"></a>

### REQ-TEAM-017 — Dated60day attendance AND volunteering evidence

Retain the SME 60 days of unbroken attendance AND volunteering, described as steady attendance and serving. Use dated observed records where available and a dated human planter attestation for unobserved behavior, recording exact Person, both behaviors, sustained start/end or asOf period, question/reference version, actor and correction lineage. CRM tenure, lifetime attendance totals and active membership alone cannot establish continuity. Less than 60 days, one behavior alone or insufficient evidence is Unknown/unestablished; do not invent attendance percentages, event quotas, absence allowances, service calendar, expiry or hidden eighth manual-signal key. Missing app observations do not disprove a dated attestation; unresolved contradiction is visible and a model cannot supply testimony. A qualifying signal only invites a human leadership conversation; interview/4 Cs remain dated human judgments, missing records are next steps, and no readiness/role/promotion/phase effect occurs. Candidate identity evidence is plant-audience only; organizations receive their permitted aggregate projection and private care is never an input.

**Named cases:** TARGET-TEAM-017, SME53-005, SME53-006, SME53-007, SME53-008, SME53-009.


## Feature requirements

| Feature | Requirement | Target disposition | Owning packages |
|---|---|---|---|
| TEAM-001 | [REQ-TEAM-001](#req-team-001) | retained | WP-017 |
| TEAM-002 | [REQ-TEAM-002](#req-team-002) | retained | WP-016 |
| TEAM-003 | [REQ-TEAM-003](#req-team-003) | retained | WP-017 |
| TEAM-004 | [REQ-TEAM-004](#req-team-004) | retained | WP-019 |
| TEAM-005 | [REQ-TEAM-005](#req-team-005) | retained | WP-017 |
| TEAM-006 | [REQ-TEAM-006](#req-team-006) | retained | WP-017 |
| TEAM-007 | [REQ-TEAM-007](#req-team-007) | retained | WP-018 |
| TEAM-008 | [REQ-TEAM-008](#req-team-008) | retained | WP-019 |
| TEAM-009 | [REQ-TEAM-009](#req-team-009) | retained | WP-019 |
| TEAM-010 | [REQ-TEAM-010](#req-team-010) | retained | WP-019 |
| TEAM-011 | [REQ-TEAM-011](#req-team-011) | retained | WP-019 |
| TEAM-012 | [REQ-TEAM-012](#req-team-012) | retained | WP-017 |
| TEAM-013 | [REQ-TEAM-013](#req-team-013) | retained | WP-019 |
| TEAM-014 | [REQ-TEAM-014](#req-team-014) | excluded-specialization-fields | scope disposition |
| TEAM-015 | [REQ-TEAM-015](#req-team-015) | retained | WP-019 |


<a id="req-team-001"></a>

### TEAM-001 — Team catalog and custom lifecycle

**REQ-TEAM-001.** Retain custom/predefined teams with name, description, icon, forming/active/paused states, current leader and staffing counts. Stable templateKey survives rename; name is never template identity. Tenant-scoped lists and team tabs use live membership rather than drifting filled flags. Paused differs from archived. Custom setup and empty states remain usable without accepting a template. Current read-only role receives no mutation controls; server policy remains authoritative.

**Target operations:** `teams.list`, `teams.get`, `teams.create`, `teams.edit`.

**Acceptance:** AC-TEAM-001--TEAM-001. **Named cases:** TARGET-TEAM-001.

**TARGET-TEAM-001 fixture:** Rename a predefined team, create a custom same-display-name team, forming/active/paused lists, multi-role staffing and foreign IDs. **Expected:** Template identity stays stable, custom records stay distinct, correct current staffing/state and tenant controls appear.


<a id="req-team-002"></a>

### TEAM-002 — Archive, restore and team corrections

**REQ-TEAM-002.** Archive hides a team from operational selectors, current staffing/health and default chart/list while retaining team/role/membership/training/meeting history. Explicit archived inclusion permits discovery and authorized restoration. Historical Person tabs show labelled former/archive records. Current follow-up duties remain visible; archiving does not waive them or broaden team programs to churchwide. Edit/archive/restore under expected revision commits current row plus before/after actor/reason history and material revision; repeated same state no-ops. Restoration does not restore revoked seats or rewrite old tenure.

**Target operations:** `teams.archive`, `teams.restore`, `teams.correct`, `teams.history`.

**Acceptance:** AC-TEAM-002--TEAM-002. **Named cases:** TARGET-TEAM-002.

**TARGET-TEAM-002 fixture:** Archive a staffed team with program, meeting and current duty; include archived list/chart; stale edit; restore and retry. **Expected:** Operational exclusion is consistent, history/duty survives, program scope stays team-bound and stale writes create neither change nor history.


<a id="req-team-003"></a>

### TEAM-003 — Optional ministry and role imports

**REQ-TEAM-003.** Retain ten predefined ministry templates and separately selected role catalog through the versioned immutable reference manifest. Preview independently chosen ministries and roles, exact rows and edit able destination choices. Skip/cancel/no selection and all reads create zero structure. Permit later additional selected roles after partial/custom setup; custom same name is never auto-conflated. Unique tenant/templateKey prevents renamed-template duplicates. Reviewed import validates every key/version/authority, creates selected teams/roles/responsibilities and receipt together or explicitly resumes named missing rows under one intent; response loss/retry/concurrent winner never duplicates. Existing customization/occupied leadership survives. Disclosed eligible Owner lead/Senior Pastor assignment uses ordinary selected vacant role only, with no entire automatic template import.

**Target operations:** `teams.previewTemplateImport`, `teams.initialize`.

**Acceptance:** AC-TEAM-003--TEAM-003. **Named cases:** TARGET-TEAM-003.

**TARGET-TEAM-003 fixture:** Partial/custom setup, renamed predefined team, independent roles selected, no selection/cancel, stale version, two concurrent imports and selected occupied pastor role. **Expected:** Only exact reviewed rows are created once, later import remains available, custom/occupied data survives and invalid selection refuses rather than silently dropping rows.


<a id="req-team-004"></a>

### TEAM-004 — Explicit leader and role-derived fallback

**REQ-TEAM-004.** Store leader provenance explicit/role-derived/legacy without fabricated history. Explicit appointment outranks role-derived fallback and survives removing that role; fallback only fills an empty leader. Unlinked live contact may be a visible ministry leader but gains no account grant. Linked account must have current same plant seat to receive own-team actions. Seat revocation clears access-dependent appointment without erasing prior provenance. Candidate search is database-backed beyond the first 100 People. Parent/team-before-role/member locking makes assignment/vacate/retire/access-removal races coherent, with history and source revision in the same transaction.

**Target operations:** `teams.appointLeader`, `teams.appointLeader`, `teams.leaderCandidates`.

**Acceptance:** AC-TEAM-004--TEAM-004. **Named cases:** TARGET-TEAM-004.

**TARGET-TEAM-004 fixture:** Explicit leader plus another leadership role; remove role; linked seat revoked racing appointment; unlinked contact; candidate 101. **Expected:** Explicit precedence holds, revoked account gains no team action, contact appointment grants no seat, search and provenance are complete.


<a id="req-team-005"></a>

### TEAM-005 — Configured role slots and retirement

**REQ-TEAM-005.** Role data includes trimmed name, leadership flag, nullable description/time commitment/desired skills, sort order and open/filled projection from active membership. One slot accepts one active Person; roles are not person counts. Preserve create/edit/import and deliberately delete from current structure through retirement, retaining old membership/assignment history rather than source cascade loss. Preview occupied-role consequences and explicit leader fallback. Dormant reporting fields do not enable a hierarchy editor; if retained for integrity, same-tenant references clear safely without changing fixed chart semantics.

**Target operations:** `teams.createRole`, `teams.editRole`, `teams.retireRole`, `teams.listRoles`.

**Acceptance:** AC-TEAM-005--TEAM-005. **Named cases:** TARGET-TEAM-005, ROLE43-004.

**TARGET-TEAM-005 fixture:** Retire occupied role, explicit versus derived leader, nullable clear, foreign role references and two active occupants. **Expected:** Current slot disappears with history retained, staffing derives actual occupants and no hierarchy or account grant is invented.


<a id="req-team-006"></a>

### TEAM-006 — Membership episodes and advisory overload

**REQ-TEAM-006.** Validate current Person/team/role within tenant and atomically maintain one active occupant/role, slot fill, leader fallback, conditional People progression and history. Competing assignees have one winner and named occupied refusal; duplicate same-assignee retry is distinct from conflicting other occupant. Start/end LocalDate values and actor are preserved; reactivation creates a new tenure episode rather than rewriting prior dates. Person may hold several roles/teams; 2+teams yields an advisory warning, no hard maximum. Removal does not automatically demote People, withdraw commitment, erase earned training or alter account seat. Schema-only pending state has no new self-service work flow.

**Target operations:** `teams.assignRole`, `teams.removeRole`, `teams.reactivateMembership`.

**Acceptance:** AC-TEAM-006--TEAM-006. **Named cases:** TARGET-TEAM-006, ROLE43-004, ROLE43-006.

**TARGET-TEAM-006 fixture:** P in 2 roles/3 teams, competing Q for one slot, repeat P assignment, remove/reactivate, cross-team role and advanced Person. **Expected:** One active slot winner, warning is advisory, episodes and advanced stage survive and tenant/reference mismatches refuse.


<a id="req-team-007"></a>

### TEAM-007 — Responsibility offer and editable checklist

**REQ-TEAM-007.** Preserve custom/predefined responsibility CRUD and tick/untick. Versioned structured Playbook lines are offered explicitly once during setup or later deliberate acceptance; reads/preview have no writes. The accepted/declined offer stamp, selected rows, receipt and audit commit together. Deleted/edited/declined lines never reappear on reload/bootstrap or upstream update. Complete has one current state/date with history and no implied phase pass. Foreign keys/selections and stale revision refuse all effects.

**Target operations:** `teams.listResponsibilities`, `teams.previewResponsibilities`, `teams.offerResponsibilities`, `teams.editResponsibility`, `teams.completeResponsibility`, `teams.deleteResponsibility`.

**Acceptance:** AC-TEAM-007--TEAM-007. **Named cases:** TARGET-TEAM-007.

**TARGET-TEAM-007 fixture:** Read/preview before acceptance, select 2 lines then crash/retry, delete/edit, declined offer and later reference revision. **Expected:** Reads create zero rows, chosen lines commit once, changed/deleted/declined work never resurrects and ticks remain reversible.


<a id="req-team-008"></a>

### TEAM-008 — Programs, assignment matrix and earned completion

**REQ-TEAM-008.** Retain team-scoped and explicitly churchwide programs, required/optional flag and dated human verified completion. Team-leader actions require its own program and current eligible member/explicit saved assignment; churchwide actions require Owner/Admin. Apply REQ-TEAM-016 for required assignments/denominator. Distinct Person/program/version earned completion cannot duplicate via repeated roles; former earned evidence remains visible after team exit. Team retirement/deletion preserves program scope and history; nulling team must never silently convert it to churchwide. Completion is human evidence, independent from scheduling a session or assignment.

**Target operations:** `teams.listTraining`, `teams.createProgram`, `teams.correctProgram`, `teams.attestCompletion`, `teams.trainingMatrix`, `teams.personTraining`, `teams.previewRequiredTrainingParticipants`, `teams.setRequiredTrainingParticipants`.

**Acceptance:** AC-TEAM-008--TEAM-008. **Named cases:** TARGET-TEAM-008.

**TARGET-TEAM-008 fixture:** Multi-role current member, required explicit roster, churchwide program, former earned completion, team archive and foreign completion. **Expected:** Unique genuine earned evidence and saved applicability agree across matrix/tabs; own-team leader cannot broaden scope and scheduling is not completion.


<a id="req-team-009"></a>

### TEAM-009 — Program correction, revoke and redo

**REQ-TEAM-009.** Expected-revision program correction retains before/after actor/version. Completion revoke marks current evidence invalid without deletion; redo appends a new earned event/date/verifier and retains original/revoked/corrected evidence, never silently overwrites history. Reject repeated invalid transition or return original retry receipt. All current training/health/PI queries exclude revoked evidence and respect requirement-version compatibility. Revocation/correction/redo updates material revision with history atomically; assignment episodes stay separate.

**Target operations:** `teams.correctProgram`, `teams.revokeCompletion`, `teams.recompleteTraining`, `teams.trainingHistory`.

**Acceptance:** AC-TEAM-009--TEAM-009. **Named cases:** TARGET-TEAM-009.

**TARGET-TEAM-009 fixture:** Complete→revoke→redo with original verifier/date, stale program update, repeat revoke and cross-tenant record. **Expected:** Current evidence changes once, original earned/revoked chain remains and every consumer uses the same compatible nonrevoked result.


<a id="req-team-010"></a>

### TEAM-010 — Person assignment and training cross-links

**REQ-TEAM-010.** Person views show distinct current team assignments, multiple-role detail, dated former tenure and earned/revoked training independently of current applicability. Archived/retired teams are labelled historical and excluded from current counts; earned completion is not erased. Candidate selection/search is bounded and database-backed, including Person 101. Links recheck exact current Person/team permission and do not grant account authority.

**Target operations:** `teams.personAssignments`, `teams.personTeamCounts`, `teams.personTraining`.

**Acceptance:** AC-TEAM-010--TEAM-010. **Named cases:** TARGET-TEAM-010.

**TARGET-TEAM-010 fixture:** Person 101 with 2 roles, archived former team, active required assignment and former earned/revoked completion. **Expected:** Search/select works, counts use distinct current teams and history/application/earned records remain clearly separate.


<a id="req-team-011"></a>

### TEAM-011 — Measured staffing, attendance and health

**REQ-TEAM-011.** Staffing measures occupied configured slots/slots; team attendance uses distinct actually attended relevant members against preserved historical distinct-member roster, not repeated-role rows or extra guests, over last 4 completed team meetings. Required training uses REQ-TEAM-016. Composite retains 40/35/25% staffing/training/attendance; absent required input means Unknown with no available-component reweighting. Measured zero differs from missing/not-applicable; empty configuration is not 100%. Staffing<40 red,<60 yellow and attendance<50 yellow remain. Exclude archived/inactive/pending from current operational measures while retaining dated historical basis and paused distinction; aggregate reports measured-team denominator. On-demand query, no invented weekly health job/leader alert or phase gate.

**Target operations:** `teams.staffingFacts`, `teams.health`, `teams.aggregateHealth`.

**Acceptance:** AC-TEAM-011--TEAM-011. **Named cases:** TARGET-TEAM-011.

**TARGET-TEAM-011 fixture:** P fills 2 slots, two distinct members attended plus guest; 0 roles, missing training applicability, archived team and measured 0 attendance. **Expected:** Slots and people denominators stay distinct, guests do not inflate, missing input yields Unknown and no phase advancement or new job occurs.


<a id="req-team-012"></a>

### TEAM-012 — Organization view and SVG/PDF export

**REQ-TEAM-012.** Preserve all-team and single-team responsive chart, pan, visible leaders/roles/vacancies and identical legible SVG/PDF exports, with long/unbroken-name wrapping in shared drawing model. Leadership template is the fixed root, other teams children; labels say organization view, not formal reporting hierarchy. Current default excludes archived with explicit labelled inclusion option. Tenant DTO excludes raw contact/account/storage IDs and unsafe markup; exports reauthorize current scope. Dormant reports To data does not create hierarchy editing.

**Target operations:** `teams.orgChart`, `teams.exportOrgChart`, `teams.exportOrgChart`.

**Acceptance:** AC-TEAM-012--TEAM-012. **Named cases:** TARGET-TEAM-012.

**TARGET-TEAM-012 fixture:** All/single team, renamed Leadership template, no Leadership/custom teams, archived option and 200 character unbroken names in both exports. **Expected:** Faithful legible shared drawing and correct tenant projection; no hidden reporting editor or raw identity/storage keys appear.


<a id="req-team-013"></a>

### TEAM-013 — Shared team meeting and training session

**REQ-TEAM-013.** Use the shared meeting type team_meeting with subtypes regular/training/planning/special/rehearsal, location/date/notes/status and one deduplicated active Person roster snapshot. Global list and team tab project the same meeting ID. Current own-team linked leader can schedule and record its team's attendance only; broader guest/RSVP/card/delete administration remains Owner/Admin. Later roster changes offer explicit reconciliation rather than mutate snapshot. Session scheduling emits a recorded fact, no nonexistent calendar integration/task generation or automatic training credit.

**Target operations:** `teams.scheduleMeeting`, `teams.listMeetings`, `meetings.setAttendance`.

**Acceptance:** AC-TEAM-013--TEAM-013. **Named cases:** TARGET-TEAM-013.

**TARGET-TEAM-013 fixture:** Schedule by own vs other leader, P in 2 roles, membership change after create, global/team views and training subtype. **Expected:** One meeting/unique roster, bounded controls and stable snapshot; session exists without fabricated calendar/task/completion effect.


<a id="req-team-014"></a>

### TEAM-014 — Deferred background/specialization disposition

**REQ-TEAM-014.** Background-check tracking and children’s roster status display are excluded, including renamed-template lookup, imports/exports and assistant fields. Unimplemented child ratios/curriculum/rooms/acknowledgments, worship songs/rotations, inventory and apprenticeship remain outside current build. Generic desired-skills and advisory overload stay under TEAM-005/006; no software safety-clearance inference is introduced.

**Acceptance:** AC-TEAM-014--TEAM-014. **Named cases:** TARGET-TEAM-014.

**TARGET-TEAM-014 fixture:** Request children’s check status through renamed template/CSV/Evry and request specialized safety/rotation operation. **Expected:** Excluded data/tools are absent; retained generic role skills/overload work without a new safety or specialized subsystem.


<a id="req-team-015"></a>

### TEAM-015 — Exact cross-feature effects

**REQ-TEAM-015.** Active role assignment advances only core_group→launch_team; qualifying ordinary ministry leadership advances only launch_team→leader. Required People history and plant source revision commit with membership/leader mutation and original actor; repeat/no-op produces no duplicate semantic event. Removal never demotes automatically. Staffing/program/assignment corrections synchronously dirty relevant fact revision. Communication Hub owns actual team sends; emitted staffing/training_scheduled placeholders do not claim welcome mail, calendar, weekly alert or task delivery.

**Target operations:** `teams.assignmentEffects`.

**Acceptance:** AC-TEAM-015--TEAM-015. **Named cases:** TARGET-TEAM-015.

**TARGET-TEAM-015 fixture:** Assignment/leadership from exact vs advanced stages, retry, source revision transaction failure, training scheduling without subscriber. **Expected:** Only approved conditional progression and facts occur once; source watermark cannot lag commit and no phantom integration is reported.


## Consumer closure and proof

Implementation remains `not_started`. Execute the named future cases through real domain requests, disposable PostgreSQL constraints/races/fault injection and native/reviewed-Evry browser paths where surfaced. Prove current authorization again at execution; no test/source count or file presence is runtime proof. Include registered Person references, current source-revision writes, exact partial/committed receipts, correction limits and failure outcomes at each owning consumer closure. Domain adapter files are owned by their specific feature packages; shared Evry runtime/catalog/review UI has one integration owner.
