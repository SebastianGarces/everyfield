# Independent explorer review

Status: passed on the installed primary file `/Users/sebastian/dev/everyfield_v3/everyfield-build-explorer.html`.

The reviewed file is 5,989,961 bytes, with SHA-256 `fd9f9066183994689d7f6e82dafffd50e751e5270e9b1dcd134fcd3723a0e808`. Its workspace copy has identical bytes. The reviewer made no v3 file changes, ran no v3 application tests, and used no server, upload, or external service.

## Results

- **77 / 77 offline browser checks passed** in isolated Chrome contexts against the exact primary path: 44 core checks and 33 extended checks.
- **9 / 9 final focused checks passed** after the two final UI clarifications: historical Evry alias labels/native links and clear group subtitle/progress-bar spacing. A fresh primary-file reload and schema screenshot confirm the latest bytes; data and progress are unchanged.
- **496 / 496 feature inspectors rendered** without mixed string/array source-field errors.
- **17 / 17 independent updater checks passed** against disposable workspace fixtures with the complete 86-package DAG.
- **Read-only primary validation passed:** canonical JSON and embedded progress are equal; source embedded local overrides are empty; canonical revision is 0 and all 86 packages are Not started.
- **No browser console/page errors or outbound runtime requests.** Only local `file://` requests occurred. Wide and narrow screenshots were visually reviewed.

Expanded views account for all 86 work packages, 272 dependencies, 88 tables, 209 physical source relations, and 496 feature records. All 209 physical relation identities, including parallel and self references, remain represented. Source schema also retains 17 qualified application relationships and four historical transitions. The 720 acceptance obligations remain future proof, rather than executed v3 tests.

The broad browser suites ran against the prior candidate with identical data and behavior; the last focused checks cover the final wording/spacing changes.

Core browser checks cover search and cross-view navigation; keyboard group expansion, node inspection, pan and zoom; pointer pan and Fit; all six package/table upstream/downstream/one-hop comparisons against directed source closures; relationship, evidence and attribute layers; truthful filtered progress denominators; table types/keys/incoming/outgoing references and feature rationale; feature source/acceptance/package/table panels; manual notes with literal script/HTML characters; reload autosave; evidence and prerequisite completion gates; malformed imports; merge/replace/reset confirmations and cancellation; and portable HTML reopened in a fresh offline context.

Extended checks cover unavailable storage and portable recovery; preservation of corrupt stored raw data on startup and view changes; whitespace/duplicate-key/type/timestamp import rejection; canonical precedence over a stale browser override; explicit reviewed rebase without promotion into canonical state; the complete decisions modal; and representative COM-011, PPL-013 and EVR-267 target/acceptance panels.

## Product authority and source preservation

Exactly five decisions are recorded as user-accepted product rulings: OD-003, AR-01, OD-004, OD-018 and OD-017. The other twenty decision/review items remain unresolved. The UI preserves reviewed Evry writes, excludes private weekly check-ins from Evry/model context while retaining native planter history, preserves advanced person stages, uses prior attended Vision meetings for first-time Vision attendance, and separates typed follow-up outcomes from task completion so only confirmed contact refreshes actual-contact freshness. These decisions do not mark implementation complete or declare the whole plan ready to build.

The initial 56-file snapshot was documentation only. The subsequent accepted rulings authorized 13 existing target-document updates and three added ruling files. Historical capability source fields are unchanged, including source implementation labels, operations, routes, tests, tables, permissions, states, failures and behavior. Raw audit files, schema evidence, DAG and source manifest are unchanged. The final source-change evidence lists the exact authorized documents; the existing Astra review was preserved.

## Findings resolved

The review identified and verified fixes for import-confirmation candidate lifetime, strict import shapes and types, duplicate/non-JSON whitespace parsing, blank evidence, preservation of corrupt storage, distinct physical-edge rendering, the evidence-layer toggle, directional focus seeds, mixed source-field types, and retained inspector scroll position. No remaining functional review blockers were found.

## Maintenance limits

The integration owner reviews actual evidence claims; the utility validates structure, revisions and prerequisite gates. Each output file is replaced atomically, but canonical JSON and HTML are not a multi-file crash transaction. Canonical progress publishes first; the documented `--refresh-html` and `--check` commands repair/detect an interruption between replacements. This is a static/manual snapshot, with no live filesystem or build monitoring.

## Evidence

- `explorer-review.json`
- `explorer-review-browser-results.json` and `explorer-review-browser-extra-results.json`
- `explorer-review-workflow-results.json`
- `explorer-review-primary-validation.json`
- `explorer-review-alias-final-results.json` and `explorer-review-evry-private-alias.png`
- `explorer-review-final-source-changes.json`
- `explorer-review-overview.png`, `explorer-review-schema.png`, `explorer-review-features.png`, `explorer-review-narrow.png`
- Reproducible harnesses: `explorer-review-browser.cjs`, `explorer-review-browser-extra.cjs`, `explorer-review-workflow.py`

The browser harnesses accept `EXPLORER_HTML`; all screenshots, downloads, fixtures and review artifacts remain in the workspace.

## Delivered evidence

The complete machine results and current source-integrity checks are consolidated in [build-explorer-evidence.json](../evidence/build-explorer-evidence.json). Browser harnesses, screenshots and disposable fixtures remain in `/Users/sebastian/Documents/Codex/2026-10-02/task`; they are supporting QA artifacts, not runtime companions. The independent reviewer used Sol6.1 with xhigh effort, as requested.
