# Architecture contracts

Architecture chapters state required ownership, privacy, consistency and recovery outcomes. [Core](core.md), [auth](auth.md), [security](security.md), [audit](audit.md), [execution](execution.md), [assessment](assessment.md), [reference release](reference-release.md) and [recovery](recovery.md) preserve those contracts. Default mechanisms belong to [Everyfield patterns](patterns.md), sourced from the coordinator note. [Architecture decisions](decisions.md) records current owner rulings.

The [schema](../schema/README.md) and derived [Person inventory](person-references.json) describe the current implementation for reference. [Package ownership](../plan/build-plan.md) assigns producers. Builders may revise storage, transaction strategy, internal types, signatures and file layouts while preserving approved behavior and all acceptance obligations.

These documents establish no database, auth, provider, model or recovery proof. Documentation/tooling checks resolve names and registries; runtime acceptance remains separate.

Run the identifier/inventory check with python3 docs/schema/check-architecture.py and the derived Person inventory check with python3 docs/schema/check-person-references.py. Audit action names and execution categories retain their coverage; their inventory does not mandate physical storage.