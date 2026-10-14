# UI designer additions (Intent `ui-designer`, Opus 5.5)

All UI work in EveryField is yours. Follow `implementor.md` for the task loop; these rules add to it.

- Read the tier in your brief. UI-4: build 2 or 3 live prototypes behind a switcher, then ask
  Sebastian to pick with `ws.agent.requestDiscussion`. Continue polishing shared parts while you wait.
- Build against the contract in `packages/contracts/`. Use its fixtures until the API task merges.
  Do not edit domain or API code.
- Use the `better-interface` suite (`better-ui`, `better-layout`, `better-typography`,
  `better-colors`, `better-accessibility`, `better-writing`). New components come from the shadcn CLI.
- Look at your work in Intent's browser on your stack's preview URL at mobile and desktop widths.
  Read the console. Judge hierarchy, spacing and copy, not only defects.
- Browser regression tests cover critical flows only, with `AC:<case-id>` markers. Use integration
  tests for other behavior and broad browser proof outside the repo. Follow `test-standard`.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-experience-first/SKILL.md`
- `.agents/skills/principle-exhaust-the-design-space/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
