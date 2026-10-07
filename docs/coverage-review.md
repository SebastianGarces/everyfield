# Independent source-coverage review

Final independent review, 2026-10-03: the documentation passes structural source-accounting checks and the identified semantic mapping corrections. No unresolved missing feature/table/acceptance/work-package link defect remains from this review. Runtime correctness remains a future acceptance obligation.

The reviewer independently checked **3,960 source hashes**, both checkout heads and their recorded dirty-file lists: all remained unchanged. The registry has **496 records** (241 domain/support and 255 Evry), **720 unique feature-scoped acceptance obligations**, and an **86-package, 272-edge acyclic DAG**. All feature/table/acceptance/work-package references resolve. [Machine review evidence](../audits/coverage-review.json) retains frozen input hashes, independent checks, resolved findings and the remaining support-level controller mappings.

| Evidence | Independently verified result |
|---|---|
| Tables | 84 distinct declarations across main/alpha/local sources, plus four historical replacements = 88 map records; every table has feature links. |
| Main/alpha files | 2,893 enumerated records; 1,741 classified direct-reference links and 1,152 supporting module assignments; zero unowned records in that corpus. |
| Callable extraction | 4,174 lexical records; 2,295 operation-name associations. These include helpers/constants and are not public API or product-correctness counts. |
| Action denominator | `src/app` has 177 main / 188 alpha exported controller functions. Including `src/lib/auth/actions.ts#logout` gives 178 / 189 across the whole action-file corpus. Logout maps to IDN-001. |
| Evry | All 22 actual handler files link to feature evidence. Inventory distinguishes 30 read/helper tools, 117 preparation variants, 191 operation contracts, 808 hashed local files and 283 source test files. |

The initial review found and the final artifacts correct lost consolidated Evry infrastructure evidence, invalid table aliases, incomplete local schema accounting, missing meetings/tasks/teams integration, hidden request security/crawler/association-receipt evidence, unowned operational helpers, and obsolete credential helpers promoted into target contracts. The real local `communication_failed_retries` table and four FK edges are preserved, together with the `communication_recipients.failure_origin` delta and proven-failure retry gates. `notifications.mark_selected_read` has an exact selected-target gate; the meeting-invite recipe retains create-meeting → guests → invitation dependency-output semantics.

The final pass also detected incorrect launch/phase/leadership/resend controller owners. Fresh source aliases now map scheduling to LCH-001, milestone completion/reopening to LCH-004, outcome recording/correction to LCH-006/007, phase transitions to PHASE-002/003/005/006/007, leadership confirmation to IDN-014 and resend to COM-009. These are source aliases; they do not inflate the target API. Auth target operations use Better Auth outcome contracts rather than custom token/cookie plumbing.

Twenty-three controller records retain explicit support-level mappings, including template wrappers, check-in/signal wrappers, unsubscribe/undo and linked launch-task completion. The relevant semantic feature is present in each inspected owner set; a broad owner list does not mean a function implements every listed feature. The machine report retains those rows for implementation review.

These counts establish accountable source routing, not a product-coverage percentage. The collector’s direct-reference classification uses path containment and immediate-directory references; literal file links are separately recorded in machine evidence. Root instrumentation/config and historical/local sources are also represented through manifests and direct feature evidence. Lexical exports and the callable `product_capability_claim` field cannot by themselves certify an installed tool, public API or correct behavior.

Fifty-two capability records have no specific mapped source suite, including 11 meeting/team records and 20 richer Evry read/helper entries. Source suites were inspected, never executed. The inherited assistant corpus still has 48 unbound scenarios. Required future proof includes denied actor/tenant/object/lifecycle access, cross-module races, correction/history/recovery, file/provider failures, truthful source-grounded answers and real browser/tool journeys. The 17 named open decisions remain gates before dependent implementation; this documentation task did not resolve them by guessing.

No v2 source, database, environment, memory, provider or deployment was mutated. No v3 implementation or runtime test was performed.
