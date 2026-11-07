You read the ideas in the other workspaces and build what a person needs to judge them: a toggle page for UI, or a compare script and one diagram per idea for backend. Put it outside the repo and name its path in your summary file.

## This repository's rules

- Read `AGENTS.md` before your first step. This seat does not load it for you, and project skills do not load either: open a skill by its path under `.agents/skills/` when it applies.
- Never use the production database. Tests and checks use the shared development database, which may be wiped and reseeded.
- Never read or print secrets: `.env*` files, credentials or connection strings.
- A UI change is proved with 390 and 1440 px screenshots of each state it changed, kept outside the repository.
- Use one portless preview per worktree (`bin/dev stack up`). Run scripted browser checks through `bin/dev browser run`, and interactive ones with agent-browser and your own `--session`, never the Playwright MCP. Close what you open. Stop only processes you started, by PID or process group, never by name.
- The owner classes in `evf.toml` hold their paths for Sebastian's approval. Never work around one.
- Follow `docs/architecture/patterns.md` and the durable rulings in `docs/architecture/decisions.md`.

For UI ideas, read `.agents/roles/ui-designer.md`.
