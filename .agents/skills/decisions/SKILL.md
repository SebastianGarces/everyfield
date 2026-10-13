---
name: decisions
description: "Apply when a task has an ambiguity that changes what gets built. Rule it yourself when it is reversible, record the ruling where the next agent will find it, and keep going. Escalate only irreversible or product-direction questions."
---

# Decisions

Do not stop for questions you can answer. A wrong reversible ruling costs one fix; a stalled
task costs a day (`principle-never-block-on-the-human`).

- **Code ruling** (naming, structure, a choice inside your owning paths): decide, and list it in
  the PR body under "Rulings and shared changes".
- **Product ruling** (behavior the user sees, methodology, privacy): check
  `docs/decisions/user-rulings.md` and the module spec first. If nothing covers it, choose the
  option that preserves existing capability and is easiest to reverse. Add an entry to
  `docs/decisions/user-rulings.json` and `user-rulings.md` with `status: "Proposed"`, the work
  package IDs in `work_packages`, and your reasoning. Future task briefs for those packages
  include it automatically. Sebastian accepts or changes proposed rulings later.
- **Escalate** with `ws.agent.requestDiscussion` only for irreversible choices (data deletion,
  external commitments), a conflict with an accepted ruling, or UI-4 prototype selection.
  Continue with other work while you wait.
