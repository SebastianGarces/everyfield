# Methodology foundations and source reconciliation

Audit date: **2026-10-03**. This is a rebuild specification, not an authorization to alter the church-planting methodology. The SME-generated Plant Intelligence rubric and Launch Playbook are authoritative product foundations. A fresh codebase, no customers, and no customer-data migration do not make those foundations disposable.

The software may simplify implementation, UI, storage and operation boundaries. It must preserve the substance of vision meetings, follow-up, commitments, ministries, interviews, the 4 C's, church phases, launch preparation and the rubric's interpretation limits. Proposed software changes below do not approve feature removal or new pastoral authority.

## Verified source hierarchy

| Source | Verified role | Authority and limits |
|---|---|---|
| `product-docs/launch-playbook.md` | Canonical repository Playbook; unchanged since initial commit `4192fa24ed86d856df58b811168bb43e1986f67c` | Preserved foundation. Its own introduction describes contextual adaptation and contribution to best practices, which does not authorize this audit to invent new methodology. |
| `product-docs/features/phase-engine/rubric-v1.md` | Says in force since 2026-08-21; last change `8375526e0b1429f8ee0b81abed3a2dc104da74ea` | Latest reviewed repository rubric artifact. Contains final threshold table and C12 ruling. |
| `src/lib/phase-engine/rubric.ts` | `RUBRICS` registers v0/v1; `ACTIVE_RUBRIC_VERSION = "v1"` | Executable judge instructions and exact behavior source. Preserve history; do not mistake stale prompt wording for a newer SME ruling. |
| `product-docs/features/phase-engine/bryan-comments-review.md` | Records C01–C26, their issues and final dispositions | Acceptance of Bryan's review on 2026-08-18; v1 assembled 2026-08-21; C12 ruled later that day. All 26 comments disposed. |
| `product-docs/decisions.md` | Current register reconciled 2026-09-26 | Current intent evidence, especially methodology, privacy, authority and known limitations. Old architecture dogma is not a v3 constraint. |
| `product-docs/features/phase-engine/frd.md` | Intended contract including unimplemented nice-to-haves | Read with source. Several references still point to v0 and generic health language. Requirements are not proof of implementation. |
| `product-docs/features/phase-engine/rubric-v0.md` | Previous review artifact | Historical explanation of v0 assessments, not the active thresholds. |
| [Historical SME Google Doc](https://docs.google.com/document/d/1YS6z8pbSeAl2yL-q3C93VvGuE4pxroh1PTzD2LAeeUk/edit) | Parent verified v0 July draft, modified Aug19, 26 Bryan comments dated Aug17, comments unresolved in Doc | Original review provenance. Doc comments are suggestions, not authority over newer accepted repository dispositions. Parent's read is recorded as delegated evidence; this auditor did not fetch or mutate the Doc. |
| Main checkout `18fc1a50…` | Implemented baseline at `/Users/sebastian/dev/everyfield_v2` | Source and tests establish behavior. Dirty unrelated skill/marketing files do not establish new methodology. |
| Alpha `2107df58885c883960422ce7e60719f0adbac0e4` | Verified checkout at `/private/tmp/everyfield-alpha-implementation`; recent unmerged work | Adds task-based follow-up metrics, actual contact freshness, private check-in history/corrections and waived-obligation launch readiness. User-approved alpha semantics are preserved. |
| Diagnostics `81abfcc7fb150fdfa5fa87392052dd07da966d03` | Verified descendant of alpha, four changed files | Only failure diagnostics/tests: final failed draft wording, not new rubric/methodology. |

The [packaged bootstrap evidence](evidence/reference-bootstrap/README.md) preserves a read-only global bootstrap snapshot verified at `/Users/sebastian/Documents/Codex/2026-09-30/task/evidence/assessment-ops/bootstrap-dry-run/`: 96 published global articles, 21 referenced sections, and 7 repository system templates at alpha `2107df58`. Manifest SHA256 `b60b368d7c0ae901c26e429bcda314502e7e836bf97ad57525d9c8816724e68b`; payload SHA256 `7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59`. Every article compiles syntactically; semantic/editorial review remains false. This resolves acquisition availability without approving import or methodology edits.

The JSON [audit manifest](../audits/methodology-intelligence.json) records full source hashes, last-change commits, main/alpha equivalence and capability IDs. This audit reads source only. It did not query a customer database, execute seeders, call a model, validate deployment configuration, or change memories.

## Preserved methodology contract

The Playbook seeks a launch with a cohesive, mature group of 50–100 adult believers aligned with the vision, mission and distinctives, and with its ministry model prepared. Rubric v1 correctly describes **this methodology's benchmarks**, not universal definitions of church health or proof of failure below 50. Its own launch objectives include facilities, finances, equipment, training, promotion and ministry teams; cutting facility-management software does not cut facilities preparation from the Playbook.

The phases remain:

| Phase | Name | Product meaning |
|---|---|---|
| 0 | Discovery | Discern calling, foundations/values, coach, readiness to begin vision meetings. |
| 1 | Core Group Development | Vision meetings, first-time follow-up, human fit/commitment, growth toward benchmark. |
| 2 | Launch Team Formation | Set launch day, transfer core-group focus into launch preparation, fill ministry leadership. |
| 3 | Training & Preparation | Train teams and test systems. |
| 4 | Pre-Launch | Integration, three pre-launch services, promotion, final preparation. |
| 5 | Launch Sunday | Execute the first service and capture its outcome. |
| 6 | Post-Launch | Sustainable rhythms and follow-up; recurring service-management software needs its own discovery. |

Phase is attested context and a soft constraint. Initial declaration describes where a plant already was when joining; it must never fabricate a 0→1→2→3 history. Owners may advance, regress, skip or correct with reason; no readiness result hard-blocks or autonomously advances them. Recording Launch Sunday does not advance phase or manufacture a meeting record.

The eight Critical Success Factors remain Vision Casting, Shared Ownership, Critical Mass, Core Group Cohesion (rubric v1's operational rendering of the Playbook's Unity), Prayer, Generosity and Financial Readiness, Emerging Leadership, and Comprehensive Training. Renaming an observable lens to Cohesion does not rewrite the Playbook's relational unity: the software cannot assess unity from attendance. Generosity and financial solvency are two separate questions under the lens; outside support does not prove sacrificial giving.

The 4 C's remain **Committed, Compelled, Contagious, Courageous**. The five interview considerations remain maturity, giftedness, chemistry, right reasons, and season of life. Interviews and 4 C's are recorded **human judgments**, not outputs that Plant Intelligence or Evry may invent. Behavioral leadership signals open a conversation; 60 days of attendance/serving does not make a person spiritually qualified or leadership-ready.

Prayer/Scripture content in the Playbook and Wiki remains approved reference material. Operational assistance may locate a passage, show a checklist or record a user's attestation. It must not generate prayer, biblical counsel, theological judgments or pastoral decisions as delegated authority.

## Ruled thresholds and alpha operational semantics

| Topic | Current approved interpretation | Evidence |
|---|---|---|
| Vision cadence | Playbook floor every 14 days; predictable rhythm matters; watch 21/direct 28 days; weekly practice legitimate | Rubric v1 Lens1; final C12 disposition; current decisions |
| Growth | Rolling 28 versus prior 28 days; momentum slowed≥21, stalled≥28; a new committed adult resets flat streak | Rubric v1 Lens3; `buildCoreGroupSignals` |
| Cohesion | No attendance last 28 after some prior 28; active committed denominator; ≥20% and minimum 3; leader among disengaged makes voice one level more direct | Rubric v1 Lens4; `buildCohesionSignals`; resolves Doc suggestion20–25% without invented coefficient |
| Phase1 exit | Five-indicator cluster: size 30–40, trajectory, viable funding, worship leadership, geographic area; no weights or magic headcount gate | Rubric v1 Phase1; `PHASE_EXIT_CRITERIA` |
| Near-launch oversight | Within 30 days plus unresolved role/training gap; a close date alone is not a warning | Rubric v1 §7; `classifyPlantHealth` |
| Prayer/giving freshness | 30-day reaffirm prompt; old answer remains attested and visibly aged, not false or current by assumption | `MANUAL_SIGNALS`, evidence profile; rubric v1 Lenses5–6 |
| V1 legacy follow-up facts | Warm attended within 14 days,7-day stale and14-day seriously stale; cold 14. Main computes these from person-row `updatedAt`, which is **not actual contact evidence** | `buildFollowUpSignals`; source implementation limitation |
| Alpha task obligations | Task-driven due/overdue warning; `no_longer_needed` resolves rather than completes; 48-hour success measured from originating meeting, not task creation; manual/missing provenance unmeasured | User clarification relayed by parent; alpha task schema/services and `computeFollowUpTaskMetrics` |
| Alpha actual contact | Successful-contact evidence from `lastContactAt`; recent younger than14days; absent/future evidence unknown | `computeContactFreshness` |

The v3 reference package must faithfully preserve the reviewed rubric and annotate implementation mismatches. Replacing a profile-edit proxy with actual contact is a software integrity fix. Relabeling the rubric's stale-contact interpretation, changing a threshold, or equating waived work with successful contact requires explicit reviewed disposition. Do not silently train the judge on both competing meanings under the same field names.

## Source conflict register

| ID | Contradiction or gap | Disposition for v3 |
|---|---|---|
| METH-01 | FRD overview still cites `rubric-v0.md` while active code is v1 | Treat as stale pointer; package approved v1 with historical v0 separately. |
| METH-02 | Compiled v1 prompt says the 14-day target is still an open Playbook parameter; review document's early open-question section also says C12 open, but its later final disposition and current decisions rule it biweekly | Correct source-copy drift when packaging, with explicit trace to final C12 decision. Do not reopen cadence or infer weekly replacement. |
| METH-03 | Playbook eight ministry areas include Administration/Finance; ten team templates include pastor/coordinator/prayer, while rubric prose calls prayer leader “one of eight” | Keep all responsibilities and operational teams; define canonical ministry-area-to-team/role mapping with SME confirmation. Never silently drop Prayer or add a ninth required area. |
| METH-04 | Coverage matches team names by substring, despite stable `template_key` existing | Replace implementation with stable mappings; preserve custom-team explicit mapping. Approve ambiguous mappings instead of guessing from renamed labels. |
| METH-05 | Cohesion computation reads completed meetings, while evidence profile tests `visionMeetings.isEmpty` for cohesion | Make evidence quality follow the exact data used by the lens; a core-group-only plant must not be mislabeled unknown. |
| METH-06 | V1 generosity and funding are independent, but evidence profile exposes one best-age/quality state for the whole lens | Preserve separate assertions and ages; show both subdimensions. Avoid implying giving is known because funding was attested. |
| METH-07 | Alpha has actual-contact and task metrics, but old `updatedAt` fields and older rubric language still reach the judge | Separate versioned facts and remove misleading completion/contact labels in new snapshots. Require reviewed prompt alignment, not automatic “v2 rubric” invention. |
| METH-08 | Literal “planter sees first” is implemented as seen **or 72 hours** release; category pairing is weaker than proving same diagnosis | Preserve disclosed default behavior in inventory; explicit decision to retain fallback/reviewed concern pairing before v3 launch. |
| METH-09 | “Network individual insights never exposed” uses cited-path heuristics; bodies and cross-cutting categories can still encode sensitive facts | Privacy need retained, implementation replaced: aggregate-only oversight DTO with fact disclosure provenance; validate entire output and tests. |
| METH-10 | Private check-in says planter-only, but main write uses Admin-capable `phase.signal`; alpha corrects to Owner-only and adds history | Use approved alpha Owner-only behavior; separate personal-care access domain; no coach/org/AI/Evry access by default. Clarify current owner versus historical author on future ownership transfer. |
| METH-11 | Check-in `weekStart` is a timestamp called a date; UTC Monday differs from church-local week. Launch day/eligibility/countdown also use UTC while local schedules use church timezone | Freeze LocalDate/Instant/Week contract before implementation. Recommend church-local launch day and personal weekly boundary; record behavior change explicitly and test DST/midnight. |
| METH-12 | `data-posture.md` July25 claims current OpenAI opt-in, account eligibility, unconfigured tracing and full prompt/response traces | Historical account evidence, not live guarantee. Source verifies `store:false`; tracing adapter currently metadata/usage only. Reverify account controls, official terms and configured destinations before live AI. No categorical “pre-revenue cannot get ZDR at any price” inference. |
| METH-13 | Repository claims 96 Wiki articles but article-checklist says content became DB-only and MDX paths historical; no current seed/source tree | The read-only alpha `2107df58` snapshot resolves missing acquisition:96 published global articles and 21 sections with checksums are available. Editorial/currentness approval remains a gate; no new live DB export is needed for this plan. |
| METH-14 | Global embed script upserts `(doc_key,chunk_index)` but never retires removed trailing chunks; no corpus revision/model hash | Verified snapshot evidence: 547 expected chunks versus 572 stored; 431 match, 114 mismatch, 2 missing and 27 obsolete; vector-model provenance absent. Versioned complete corpus rebuild/publish; stale chunks cannot survive as current guidance. |
| METH-15 | FRD nice-to-haves outcome linkage/reactive criteria/network-configurable rubric have schema substrata but no finished implementation | Track explicit deferred specs; preserve implemented outcomes/history. No hidden “complete” claim. |
| METH-16 | Retired Evry decision in v2 and new user direction to restore first-class operational Evry | User's current direction governs v3. Keep judgment pipeline separate from operations assistant; do not revive old implementation/authority assumptions. |

## Fresh global bootstrap, no customer migration

The new project imports approved **global reference content**, never customer accounts, seats, plants, persons, meetings, tasks, check-ins, feedback, history or database migration ledgers.

1. Freeze source input manifest: Playbook, reviewed rubric v1/v0, manual signals, 7 phases, 8 lenses, 20 task templates, 10 ministry templates/roles, 11 document templates, 7 communication templates, 9 launch milestones/22 task entries. Record hashes and approved provenance.
2. Use the verified global-only alpha `2107df58` snapshot as the reproducible Wiki package candidate: global `wiki_articles`/`wiki_sections`, content/MDX, published state, stable slug, title/excerpt, phase, section, sort order, related articles/template links and version metadata. No progress/bookmarks/feedback, tenant overrides or private content. The verified payload is already available as read-only evidence; this audit has not read a live DB. Approve editorial/currentness alignment before future import.
3. Validate all 96 snapshot articles against their record/content hashes and intended approved scope; resolve additions/removals with an editorial manifest, not the old checklist's checkmarks. Check phase/section hierarchy and canonical links. Preserve all methodology content; implementation-friendly edits remain traceable.
4. Make seed functions deterministic and idempotent against stable reference keys/content versions. Each environment creates fresh app/auth tables and reference package only; synthetic demos/evals require separate owned disposable DBs and explicit fixtures.
5. Build corpus chunks from this exact approved package. Record source SHA, passage SHA, chunker version, embedding model/dimensions and corpus revision. Publish one fully verified generation and retire removed passages in it. Rubric remains whole in-context, outside embeddings.
6. Acceptance blocks implementation signoff until blank-environment bootstrap produces the same reference manifests and every article/template link resolves. Neither a successful seed sentinel nor a development DB label authorizes destructive work.

## Approval boundary

No new approval is needed to create this documentation. Implementation decisions requiring future human/SME resolution are METH-03 canonical ministry mapping, METH-07 follow-up rubric alignment, METH-08 oversight 72-hour policy, METH-10 historical personal-check-in ownership, METH-11 calendar boundary, and METH-13 canonical Wiki snapshot editorial/currentness approval. Product owners retain all pastoral, methodological and rubric-release authority. Changes to benchmark numbers, interview criteria, 4 C's, phase meaning or prayer/generosity meaning cannot arise as unnoticed technical refactors.
