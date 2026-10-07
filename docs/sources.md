# Audited sources and reproducibility

Captured 2026-10-03. Primary paths were verified before writing. Requested `/Users/sebastian/dev/everyfield_v3` was absent; all work was staged independently for validation. No source checkout, environment file, database, memory or migration was modified.

| Baseline | Exact checkout/commit | Meaning |
|---|---|---|
| main | `/Users/sebastian/dev/everyfield_v2` at `18fc1a505c64615fe9ef197dba0e2cd037063d31` | current merged checkout; recorded unrelated dirty/untracked marketing/skills files |
| alpha | `/private/tmp/everyfield-alpha-implementation` at `2107df58885c883960422ce7e60719f0adbac0e4` | clean exact supplied PR913 head; implemented/unmerged enhancements |
| diagnostics | alpha object store branch `alpha/assessment-diagnostics`, `81abfcc7fb150fdfa5fa87392052dd07da966d03` | descendant of alpha head, four PI route/rejection/test files; accurate last-draft attribution |
| Evry | main object store pre-retirement and local `b3bb9f52af6e0c64b537f7ba1316b2edf0f373ae` | historical production versus fullest audited unmerged Eve/JeV capability work, separately classified |

Evidence: [source manifest](evidence/source-manifest.json), [surface inventory](evidence/surfaces.json), [schema declarations](evidence/schema-source.json), [direct dependencies](evidence/dependency-inventory.json). Source manifests record tracked-file SHA-256 values, checkout/branch/HEAD/status, recent logs and alpha/main differences. Environment-file contents and symlink targets are excluded. Dirty files are evidence, never silently reverted. The diagnostic commit is absent from the main clone but verified in the separate alpha object store.

## Reproduce the audit snapshot

Read-only commands for each verified checkout:

```sh
git -C /Users/sebastian/dev/everyfield_v2 rev-parse HEAD
git -C /Users/sebastian/dev/everyfield_v2 status --porcelain=v1
git -C /private/tmp/everyfield-alpha-implementation rev-parse HEAD
git -C /private/tmp/everyfield-alpha-implementation status --porcelain=v1
git -C /private/tmp/everyfield-alpha-implementation show --stat 81abfcc7
git -C /private/tmp/everyfield-alpha-implementation diff --name-status 18fc1a505c64615fe9ef197dba0e2cd037063d31 2107df58885c883960422ce7e60719f0adbac0e4
```

For each non-environment tracked regular file, compare SHA-256 bytes to `tracked_file_hashes`. A HEAD match alone is insufficient for dirty sources. Source refs use repository-relative paths and symbols; main/alpha/local context is named in the module records. A retired symbol in a local commit is resolved through `git show COMMIT:PATH`, not through current main.

## Scope classifications

`implemented-main` means code behavior is present on the merged baseline; `implemented-local-only` means implemented evidence is only on the audited unmerged branch; `partial` means a capability exists with a reachable or semantic gap; `dead` means implementation/historical models have no current runtime consumer; `uncertain` means authority/reachability/content needs explicit verification. Documentation/FRD intended behavior is never automatically promoted to implemented. Historical source is preserved for interpretation, not blanket v3 constraint.

Surface inventory is mechanical evidence including helper/component/test exports, not a claim that every export is an independent product feature. Acceptance records and module specs provide the semantic inventory. Schema source counts are 79 main,82 alpha and80 pinned local; their declaration union is84. The database map includes both local-only tables (`evry_eve_attachments`, `communication_failed_retries`) and four historically replaced meeting tables, totaling88. No live database catalog was queried.

## Read-only constraints followed

Repository AGENTS/memory and relevant .agents skills were read. Existing v2 architecture instructions inform its audit, not v3 design mandate. No installs, formatting sweep, build, runtime preview, remote fetch, migration, seed, deployment, memory edit or PR were performed. Application runtime tests remain future plan gates; documentation validation only checks the actual produced plan.
