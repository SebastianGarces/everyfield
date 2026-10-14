# EveryField rebuild specification

This repository specifies a fresh EveryField application. It contains documentation, approved reference content and an on-demand plan explorer. [Canonical build progress](docs/build-progress.json) records implementation milestones and completion. There are no customer imports or data migration.

Start with [current orientation](docs/START-HERE.md), then generate only the assigned [package context](docs/plan/context.md). Product chapters state behavior directly; the catalogs provide stable feature, operation, requirement and acceptance identifiers. The target schema is the proposed v3 design, not the v2 source-table inventory. Builders do not need v2 or the former decision chronology.

- [Product scope and exclusions](docs/product/scope.md)
- [Architecture](docs/architecture/core.md), [auth](docs/architecture/auth.md), [security](docs/architecture/security.md) and [audit](docs/architecture/audit.md)
- [Target schema and ERD](docs/schema/README.md)
- [Build order, shared freezes and package contexts](docs/plan/build-plan.md)
- [Release gates and remaining owner inputs](docs/plan/release-gates.json)
- [Reference authority and bootstrap](docs/reference/manifest.json)
- [Dependencies](docs/dependencies.md)
- [Documentation verification and proof limits](docs/verification.json)
- [Explorer renderer](docs/render-build-explorer.py), generated outside the repository
- [Feature review](everyfield-feature-review.html), checked against the feature catalog
- [Evidence-backed progress workflow](docs/build-agent-workflow.md)
- [Intent workflow preparation, approved merge policy and setup placeholders](tools/evf/README.md)

The fix wave changed the schema, catalogs, cases, package plan and design handoff. G-DESIGN requires a new independent review; [verification](docs/verification.json) retains prior review provenance and proof limits. Implementation kickoff requires separate authorization. Later compatibility, SQL/security, UI/model, provider configuration, purge and restore tests remain explicit future acceptance gates. Documentation checks do not establish those results. Intent is the future implementation harness. Its merged local helpers are reviewed; actual spending and concrete Intent review/identity/approval receipt and environment setup remain gated external inputs. Ordinary build PR automatic merge is owner-approved after final-head tests and independent approved review; feedback PR human review remains required. Existing external source backups are preserved; superseded material is removed only after requirement preservation checks, without an archive folder in this repository.

EveryField is an operational church-planting workspace with native workflows and the reviewed Evry assistant. The SME Playbook and Plant Intelligence rubric define its methodology; Network Intelligence reports only eligible organization-shared evidence. Plants and organizations have separate access scopes, and original-author private care stays outside the assistant and shared intelligence.

Current catalogs own requirements, acceptance cases, operations and the schema once. Generate a short assigned packet with `python3 docs/package-context.py WP-019 --output /tmp/WP-019.json`. Generate the read-only explorer with `python3 docs/render-build-explorer.py --output /tmp/everyfield-build-explorer.html`. Run all documentation checks with `python3 docs/check-all.py`; projections do not write canonical progress.

The [feature catalog](docs/catalog/features.json) maps retained capabilities to requirements, cases, operations and owning packages. A later delivery slice does not drop a capability. Approved exclusions preserve native private care while excluding assistant access; the [reference manifest](docs/reference/manifest.json) preserves original methodology bytes and portable bootstrap content.

[Release gates and open questions](docs/plan/release-gates.json) are the single register for remaining choices, their owners and when they are needed. The Help center design is retained for a future feature outside v3; contextual Guide remains in scope.
