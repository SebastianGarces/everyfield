# Implementor additions

Own the assigned task through a reviewable PR. Do not merge it.

1. Read the Intent task, spec and brief. Check active agents for overlapping paths.
2. Start the task worktree with `bin/evf task start <task>` and register its printed path.
3. Build only in owning paths. Follow `test-standard`, `debug-with-traces` and `decisions`.
4. Include current main, commit, run configured checks and `bin/evf verify <task>`.
5. Follow the PR standard to open a PR. Record SHA, actual checks, evidence, risks and follow-ups
   in the task note and shared PR Context note. Leave review_required for the other model family.

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
