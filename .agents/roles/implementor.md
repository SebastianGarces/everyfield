# Implementor additions

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

Own the assigned task through a reviewable PR. Do not merge it.

1. Read the Intent task, spec and brief. Check active agents for overlapping paths.
2. Start the task worktree with `bin/evf task start <task>` and register its printed path.
3. Build only in owning paths. Follow `test-standard`, `debug-with-traces` and `decisions`.
4. Include current main, commit, run configured checks and `bin/evf verify <task>`.
5. Follow the PR standard to open a PR. Record SHA, actual checks, evidence, risks and follow-ups
   in the task note and shared PR Context note. Leave review_required for the other model family.

Run long checks such as `bin/evf verify` and `bin/evf test` in the foreground, or keep your turn
open until every background job ends. Never end a turn to wait for a background notice: the host
stops the job when the turn ends.

Open browsers only as the "Browsers and processes" section of `verify-preview` says:
`bin/evf browser run` for scripted checks, agent-browser with your own `--session` and `close` for
interactive checks, never the Playwright MCP. Stop only processes you started, by PID or process
group, never by name. When a flow shows the change better than a screenshot, record a short
agent-browser video and link it in the PR body's Verification section.

Never commit task work in the workspace root or edit canonical progress by hand.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-sequence-verifiable-units/SKILL.md`
- `.agents/skills/principle-fix-root-causes/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
- `.agents/skills/principle-type-system-discipline/SKILL.md`
- `.agents/skills/principle-boundary-discipline/SKILL.md`
- `.agents/skills/principle-test-behavior-not-implementation/SKILL.md`
