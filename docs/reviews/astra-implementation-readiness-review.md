# Independent implementation-readiness review — EveryField v3

**Review date:** 2026-10-03. **Verdict:** conditional go for a bounded representative spike and first operational slice after discussion; no-go for treating the current plan as a complete, frozen specification for a broad parallel build. This is a review, not implementation authorization.

The substantive architecture, source-semantic and product-question reviews were performed by three independent `gpt-6-astra` agents at `high` reasoning effort, as requested; the coordinator inspected current artifacts, cross-checked findings and assembled this report. Existing documentation was preserved. No application code, deployment, database activity, provider inference, source changes or external upload was performed. The concurrent explorer HTML and its worker-owned files were not edited.

## Executive judgment

The plan is a strong preservation audit and a credible architectural direction. Its treatment of the SME Plant Intelligence rubric, Playbook, vision meetings, ministries, interviews, commitments and human 4Cs is substantive, not just a list of feature names. One PostgreSQL database, explicit domain operations, shared UI/assistant behavior, real transactions, private artifacts and durable external-effect handling are proportionate. The current complexity budget already rejects services per module, generic workflow engines and one tool per legacy helper. Those corrections deserve credit.

It is **not yet a complete implementation contract**. The principal gaps are conflicting authority, underspecified cross-module ownership, semantic source misstatements, and decisions scattered outside the 17 named ODs. The 86-node graph is acyclic and its slices are dependency-closed, but that is insufficient to prove that a scheduled package has all the implementations needed for its promised behavior. The prior `docs/review.md` conclusion of “no remaining documentation blocker” should be read as the result of that review's checks, not carried forward as an unconditional readiness certification.

### High-severity corrections

1. **Private check-in exposure contradicts the preserved privacy rule.** `docs/evry-design.md`, “Feature-to-tool surface,” Plant Intelligence row (line 113), permits check-in reads and `save check-in`. `docs/methodology-foundations.md`, METH-10, and `docs/modules/methodology-intelligence-launch.md`, “Authority and privacy contract” / PI-038, exclude this private care data from Evry and AI. Remove private care operations from the assistant catalog by default and make the denial explicit in generated catalogs and direct-tool tests. Keep legitimate operational attestations separate. This is a specification conflict with potential sensitive-data consequences, not an autonomy preference to leave to the model.
2. **The DAG does not express several actual transactional prerequisites.** WP-022 promises finalization without half-completed work but does not depend on the task/follow-up kernel; WP-023 introduces obligation semantics afterward. WP-015 promises complete merge accounting before future Person-reference owners have landed. Split kernel contracts from later UI/enrichment, or combine a cohesive vertical integration batch; do not create circular dependencies by simply adding every later package as a prerequisite.
3. **Auth and domain atomicity must be demonstrated or deliberately revised.** The architecture promises account+invitation+grant+Person atomicity; the contract also describes Better Auth plus separate domain orchestration. Verify the selected adapter's actual transaction boundary with injected failures. If credentials cannot share the transaction, use a durable unprivileged, resumable registration state followed by atomic domain acceptance. A user account must never acquire partial or stale authority.
4. **Assessment job identity must permit time-only refresh.** The unique candidate tuple `(plant, sourceRevision, rubricHash, assessmentPolicyVersion)` is insufficient as lifetime deduplication: a quiet plant needs a new assessment after seven days although its source revision is unchanged. Separate active lease uniqueness, retry identity and immutable run identity; include an evaluation period or make the claim explicitly active-only. Otherwise correct idempotency can permanently suppress required freshness.
5. **Material-source freshness needs a synchronous watermark.** Some source mutations place PI invalidation in an after-commit outbox, while publication relies on a current source revision to reject stale results. Define an atomic watermark increment for every material source mutation; queue only the expensive follow-on work. Test a mutation during inference while the outbox is paused. Private check-ins must not dirty intelligence.

### Important semantic correction

**Private-care nudge semantics are misstated.** The plan says three consecutive “struggling” answers; actual source accepts both `strained` and `struggling`, with a mixed-answer test. The plan also claims missing weeks break the sequence, while the inspected implementation does not check week spacing. Preserve the actual distinction between source behavior and a proposed correction; have the product/SME owner rule on the future private nudge behavior.

These are blockers to the affected contract/package signoffs. They need not block a read-only discussion or a bounded architecture spike using synthetic fixtures once separately authorized.

### Worthwhile corrections before broad parallel work

- Centralize every unresolved behavior and its provenance, including module-only and acceptance-only questions. Do not require all questions to be answered before the first slice. Attach each to the earliest contract or production capability it can affect.
- Give one named owner to shared Evry registry, runtime, cards and executor integration. The 28 read/write batches currently name the same broad paths. Give domain adapters disjoint paths and a single integration owner; a prose request to coordinate does not make concurrent edits safe.
- Reduce first-slice prerequisites to the actual user journey. The current DAG's S0 totals **14 packages / 40 assumed engineer-days**; cumulative S1 totals **30 / 82**. These are calculations from `dag.json`, not delivery forecasts. Imports, complete merge tooling and all settings need not precede the first small assistant read/reviewed-write demonstration. Preserve their target scope and acceptance IDs for later delivery.
- Turn reference-content publication into a small explicit release protocol: approved bundle, validate/render/link check, rebuild derived corpus, atomically select generation, retain previous version, and rollback the active pointer. A full content CMS is unnecessary initially; product editorial authority remains necessary.
- Run cross-module races and privacy fixtures at the slice that introduces the behavior. WP-056 is a final consolidated verification, not the first occasion to test integration.
- Implement auditable explorer status publication before assigning build agents. A static single HTML file cannot observe repository changes or certify tests by itself.

### Optional polish

Do not spend the first build budget perfecting estimates, a generic operation registry, generalized schemas, multi-workspace support, a custom Wiki CMS, code-mode execution or universal undo. Keep stable traceability IDs and simple operation-specific contracts. Re-estimate after the first measured slice. Interface abstraction is justified by actual shared behavior; the size of the audit is not evidence that a large framework is needed.

## Architecture recommendation and proportionality

