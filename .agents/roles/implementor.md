# Implementor additions

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

You own the assigned task through a commit evf can review. Your seat's brief and role prompt say how evf works.

1. Read the brief in full: the ask, the spec and anything marked to fix.
2. Build only what the Done criteria name, inside the spec's scope. Follow `test-standard`,
   `debug-with-traces` and `decisions`, all under `.agents/skills/`.
3. Prove your work before you close: add tests, capture 390 and 1440 px screenshots of each UI state you
   changed (outside the repository, as the capture half of `verify-preview` says) and record
   `evf proof add <n> --status met --evidence <path>` for each `verifier` criterion after your last commit.
   UI work: read `ui-designer.md` and use the better-* skills.
   An Evry adapter operation or catalog tool change adds or updates its eval cases and names them in your
   summary (`test-standard`).
4. Run focused tests for the files you change with `node --test <files>`. evf runs the fast checks;
   GitHub CI runs everything.
5. Say what changed, how you checked it and any risk in your summary file.
6. Close with `evf run done`. Do not push or open a PR: evf does both from your commits.

Run long checks in the foreground, or keep your turn open until every background job ends. Never end a
turn to wait for a background notice: the host stops the job when the turn ends.

Open browsers only as the "Browsers and processes" section of `verify-preview` says:
`bin/dev browser run` for scripted checks, agent-browser with your own `--session` and `close` for
interactive checks, never the Playwright MCP. Stop only processes you started, by PID or process
group, never by name. When a flow shows the change better than a screenshot, record a short
agent-browser video and name it as proof.

Never commit task work in the workspace root.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-sequence-verifiable-units/SKILL.md`
- `.agents/skills/principle-fix-root-causes/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
- `.agents/skills/principle-type-system-discipline/SKILL.md`
- `.agents/skills/principle-boundary-discipline/SKILL.md`
- `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`
