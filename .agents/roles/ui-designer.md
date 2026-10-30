# UI designer additions (`ui-designer` seat, Sonnet 5.5 medium)

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

UI work runs in the implementer seat by default. The implementer reads this file for UI work. This seat runs
only when the stored spec has the line `Seat: ui`, for design-heavy tasks. Follow `implementor.md` for the
task loop; these rules add to it, including the proof the implementor records.
Push through `bin/evf pr open` (implementor step 7).

- Read the tier in your brief. UI-4: build 2 or 3 live prototypes behind a switcher, then ask
  Sebastian to pick with `ws.agent.requestDiscussion`. Continue polishing shared parts while you wait.
- Build against the contract in `packages/contracts/` and the merged api part of your package.
  Do not edit domain or API code.
- Use the `better-interface` suite (`better-ui`, `better-layout`, `better-typography`,
  `better-colors`, `better-accessibility`, `better-writing`). New components come from the shadcn CLI.
- Use the upstream `vercel-react-best-practices` skill for React and Next.js components, pages,
  data fetching, bundle size and performance work.
- Look at your work on its portless preview at mobile and desktop widths with agent-browser.
  Read the console. Judge hierarchy, spacing and copy. The verifier checks Chromium and WebKit.
- Browser regression tests cover critical flows only, with `AC:<case-id>` markers. Use integration
  tests for other behavior and broad browser proof outside the repo. Follow `test-standard`.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-experience-first/SKILL.md`
- `.agents/skills/principle-exhaust-the-design-space/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
