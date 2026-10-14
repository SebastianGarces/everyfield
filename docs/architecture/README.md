# Architecture contracts

EveryField uses one modular Next.js application for native work and Evry. [Core](core.md) defines ownership and transactions; [auth](auth.md) separates credentials from domain acceptance; [security](security.md) defines current access and purpose projections; [audit](audit.md) defines platform events and exclusions. [Execution](execution.md) defines leases, receipts and job uniqueness. [Assessment](assessment.md) defines input triggers, fixed snapshots and guarded publication. [Reference release](reference-release.md) defines immutable corpus activation. [Recovery](recovery.md) defines cancellation, purge, witnesses and the before-customer-data gate.

The [adopted schema](../schema/README.md) is the reviewed starting design. [Person references](person-references.json) are derived from it. [Package ownership](../plan/build-plan.md) assigns the producers. Architecture fixes rules and boundaries; function names, signatures, internal types and file layouts belong to builders. Reviewed migrations may revise the starting schema while preserving approved behavior.

These documents establish no database, auth, provider, model or recovery proof. Documentation/tooling checks resolve names and registries; runtime acceptance remains separate.

Run the identifier/inventory check with python3 docs/schema/check-architecture.py and the derived Person registry check with python3 docs/schema/check-person-references.py. Inline code in the contract chapters denotes physical table or column identifiers.
