# Build agents must maintain the explorer

This is a maintenance workflow for the local documentation explorer. It does not authorize implementation of the v3 application, database work, runtime changes, deployment, or external services. Implementation requires its own authorization.

`docs/plan/dag.json` defines package IDs, direct prerequisites, owning paths, outputs and acceptance gates. `docs/build-progress.json` is the versioned, evidence-backed status authority. `everyfield-build-explorer.html` embeds that state and the DAG so it remains one standalone file that works offline; the maintenance JSON and Python script are not runtime companion assets. The DAG's planning status does not prove implementation.

## Ownership and update frequency

Assign one owner to each work package and one integration owner for shared progress and the HTML. Package owners must submit an update when they claim/start work, encounter or resolve a blocker, produce a reviewed milestone or test result, and before they close the package or hand it off. Keep evidence current throughout the work, not just at the end. A reviewer must confirm the claims; the utility validates structure and gates, not the truth of evidence.

Parallel agents own only `docs/build-progress-updates/WP-NNN.json` for their assigned package. They must not rewrite the full canonical JSON or HTML. Use a temporary file and rename to publish a complete patch; coordinate explicitly if ownership changes. Keep implementation edits inside the DAG's owning paths unless the integration or contract owner authorizes shared changes.

## Canonical state and evidence

The initial canonical document uses `schema_version: 1`, `project_id: "everyfield-v3"`, global `revision: 0`, `updated_at: "2026-10-03"`, and one record for every DAG package. Each record begins with `status: "not_started"`, `evidence: []`, `notes: ""`, `owner: null`, `revision: 0`, `updated_at: null`. Allowed statuses are `not_started`, `in_progress`, `blocked`, and `done`.

Every evidence record has exactly five string fields: `path`, `commit`, `test`, `result`, `note`. Leave an unused reference field empty. `path` is a repository-relative reference, `commit` identifies the reviewed change, `test` names the acceptance check or test command, and `result` is `passed`, `failed`, `not_run`, or `in_progress`. `note` explains what the evidence establishes, including a blocker or human acceptance when relevant. Use actual outputs and recorded results. File presence, generated stubs, estimates, a local checkbox, and an agent's unsupported assertion are not completion evidence. The utility never reads an evidence path or infers status from a file's existence.

Every status other than `not_started` requires a path/commit/test reference plus an explanatory note (at least 12 characters and two words) or a named test with an actual result (`passed`, `failed`, `in_progress`). `done` additionally requires at least one record that links a substantive output path or commit to a named passed acceptance test and an explanatory note. All direct prerequisites must be canonically `done`, and the package's acceptance gates, output review and integration rule must be satisfied. For document or decision packages, a named recorded review/approval gate can be the test; cite its evidence. `not_run` never supports completion.

Canonical evidence outranks browser-local planning changes. Browser overrides are visibly local and can be stale when their `base_revision` differs from the canonical package revision. They never silently become source-controlled completion. To promote a local idea, the owner must independently verify its evidence and submit a normal package patch for review. Refreshing the source HTML clears `embedded-local-state` to `{}`; it does not read or erase a browser's local storage.

## Package patch

Read the current package revision immediately before preparing the patch. A patch replaces that package's status, evidence and notes; include all evidence that should remain, rather than relying on an append. Use the exact fields below in `docs/build-progress-updates/WP-001.json`:

```json
{
  "schema_version": 1,
  "package_id": "WP-001",
  "base_revision": 0,
  "status": "in_progress",
  "evidence": [
    {
      "path": "docs/reference/manifest.json",
      "commit": "",
      "test": "current reference manifest review",
      "result": "in_progress",
      "note": "Review is underway; exact current reference checksums are being verified."
    }
  ],
  "notes": "Awaiting the named reference verification; no completion claim.",
  "updated_by": "WP-001 owner",
  "updated_at": "2026-10-03T12:00:00Z"
}
```

This is an illustrative shape, not a real claim: replace the path, owner, timestamp and evidence with verified facts before submission. Use an ISO date or a timezone-aware ISO timestamp supplied by the owner; the utility does not invent timestamps. A package timestamp may not move backward. A stale `base_revision` is a conflict: reread canonical evidence, reconcile with its owner, and submit the reviewed replacement at the current revision. Never fix a conflict by editing the revision number without rechecking the full replacement.

Applied patches are preserved. After integration, the canonical document adds optional `applied_patches`, a SHA-256 map with `{ "package_id": "WP-001", "package_revision": 1 }` records. Exact-byte replays are skipped even after later package changes; edited patches must use the current package revision. One successful batch increments the global revision once and each changed package revision once. Its global timestamp is the latest supplied package/current timestamp, with a deterministic tie break. Package `owner` becomes `updated_by`.

## Ready gates and completion checklist