Keep a modular monolith with domain folders, one relational database and one schema release owner. Next.js + Better Auth + Tailwind/shadcn is coherent. Use the requested current stable release baseline only after pinning and compatibility tests. This review reopened the official [Next.js security release](https://nextjs.org/blog/september-2026-security-release) and [Better Auth 1.7.7 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.7); they support the plan's cited baseline, but do not establish cross-library compatibility. No dependencies were installed.

The deployment topology is still a real choice. **Modular Next plus a durable worker is the default cost comparator**, not a consolation architecture. A separate Bun API is justified if the actual host/stream/worker constraints or operational ownership earn its extra deployment, SSR credential forwarding, observability and contract coordination costs. If choosing Bun, the user's Elysia familiarity is a real advantage; compare it fairly with Hono's small portable adapter surface. The strongest two candidates should be selected on maintenance fit before doing identical spikes. Do not build the entire product twice or compare only synthetic throughput.

Use one small behavior set for the spike: sign-in and invitation acceptance with rollback/reconciliation; forbidden cross-tenant request; revision-conflicting update; real PDF/DOCX/XLSX fixture rendering and upload limit; disconnect/reconnect of an assistant run; durable worker restart. Record deployable count, local setup, cold/steady behavior where relevant, connection pool constraints, required native/render libraries, monthly baseline and workload assumptions. No provider-specific cost figure is established by the current plan. Choose based on observed behavior and maintainability, not presumed Bun speed or Next limitations.

Plain functions, typed request schemas and a small explicit operation catalog suffice initially. Retain Drizzle if it makes constraints and transactions readable; it must not become a generic repository framework. Use one maintained PostgreSQL job mechanism if it covers the actual lease/retry needs; avoid maintaining both a queue framework and a second homegrown scheduler without a clear reason. Separate workers are not separate domain services. Keep source-of-truth SQL, runtime assertions and transport parsing at their respective boundaries rather than reproducing the same validator at every layer.

The existing 72-hour oversight fallback has stronger provenance than a stray implementation detail: `product-docs/features/phase-engine/rubric-v1.md` records its accepted release in the change log. OD-016 may still invite a new v3 product/privacy decision, but the discussion must acknowledge that accepted history rather than assert that the fallback has no methodology provenance.

## Smallest decision set before starting

The user requested discussion before implementation. No recommendation below is approved merely because it is in this report.

1. **Confirm the first implementation objective:** representative topology/auth/job/file/stream spike followed by one People → vision meeting → attendance → actual follow-up workflow, with an early bounded Evry operation. Full preservation remains the target; this is delivery order.
2. **Select the two topology candidates and evaluation limits:** modular Next+worker against the preferred Bun framework, with Elysia familiarity explicitly weighted. Final topology follows evidence rather than preceding the spike.
3. **Confirm first-slice authority:** single active tenancy seat with independent coaching grants; private check-ins excluded from Evry; proposed first Evry policy of authorized reads/drafts plus exact reviewed durable writes, without delegated autonomous tasks. Safe auth UI handles secrets.
4. **Name integration and status ownership:** schema/contracts owner, Evry kernel owner, reference owner, and explorer publisher; adopt per-package evidence records and an integration gate. These roles may be held by the same person/agent in a small team.

Before the operational slice closes, also settle its actual behavior choices: non-regression of advanced People status when recording an interview/commitment, typed actual-contact outcome, recurrence/date behavior if included, and the auth acceptance atomicity result. Before intelligence implementation, settle the eight ministry-area mapping and rubric/follow-up alignment with the SME. Before disclosure/inference, settle oversight policy and verified provider data posture. Wiki editorial approval, post-retirement scope, transfer/deletion, fine-grained administration and optional analytics can proceed on their own gates; none requires freezing all product decisions to begin the technical spike.

## Explorer progress: auditable single-file delivery

**Current review scope:** the explorer is being built concurrently. This review does not claim to have inspected its final behavior and does not modify its files. The existing plan's `dag.json` contains planned statuses; `validation.json` describes documentation checks. Neither is evidence of implemented application progress.

Adopt the following workflow as a required build-agent contract, with the user-visible output remaining `everyfield-build-explorer.html`:

- **Canonical facts:** keep plan structure in `docs/plan/dag.json`; keep execution evidence in separate per-package status records (for example `docs/build-status/WP-022.json`). Each active package has one owner. An agent edits its own record on start, material progress, failed checks, blocked decisions, review submission and completion. Do not have all agents edit one status JSON or the HTML.
- **Minimum record:** package ID, state, owner, attempt, target branch/commit, changed artifact paths and hashes/revisions, linked acceptance IDs, exact test command and environment, timestamp, outcome and log/artifact path, unresolved failures, decision dependencies, reviewer and integration revision. Avoid secrets and real personal data. Record `not_run`, `failed`, `passed` and `waived_by_named_decision` distinctly.
- **Completion policy:** `planned → in_progress → ready_for_review → verified`, with explicit blocked/superseded states. `ready_for_review` is an agent assertion; `verified` requires inspected artifacts and appropriate passing acceptance at the integrated revision. Relevant dependencies must be verified or explicitly compatible. A changed input invalidates affected proof until rerun; a retry does not erase failed evidence. File existence, elapsed time, a commit, screenshots alone, or agent self-report are insufficient.
- **Single publisher:** one integrator validates status records against the DAG, artifact existence/revision and acceptance bindings, then regenerates the standalone HTML using deterministic inputs and an atomic replacement. Workers publish evidence fragments; they do not compete for the shared HTML, registry or aggregate totals. Worktrees/branches isolate file edits; merge review serializes genuinely shared changes.
- **Update cadence:** regenerate after every accepted status change and integration event, and before each agent's final handoff. Continuous progress means updates throughout work, not only a final checkbox. Show the last generation time, evidence revision and stale/unverified state. If genuinely live viewing is desired, an explicitly started local read-only watcher can rebuild/serve the same HTML; the saved standalone artifact remains a snapshot and should say so.
- **Honest totals:** display verified obligations separately from packages in progress and pending SME decisions. Do not calculate confidence from lines written, number of tests or the original 222-day estimate. A weighted progress view may be useful but must disclose weights and never imply that a high percentage certifies security or methodology.
- **Verification of the workflow itself:** future tests should prove a failed required check prevents verification, unknown package/evidence IDs fail validation, two worker updates survive a rebuild, changed artifacts mark proof stale, and the generated HTML opens standalone with embedded status data. These are necessary checks of the new user requirement, not application implementation performed by this review.

Add this contract to future v3 agent instructions and task handoffs. The v2 `AGENTS.md` rule that status lives only on the GitHub board is historical workflow evidence; the user's new explicit explorer requirement governs v3. Do not maintain two competing canonical status stores. If a board is used later, generate its status from the same accepted evidence or explicitly designate one canonical direction.

## Prioritized proposed edits and dependency implications

| Priority | Proposed plan correction | Earliest gate / owner |
|---|---|---|
| P1 | Remove private care from Evry catalog and distinguish private-checkin contracts from operational attestations | C0 actor/data classification; WP-039, WP-052, WP-073/074; domain + assistant owners |
| P1 | Resolve auth transaction/reconciliation contract with actual adapter fault tests | WP-003 before WP-005/008 freeze; platform owner |
| P1 | Introduce task/follow-up kernel ownership before atomic meeting finalization; preserve a closed integrated slice | WP-022/023/024 before scheduling; domain integrator |
| P1 | Make Person-reference registry extensible and mandatory for each new consumer; test merge/retirement after each addition | WP-015 initial contract; all later referencing modules; schema owner |
| P1 | Increment the material-source watermark atomically with each relevant mutation; prove stale publication refusal with outbox paused | Before parallel source-writer implementation; WP-040/043; domain + intelligence owners |
| P1 | Separate assessment lease/dedup identity from time-based run refresh | WP-004/031/040/043 schema/job contract; intelligence owner |
| P2 | Reconcile private nudge evidence and explicit future behavior | WP-039; product/private-care owner |
| P2 | Centralize OD and embedded questions with approved/recommended/deferred distinctions | WP-001 continually; product/SME owner |
| P2 | Fence stale lease owners on heartbeat/result/publication; state external-call duplication limits | WP-031/043; worker owner |
| P2 | Disjoint adapter paths plus one shared Evry kernel/registry/review owner | Before WP-059..086 parallel dispatch |
| P2 | Move relevant integration proof into each slice; keep WP-056/057 as final regression/release gates | All slice owners + integration reviewer |
| P2 | Versioned reference release/promotion/rollback with reproducible corpus | WP-032/033/035/041; reference owner |
| P2 | Adopt canonical progress records and one explorer publisher | Before first build-agent assignment |
| P3 | Re-estimate effort, consider optional libraries/code mode only after measured need | After representative slice |

The following appendices contain the detailed Astra evidence and the question-by-question dispositions. Recommendations are proposed answers for discussion; source evidence is identified separately from intended future corrections.


## Appendix A — Product and methodology questions

Review date: 2026-10-03. This is a read-only review of the v3 plan and local v2 evidence, plus this requested review appendix. No recommendation below is an approval. No implementation, database, migration, customer import, deployment or upload was performed. I read v2 `AGENTS.md`, `memory/index.md`, and the relevant domain/foundational principle skill instructions. These repository instructions inform source interpretation; they do not make historical architecture a v3 mandate.

### Executive assessment

The plan preserves the major SME foundations: seven phases, eight lenses, vision meetings, follow-up, human interviews and 4 C's, commitment documents, ministry staffing, training, and launch preparation. It is not ready to claim every open product question is centrally tracked: seventeen OD rows coexist with many explicit questions in module acceptance criteria and contract-freeze prose. A question-to-acceptance crosswalk is needed before declaring the register complete.

Three material distinctions matter. First, C12 biweekly cadence is already ruled; stale prompt/changelog wording is a source reconciliation task, not a new SME vote. Second, the 72-hour oversight fallback appears explicitly in the reviewed v1 rubric change log, not merely in implementation; changing it is a v3 policy reconsideration. Third, people/role denominators, actual-contact evidence and ministry coverage maps change the meaning of measurements; they cannot be hidden in an engineering refactor.

Recommendations: finish a thin operational S1 with explicit human judgment, dependable person/meeting/follow-up records and an Evry read/draft kernel; require an explicit authority disposition before reviewed writes or delegated execution. Resolve only decisions that alter S1 contracts before S1; leave later content publishing, hierarchy, reporting and full PI choices as dated gates for their dependent slices. “Deferred” below means deferred decision/implementation, never approved feature removal.

### Reading key and sources

- **M**: methodological ruling or SME interpretation needed. **P**: product/privacy authority. **E**: engineering default within an agreed contract. Some choices need both.
- **H/M/L confidence**: confidence in the recommendation from inspected evidence, not confidence that a human has approved it.
- **S0** is runtime/auth/contracts/platform; **S1** is person → vision meeting → attendance → first-time follow-up → outcome/history, plus early Evry. Exact scope: `/Users/sebastian/dev/everyfield_v3/docs/plan/build-plan.md:379`, especially rows at 385–386. Its published S1 includes WP-014/015, so qualification effects are part of that stated scope.
- **V3** means `/Users/sebastian/dev/everyfield_v3`; **V2** means `/Users/sebastian/dev/everyfield_v2`; **ALPHA** means `/private/tmp/everyfield-alpha-implementation`.
- Current OD wording below is quoted exactly from `V3/docs/open-decisions.md:7–23`, Decision/gap column. The same rows contain proposed defaults, responsible roles and package blocks; these are proposals, not evidence of approval.
- Methodology hierarchy: `V3/docs/methodology-foundations.md:7–25`; actual canonical evidence inspected: `V2/product-docs/launch-playbook.md`, `V2/product-docs/features/phase-engine/rubric-v1.md`, `V2/product-docs/features/phase-engine/bryan-comments-review.md`, `V2/product-docs/decisions.md`. The historical Google Doc was not fetched by this reviewer; v3 records a prior delegated read. Do not promote that indirect provenance to independent verification here.

### All seventeen named decisions

#### OD-001 — “Separate Bun/Hono, Elysia or modular Next topology”

**Recommendation (E; H on decision method, M on winner):** keep the choice provisional; briefly compare Bun framework fit, then run the same auth/recovery, transaction rollback, file preview and SSE reconnect slice in modular Next and the user's preferred Bun framework. The user's Elysia familiarity is a concrete maintenance advantage and should count in that selection; Bun/Hono is not entitled to lead merely because the draft says so. Pick the simpler deployable result given measured limits and team maintenance. Do not build a third full spike unless the first comparison reveals a material unanswered issue.

**Impact/tradeoff:** a short evidence spike avoids locking all modules to an unproven integration; two implementations cost a little now. **Gate:** S0/WP-003 final freeze, not permission to block source review or domain design. **Provenance:** OD row7; `V3/docs/plan/build-plan.md:418–426`; methodology authority is independent of runtime (`methodology-foundations.md:3–5`).

#### OD-002 — “Confirm the available Wiki snapshot as the v3 starting version”

**Recommendation (M/P; H):** use the already available 96-article/21-section/7-template bundle as the candidate reference release. Obtain editorial/currentness signoff, verify assets and links, then build fresh derivatives from that exact approved content. Do not request another live export merely to plan; do not silently substitute newly written guidance.

**Impact/tradeoff:** preserves SME substance and reproducibility; editorial review remains real work even though MDX compiles. **Gate:** Wiki/reference publication WP-033 and full release; S1 can proceed with clearly provisional reference fixtures. **Provenance:** OD row8; `V3/docs/methodology-foundations.md:23,83,88–97`; `V3/docs/modules/communications-knowledge-ops.md:1141`. Compilation does not establish semantic correctness.

#### OD-003 — “Evry autonomy/approval scope”

**Recommendation (P; H):** propose operational read/draft plus exact reviewed writes as the first authority model. A proposal must identify subjects, changed values/consequences, revision and expiry; execution must recheck actor, subject, approval and current state and return a durable receipt. Delegated classes require a later explicit scope, revocation and audit ruling. Current user direction restores Evry, but does not by itself approve autonomous writes.

**Impact/tradeoff:** useful operational help with visible human control; review adds a step for mutations. No pastoral/prayer/biblical counsel, inferred interview/4Cs judgments or private-care tools. **Gate:** read/draft S1 does not need new write authority; execution in S1/WP-053 and production WP-055 does. **Provenance:** OD row9; `V3/docs/modules/meetings-tasks-teams.md:186`; `V3/docs/modules/methodology-intelligence-launch.md:145`; `V3/docs/methodology-foundations.md:47–49,86`.

#### OD-004 — “Status changes when recording a later/negative interview or commitment”

**Recommendation (M/P; H):** retain “interviewed = an interview happened, any outcome”; record the human result separately. A new record may advance an earlier stage according to the approved progression, but must not silently demote Core Group/Launch Team/Leader. Commitment records retain their type and evidence; do not infer that a launch-team commitment alone overrides the distinct team-assignment transition. Provide an explicit human stage-change operation for intentional regression/correction.

**Impact/tradeoff:** a repeat interview no longer accidentally removes an advanced person from operational cohorts; a deliberate negative decision needs an explicit status action. **Gate:** S1 qualification packages WP-014/015. **Primary conflict:** `V2/src/app/(dashboard)/people/assessment-actions.ts:172–174` unconditionally writes interviewed; `:286–288` unconditionally writes core_group. Intended meaning/FRD references: `V3/docs/modules/identity-people.md:1361–1421,1589–1599,1790`; Playbook interview and commitment: `V2/product-docs/launch-playbook.md:290–340`. This recommendation is not an approved rewrite of the pipeline.

#### OD-005 — “Team health denominator counts people or membership/role rows”

**Recommendation (M/P with E arithmetic; H):** staffing uses role slots; attendance uses distinct eligible people per meeting; training uses distinct applicable person/program obligations. Retain accepted weights pending a named measurement ruling. Decide whether membership eligibility is measured at the event or at assessment time, and label it. Separate Unknown, N/A and measured zero; do not turn a no-evidence team into 100%.

**Impact/tradeoff:** one person covering two roles does not count twice against one attendance or training fact. This changes scores and must be acknowledged/versioned. **Gate:** defer beyond S1 to TEAM-011/WP-019/040. **Primary evidence:** `V2/src/lib/ministry-teams/health.ts:44–46,74–82,100–120`: row-based denominators, distinct-person membership set in numerator, 40/35/25 weights; `V3/docs/modules/meetings-tasks-teams.md:81,84` exposes unique training matrix versus metric tension. This local team score is not itself the SME eight-lens rubric or a phase gate.

#### OD-006 — “Stale or unsupported rubric copy / role list variants”

**Recommendation (M for mapping; E/editorial for ruled copy; H):** split into two decisions. C12 is already ruled: target 14 days, watch 21/direct 28, weekly permitted. Correct stale compiled/changelog wording with citation to that ruling. For roles, preserve all eight ministry areas and all ten operational templates; have the SME approve a stable responsibility-to-role/team map. Never silently swap Prayer for Administration/Finance or invent a ninth mandatory area.

**Impact/tradeoff:** avoids contradictory advice and inaccurate “six of eight” coverage. **Gate:** canonical role mapping before reference/team/PI contracts WP-032/041/042; no new cadence vote. **Primary evidence:** `V2/product-docs/features/phase-engine/rubric-v1.md:67` stale “deferred”, versus `:152–159,838–845` ruled; `bryan-comments-review.md:490` stale open, `:501,516,546` closed; `V2/product-docs/decisions.md:39`; eight areas `launch-playbook.md:70–79`, Prayer Leader responsibilities `:556`; rubric eight-role list `rubric-v1.md:117` versus Prayer “one of eight” `:718–720`.

#### OD-007 — “Provider accepted but interrupted mail claim recovery”

**Recommendation (E/P operational recovery; H on principle, provider details unverified):** persist delivery intent, stable provider key and attempt outcome; distinguish accepted/delivered/unknown/failed. Reconcile unknown outcomes before replay; expose operator recovery with exact scope and audit. Do not promise external exactly-once from a DB uniqueness constraint.

**Impact/tradeoff:** avoids duplicate emails after a crash; ambiguous delivery may wait for reconciliation. **Gate:** WP-028/031, and S0 durable-job contract; real mail not needed to prove person/meeting S1 with stubs. **Evidence:** `V3/docs/modules/communications-knowledge-ops.md:34–35,156–164,348–352`; OD row13. No live provider guarantees were checked in this review, so the provider-specific replay policy cannot be certified here.

#### OD-008 — “Storage/DB/jobs hosting and process limits”

**Recommendation (E; H architecture, M vendor):** PostgreSQL with real transaction support, private object storage, durable jobs and explicit file-render/stream limits; select the fewest deployable processes that meet the measured spike. Do not pre-approve provider costs, retention or limits from old docs.

**Impact/tradeoff:** reliable operations and files without a prematurely elaborate service estate. **Gate:** S0 WP-003/004/050. **Evidence:** OD row14; representative-spike gate `V3/docs/plan/build-plan.md:418`; object/SQL lifecycle separation `V3/docs/modules/communications-knowledge-ops.md:24`. Vendor choice remains unverified.

#### OD-009 — “AI provider/model retention and current data posture”

**Recommendation (P/E; H):** verify current account configuration, contracts, tracing destinations and disclosure before using sensitive production data. Build/evaluate against synthetic fixtures meanwhile. Keep private sustainability and confidential human material out of model input by default; metadata observability does not establish provider retention terms.

**Impact/tradeoff:** honest disclosure and narrower exposure; production AI waits on concrete evidence. **Gate:** WP-042/043 production inference, not S1 operational records or synthetic integration. **Evidence:** OD row15; `V3/docs/methodology-foundations.md:82`; `V2/product-docs/decisions.md:33`. This review makes no current vendor retention/legal claim.

#### OD-010 — “Post-retirement/unmerged Evry capabilities count as target parity”

**Recommendation (P; H):** retain the full operation inventory for review; classify each as wanted behavior, historical implementation, partial requirement or obsolete mechanism. Preserve approved user needs through shared domain operations; do not automatically reproduce every local experiment as a product feature or discard it because main retired chat.

**Impact/tradeoff:** avoids both accidental feature loss and unnecessary revival. **Gate:** S1 selected people-operation parity before its adapter; full WP-052–055 disposition later. **Evidence:** OD row16; source classification `V3/docs/sources.md:5–10,29–33`; main retirement `V2/product-docs/decisions.md:14`; user direction reconciliation `V3/docs/methodology-foundations.md:86`. Restoration is current direction; exact authority is separate OD-003.

#### OD-011 — “Orphan/helper/historical models”

**Recommendation (E/P; H):** design fresh v3 tables from current semantic operations and required future history. Carry no customer records or migration ledgers. Preserve source/history documentation for interpretation; a leadership-version or session table needs a new table only when an approved operation/query needs its semantics.

**Impact/tradeoff:** smaller clean schema without deleting required behavior. **Gate:** S0 schema and selected-operation contracts; unused historic helpers need not block S1. **Evidence:** OD row17; `V3/docs/methodology-foundations.md:88–97`; `V3/docs/sources.md:31–33`. “Retain history semantics” must not be read as a customer migration requirement.

#### OD-012 — “Single tenancy seat versus future multiple workspaces”

**Recommendation (P; H):** one active tenancy seat plus independent coaching grants; model those explicitly. A normalized membership table must not silently enable multiple simultaneous workspaces. Defer a multiworkspace product expansion until named workflows justify it.

**Impact/tradeoff:** predictable permissions and less context confusion; users cannot acquire arbitrary extra tenancy seats. **Gate:** S0 auth/grants WP-006/008; future expansion deferred. **Evidence:** OD row18; `V2/product-docs/decisions.md:18–21`; `V3/docs/modules/identity-people.md:1727–1736`.

#### OD-013 — “Support deletion/ownership transfer and historically deferred scope”

**Recommendation (P; H):** split this catch-all into named backlog entries. Preserve finance as deferred, facility-management software as previously cut, SMS/scheduled sends as post-beta, video as near-term cut, deletion via support and transfer as separate design. Current user can reconsider any; inventory alone is not approval. Retain Playbook facilities/financial preparation guidance even when dedicated management software is absent.

**Impact/tradeoff:** realistic scope without erasing planting responsibilities. **Gate:** full-target scope signoff; a secure support/access recovery baseline is S0, general transfer/delete UI is deferred. **Primary evidence:** `V2/product-docs/decisions.md:10–13`; `V3/docs/methodology-foundations.md:29`. The OD row’s phrase “historically deferred” obscures that facility software was explicitly cut, not merely deferred.

#### OD-014 — “Reversibility limits for merged people/sent email/completed recurring chains”

**Recommendation (P/E; H):** action-specific correction semantics. Unsaved drafts can be discarded; saved records corrected with history; unsent mail canceled; sent mail cannot be recalled; merge recovery requires explicit reference/uniqueness/conflict checks; recurring-task reopening cannot create two open occurrences. Review must state consequences before executing irreversible operations.

**Impact/tradeoff:** honest recovery instead of an unreliable universal Undo. **Gate:** S1 operations need truthful receipts and correction policy; merge/mail-specific recovery before their release WP-015/028/053. **Evidence:** OD row20; `V3/docs/modules/meetings-tasks-teams.md:59,186`; `V3/docs/modules/identity-people.md:1754`; `V3/docs/modules/communications-knowledge-ops.md:47`.

#### OD-015 — “DST ambiguity, timezone edits and UTC Monday check-in week identity”

**Recommendation (P/E; H distinction, M exact product times):** use distinct LocalDate, Instant and zoned recurrence types. Meeting+2 calendar-day due date and exact 48-hour performance metric remain different. Recommend church-local launch days and explicit local all-day reminders. Historical instants never move; timezone edits affect future scheduling with preview. Proposed engineering default for recurring schedules: shift a nonexistent local time forward by the DST gap and notify; use the earlier offset for a repeated time, fire once, and display the resolved offset. For an explicitly entered one-off ambiguous meeting time, present the two occurrences for human selection before committing. Test all cases. For greenfield check-ins, recommend church-local Monday as the weekly boundary so the user's church calendar governs the week, with a stable zone/week identifier recorded on each entry. These are unapproved target recommendations: the existing UTC Monday behavior remains the documented baseline until the product chooses the change.

**Impact/tradeoff:** users see intended dates without silently rewriting past evidence; rare clock transitions need clear handling. **Gate:** S0 date contract and S1 meeting/task clocks; check-in and launch boundary can defer to WP-039/040, provided types allow them. **Evidence:** OD row21; `V2/product-docs/decisions.md:50`; `V3/docs/modules/meetings-tasks-teams.md:63,66,170–176`; `V3/docs/methodology-foundations.md:81`. The latter recommends a local personal boundary while OD-015 preserves UTC pending ruling; call this an unresolved recommendation, not an approved contract.

#### OD-016 — “Oversight diagnosis release after planter sees it or72hours”

**Recommendation (M/P; M):** preserve reviewed v1 “opened or 72h” as the documented baseline unless the SME/product owner changes it. Recommend the same concern be shown to the planter immediately, with a visible pending release time; current consent must be checked at release/read. If the intended promise becomes literal “has personally seen it first,” remove the timeout explicitly and accept delayed oversight. Opening/delivery is not proof of reading.

**Impact/tradeoff:** timed release supports overseer usefulness but may reveal unseen diagnoses; seen-only supports the literal trust promise but may delay indefinitely. **Gate:** defer until oversight PI WP-044/047; no S1 blocker. **Critical primary provenance:** `V2/product-docs/features/phase-engine/rubric-v1.md:61` says “An assessment releases to oversight when the planter opens it, or after 72 hours.” Thus OD row22/`V3/docs/methodology-foundations.md:78` should not frame 72h as only accidental implementation. The policy may still deserve reconsideration.

#### OD-017 — “Completed person-linked tasks are treated as contact even outside follow-up”

**Recommendation (P/M; H):** record a typed outcome: contacted, attempted/no contact, administrative completion, no longer needed. Only confirmed actual contact advances contact freshness; administrative task completion advances task state only. Follow-up success credit must state whether it means completed obligation or actual contact, with a reviewed rubric alignment. Preserve approved 14-day actual-contact freshness and waiver-no-success semantics.

**Impact/tradeoff:** correct warnings and PI evidence; a small explicit outcome choice may be needed. **Gate:** S1 WP-023/029 and later PI WP-040; blocks the advertised outcome/history slice if left ambiguous. **Primary evidence:** `ALPHA/src/lib/communication/log.ts:106–119` asserts any completed person-linked task is contact regardless of category; `:233–236` writes that assumption. Methodology reconciliation: `V3/docs/methodology-foundations.md:61–65,77`; OD row23.

### Additional questions already present outside the seventeen OD rows

These are distinct unresolved choices, even when one OD broadly overlaps them. Each row below gives the source’s exact acceptance identifier where available. “Default” remains a recommendation.

| Question / exact provenance | Recommended answer and user impact | Kind / confidence / gate |
|---|---|---|
| Successful registrations vs attempts and rate budgets — AC-IDN-002; `identity-people.md:1802` | Separate failed-attempt abuse limits from successful-account caps; use atomic budgets and generic responses. Prevent abuse without locking legitimate invited users out. Exact numbers need deployment evidence. | E/P, H principle/M limits; S0 auth |
| Qualification next-step suggestions — AC-PPL-022; `identity-people.md:1653` | Show optional reviewed task suggestions linked to the human interview; never infer fit or create commitments automatically. A missing suggestion UI is partial scope, not delivered automation. | P/M, H; qualification release, can defer S1 enhancement |
| Hidden conversion analytics exposure — AC-PPL-023; `identity-people.md:1681–1703` | Keep source evidence and define cohort/unique-person/event denominators before exposing. Do not ship a misleading conversion rate solely because a helper exists. | P/E, H; defer analytics |
| Admin RSVP reset/token coordination — AC-MTG-008; `meetings-tasks-teams.md:36–37` | One canonical RSVP state with provenance; admin correction supersedes prior response, and reset deliberately issues/reopens a valid response opportunity rather than resurrecting an old used token accidentally. Keep attendance/cards separate. | P/E, H; S1 if RSVP included |
| Cross-type prior attendance and returning classification — AC-MTG-010; `meetings-tasks-teams.md:38` | Recommend first-time vision eligibility based on prior vision attendance, not an unrelated team meeting. Preserve committed cohort distinction. SME confirms because this changes follow-up population. | M/P, M; S1 follow-up blocker |
| Absent invited guest with response card — AC-MTG-013; `meetings-tasks-teams.md:41` | Preserve card and attendance independently; show attended responders and other recorded cards separately; no card is Unknown, not no interest. No inferred commitment/email consent. | P/M, H; response-card release |
| Legacy inviter/name-only invitation shape — AC-MTG-019; `meetings-tasks-teams.md:47` | In fresh v3 preserve inviter attribution and token coordination through explicit references; no customer legacy-data migration. Do not resurrect removed invitation-tree feature. Decide name-only guests only if an actual wanted workflow requires them. | P/E, H; meeting contract, name-only expansion defer |
| Advisory vs hard task dependencies — AC-TSK-006; `meetings-tasks-teams.md:58,176` | Keep current advisory badge and deliberate human completion; validate graph integrity. Hard blocking needs explicit new product approval. | P, H; S1 default can freeze now |
| All-day reminder clock — AC-TSK-014; `meetings-tasks-teams.md:66,173` | Recommend a configurable church-local daytime reminder, not midnight UTC; exact default time is product choice. Due day remains a date, independent of 48h success metric. | P/E, M; before reminders, type contract S0 |
| Role deletion/history — AC-TEAM-005; `meetings-tasks-teams.md:78` | Retire roles with ended membership episodes; preserve prior staffing history. Hard delete only unreferenced accidental draft roles. This changes delete UX and needs explicit disposition. | P/E, H; teams release |
| True hierarchy vs organization diagram — AC-TEAM-012; `meetings-tasks-teams.md:85` | Keep legible current staffing/organization view; do not imply reports-to semantics from Leadership-root layout. Defer formal hierarchy editing. | P, H; not S1 blocker |
| Wiki product-admin publishing — AC-WIKI-009; `communications-knowledge-ops.md:1126` | Versioned reviewed reference publishing with rollback is sufficient initially; dedicated in-product CMS requires named audience/workflow. Preserve content refresh, do not count dead exports as shipping UI. | P/E, H; defer CMS |
| Same-phase “noop” appends history — AC-PHASE-003; `methodology-intelligence-launch.md:56,235` | Retry/no-change request should not create a transition or task offer. If a human wants to reaffirm context, provide explicit attestation/audit with different semantics. This is a behavior change requiring disposition. | P/E, H; phase release |
| Launch date UTC vs local — AC-LCH-008; `methodology-intelligence-launch.md:248` | Recommend a church-local LocalDate for day, eligibility and countdown; stored completion instant and historical completed date remain fixed. | P/E, H; launch release, schema type S0 |
| Ten templates/eight ministry coverage — AC-REF-005; `methodology-foundations.md:73–74`; Playbook `:70–79,474–561` | Separate operational teams/roles from eight measured responsibility areas; stable explicit custom-team mapping; SME signs off Prayer/Admin-Finance ambiguity. | M, H; same gate as OD-006 |

### Remaining module-prose questions requiring central entries

The following inventory records every additional explicit decision cluster found in the inspected module decision paragraphs. It intentionally distinguishes recommendation from historical approval. Paths in this section are relative to `V3/docs/modules/`.

#### Identity and people (`identity-people.md:1802` unless otherwise cited)

| Open cluster | Recommendation / impact | Kind, confidence, earliest gate |
|---|---|---|
| Lead pastor attestation vs administrative Owner | Separate pastoral identity from administrative permission. An Owner is not automatically the pastor; record the attested person and explicit duty owner. Avoid fictitious leadership and lost follow-up assignment. | P/M, H, S0/S1 owner resolution |
| Coach qualification/document/history parity; communications/activity access (`:858–868`) | Preserve explicitly promised coach reads only after scoped DTO/privacy review; independent coach grant never becomes seat/write authority. Do not add communications merely because CRM read access exists. | P, H, coach slice; partial parity decision before claim |
| Invite-origin wording/granularity/dead sharing toggles (`:46,778`) | Preserve disclosed invite-origin default and existing user choices; represent only meaningful categories, with exact removed-toggle disposition. Current invitation acceptance must show what will be shared. | P, H, association release |
| Same-plant/external commitment witness | Typed witness: same-plant person reference or explicit external name/record, if approved; never accept arbitrary foreign UUID. Does not replace the human signature/commitment. | P/M, H, qualification slice |
| Formula-safe CSV and roundtrip | Escape formula-like cells for spreadsheet export; define a separate typed import contract and preview rather than promising lossless generic CSV roundtrip. | E/P, H, import/export slice |
| Note revisions and sensitive correction retention | Preserve actor/time and corrected versions only within authorized scope; define bounded retention/redaction policy for sensitive content. Immutable audit does not mean unrestricted forever-visible sensitive text. | P, M, notes/corrections release |
| Credential reauth/current-session policy | Require recent verification for sensitive identity/security changes and session revocation behavior explicitly; generic error responses. | E/P, H, S0 auth |
| Trusted ingress/origin/cookie/CORS topology | Single documented trusted ingress, authenticated request origin/session checks and least cross-origin exposure consistent with chosen topology. | E, H, S0 |
| Org profile/billing directions | Preserve actual profile operations; defer billing product decisions separately from beta pricing. Do not add a paywall from historical entitlement direction. | P, H, profile contract/billing defer |
| Recovery/merge reversal and transfer/delete | Covered OD-013/014, but must retain named acceptance links rather than disappearing into a catch-all. Private check-in ownership needs its own transfer rule. | P/E, H, dependent slice |

#### Meetings, tasks and teams (`meetings-tasks-teams.md:236` and cited acceptance rows)

| Open cluster | Recommendation / impact | Kind, confidence, earliest gate |
|---|---|---|
| Canonical catalog fidelity/version | Freeze source versions/stable keys; copying templates never makes future edits overwrite user work. | M/E, H, reference contract |
| Facility task relation | No facility management entity without approved scope; preserve facility preparation as ordinary tasks/reference guidance. Explicitly dispose dormant typed relation. | P/E, H, task schema |
| Pending membership self-service (`:109`) | Preserve schema intent as backlog; do not invent join/approve UI from unreachable enum. If implemented later, define approver and effect on capacity/access. | P, H, defer |
| Archive propagation to all projections (AC-TEAM-002 `:75`) | Active operational views exclude archived teams consistently; historical profiles/training retain labeled records; PI uses only approved eligibility. | P/E, H, teams/PI |
| Meeting deletion/history (AC-MTG-002 `:30`) | Recommend cancel/archive once evidence exists; hard delete only unreferenced drafts. Explain affected evidence and keep an audit. | P, H, meeting release |
| Missing planter follow-up owner (AC-MTG-012 `:40`, AC-TSK-011 `:63`) | Create durable unmet/unassigned obligation and visible “Needs owner”; select eligible human explicitly. Do not silently omit or mark fulfilled. | P/E, H, S1 |
| Dual same-day generated obligations (AC-TSK-011 `:63`) | Key by source meeting/person/obligation, never person/day alone. Distinct meetings remain distinct; retry same source converges. | E/P, H, S1 |
| Training applicability/retirement (AC-TEAM-008/009 `:81–82`) | Define applicable person/program obligation at a stated date; retain earned history after team exit and program retirement; revoke/redo records episodes. No expired applicability inferred. | M/P/E, M, training/PI |
| Correction sensitive-data retention | Same private-history policy as people notes; show provenance without leaking prior prayer/question text to newly authorized readers. | P, M, corrections |
| Recurrence overdue successor policy (AC-TSK-007 `:59`) | Preserve one interval, potentially overdue successor until product approves skip-ahead; make late behavior visible and maintain one-open-instance invariant. | P/E, H, recurrence |

#### Intelligence, launch and private care (`methodology-intelligence-launch.md`)

| Open cluster / source | Recommendation / impact | Kind, confidence, earliest gate |
|---|---|---|
| Check-in historical author vs future owner `:40` | Default personal check-ins to original author, not an inheritable tenancy asset; define any explicit export/delete/transfer consent before ownership transfer ships. Current owner can start their own record. | P, H, private-care schema; transfer deferred |
| Coach assessment feedback `:41` | If approved, scope feedback to a visible insight and actor, label coach provenance, never grant raw snapshot/private-care access. Existing same-church guard is not fulfilled coach support. | P, H, coach feedback release |
| RAG degraded publication `:89` | Recommend hold new actionable assessment when required grounding fails; preserve last valid assessment marked stale and show deterministic missing-evidence guidance. Rubric-only publication requires an explicit bounded policy and no invented citations. | M/P/E, M, PI publication |
| Generated overall summary not persisted `:89` | Either persist approved summary with assessment/version/audience or remove it from required generation. Recommend omit from first PI UI unless a concrete reading need exists; do not claim it is delivered. | P/E, H, PI view |
| Feedback rating history `:113` | Current rating plus minimal attributable revisions if evaluations need them; avoid a full analytics history system without use. | P/E, M, PI feedback |
| Network-configurable rubric/reactive readiness/outcome-correlated benchmarking/recurring services `:11` | Separate future discovery entries; never silently customize thresholds, add automatic pastoral judgment or portray correlations as causal. Preserve existing outcome/journal/reference behavior now. | M/P, H, defer |
| Provider retry/deadline/token budgets `:87` | One bounded budget across provider and output retries with distinct error attribution. Exact limits based on measured latency/cost; old 4×3 values are evidence, not a mandate. | E, H, PI runtime |

#### Communication, Wiki and operations (`communications-knowledge-ops.md`)

| Open cluster / source | Recommendation / impact | Kind, confidence, earliest gate |
|---|---|---|
| SMS/both, draft/schedule/inbound `:122,311` | Declare implemented email contract accurately; each intended channel/lifecycle gets separate backlog disposition. Do not expose unsupported values as sendable. | P/E, H, communication contract; expansion defer |
| Oversight digest daily window/timezone `:475` | Explicit recipient/org-local scheduled preference; evaluate current plant consent at delivery. Do not substitute app-server timezone. | P/E, M, digest release |
| Suppression restoration proof `:538` | Require current address-holder verification appropriate to suppression cause; do not claim “reverified” from session presence. Stronger restoration belongs to auth/communication boundary. | P/E, H, recovery release |
| Intended notification producers `:598–600` | Named scope choices for team welcome/health/training/assessment-ready/failure notices; preserve existing producers and avoid announcing an unused helper as delivered. | P, H, notifications release |
| Wiki search language `:1000` | Preserve verified corpus language, make no multilingual relevance promise; add language-aware search only with corpus/editorial coverage. | P/E, H, search release |
| Versioned article completion `:1021` | Completion attaches to article/version with explicit carry-forward/reaffirm policy for revisions; never conflate tenant override and global article by slug alone. | P, H, Wiki progress |
| Wiki feedback/reading ownership after tenancy change `:1063,1548` | Personal reading follows account; plant-scoped feedback remains scoped to its origin; define deletion/retention for both. No old private content leaks through a new tenancy. | P, H, Wiki progress/feedback |
| Public global preview contract `:1163` | Public previews only for explicitly public global content; private content always session/authorization gated regardless of user-agent. Approve exactly what metadata is public. | P/E, H, Wiki routing |
| Feed/queue schema separation `:1539` | Let durable job recovery own transport; let notifications own recipient-readable history. One or two tables is engineering choice, not product authority. | E, H, S0 jobs/notifications |

### Methodology completeness and additional missing questions

#### What is substantively preserved

Vision meetings remain the growth engine, formal or informal, at least every other week. The plan preserves invitation/attendance, six-section agenda, logistics kit, response cards, evaluation, first-time follow-up and historical corrections. Primary Playbook evidence: `V2/product-docs/launch-playbook.md:125–275`; v3 acceptance: `meetings-tasks-teams.md:29–47`. Preserve the eight qualitative evaluation factors as human scores; software cannot infer a compelling message or spiritual outcomes from attendance.

Interviews retain maturity, giftedness, chemistry, right reasons and season of life (`launch-playbook.md:290–298`). The 4 C's remain Committed, Compelled, Contagious and Courageous (`:862–871`), with definitions intact. Recorded scores/judgments can be cited with dates and provenance; the model must never create them. Rubric v1 explicitly narrowed 60-day behavior to a candidate signal, not readiness (`rubric-v1.md:55,118,679–683`). Four numeric ratings are an operational representation of human assessment, not an objective spiritual-fit score.

Commitment is more than a pipeline label: the Playbook requires clarity of expectations, a member commitment card, and commitments of the Core Group signed by pastor/designated leader (`launch-playbook.md:314–340`). V3 retains signed record/private document/history/corrections (`identity-people.md:1393–1449`). Acceptance should validate the actual three-document coverage, not merely count templates or prove an upload succeeds.

Ministries and training retain eight areas and ten operational leadership templates, including Prayer Leader; launch preparation also retains equipment, facilities, financial accountability, promotion and rehearsal responsibilities even where specialist software is out of scope (`launch-playbook.md:59–79,460–698,704–860`). A shortened app must not shorten the underlying Playbook.

The rubric preserves its reviewed limits: launch-process health, not church health; 50–100 is this methodology's benchmark, not universal spiritual validity; unknown is not healthy; generosity and solvency are independent; prayer is self-attested rhythms; people-level judgments are private human records; no named individual insights to networks; one primary plus up to two supplements, separate positives. Evidence: `rubric-v1.md:20–26,47–66,88–127,607–650`; `V3/docs/methodology-foundations.md:27–65`. Its final disposition accounts for all C01–C26 (`bryan-comments-review.md:497–546`). That proves disposition, not behavioral validation of every implementation.

#### Missing or under-specified questions to add

| Proposed question | Why needed / defensible recommendation | Kind / confidence / gate |
|---|---|---|
| Does setting the plant launch date change individual recruitment statuses? | Playbook says the Core Group transitions to Launch Team when the launch date is set (`launch-playbook.md:440–446`), but software promotes an individual on team assignment (`identity-people.md:1599`). Recommend explicitly distinguish plant mission phase from individual staffing stage; no bulk automatic person promotion from scheduling. SME should confirm labels to avoid a silent methodology mismatch. | M/P, H, launch/people contract; not basic S1 |
| What qualifies as a committed adult for growth/critical mass? | Rubric says signed core-group commitments and most recent person's first commitment (`rubric-v1.md:114`), while v3 dashboard counts recruited core_group/launch_team/leader and excludes seat-person cohort (`communications-knowledge-ops.md:1264`). Need one approved definition covering adults/unknown age, inactive/deleted people, backdated records, repeated commitments, imported manually set stages, seat-linked people and corrections. Recommend explicit measured cohort and separate unknown-age count; no invented DOB or automatic exclusion merely due to login. | M/P/E, H, S1 commitment contract; PI measurement release |
| Does “completed follow-up” mean task closure or successful contact? | OD-017 catches administrative tasks, but attempted unanswered contact can legitimately finish a task without actual contact. Define outcome-specific success denominator and communicate it. Waived/missing-provenance tasks never become successes by omission. | M/P, H, S1 blocker |
| Does first-time follow-up obligation survive reclassification/correction? | Late attendance, backdated earlier meeting, removed attendee and edited meeting time can alter “first-time” and 48h inputs. Recommend immutable creation provenance plus explicit cancellation/correction, with no silently rewritten historical success. Same-day source keys alone do not answer this. Sources: AC-MTG-010/012, AC-TSK-011 (`meetings-tasks-teams.md:38–40,63`). | P/M/E, H, S1 |
| Who may view detailed interview, 4Cs, prayer/question notes and signed documents? | Broad coach-read promise and Member team context cannot substitute for a per-field sensitive-data decision. Recommend a matrix of exact human-record fields by actor and purpose, separate from ordinary contact basics; no Evry/PI default access to full confidential notes. Sources: `identity-people.md:868,1373`; `meetings-tasks-teams.md:99`; `methodology-intelligence-launch.md:32`. | P/M, H, qualification/card slices |
| How do methodology and reference releases get approved and tested? | Snapshot counts/hashes prove identity, not that thresholds, role maps and cross-linked templates agree. Recommend named SME/version approval, semantic fixtures for each of eight lenses/seven phases, source-to-claim examples and explicit supersession records. Source: `methodology-foundations.md:92–101`; rubric v1 Appendix A target observations `:656–733`. | M/P/E, H, reference/PI release |
| Which Playbook specifics are canonical for all plants versus optional/contextual? | Playbook has concrete doctrinal, church-government, trademark and 5% budget commitments (`launch-playbook.md:329–340`) and US-specific administrative guidance (`:704–719`). Preserve source text; do not silently generalize them or make every line a universal software gate. SME should label applicability when packaging for plants with differing contexts. This is content interpretation, not authorization for legal/pastoral advice. | M/P, M, editorial approval; S1 can retain source verbatim |
| What exactly counts as “same concern” across planter and oversight? | Matching category can pair different diagnoses. Recommend shared concern identity tied to allowed fact references and separate audience wording; never generate the network concern absent from planter view. Source: `methodology-foundations.md:78–79`; rubric v1 `:792–797`. | M/P/E, H, PI oversight |
| How stale can an attestation, snapshot or assessment be before its current UI claim changes? | Thirty-day prayer/giving reaffirm is ruled, but lens-wide best-age metadata can imply more than measured. Recommend separate assertion ages and explicit unavailable/stale/fresh status, never reset freshness merely on a new run. Source: `methodology-foundations.md:60,75–77`; `methodology-intelligence-launch.md:83`. | M/P/E, H, PI |

### Nine explicit Evry questions and finite policy subchoices

Exact questions below come from `V3/docs/evry-design.md:248–258`; the detailed execution/evaluation context is at `:210–227,233–246`. This section crosswalks them rather than pretending OD-003 alone fully answers them.

| Exact current wording | Recommended answer / impact | Confidence, kind and gate / crosswalk |
|---|---|---|
| “Choose autonomous policy, exceptions, per-actor/grant lifecycle, approval expiry and outbound send authority. Recommended initial policy is reviewed writes, not assumed authorization.” | Start read/draft and explicitly approved exact writes. No inherited grant from another task, conversation or role; authority is checked on every execution. Proposed default: approval ends when scope/content/target/revision changes or approving authority is revoked. Outbound sends always need their exact content/audience review; expiry time remains a named product setting. | H on structure/M duration, P/E; before any execution; OD-003 |
| “Choose plain AI SDK versus Eve after equivalent recovery/clarification/budget/browser proof; retain capability semantics regardless of framework. No old framework API is a blanket v3 constraint.” | Prefer plain SDK as the initial spike candidate because shared operations/state are the contract; use Eve only if equivalent tests demonstrate lower total complexity or better required behavior. This is not an approved winner. | M, E; S0/S1 runtime spike, not a prerequisite to starting that spike; OD-001/010 |
| “Decide Settings/coach/oversight/onboarding/admin tool expansion. Preserve privacy and actor separation; historical exclusions are evidence and not invisible omissions.” | Review each operation by actor and subject. Start plant operational People/Tasks scope; settings and onboarding may follow existing named operations. Coach stays read-only; oversight gets only consented aggregate projection; admin authority cannot be obtained through general chat. Keep all expansion questions in parity inventory. | H, P; per adapter release; OD-003/010/012 plus coach questions |
| “Resolve one app-owned history/run/proposal schema and command-audit storage. All fourteen historical/local Evry tables are mapped; none requires customer migration or old ledger reuse.” | Use one app-owned model for conversation/turn/run/proposal/approval/receipt with durable command audit references. Preserve required operation semantics, not fourteen tables by default. Product audit is independent of disposable telemetry. | H, E/P; before durable S1 assistant state; OD-011 |
| “Adopt alpha domain behavior for corrections, task waiver/filter/follow-up, leadership and privacy rather than transplanting stale unmerged effect SQL. Reconcile each adapter against its owning spec before implementation.” | Reuse canonical domain operations implementing approved alpha semantics and versioned receipts. Never copy stale effect SQL into the assistant; map every historical alias to its actual owned operation and exception. Open semantic conflicts such as contact evidence still need ruling. | H, E/P/M as applicable; each S1 adapter; OD-004/005/010/017 |
| “Bind all48 inherited eval gaps and close recorded browser/latency/repeated-prose limitations. Source-heavy test suites and routing measurements are insufficient release evidence.” | Maintain an explicit mapping for all 48 gaps and run semantic, effects, privacy and browser fixtures. Define latency/cost/prose thresholds using human calibration; factual/permission/effect failure cannot be offset by style score. First read slice gets its relevant gates; full parity requires the entire corpus. | H, E/P; relevant S1 gates then full WP-055; not a gate before the first spike |
| “Define compensation eligibility by command; no general v2 undo exists. Email recall is not a possible database inverse.” | Command-specific restore/reopen/correct/cancel with current permission and conflict checks. Review irreversible effects explicitly; preserve receipt and audit. | H, P/E; each effect release; OD-014 |
| “Decide optional code-mode/Jev after measured need and new held-out evaluation; no sole-selector approval exists.” | Defer until direct operations fail a demonstrated workflow need. If adopted, bounded sandbox/resource limits, no ambient executor/approval authority, complete effect trace and held-out comparison. | H defer/M eventual selection, E/P; beyond S1; OD-010 |
| “Confirm provider/telemetry retention and private-content posture from current official primary sources in the root dependency ADR. Historical estimates and no-retention language are not current promises.” | Current configuration/contracts/disclosure must be checked before sensitive data; synthetic fixtures can proceed. Redact traces and keep private care excluded by default. | H principle/current facts unverified, P/E; production model enablement; OD-009 |

Finite policy choices should not disappear behind “reviewed writes.” Recommended initial dispositions, all unapproved:

- **Approval duration:** use a short explicit expiry plus mandatory expiry on any material revision; choose the actual duration from workflow testing. An arbitrary numeric lifetime would be false precision at this review stage. Expired proposals can be refreshed and reviewed without losing drafts.
- **Approver identity:** the authenticated actor must have current ordinary authority for every effect. Owner-only operations stay Owner-only; shared account/team status cannot transfer an approval. Product must decide whether a different authorized person can approve another user's draft; recommend yes only through explicit handoff with visible authorship, never implicit.
- **Approval scope and edits:** review exact operation, targets, values, audience, files, consequences and dependency plan; material edit invalidates approval. An approval for one operation is not authorization for a general task or additional actions inferred later.
- **Delegated exceptions:** no initial autonomous mutation exceptions. A future allowed class needs named verbs, subject scope, limits, expiry, revocation and audit. Even “mark read” changes user state and should not be silently exempted before this choice.
- **Bulk and partial work:** enumerate included/excluded targets and produce per-target outcomes. Product should approve the recipe's partial-failure behavior; recommend stop dependent steps after unmet prerequisites, retain successful independent receipts, and offer reviewed retry of the remainder.
- **Outbound mail:** exact content/audience review, current suppression/consent check, durable provider outcome. An uncertain send cannot become an approved “retry failed” action just because the previous run lost its response. The specialized failed-retry gate is `AC-EVR-242-FAILED-RETRY` at `evry-design.md:212`.
- **Grant/session revocation and cancellation:** revoke uncommitted authority immediately; cancellation stops pending work but cannot erase committed effects. Show receipts for already committed work and preserve draft recovery.
- **Context and read privacy:** visible plant/person context, bounded authorized facts, no ambient scope combining seat plus coach. File/note instructions are data, not delegated authority. Full confidential notes and private check-ins remain excluded unless their separate data-access decision is approved.
- **Budget and resume:** saved run/receipt identity survives disconnect; reconnect reads progress, never repeats the command. Exhaustion ends the turn visibly; a new explicit retry cannot mint a new external effect key for an unresolved old attempt. Numeric limits should be measured in the spike.

The policy inventory can be reviewed as one coherent initial contract. It does not justify holding the runtime comparison or synthetic read/draft work until every later tool-expansion question is answered.

### Review limits and next disposition

This is a source-based independent review, not runtime proof. I did not run v2/v3 tests, query databases, inspect credentials, contact providers or independently reread the historical SME Google Doc. No customer migration is needed or recommended. Existing source/test provenance supports the cited behaviors, but exact provider claims and editorial currentness remain unverified.

Before calling the plan ready for implementation, centralize each question above with owner, recommended answer, explicit accepted/deferred/rejected state, affected acceptance IDs, and the first package it blocks. Keep engineering defaults moving where authorized. Do not turn this review's recommendations into approved SME methodology or approved Evry authority.


## Appendix B — Architecture and execution evidence

Reviewed 2026-10-03. Read-only inspection of `/Users/sebastian/dev/everyfield_v3` and selected v2 source. This appendix is the only file created. No application changes, database access, deployment, customer migration or external upload occurred. Findings concern a future plan, not observed defects in running v3 software.

### Executive judgment

The proposed modular monolith is proportionate **if the documented consolidation is enforced**. The current documents already reject table-per-service architecture, blanket tool recreation, CQRS/DI/workflow frameworks and unnecessary brokers; those are not outstanding findings. They acknowledge the recurring cost of a separate backend honestly. PostgreSQL transactions, shared UI/Evry domain operations, private DTOs and a durable effect boundary address real v2 weaknesses.

I would authorize a bounded runtime/auth/domain spike, but would not treat the current graph as an implementation-ready allocation of all work. The graph is syntactically valid and its arithmetic checks out: 86 packages, 272 prerequisite edges, 222 assumed engineer-days, 66-day unlimited-capacity longest path; all six cumulative slices are closed under the **declared** edges. That does not establish semantic dependency completeness or exclusive write ownership.

The most important changes are a concrete private-check-in contradiction; an unproven auth/domain transaction boundary; missing cross-domain contracts for attendance finalization and person merge; and a freshness rule that currently permits delayed invalidation to undermine assessment publication CAS. These can be resolved without changing the SME rubric or Launch Playbook. Evry remains operational only.

### A1 — P1: Evry's target tool table explicitly includes prohibited private check-ins

**Evidence.** `docs/evry-design.md:113` lists check-ins among Plant Intelligence read tools and `save check-in` among draft/propose/execute tools. In direct conflict, `docs/modules/methodology-intelligence-launch.md:40` excludes coach, organization, assessment and Evry access by default; `:101` prohibits emitting assessment dirtiness, notifications or traces from private answers; `:145` states private sustainability answers have no default tool. PI-038 at `:228` identifies the spiritually, marriage/family, financially and pace answers as excluded from AI, readiness, oversight, coaches and Evry. That module also proposes `packages/domain/src/private-checkins/`, while WP-039 (`docs/plan/build-plan.md:850`) assigns the work to general intelligence paths. `docs/architecture/contracts.md:39` groups generic `checkIns` with phases/signals rather than expressing the stronger exclusion.

**Counterexample.** An Owner asks Evry for the week's check-in or asks it to save “financially struggling” plus a family note. The target tool table lets an implementer expose that through the same authorized-owner operation used by the private UI. Ordinary role authorization succeeds, yet the assistant/provider receives material the methodology module explicitly excludes. An “Owner can read it” policy is insufficient: this is also a source/purpose restriction.

**Required correction.** Remove private check-ins from Evry's default tool map and source-to-target adapter crosswalk; make their separate sensitive policy explicit in public contracts. Add a registry-level negative assertion and a context-compilation/eval fixture proving these records and their historical snapshots cannot reach model input even for the Owner. Preserve the human UI and history. A future expansion would need an explicit product/privacy decision, not ordinary tool parity.

**When it blocks.** Correct before C0/C3 or generating the intelligence tool catalog. It does not block an auth/runtime spike or ordinary People work. This is not a new question for the user: the existing exclusion supplies the default.

### A2 — P1: Atomic registration crosses an unproven Better Auth/domain boundary

**Evidence.** `docs/architecture/architecture.md:58` and transaction row `:68` promise token claim, account, seat/association, person link and audit as one atomic database operation. `docs/architecture/contracts.md:17` instead describes Better Auth credential ownership plus separate explicit domain orchestration. WP-003 (`docs/plan/build-plan.md:418`) tests login/recovery/revocation, rollback, files and streams; it does not require an invite-registration transaction crossing the auth adapter. WP-005 and WP-008 remain distinct stages (`:442`, `:478`). The shared UoW rule at architecture `:79` establishes the desired rule for domain functions, but does not demonstrate that the selected auth adapter participates.

**Counterexample.** Better Auth commits credential account A; invitation acceptance then discovers revocation or fails linking Person P. The domain transaction rolls back, but A and perhaps its session survive. Running a generic PostgreSQL rollback test and a separate auth test would both pass while the promised all-or-nothing registration contract fails. Conversely, claiming the invitation before credential creation risks a consumed invitation without a usable account.

**What is and is not proven.** This is an unresolved integration contract, not a claim that Better Auth cannot support it. Its official [database hooks documentation](https://better-auth.com/docs/concepts/database#database-hooks) describes before/after lifecycle hooks; the inspected documentation does not establish that arbitrary domain writes share the auth transaction. The [Drizzle adapter documentation](https://better-auth.com/docs/adapters/drizzle) documents adapter integration and schema management, not proof of this application-specific unit of work. Exact selected-version source and fault injection must settle it.

**Required correction.** Put invited registration into WP-003: inject failure after credential account creation, after invitation claim, before person/seat linking, and before response delivery; race revoke and duplicate acceptance. Select one honest contract: (a) a verified common transaction via supported adapter integration; or (b) a durable unprivileged account-registration state followed by atomic domain acceptance, with resumable retries and no tenant access before completion. Option (b) changes the all-or-nothing account-creation promise and must be recorded explicitly. Never solve this by granting revoked invitations or deleting an independently existing account as blind compensation. Keep token issuance/email outbox consistency in the same proof.

**When it blocks.** It blocks final auth/domain contract freeze, not beginning the spike. It need not block unrelated reference curation. No need to decide every later product question first.

### A3 — P1: Attendance package cannot independently satisfy its advertised transaction

**Evidence.** Architecture `:71` requires attendance finalization, first-time obligation claims, evaluation task and follow-up rows atomically. `docs/modules/meetings-tasks-teams.md:159–160` requires finalization and evaluation to commit their managed task effects together. WP-022 (`docs/plan/build-plan.md:646`, and corresponding DAG object) depends only on WP-020 and WP-021; task lifecycle WP-024 is independent. Follow-up obligation/outcome WP-023 depends on WP-022 and WP-024, so making all of WP-023 a prerequisite of WP-022 would introduce a cycle. The module-level handshake is acknowledged at meetings/tasks/teams `:216`, but is not represented as an executable output/dependency in the master graph.

**Counterexample.** A Meetings owner follows the current DAG and closes WP-022 before the Tasks lane finishes WP-024. A stub can make finalization tests green, but no real evaluation task/obligation is committed. Or Meetings owns ad hoc task writes and later diverges from Tasks' revision, assignee and audit rules. Neither outcome satisfies the architecture despite a dependency-closed S1.

**Required correction.** Freeze and implement the small obligation/managed-task write contract before finalization, then make WP-022 depend on that and the needed task kernel. Keep follow-up UI/outcome/metrics downstream. Alternatively, make finalization plus obligation creation a single jointly owned package whose input includes the task kernel. Name the transaction orchestrator and require a real PostgreSQL test that fails between attendance, obligation, evaluation task and history; every row must roll back together. No need for an event bus or general workflow engine.

**When it blocks.** Resolve before splitting Meetings and Tasks work or declaring S1 runnable. Does not block WP-003 or initial auth/People scaffolding.

### A4 — P1: Asynchronous source invalidation can defeat stale-assessment CAS

**Evidence.** Architecture `:69` places person-related PI invalidation in the external/recovery boundary “after commit”; `:71` permits a dirty-signal outbox. `docs/modules/meetings-tasks-teams.md:162` makes the PI material mark an outbox effect and `:168` includes PI invalidation among delayed effects. But `docs/modules/methodology-intelligence-launch.md:81` promises that newer activity stays dirty because the current source revision exceeds the assessed revision, and `:83–85` requires consistent snapshot/publication semantics. Only the attestation case at `:58` explicitly increments the source revision in the source transaction.

**Counterexample.** An assessment snapshots source revision 10. A training/person/task mutation commits, but its dirty job is delayed. Publication still reads revision 10 and passes CAS, presenting the old assessment as current until the job eventually runs. A single database snapshot at generation time does not fix this later race. The supposed newer-data rejection has no contemporaneous version change to detect.

**Required correction.** Every material source mutation increments the relevant plant/source watermark in its own commit transaction, using one shared small function or another equally explicit version strategy. Only expensive recalculation, dispatch and inference are asynchronous. Publication compares snapshot watermark and current watermark, including reference/rubric changes as defined. Private check-ins must remain outside that invalidation path. Prove it with a test that pauses the outbox worker, commits new material data during inference, then tries to publish the old run.

**When it blocks.** The watermark write contract belongs before implementing source writers in parallel; full publication testing can land with WP-043. It does not require changing any assessment criterion.

### A5 — P2: Merge-reference completeness has no incremental enforcement after WP-015

**Evidence.** WP-015 (`docs/plan/build-plan.md:562`) requires “all dependent references accounted” but depends only on WP-012 and WP-014. Teams, Meetings, Communication, Documents and later domains can land after it. The real v2 `src/lib/people/merge-references.ts:1` contains a concrete reference registry spanning attendance, responses, inviter/invitee, meeting checklist assignees, team membership/leader, training, communication recipients, RSVP tokens, polymorphic tasks and notifications; its comment says it is compared against PostgreSQL FK metadata in a disposable proof. Architecture `:70` says v3 must repoint all enumerated references, but later-package gates do not require extending/verifying this registry.

**Counterexample.** WP-015 passes with the initial People schema. WP-020 later introduces a person-linked checklist or RSVP reference without teaching merge about it. A later merge either fails a restrictive FK or silently preserves wrong attribution in a polymorphic reference; the earlier green merge gate does not protect the new domain.

**Required correction.** Make the merge-reference contract a shared schema acceptance rule: each new person relationship declares move/dedupe/preserve-snapshot/deny behavior and extends one integration fixture. Compare actual FK metadata with the registry and explicitly include polymorphic/non-FK identities. The schema owner gates migrations on that check. Keep WP-015 as the initial merge kernel and put a later full-schema acceptance gate where appropriate; do not postpone all merge work until every UI exists.

**When it blocks.** Before later domains add person references. It does not block early People CRUD.

### A6 — P2: Parallel Evry lanes still share unspecified mutable registration and UI surfaces

**Evidence.** WP-059 through WP-086 all own the same four broad paths: `packages/evry/`, `packages/contracts/src/evry/`, `apps/web/src/features/evry/`, `tests/evals/evry/` (examples at build-plan `:1090`, `:1114`, `:1390`). `docs/evry-design.md:40,47` requires a shared generated catalog and common metadata; `:42` requires one client state machine. The integration rule at build-plan `:375` gives one owner to shared schema/migrations and contract review, but does not assign the tool registry, card renderer, runtime dispatcher or client state machine. The complexity budget correctly says the 28 batches can share registration and combine; that does not allocate actual file ownership.

**Counterexample.** People, Meetings and Teams agents each add their tools to a central registry and variants to the same discriminated card renderer. Their isolated worktrees compile; merging changes registration IDs, generated output ordering or exhaustive unions and invalidates another lane's fixtures. A shared owner in prose only for contracts/migrations does not settle these writes.

**Required correction.** Give each lane a concrete domain manifest/tool/card fixture folder. One Evry kernel owner owns the runtime, registry composition, common client state machine and shared card protocol. Generate catalogs deterministically from manifests; integration rejects duplicate operation IDs and unmet handlers. Serialize only those genuinely shared files, not every domain adapter. If one engineer owns several pairs, combine their work packages as the budget already permits.

**When it blocks.** Before launching parallel assistant adapters, not before the early S1 assistant kernel.

### A7 — P2: A lease needs a stale-owner commit fence and a stated external-effect limit

**Evidence.** Architecture `:83–89` specifies `SKIP LOCKED`, leases, attempts, unknown provider reconciliation and no blind retry. The intelligence module `:81` says expiry/heartbeat prevents two cron/manual triggers assessing the same revision simultaneously. Neither the common contract nor WP-031 expressly states a monotonically changing claim token checked on completion/renewal. Existing CAS language concerns aggregate/source revisions and final publication, not clearly ownership of a reclaimed job.

**Counterexample.** Worker A pauses beyond lease expiry. Worker B reclaims the job. A resumes while B works. Both can make an AI call and both attempt a completion for the same source revision. `SKIP LOCKED` only protected claiming, not the period after the transaction ended. Stable email provider idempotency helps within its supported retention window but is not a generic guarantee for inference, files or all provider calls.

**Required correction.** Include a lease-generation/claim token in every heartbeat, result write, release and publish CAS; reject stale owners. Test pause–expiry–reclaim–resume, not just crash–restart. Keep durable business idempotency independent of attempt identity. State the realistic guarantee: one accepted database publication/effect identity; unavoidable overlapping external computation may consume budget, and uncertain mail must be reconciled as already documented. Do not claim a lease alone prevents all simultaneous execution.

**When it blocks.** Before WP-031 closes; external-model budget behavior can finish with WP-043. A mature PostgreSQL job library may implement part of this, but still needs this application proof.

### Runtime and cost recommendation

The current comparison should remain a measured decision, not be replaced with an unqualified framework preference. The architectural boundary is shared framework-independent operations plus a durable worker; a separately deployed HTTP API is optional.

- **Modular Next + worker:** strongest control candidate when one team operates one browser product. Calling the same domain handler from web and Evry does not itself require HTTP between SSR and domain code. Keep imports and authorization boundaries enforceable. A worker boundary need not make the HTTP service separate.
- **Bun + Hono:** earns selection if the real stream/worker topology or operational ownership is materially easier, with demonstrated cookie/proxy/SSR credential forwarding, recovery and private file support. The existing recurrent-cost disclosure is adequate qualitatively; selecting it still needs measured evidence.
- **Bun + Elysia:** should receive the same slice and maintainability criteria. User familiarity is a real engineering benefit. Do not combine Hono RPC, Eden, a second generated API framework and hand-maintained Zod contracts merely to compare them; the shared domain schema stays canonical.

Run the two strongest candidates selected by the lead/user against identical acceptance, preferably including modular Next as the cost control unless there is already a decisive deployment constraint. Record deployables and environments, CI/local setup, connection-pool budget, stream duration/reconnect behavior, auth cookie propagation, document runtime dependencies and failure recovery. Do not use synthetic request throughput as the winner. Provider choice is still open, so no precise monthly price can be supported by these documents.

The 222/66 numbers are reproducible planning assumptions, not forecast evidence. The 14–20 week range already admits capacity and waits; I found no arithmetic defect. The unmodeled recurring cost is ownership/integration contention, especially shared assistant surfaces. Re-estimate from the first complete slice rather than adding blanket percentage contingency to a graph with incomplete semantic edges.

### Minimal decision and correction bundle

**Can start now:** reference/methodology reconciliation and an isolated runtime/auth transaction spike using synthetic fixtures. No customer migration, deployment or new pastoral-AI behavior is needed.

**Before C0/runtime/auth freeze:** correct the private-check-in tool contradiction; select the two representative runtime candidates and acceptance criteria; choose the verified auth registration atomicity contract. Define trusted actor/grant scope and explicit current session checks using the already-preserved single-seat/independent-coach default.

**Before S1 cross-domain work splits:** assign the attendance/obligation/task transaction owner and contract; define the synchronous material source watermark; make request identity mandatory for retriable creates/effects and distinguish it from request tracing. Keep the existing full-domain schema owner.

**Before corresponding later packages close:** approve provider unknown-outcome reconciliation, enforce job claim fencing, incrementally prove merge references, allocate assistant registry ownership, decide OD-016's diagnosis release and OD-003's production authority. These are targeted gates; they should not all block starting the spike.

Private object URLs and cached/provided conversation content also need revocation fixtures under the existing policy, but I did not elevate these to separate defects: the documents already require current-scope reads, authorized downloads and revocation. Likewise coach versus organizational scope and all-underlying-fact-scope oversight projection are explicitly addressed in the current methodology/identity specs; implementations need to prove them, not invent a second permission system.

### Evidence and limits

Inspected architecture/contracts/decisions/complexity budget, complete machine-readable DAG and selected work-package text, methodology/intelligence/launch module, meetings/tasks/teams module, Evry design, communications module, identity module, v2 `AGENTS.md`, relevant principles in `.agents/skills/`, and selected v2 transaction/finalization/merge-reference source. Applied principles: boundary discipline, idempotency, separate shared mutable state, verifiable sequencing and subtraction. No v3 runtime exists here and no v2 test suite was run. Official Better Auth pages were read only to bound the auth integration claim; they do not prove the intended v3 wiring.


## Appendix C — Source-to-capability semantic evidence

Reviewed 2026-10-03. Scope: actual files in `/Users/sebastian/dev/everyfield_v3`, compared with selected actual source and tests in `/Users/sebastian/dev/everyfield_v2` and `/private/tmp/everyfield-alpha-implementation`. This is a source/document review, not a runtime certification. No application/source edits, database access, deployment, provider calls, uploads, or explorer edits were performed. The only new file is this requested review appendix.

### Executive judgment

The plan preserves the substantial planting methodology considerably better than a route/table inventory alone would. I found no evidence that it intentionally removes vision meetings, ministries, commitments, interviews, the 4Cs, the approved SME rubric, or the distinction between human judgment and AI evidence. The fresh-project/no-customer-migration premise is explicit and coherent.

It is not yet safe to treat all operation/acceptance catalogs as mutually consistent implementation inputs. One high-severity privacy contradiction must be resolved before generating Evry adapters. One assessment-job identity ambiguity can defeat an explicitly preserved time-based workflow if implemented literally. A concrete private-care threshold is miscopied from source into both prose and acceptance evidence; another private-care behavior is described as source parity even though the source does not implement it.

The 496 inventory records and 720 acceptance IDs establish bookkeeping, not semantic completeness. The PI-039 counterexamples below are direct evidence of the distinction: the source and test are listed, yet the claimed behavior differs.

### High-severity blocker

#### S1 — Evry's target operation map grants access that private-care policy forbids

**v3 locations**

- `docs/evry-design.md:113`, Feature-to-tool surface, Plant Intelligence row: read tools include **check-ins** and write tools include **save check-in**.
- `docs/methodology-foundations.md:80`, METH-10: no coach/org/AI/Evry access by default.
- `docs/modules/methodology-intelligence-launch.md:22`, Private care owner: separate private-checkins module, explicitly excluded from general assistant tools.
- Same module, Authority and privacy contract, Private weekly check-ins row: Owner-only, no coach/org/assessment/Evry tool by default.
- Same module `:228`, PI-038: explicitly no AI/Evry access by default.
- Same module, Evry integration and human ownership: private sustainability answers have no default tool.

**Source evidence**

`src/lib/phase-engine/planter-checkin.ts:11–24` states that private answers are structurally outside the snapshot/judge/oversight pipeline and that no model reads or writes them. The source's privacy test is `src/lib/phase-engine/planter-checkin.test.ts`. The approved alpha retains this separation while tightening native writes to Owner authority and preserving correction history.

**Concrete counterexample**

An Owner asks Evry, “What has changed in my plant this month?” An adapter generated from the target map may read their marriage/family, spiritual, financial, and pace answers and submit them to the model. The actor is allowed to read these values in the native private-care UI, so a generic “same authority as the user” guard passes. That is still forbidden by the separate no-AI policy. Similarly, a reviewed `save check-in` proposal would send private answers through the model before an execution guard could help.

**Required correction**

Remove private-care reads/writes from the default Evry map and explicitly distinguish actor authorization from channel/data-use authorization. Use a closed allowlist excluding private-checkin DTOs, histories, notes, summaries and indirect aggregates from model context, tools, routine telemetry and evaluation fixtures. Native Owner-only operations remain fully preserved. Add a negative contract test proving that an Owner's valid native access cannot be reused via Evry. Any later opt-in must be a separately approved policy, not inferred from a generic tool-coverage requirement.

This blocks adapter/schema freeze, not the review itself or unrelated foundation work.

### Important contract issue to resolve before implementation

#### S2 — Assessment claim identity does not state how quiet plants get a new stale refresh

**v3 locations**

- `docs/modules/methodology-intelligence-launch.md:81`: candidate claim unique per `(plant, sourceRevision, rubricHash, assessmentPolicyVersion)`.
- Same module `:211`, PI-021: preserve dirty/never-assessed/**seven-day-stale** scheduling.
- Same module, Assessment job state diagram: complete returns to eligible on staleness.
- `docs/plan/build-plan.md`, WP-043: claims, dirty scheduling, stale publication, concurrency and recovery.

**Source evidence**

- `src/lib/phase-engine/assessment/dirty.ts:25`: seven-day max-staleness window.
- Same source `selectionReasonFor`: a quiet plant is selected when the last complete assessment is older than the window, without requiring a material event.
- `src/lib/phase-engine/signals/build-fact-snapshot.ts:372`: days since last vision meeting depends on `asOf`.
- Same source `:262–271`, `:308–311`, `:403–404`, `:703`, `:771`: growth windows, elapsed time, cohesion windows, launch countdown and attestation age change with time even when database rows do not.

**Concrete counterexample**

On day 0, source revision 42 is assessed under rubric v1/policy 1. No user changes anything. On day 8, the last vision meeting is eight days older and the plant is eligible for a stale refresh. The tuple remains `(plant,42,v1,1)`. If it is a durable successful-job/idempotency key, the worker returns the old success or refuses the new run forever. A quiet plant can never obtain the promised periodic reassessment.

**Required clarification**

Define separately (a) an active per-plant lease, (b) a logical assessment request/period identity and (c) the immutable published run identity. Specify whether the tuple's uniqueness is active-claim-only and how a later completed-period refresh obtains a distinct run. Include the reference package revision where a approved corpus-only update must produce a new evaluation. Preserve same-request retry idempotency without treating every assessment of the same database revision as the same event.

This is an ambiguity, not proof that the authors intended permanent deduplication. The current text can support a correct lease implementation, but it does not disambiguate it from the broken durable-key implementation. A fake-clock day-0/day-8/no-write acceptance case should close the ambiguity before WP-043.

### Worthwhile source corrections

#### S3 — PI-039 narrows the care nudge from “strained or struggling” to “struggling”

**v3 locations**

- `docs/modules/methodology-intelligence-launch.md:101` and `:229`.
- `docs/evidence/capabilities.json`, PI-039, title, decision and `acceptance_criteria` (around lines 19573–19615).
- Corresponding PI-039 audit, preservation and acceptance artifacts need the same correction; avoid fixing only visible prose.

**Actual source and test**

`src/lib/phase-engine/planter-checkin.ts:193` defines `CONCERNING = ["strained", "struggling"]`. The loop at `:215–220` counts either value. `src/lib/phase-engine/planter-checkin.test.ts:150–161` explicitly asserts a nudge for strained / struggling / strained on three successive weeks. Main and the inspected alpha have identical behavior here.

**Counterexample**

Three successive “strained” answers produce a source nudge. An implementation following v3's “three consecutive struggling answers” acceptance can suppress it and still pass the planned stated test.

**Correction**

Preserve “three consecutive weeks at strained or struggling” unless a deliberate product change is approved. Include mixed-value and all-strained examples, not only all-struggling. Preserve the source's question directing to human support; no generated counseling is implied.

#### S4 — A missing week breaking the nudge is intended behavior, not current implemented behavior

**v3 locations**

The same PI-039 prose/registry classifies the feature implemented-main and states that a missing week breaks the run. The requirement is sensible, but its source/proposed status is inaccurate.

**Actual source**

`src/lib/phase-engine/planter-checkin.ts:199–201` comments that gaps break the run; the implementation at `:211–217` only reverses rows and checks answer levels. It never checks `weekStart` or the distance between dates. `src/lib/phase-engine/planter-checkin-db.ts:77–95` returns existing rows from the time window; it does not insert empty weeks. `src/app/(dashboard)/phase/page.tsx:312` passes those rows directly to `checkinNudges`. Alpha has the same pure-function behavior. The test at `planter-checkin.test.ts:175` tests a **steady answered week**, not an absent week.

**Counterexample**

Records for August 3, August 10 and August 24 are all strained, with no August 17 record. The current loop counts three rows and produces a three-weeks-running nudge. Thus the source comment and the v3 inventory describe an invariant not enforced by source.

**Correction**

Record this as a source defect and proposed v3 repair, not unchanged parity. Define adjacent LocalWeek behavior and add missing-interior-week and missing-most-recent-week examples. Whether absence in the current not-yet-complete week suppresses the prior three-week nudge should be stated deliberately; a simple date-gap check does not answer that UX question.

S3 and S4 can be fixed without changing the SME planting rubric: they are accurate preservation plus explicit repair of deterministic private-care software.

### Operational completeness improvements

#### S5 — Give reference publication/rollback one explicit end-to-end contract

The plan already has strong fresh-bootstrap ingredients: exact approved source versions, immutable article intent, stable IDs, checksums, a guarded installer, retired stale chunks, private/global separation, no old vectors and editorial approval. These are preserved in `docs/evidence/reference-bootstrap/README.md:11–15`, `docs/modules/communications-knowledge-ops.md`, and WP-032/033/035/041/058.

The missing precision is the *second* content release: the transition from approved bundle A to B, including failed embeddings, activation, stale caches, retirement and rollback. The bootstrap writer stops on unexpected differing digests; “intentional reviewed updates” is not yet the full state transition. WP-035 names manage/import/revalidate and tests exact revisions, while WIKI-009 still leaves product-admin publishing a decision. An admin UI is not necessary, but a version-controlled operator release path is.

**Counterexample**

Article B is imported and Wiki serves it, embedding generation fails, and assessment retrieval continues on A or a partial B. A previous assessment cites the old article version. Reverting the current slug must not erase historical citation content, reset users' stable reading identities or silently relabel an old assessment as grounded in B.

**Recommended acceptance**

Prepare/validate/stage/activate/retire/rollback a reference release with immutable content versions and an explicit current-pointer boundary. Prove a failed derivative build leaves the previous approved corpus active; historical citations resolve their original bytes; rollback changes future reads/assessments coherently; publication roles have no private-plant access. Freeze whether Wiki and intelligence activate together or carry explicitly different supported versions. This is worthwhile operational specification, not a claim that a missing CMS was a shipped v2 feature.

### Evidence-backed strengths and areas not reported as defects

- **Methodology authority is not being deleted.** `docs/methodology-foundations.md` preserves phase meanings, the eight CSFs, vision cadence, the Phase-1 five-indicator cluster, 4Cs, five interview considerations, prayer/generosity interpretation limits and human authority. It names source conflicts rather than using framework simplification to change methodology.
- **People semantics are granular.** PPL-012/013/014 distinguish human 4Cs, interview-happened versus qualified, signed commitment and date/history. Source `src/lib/people/assessments.ts` and `commitments.ts` substantiate the append/latest records. Repeated interviews/commitments regressing an advanced stage is already called out for a ruling; it is not an undiscovered omission in this review.
- **Meeting workflow is real.** MTG-007 through MTG-017 separately retain invited guests, own/token/admin RSVP, attendance, finalization, response cards, evaluation/correction and authored notes. First-time chronology and cross-type prior attendance are explicitly disclosed in `docs/modules/meetings-tasks-teams.md:174`; source `src/lib/meetings/attendance-type.ts:65–88` confirms the all-meeting behavior. I did not report that already-recorded ambiguity as a new gap.
- **Follow-up metrics are not collapsed.** The plan distinguishes meeting-origin obligations, due-day-plus-two, exact 48-hour completion, actual-contact freshness, manually created tasks, and `no_longer_needed`. An explicit unowned obligation replaces silent fulfillment when no planter is available.
- **History is more than an “audit log” label.** The plan names exact before/after corrections, stale revisions, phase corrections by append, recurring-task reopening conflicts, launch-outcome old values, milestone completion/reopen history, membership episodes, merge reference transfer and limitations of unmerge. It does not falsely claim external emails can be unsent.
- **AI grounding has important concrete controls.** The plan proposes typed fact path/value/provenance references, immutable snapshots and rubric/content hashes, one primary plus two supplemental focus items, unknown-not-healthy, bounded corrective/provider ladders, per-run failure attribution, no invented human spiritual judgment and coherent last-good-result recovery. Those controls remain future gates; this review did not call a model or certify semantic eval results.
- **Greenfield data policy is coherent.** Reference-only bootstrapping excludes tenants, accounts, private records, customer histories, credentials, sessions and old vectors. The verified global payload has 96 article rows, 21 section rows and seven templates. These counts establish the snapshot's shape, not editorial validity or complete reference lifecycle.
- **Proportional architecture.** One PostgreSQL database with explicit module ownership, same-connection transaction coordination, composite tenant integrity, a limited outbox/job worker and shared native/Evry operations is compatible with the actual workflows. There is no need to preserve dead tables or legacy runtime abstractions solely to retain the product capabilities.

### Optional polish

- Label reference rows “previously published” where “approved” could imply the pending v3 editorial/currentness decision has already happened (`reference-bootstrap/README.md:9` versus `:11`). The surrounding qualification is already honest, so this is wording polish.
- Add a short set of end-to-end semantic counterexample fixtures to the future acceptance index. Examples: an Owner with native private-care access denied an Evry read; unchanged database on day 8 receives a fresh assessment; mixed strained/struggling care streak; failed reference B activation preserves A; first vision meeting after an earlier team meeting follows the explicitly approved classification. These are much stronger coverage signals than more operation aliases or counts.
- Keep source behavior, approved product intent and proposed repairs as separate fields in methodology capability records. The PI-039 comment-versus-code discrepancy shows why one undifferentiated disposition sentence is easy to misread.

### Limits

This was a focused independent semantic audit, not a second exhaustive line-by-line review of all 3,960 claimed source files. I read the actual architecture/contracts/database methodology/reference and operational documents, inspected the registry shape and selected relevant capability records, and followed the concrete findings into actual source, tests and call sites. No v3 runtime exists to test here. I did not re-query external SME documents, regenerate the entire inventory, audit all source hashes or execute deployment/bootstrap processes. Open-decision adjudication is owned by the parent review; this appendix does not authorize changes to methodology, privacy, autonomous authority or external publication.


## Review verification and limits

The coordinator verified that all 56 pre-existing Markdown/JSON files captured in the review-input snapshot retained identical SHA-256 bytes before report delivery. This is preservation evidence, not a claim that every source file was semantically audited. The main source checkout HEAD was `18fc1a505c64615fe9ef197dba0e2cd037063d31`; the alpha checkout HEAD was `2107df58885c883960422ce7e60719f0adbac0e4`, matching the plan baselines. The architecture reviewer independently checked the declared DAG and slice closure. The substantive audit followed selected counterexamples into source and tests; it did not execute the old application, revalidate all 3,960 source hashes, query a database or certify a future v3 runtime.

Only this separate review report is delivered into v3. All recommendations await the appropriate discussion/disposition; this report does not change architecture, approve product choices or authorize implementation.
