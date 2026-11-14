# Everyfield

Everyfield is an operational church-planting workspace with native workflows and the reviewed Evry assistant. The SME Playbook and Plant Intelligence rubric define its methodology; Network Intelligence reports only eligible organization-shared evidence. Plants and organizations have separate access scopes, and original-author private care stays outside the assistant and shared intelligence.

Start with [current orientation](docs/START-HERE.md). Requirement JSON in `docs/catalog/requirements/` is the behavior authority; product chapters are readable summaries. Run all documentation checks with `python3 docs/check-all.py`. Run the early-access request tests with `pnpm test:early-access`.

- [Product scope and exclusions](docs/product/scope.md)
- [Architecture](docs/architecture/core.md), [auth](docs/architecture/auth.md), [security](docs/architecture/security.md) and [audit](docs/architecture/audit.md)
- [Target schema and ERD](docs/schema/README.md)
- [Build order, shared freezes and package contexts](docs/plan/build-plan.md)
- [Package context](docs/plan/context.md)
- [Release gates and remaining owner inputs](docs/plan/release-gates.json)
- [Reference authority and bootstrap](docs/reference/manifest.json)
- [Feature catalog](docs/catalog/features.json)
- [Dependencies](docs/dependencies.md)
- [Documentation verification and proof limits](docs/verification.json)
- [Explorer renderer](docs/render-build-explorer.py), generated outside the repository
- [Feature review](everyfield-feature-review.html), checked against the feature catalog
- [Build workflow, progress and merge rules](docs/build-agent-workflow.md)
- [Build progress](docs/build-progress.json), frozen on 2026-10-22 at PR #235 except WP-017–039, WP-071 and WP-072, which T-290 refreshed on 2026-11-13; evf v2's task records are still the live state
