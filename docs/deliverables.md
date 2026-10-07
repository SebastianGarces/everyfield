# Deliverable inventory

The primary deliverable is the documentation directory `/Users/sebastian/dev/everyfield_v3`. Its files are Markdown or JSON: specifications, proposed interfaces/architecture, future work packages, audit evidence and the approved-reference candidate. It contains no application implementation, lockfile, executable scripts, database migration or customer import. The local ZIP and optional Library copy package this directory for inspection; the directory remains primary.

## Readable documents

| Group | Files |
|---|---|
| Entry and scope | [README](../README.md), [executive summary](executive-summary.md), [module index](modules/README.md), this inventory |
| Product foundations | [Methodology/version/conflict register](methodology-foundations.md), [open decisions](open-decisions.md) |
| Module specifications | [Identity/people](modules/identity-people.md), [meetings/tasks/teams](modules/meetings-tasks-teams.md), [communication/notifications/documents/Wiki/admin/ops](modules/communications-knowledge-ops.md), [methodology/intelligence/phases/launch/reference](modules/methodology-intelligence-launch.md), [Evry inventory](modules/evry-inventory.md) |
| Architecture | [Architecture](architecture/architecture.md), [ADRs](architecture/decisions.md), [contracts](architecture/contracts.md), [complexity budget](architecture/complexity-budget.md), [database map/ERD](database-map.md), [Evry design](evry-design.md), [lessons](lessons.md), [dependency plan](dependencies.md) |
| Implementation traceability | [Capability matrix](capability-preservation.md), [work packages/slices/lanes/gates](plan/build-plan.md), [DAG](plan/dag.json) |
| Sources and reviews | [Pinned source guide](sources.md), [independent plan review](review.md), [independent coverage review](coverage-review.md), [reference-bootstrap provenance](evidence/reference-bootstrap/README.md) |

## Machine-readable evidence

| Evidence | Meaning |
|---|---|
| [Capabilities](evidence/capabilities.json), [acceptance registry](evidence/acceptance-registry.json), [coverage summary](evidence/coverage-summary.json) | 496 distinct evidence records, target ownership/operations, planned feature-scoped proof and status/family denominators |
| [Database map](evidence/database-map.json), [main/alpha declarations](evidence/schema-source.json), [local declarations](evidence/local-schema-source.json) | 88 table dispositions, consumers, feature/package links, source constraints/relations and local deltas |
| [Source manifest](evidence/source-manifest.json) | Heads, dirty state, tracked-file hashes, source divergence and diagnostic provenance |
| [Full surface inventory](evidence/surface-inventory-full.json), [file owners](evidence/surface-ownership.json), [callable owners](evidence/callable-ownership.json), [surface summary](evidence/surface-coverage-summary.json) | Measured source files and lexical declarations; distinguishes exact evidence from supporting module ownership |
| [Controller function ledger](evidence/action-function-coverage.json), [reviewed wrapper aliases](evidence/wrapper-alias-verification.json) | Source-action ownership and specific controller-to-domain-feature links; no one-for-one public API mandate |
| [Dependency inventory](evidence/dependency-inventory.json) | All direct source manifest dependencies and retain/replace/defer rationale; latest versions of ancillary choices are future verification gates |
| [Reference manifest](evidence/reference-bootstrap/manifest.json), [global seed candidate](evidence/reference-bootstrap/global-seed-payload.json), [verification](evidence/reference-bootstrap/verification.json), [prior MDX syntax proof](evidence/reference-bootstrap/mdx-syntax.json) | Checksummed global-only content/template candidate, scope/hash verification and prior syntax evidence; editorial approval remains open |
| [Validation](evidence/validation.json) | Documentation/link/traceability/DAG/slice/source-preservation checks; not runtime acceptance |
| [Delivered file manifest](evidence/deliverable-manifest.json) | SHA-256/size list for every package file except the manifest itself |

The `audits/` directory retains the six substantive module/database inventories, Evry's separate surface corpus and the two independent review records. Central files reconcile worker placeholders and aliases; source audit candidates remain inspectable. A central normalized target operation can differ from a historical helper name while preserving its product outcome.

## Remaining gates

No documentation blocker remains after independent reconciliation. The17 [named decisions](open-decisions.md), reference editorial/currentness approval and actual future runtime/provider/privacy/semantic acceptance remain open. No acceptance obligation is reported as an executed v3 test. The [module index](modules/README.md) defines all source-count denominators and important coverage limitations.