Before starting implementation, confirm that the package is authorized, its direct prerequisites are canonically `done`, its owning paths and contracts are available, and its required decisions/providers are resolved. If a prerequisite or decision prevents work, record `blocked` with a referenced explanation. A documentation investigation can be recorded as `in_progress` without claiming an implementation ready gate.

Before closing each package, its owner must:

- Review the DAG's outputs, acceptance gates and integration rule; confirm all direct prerequisites are canonically `done`.
- Link the actual output and reviewed commit, and record each required named test/review result with a meaningful explanation. Explain any failures or skipped checks; do not claim `done` while a required gate remains unmet.
- Submit the owned package patch at the current package revision and have the integration owner review the evidence, shared contracts and conflict resolution.
- Have the integration owner apply the patch, refresh the embedded view, and run the canonical/HTML check below.
- Open the single HTML file offline, confirm that the package, evidence, prerequisite readiness and canonical/local labels show the integrated result, and record that check in the package evidence before final closure. If that evidence is added after the first integration, submit and integrate a second patch at the new revision. Keep the package open until the final patch and check pass.
- Include the canonical progress, retained patch, refreshed HTML and relevant evidence in the reviewed commit. Include the implementation commit in evidence; do not create a circular claim requiring the same commit hash to be embedded in itself.

## Integration owner's commands

Run from the project root using Python 3.9 or newer on macOS/Linux (the lock uses `fcntl`). `--root` also allows reviewers to run these commands against a disposable fixture with the same relative paths.

```sh
python3 docs/update-build-explorer.py --root . --check
python3 docs/update-build-explorer.py --root . --apply
python3 docs/update-build-explorer.py --root . --check
```

`--check` verifies canonical structure, evidence and prerequisite gates, exact DAG/HTML package IDs and prerequisites, equality of embedded and canonical progress, empty source local state, and every pending patch against the proposed complete batch. It applies no progress changes. All modes acquire an exclusive nonblocking lock at `docs/.build-progress.lock`; the persistent lock file is administrative and contains no progress data. A busy lock fails rather than waiting. Do not commit the lock file.

`--apply` reads all package patches in sorted filename order, validates every patch before staging output, checks per-package revisions, and verifies completion prerequisites against the entire proposed batch. It then atomically replaces each changed output file, canonical first and HTML second; patches remain untouched. A rejected patch prevents the whole batch from changing progress or HTML. Reviewers should not merge conflicting or unsupported evidence just because validation passes.

If interrupted between the two atomic replacements, canonical JSON remains authoritative. Repair the view, then check it:

```sh
python3 docs/update-build-explorer.py --root . --refresh-html
python3 docs/update-build-explorer.py --root . --check
```

`--refresh-html` applies no package patches. It reads only canonical progress and updates the contents of the `canonical-progress` and `embedded-local-state` JSON scripts. It preserves all inline CSS, JavaScript and graph data byte for byte. These commands access only the expected paths inside `--root`, reject symlinks on those paths, do not fetch anything, and never access evidence references. They cannot provide a multi-file crash transaction; the equality check and refresh command provide explicit recovery.

## Shared-file discipline

The integration owner alone maintains `docs/build-progress.json` and the shared HTML. Agents must not compete with full-file rewrites, merge browser-only scenarios into canonical progress, alter unrelated review/source documents, or overwrite unrelated `AGENTS.md` instructions. If new scoped instructions are needed, add them while preserving existing repository instructions. Any DAG or visual explorer change needs its own review; this utility deliberately updates only embedded progress and the empty source local state.

## Explorer design source

The offline UI source is `docs/explorer-ui.template.html`. The integration owner can apply an authorized UI edit with `python3 docs/render-build-explorer.py --root . --apply`, then run `python3 docs/update-build-explorer.py --root . --refresh-html` and `--check`. Verify the design with `python3 docs/render-build-explorer.py --root . --check`. The design renderer uses the existing HTML’s embedded source snapshot and local-state payload plus current canonical progress; it never reloads old workspace inventories, changes the source fingerprint, infers completion or drops saved embedded changes. Browser storage keys and the progress import/export schema stay stable across UI-only renders.

The progress updater continues to preserve all design and graph bytes outside its two progress JSON scripts. Organizational tree branches are navigation groups; they are not build dependencies, database references or new architecture decisions. Keep actual relationships available in the selected record’s details. Design-template changes require their own review; only the integration owner replaces the shared HTML.

Ayu light/dark preference uses the separate `everyfield-build-explorer:theme:v1` browser key (`dark` or `light`), never the progress override schema. The source file defaults to dark; portable HTML carries the selected `data-theme`, which the design renderer preserves. Keep document/body scrolling disabled; the canvas, selected-item panel and opened disclosures provide contained scrolling.
