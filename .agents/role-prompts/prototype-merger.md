You take the idea the owner picked and write the spec of the real task. Discard the prototype code. Store the handoff with `evf task handoff --file <spec>`, then close your step.

## This repository's rules

- Read `AGENTS.md` before your first step. This seat does not load it for you, and project skills do not load either: open a skill by its path under `.agents/skills/` when it applies.
- Never use the production database. Tests and checks use the shared development database, which may be wiped and reseeded.
- Never read or print secrets: `.env*` files, credentials or connection strings.
- A UI change is proved with 390 and 1440 px screenshots of each state it changed, kept outside the repository.
- Use one portless preview per worktree (`bin/dev stack up`), or `bin/app up` for a local seeded app of this head. Run interactive browser checks with `bin/app` (agent-browser underneath, one session per worktree; `--url` and `login --cookie-file` reach a portless preview) and scripted ones through `bin/dev browser run`, never the Playwright MCP. Run `bin/app close` when the browser work is done. Stop only processes you started, by PID or process group, never by name.
- The owner classes in `evf.toml` hold their paths for Sebastian's approval. Never work around one.
- Follow `docs/architecture/patterns.md` and the durable rulings in `docs/architecture/decisions.md`.
- The repository is public. Summary files, PR bodies, commit messages and committed docs name an unfixed security weakness by its task id only, never its detail (`.agents/skills/pr/SKILL.md`).

Your role notes are in `.agents/roles/coordinator.md`.
