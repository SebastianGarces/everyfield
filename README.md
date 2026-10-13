# EveryField rebuild specification

This repository specifies a fresh EveryField application. It contains documentation, approved reference content and a standalone offline plan explorer. **No v3 application is implemented.** All 86 work packages remain not started. There are no customer imports or data migration.

Start with [current orientation](docs/START-HERE.md), then generate only the assigned [package context](docs/plan/context.md). Product chapters state behavior directly; the catalogs provide stable feature, operation, requirement and acceptance identifiers. The target schema is the proposed v3 design, not the v2 source-table inventory. Builders do not need v2 or the former decision chronology.

- [Product scope and exclusions](docs/product/scope.md)
- [Architecture](docs/architecture/core.md), [auth](docs/architecture/auth.md), [security](docs/architecture/security.md) and [audit](docs/architecture/audit.md)
- [Target schema and ERD](docs/schema/README.md)
- [Build order, shared freezes and package contexts](docs/plan/build-plan.md)
- [Release gates and remaining owner inputs](docs/plan/release-gates.json)
- [Reference authority and bootstrap](docs/reference/manifest.json)
- [Dependencies](docs/dependencies.md)
- [Documentation verification and proof limits](docs/verification.json)
- [Offline explorer](everyfield-build-explorer.html)
- [Evidence-backed progress workflow](docs/build-agent-workflow.md)
- [Intent workflow preparation, approved merge policy and setup placeholders](tools/evf/README.md)

The current specification passed independent whole-plan and semantic preservation reviews; [verification](docs/verification.json) records their scope and proof limits. Implementation kickoff requires separate authorization. Later compatibility, SQL/security, UI/model, provider configuration, purge and restore tests remain explicit future acceptance gates. Documentation checks do not establish those results. Intent is the future implementation harness. Its merged local helpers are reviewed; actual spending and concrete Intent review/identity/approval receipt and environment setup remain gated external inputs. Ordinary build PR automatic merge is owner-approved after final-head tests and independent approved review; feedback PR human review remains required. Existing external source backups are preserved; superseded material is removed only after requirement preservation checks, without an archive folder in this repository.
