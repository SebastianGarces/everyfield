# CI tooling gate

The `tooling` job in `.github/workflows/ci.yml` starts with `node tools/ci/tooling-gate.ts`. On a pull request it lists
the paths changed since the merge base of the PR base and head, and runs each tool self-test only when its own paths
changed:

| Self-test | Runs on a PR when a changed path is under |
|---|---|
| INV-typecheck (`tools/ci/tests/typecheck*.test.ts`) | `tools/ci/typecheck*`, any `tsconfig*.json` or `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` |
| INV-formal (`tests/workflow/formal.test.ts`) | the "formal checks" rule in `tools/ci/select.ts`, or the test itself |
| QA preview tool (`tools/qa/tests`) | `tools/qa/`, `bin/qa`, `tools/prod-identity/`, `bin/prod-identity`, `packages/db/migrations/` |
| Wiki tool install, Chromium and tests | `tools/wiki/` |
| App verification tool and agent-browser | `tools/app/`, `bin/app` (the wiki install and Chromium run for it too) |
| Local stack tests (`pnpm test:workflow`) | `bin/`, `scripts/`, `tests/workflow/`, or when INV-formal runs |

A PR that changes `.github/workflows/`, `.github/actions/`, the gate script or a "shared input" path in
`tools/ci/select.ts` runs the full set, as does an empty or unreadable diff. The docs check, `ci-tests.ts`, feature maps,
`machines:check`, Evry eval coverage, the `.github/scripts` tests, the actionable watcher and the rest of
`tools/ci/tests` run on every PR.

A push to main, a merge queue run and the nightly schedule of `ci.yml` (06:47 UTC) run every step. The gate step's log
prints each run or skip and the path or rule that decided it.
