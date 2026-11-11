# QA previews

`bin/qa` makes, lists and removes Nora's QA previews. The steps, logins and tear-down are in
`docs/runbooks/qa-preview.md`.

| File | What it holds |
|---|---|
| `main.ts` | The `bin/qa` commands |
| `qa.ts` | `up`, `list` and `down` |
| `store.ts` | The preview records: `<git common dir>/qa/previews.json`, one file for every worktree, not tracked |
| `qa-guard.ts` | The database rules every step obeys |
| `qa-seed.ts` | The test church, run from the previewed branch's own code |
| `tests/` | The tests. `.github/workflows/ci.yml` runs them in the `tools` job, with Docker |

