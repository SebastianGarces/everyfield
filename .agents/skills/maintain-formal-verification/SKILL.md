---
name: maintain-formal-verification
description: "Apply when a diff touches a path named in any .agents/skills/formal-*/map.json, or a formal/ model: update the model and map, rerun bin/dev formal and the conformance test, and file a task for a real weakness by its id only."
---

# Maintain formal verification

A formal model is worth what its tie to the code is worth. When code it models changes, the model changes in the
same branch, or the check proves something about code that no longer exists.

## When it applies

Your diff touches a file named in a map, or a model under `formal/`. List the mapped files:

```sh
node -e 'for (const f of require("fs").globSync(".agents/skills/formal-*/map.json")) { const m = JSON.parse(require("fs").readFileSync(f)); for (const e of [...m.actions, ...(m.rules ?? []), ...m.properties]) for (const c of e.code) console.log(c.file, c.function, "<-", e.name, f) }' | sort -u
```

Today that is the permissions model (`.agents/skills/formal-permissions/`): `packages/domain/src/access/session.ts`,
`packages/domain/src/identity/{seats,invitations,invitation-core,service}.ts`, the invitation contracts and the seat
indexes and session functions in `packages/db/migrations/`.

`bin/dev fast-check` (and so the pre-push hook) enforces this: its `formal` step fails a branch that changes, deletes or
renames a mapped file without changing that map or the model folder its `"model"` names, and lists the files. When you
followed the steps below and the behavior did not change, so neither the model nor the map needs an edit, add the
trailer `Formal-model: unchanged` to a branch commit's message; the step then passes and names that commit.

## Steps

1. **Decide whether the behavior changed.** Read the map entries for each function you touched and the model
   operators they point to. A refactor that keeps every allow and refuse the same changes only the map. A change to
   who may do what, when a check runs, or which state a step reads changes the model.
2. **Update the model** in `formal/<subsystem>/`: the action's guard or effect, or the rule operator the action and the
   outcome table share. A new operation is a new action in `Next` and new outcome rows. A new requirement or ruling may
   add a property; give it a letter in the subsystem skill.
3. **Update the map** (`.agents/skills/formal-<subsystem>/map.json`) for every moved, renamed, added or removed
   function, action, rule or property, with its requirement or decision ids.
4. **Rerun the formal check:** `bin/dev formal`. It must pass every property, report the outcome table current and
   pass the map check. When you changed the model on purpose, run `bin/dev formal --write` and read the
   `outcomes.json` diff: each changed row is a permission that changed, and it must be the one you meant.
5. **Rerun the conformance test** on a throwaway Postgres (see `.agents/skills/verify/SKILL.md`), for permissions:
   from `packages/domain`, `npx tsx --conditions=react-server --test ../../tests/integration/access/formal-permissions.test.mts`.
   A row that fails means the code and the model disagree: fix whichever is wrong for this task.
6. **Keep the demonstrations working.** If you moved a guard that a mutation in `tests/workflow/formal.test.ts`
   edits, update that edit and the subsystem skill's demonstration together; never delete one to make the test pass.
   Run `node --test tests/workflow/formal.test.ts`.
7. Say in your summary which model actions, rules or properties changed and why, and name the outcome rows that changed.

## A real weakness

When TLC finds a counterexample, or the conformance test a disagreement, that shows the **code** breaks a property
(not a model mistake), and fixing it is outside your task:

1. File it with `evf task new`, with the counterexample, the property, the affected operation and how to reproduce it.
   The evf store is private; that is where the detail lives.
2. Keep your branch green without hiding it: leave the property and the code as they are, and tell the owner with
   `evf ask owner` if the check cannot pass without a fix.
3. In anything committed or published (code comments, the model, the skill, commit messages, the summary, PR body),
   name it by task id only, for example "a weakness tracked in T-NNN". Never the route, field, input, role pair or
   steps that trigger it. The repository is public (`AGENTS.md`, `.agents/skills/pr/SKILL.md`).
