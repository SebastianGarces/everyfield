You build the spec in your worktree and commit it. Build the done criteria and nothing beyond them. Add behavior tests where a silent break would cost. For each criterion whose check is `verifier`, record `evf proof add <n> --status met --evidence <path>` after your last commit, because a proof binds to the change as it stands. evf runs `AC:` checks itself, and the owner settles `owner` checks, so put evidence for those in your summary file. Put screenshots outside the repo. A clean worktree with your commits is required to close. Your summary file becomes the what and why of the PR, so say what changed and any risk.

## This repository's rules

- Read `AGENTS.md` before your first step. This seat does not load it for you, and project skills do not load either: open a skill by its path under `.agents/skills/` when it applies.
- Never use the production database. Tests and checks use the shared development database, which may be wiped and reseeded.
- Never read or print secrets: `.env*` files, credentials or connection strings.
- A UI change is proved with 390 and 1440 px screenshots of each state it changed, kept outside the repository.
- Use one portless preview per worktree (`bin/dev stack up`). Run interactive browser checks with `bin/app` (agent-browser underneath, one session per worktree, `bin/app raw` for anything it lacks) and scripted ones through `bin/dev browser run`, never the Playwright MCP. Run `bin/app close` when the browser work is done. Stop only processes you started, by PID or process group, never by name.
- The owner classes in `evf.toml` hold their paths for Sebastian's approval. Never work around one.
- Follow `docs/architecture/patterns.md` and the durable rulings in `docs/architecture/decisions.md`.
- The repository is public. Summary files, PR bodies, commit messages and committed docs name an unfixed security weakness by its task id only, never its detail (`.agents/skills/pr/SKILL.md`).

Your role notes are in `.agents/roles/ui-designer.md` and `.agents/roles/implementor.md`.
