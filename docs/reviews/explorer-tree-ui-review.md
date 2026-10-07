# Offline tree explorer review

The [primary explorer](../../everyfield-build-explorer.html) now organizes all three views as top-down trees. A parent sits above its children; expanded sibling branches receive separate horizontal intervals. Select a branch to read its explanation, use **Focus this branch** to follow it, and use **Back** or breadcrumbs to restore context. Wide expanded trees use contained scrolling. Progress and maintenance controls are quieter, while source evidence, decisions, import/export and upkeep remain available through disclosure.

Tree lines mean organizational containment. They do not imply build prerequisites, foreign keys, feature causality or new module boundaries. Actual work-package connections and table references appear in the selected record's details. The schema panel begins with the table's purpose, selectable attributes and a plain explanation; exact types, constraints and provenance remain available below.

The review passed **95 offline browser checks and 15 disposable maintenance fixtures**, with zero runtime errors or outbound requests. It rendered every one of the **670 leaf panels** (86 packages, 496 capability records and 88 tables) and selected all **882 recorded attributes**. Fully expanded trees had no overlapping cards. Native keyboard navigation, repeated expand/collapse, multiple expanded siblings, focus/back, dismiss, cross-view search, narrow layouts, pointer/keyboard panning, zoom and minimum expand-button targets were checked.

The original fingerprint and browser storage key remain unchanged. Existing local status, notes and multiple evidence entries survive reloads and editing. The review exercised legacy JSON merge/replace, cancellation, malformed-import rejection, prerequisite-gated Done, stale canonical revisions, explicit rebase, reset cancellation and portable HTML recovery when storage is unavailable. Canonical progress remains revision 0 with all 86 packages **Not started**. The 720 future acceptance obligations remain planning records; this UI review does not claim those v3 tests have run.

The [design template](../explorer-ui.template.html), [design renderer](../render-build-explorer.py) and [updated workflow](../build-agent-workflow.md) keep future progress updates on the current layout. The renderer preserves the embedded source snapshot and local payload, reads current canonical progress, uses the shared nonblocking maintenance lock and writes the standalone file atomically. The existing updater preserves CSS, JavaScript and source data outside its two progress scripts. Fixtures proved refresh compatibility, nonzero canonical-progress preservation, portable evidence retention, interrupted-source refresh, lock rejection, invalid-template rejection and symlink rejection.

All three embedded source/progress/local JSON values match the pre-redesign baseline. The 272 package dependencies, 209 physical table relations, five accepted product rulings and 20 unresolved register/review entries are retained. The 3,960 main/alpha source hashes and all five Astra reports remain unchanged. Changes to existing project documentation are confined to the explorer, its workflow and scoped README links. No rebuild decision or methodology ruling was added, and no application, database, deployment or external upload work occurred. Earlier review files remain historical evidence.

The actual before and after captures were opened for visual inspection. Local screenshots:

- [Before: expanded grid](explorer-screenshots/tree-before-expanded.png)
- [After: overview](explorer-screenshots/tree-overview.png)
- [Focused branch](explorer-screenshots/tree-focused-branch.png)
- [Expanded sibling branches](explorer-screenshots/tree-sibling-branches.png)
- [Schema and attributes](explorer-screenshots/tree-schema-attributes.png)
- [Module explanation](explorer-screenshots/tree-modules.png)
- [Narrow layout](explorer-screenshots/tree-narrow.png)

[Machine evidence](../evidence/explorer-tree-ui-review.json) includes each check, geometry totals, source integrity and screenshot hashes. The existing [agent instructions](../../AGENTS.md) and progress maintenance requirements still apply. There are no remaining UI blockers.
