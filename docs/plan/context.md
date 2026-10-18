# Assigned package brief

Start with `python3 docs/package-context.py WP-019`. Its default JSON brief contains the goal, outputs, exact gates, proof stage, execution and ownership rules, owned requirement/case/operation IDs, direct prerequisites, design/chapter links and schema table names. Builders choose filenames and internal code structure inside those directories. Read the small shared orientation, security and audit contracts; `docs/build-agent-workflow.md` is for coordinators and is not a shared package read.

Full records are available on demand with `--part requirements`, `--part operations`, `--part cases` or `--part schema`. Use `--page 2` when a needed record falls on a later page. Pages contain at most ten full records and 196,608 UTF-8 bytes, report `selectedCount` and `totalPages`, and never truncate records. There is no mandatory full-packet read. Consumer tables are named in the brief and can be looked up directly in [the schema](../schema/target.json). Original SME passages and approved design sections are also read on demand.

The catalog is the owner of record: requirement and case `work_packages`, and operation `owning_package`/`evry_packages`. The manifest derives every `own_*` list from these fields; feature selectors only add consumed context. The [DAG](dag.json) stores each package's `context_scope`, including any explicit contract portions, operation selection, case selection and schema scope. WP-002 owns the bounded C0 shared scope/time/revision/replay/receipt/audit patterns and their contract fixtures. Feature domain behavior, database enforcement and later native/assistant portions belong to their producers. The final integration packages retain the full target index and use scripts to check it without requiring the whole catalog in one context window.

[context-manifest.json](context-manifest.json) retains every selected requirement, case, acceptance bundle, operation and shared contract. `own_requirement_ids`, `own_case_ids` and `own_operation_ids` distinguish the package's work from consumed contracts. A referenced internal or native-only operation remains excluded from model/HTTP exposure. Read and command adapters select their own queries and commands separately; details needed to prove a denial do not grant an adapter implementation ownership.

`case_ids` contains proof obligations whose owners are the package, its prerequisites or its downstream packages. Unrelated cases remain in `context_case_ids` for reading with `evf ac <case-id>` and are not task verification obligations. The plan checker rejects an unrelated selected proof case and any fast-track declaration outside WP-097.

`ui_depends_on` gates only a presentation task. Contract and API work use `depends_on`. UI briefs name the prototype and exact screen-map rows, including undrawn flows. WP-088/089/090 own foundations, controls and displays in separate directories. WP-091..096 split integration at core, knowledge and intelligence seams; WP-056/057 retain complete target gates with no deferrals.

A producer proves its applicable portions before dependents consume the reviewed interface milestone. Later native/assistant portions remain assigned to their downstream owners, and integration closes full package obligations. Short reading does not remove requirements or waive gates. No brief grants implementation, spending, remote publication or progress-update authority.

Regenerate and check the documentation projections after a reviewed catalog or scope change:

```sh
python3 docs/package-context.py --refresh-plan
python3 docs/package-context.py --refresh-manifest
python3 docs/package-context.py --check-plan
python3 docs/package-context.py --check-manifest
python3 docs/package-context.py --check-ownership
python3 docs/package-context.py --check-case-actions
python3 docs/package-context.py --brief-sizes --output /tmp/package-brief-sizes.json
```

`--check-plan` checks nonempty goals/outputs/gates/directories, the 65,536-byte default brief budget, retired IDs, ordered overlaps across all owning directories, catalog owner parity, query/command ownership, owned operations and assistant adapter producer ancestors, dependency-closed slices and generated estimates/critical path. `--brief-sizes` measures default JSON UTF-8 bytes only; linked files and on-demand pages are not included. Planning estimates use each package's owned scope counts and stored factors; whole-target gates use all selected cases. They are rough engineer-days, not a delivery date or measured agent throughput.

The [case-action ordering ledger](case-action-ordering-baseline.json) records open later-package pairs. S0 policy is fail; warning mode is rejected. Package closure rejects open entries. See [verify](../../.agents/skills/verify/SKILL.md) for the at-start repair rule.

Keep generated briefs, measurements, screenshots and proof outside the repository. These checks establish documentation/tooling consistency. Application acceptance needs real checks on the branch preview and development database, applicable browser layers and independent verification by another model family.
