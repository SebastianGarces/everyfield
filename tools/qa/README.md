# QA previews

`bin/qa` makes, lists and removes Nora's QA previews. The steps, logins and tear-down are in
`docs/runbooks/qa-preview.md`.

| File | What it holds |
|---|---|
| `main.ts` | The `bin/qa` commands |
| `qa.ts` | `up`, `list`, `down` and `carry-over` |
| `store.ts` | The preview records: `<git common dir>/qa/previews.json`, one file for every worktree, not tracked |
| `qa-guard.ts` | The database rules every step obeys |
| `qa-seed.ts` | The test church, run from the previewed branch's own code |
| `tests/` | The tests. `.github/workflows/ci.yml` runs them in the `tools` job, with Docker |

`bin/qa carry-over` copies the previews recorded in the v1 work store into the preview file. It reads that store and
stops nothing. A second run adds only ids it has not seen, so it never brings back a preview that `qa down` removed.
