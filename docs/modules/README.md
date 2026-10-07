# Module index and coverage interpretation

Use a stable feature ID to move from source behavior to a target module, exact table links, planned acceptance and owning work packages. The human [preservation matrix](../capability-preservation.md) is the compact index; [capabilities.json](../evidence/capabilities.json) retains the full fields and audit provenance. Module files supply actual state, permission, validation, failure, correction and historical details rather than a route list.

| Capability family | Stable IDs / records | Specification | Principal future packages |
|---|---|---|---|
| Identity, tenancy, consent, coaching, onboarding, request security and settings | IDN, 28 | [Identity and people](identity-people.md) | WP-005..010, shared WP-002/006/031 |
| CRM, pipeline, households/tags/skills/photos, assessments/interviews/commitments, import/export, correction and merge | PPL, 23 | [Identity and people](identity-people.md) | WP-011..015 |
| Vision/team/other meetings, venue and agenda, invitations/own/public RSVP, attendance, evaluation and reconciliation | MTG, 19 | [Meetings, tasks and teams](meetings-tasks-teams.md) | WP-020..023 |
| Managed follow-up and manual tasks, assignment/bulk/history, recurrence/dependencies and phase-template offers | TSK, 16 | [Meetings, tasks and teams](meetings-tasks-teams.md) | WP-023..026 |
| Canonical/custom ministries, roster/roles/leadership, responsibilities, org chart and training | TEAM, 15 | [Meetings, tasks and teams](meetings-tasks-teams.md) | WP-016..019 |
| Composer, merge/templates, recipient selection, send/tracking/history, nonopener resend and verified failed-send retry | COM, 12 | [Communication, knowledge and ops](communications-knowledge-ops.md) | WP-027..029, early transport WP-031 |
| In-app feed, event producers, actor/organization preferences, digest/reminder/deadlines, suppression and opt-out/undo | NTF, 15 | [Communication, knowledge and ops](communications-knowledge-ops.md) | WP-030/031 and emitting domain packages |
| Template browsing, real merged PDF/DOCX/XLSX generation/preview, private storage/history/download and attachments | DOC, 15 | [Communication, knowledge and ops](communications-knowledge-ops.md) | WP-036/037, storage WP-004 |
| Wiki scope/navigation/search/render/export, progress/bookmarks/rating/help, crawler preview, reference bootstrap and revalidation | WIKI, 11 | [Communication, knowledge and ops](communications-knowledge-ops.md) | WP-032..035 |
| Feedback/admin triage, optional issue bridge, identity routing/dashboard, marketing/waitlist and public/legal pages | ADM, 7 | [Communication, knowledge and ops](communications-knowledge-ops.md) | WP-048/049 |
| Protected ticks/jobs, health/observability, event consumers, migrations/seeds/test/CI/preview/support tools and diagnostics | OPS, 11 | [Communication, knowledge and ops](communications-knowledge-ops.md) | WP-031/050 and cross-module gates |
| Plant Intelligence facts/metrics, reference retrieval, grounded judgment/retries/publication/history, feedback and oversight | PI, 42 | [Methodology, intelligence and launch](methodology-intelligence-launch.md) | WP-039..044/047 |
| Phase attestation/history and check-in evidence | PHASE, 8 | [Methodology, intelligence and launch](methodology-intelligence-launch.md) | WP-038/039 |
| Launch planning/readiness, milestones/tasks/date changes, outcomes/history and privacy | LCH, 11 | [Methodology, intelligence and launch](methodology-intelligence-launch.md) | WP-045/046 |
| SME rubric/Playbook, canonical teams/templates and versioned reference sources | REF, 8 | [Methodology foundations](../methodology-foundations.md), [methodology specification](methodology-intelligence-launch.md) | WP-001/032/033/041/042 |
| Historical/local Evry runtime, plans/approvals/execution, 191 operation contracts and 30 richer read/helper entries | EVR, 255 | [Inventory](evry-inventory.md), [target design](../evry-design.md) | WP-051..055 plus module adapters WP-059..086 |

Domain/support rows total 241; Evry rows total 255. Families are inventory partitions, not a demand to deploy sixteen services. Shared tables and operations can participate in multiple workflows; one named domain owner controls invariants and other modules consume its typed interface.

## Follow a feature through the plan

1. Locate its row in [the capability matrix](../capability-preservation.md), then read the linked specification and source symbols. Verify baseline/status: implemented main, implemented local-only, partial, dead or uncertain.
2. Look up the feature in [the complete registry](../evidence/capabilities.json): `tables`, `permissions`, `states`, `validation`, `failures`, `v3_operations`, `v3_owner_paths`, `acceptance_ids` and `work_packages`. `original_v3_operations` preserves the worker's candidate names; credential helpers and other internals are not all public APIs.
3. Follow exact table IDs into [the table map](../evidence/database-map.json) for consumers, relationships, source constraints/deltas, target model/disposition and integrity gates. Every table has feature links; no orphan declaration is silently omitted.
4. Follow each unique feature-scoped acceptance ID into [the acceptance registry](../evidence/acceptance-registry.json). Shared gate labels remain `shared_gate_refs`; they do not substitute for each feature's fixture and observed result.
5. Follow exact WP IDs into [the DAG](../plan/dag.json) and [human build plan](../plan/build-plan.md) for prerequisites, outputs, owner paths/interfaces and gates. No package closes on a count alone.

## Denominators and limits

| Evidence layer | Count / interpretation |
|---|---|
| Capability registry | 496 records; 210 main, 249 local-only, 13 partial, 23 dead, one uncertain. Domain/support: 210 main, 14 local-only, 13 partial, three dead, one uncertain. Evry: 235 local-only, 20 dead. |
| Schema | 79 main, 82 alpha and 80 pinned local declarations; union 84, plus four historical replacements = 88 map records. Source FK edges = 209, not a queried live catalog. |
| Main/alpha file inventory | 2,893 records: 1,427 main and 1,466 alpha. Includes 151 pages, 87 action files, 26 API files, 779 services, 802 tests, 835 components, 64 schema files, 101 scripts, 42 shell/ops files and six prototype files. |
| Ownership ledger | 1,741 exact feature/test file references plus 1,152 module-support mappings; zero unowned enumerated files. Broad supporting ownership does not prove semantic behavior or create an API. |
| Callable ledger | 4,174 lexical callable records, including helpers; 2,295 named operation mappings. This is an auditable extraction aid with syntax limits, not an AST-certified public API count. |
| Future acceptance | 720 unique feature-scoped obligations across 496 records. Positive, denied/tenant/object, validation, state, failure, recovery/correction and integration proof still must be implemented and observed. |
| Build graph | 86 packages; shared freezes, domain-to-adapter links and integration gates; estimate conditional on staffing and open decisions. |

The [surface summary](../evidence/surface-coverage-summary.json), [file ledger](../evidence/surface-ownership.json), [callable ledger](../evidence/callable-ownership.json) and [direct action-function ledger](../evidence/action-function-coverage.json) make mechanical ownership inspectable. The direct ledger enumerates exported action functions under `src/app` (177 main/188 alpha); the whole action-file corpus also includes `src/lib/auth/actions.ts#logout`, giving178/189. Logout is covered by IDN-001 and the callable ledger. [Wrapper alias verification](../evidence/wrapper-alias-verification.json) checks twelve explicitly reviewed controller/feature aliases on both baselines. The local Evry corpus is separately enumerated in [evry-surfaces.json](../../audits/evry-surfaces.json). Current/local/historical duplicate paths are deliberately retained as different evidence snapshots.

High test counts do not establish user journey coverage. Existing tests were read, not executed. Fifty-two capability records lack a specific mapped source suite, including eleven meeting/task/team records and twenty richer Evry read/helper entries; inherited Evry evaluation scenarios include48 unbound cases. Twenty-three controllers retain explicit support-level owner mappings whose semantic feature is present in the inspected owner set, rather than one-to-one lexical operation associations. The specifications turn these evidence limits into future owned gates instead of claiming certainty. Hidden request-boundary, public crawler, receipt, operator and assistant variants are included in the inventory.

## Methodology and decisions

The [foundation/version map](../methodology-foundations.md) distinguishes approved SME sources, later rulings, historical docs and open contradictions. Module acceptance must cite those sources when changing facts, denominators, phase/task templates or assessment output. Consult [open decisions](../open-decisions.md) before resolving a contradiction through implementation. Staging work or replacing a dead mechanism does not imply product removal approval.
