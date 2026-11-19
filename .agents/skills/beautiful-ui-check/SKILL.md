---
name: beautiful-ui-check
description: Use before building or changing any UI component. Checks https://beautifului.dev for an existing crafted component that fits (thinking traces, streaming text, approval cards, tool chips, task rows, chat, prompt bar, context cards, diff/records/filter tables, command search, insight cards, code block, selection actions), says how to install it, and adapts it to Everyfield's tokens, packages/ui primitives and lint rules instead of hand-rolling one.
---

# Beautiful UI check

Run this before you build a new component or rework an existing one. The aim is to start from a crafted
component when one fits, not to add a dependency.

## 1. Look for a fit

Open https://beautifului.dev. The homepage shows each component live, numbered 01 to 21. The registry index at
https://beautifului.dev/r/registry.json lists the same set by registry name:

| Need | Registry name |
|---|---|
| Loading, thinking traces | `loading-state`, `thinking-state` |
| Streaming text | `streaming-text` (uses `stream-text`, `shimmer`) |
| Approve or reject an action | `approval-card` |
| Tool calls, task progress | `tool-chips`, `task-rows` |
| Chat thread and composer, prompt bar | `chat-composer`, `prompt-bar` |
| Context, recommendation, insight cards | `context-cards`, `recommendation-card`, `insight-cards` |
| Diff, records and filter tables | `diff-table`, `records-table`, `filter-table` |
| Command search | `search` |
| Code block | `code-block` |
| Selection actions | `selection-actions` |
| Also listed | `sidebar-nav`, `flowchart`, `fine-tune-card` |

The homepage's Agent Screen is a demo with no registry item.

Check `packages/ui/src/{controls,display,foundations,shell}` too. When Everyfield already has the primitive (for
example `InsightCard`, `CommandPalette`, `DataTable`, `Toast`), improve that one and use the beautifului.dev
component only as a reference. Never ship two versions of the same thing.

Write down what you found, including "nothing fits", in your summary.

## 2. Say how it installs

beautifului.dev is a shadcn registry. Its items follow `https://ui.shadcn.com/schema/registry-item.json` at
`https://www.beautifului.dev/r/<name>.json`, so the published route is:

```
npx shadcn@latest add https://www.beautifului.dev/r/<name>.json
```

The site publishes no npm package. Each item pulls in `foundation` (a Tailwind v4 `foundation.css` with its own
color and shadow tokens, plus the `shadow-plugin` import), and usually `button` (needs `class-variance-authority`) and
other support items through `registryDependencies`. Files land at `components/primitives/*.tsx`,
`components/atoms/*.tsx` and `app/beautifui/foundation.css`, and they import `cn` from `@/lib/utils`.

This repo has no `components.json`, and those paths and tokens are not ours. So take the copy route: fetch the item
JSON (`curl -sL https://www.beautifului.dev/r/<name>.json`), read `files[].content` and each `registryDependencies`
item, and port the code by hand. Name the item and URL you ported in your summary. The site is MIT licensed
(https://beautifului.dev/license): keep that credit in your summary or commit message, not in a code comment.
Check the registry again when you use it, because its items change.

## 3. Adapt it to Everyfield

Port, don't paste. The result must read like the rest of `packages/ui`:

- Tokens: drop `foundation.css` and its `--ink`, `--surface`, `--line`, `--accent` style variables. Map them to
  Everyfield's tokens in `packages/ui/src/foundations/product.css` and the Tailwind theme. Dark mode is
  `data-theme="dark"`, not a `.dark` class.
- Primitives: use our `Button`, `Menu`, `Popover`, `Dialog`, `Icon` and `cn` from `packages/ui`, not the
  item's atoms. Overlays use the Radix-based controls already there.
- Placement: shared primitives go in `packages/ui/src/<group>/` and its `index.ts`; feature-only UI goes in
  `apps/web/src/features/<feature>/` and imports other features only through their public files
  (`everyfield/feature-boundaries`).
- Lint rules (`scripts/lint/everyfield-plugin.mjs`) that upstream code often breaks:
  - no comments;
  - no `useEffect` or `useLayoutEffect`: derive during render, use event handlers, refs or the existing
    `foundations` helpers (`observe`, `reveal`, `focus`);
  - at most four state hooks per component or hook;
  - no timers (`setTimeout`, `setInterval`, `requestAnimationFrame`): use CSS animation or `motion`;
  - no global `window`/`document` listeners and no `dangerouslySetInnerHTML`;
  - no `cursor-*` utilities: `controls.css` sets the cursor from semantics;
  - click handlers only on real controls (`everyfield/clickable-host`).
- Then apply `better-interface` and the other better-* skills, and prove it with 390 and 1440 px screenshots.

## 4. When nothing fits

Fall back to the route in `.agents/roles/ui-designer.md`: new components come from the shadcn CLI, adapted the same
way as step 3. Say in your summary which beautifului.dev items you checked and why none fit.

## 5. Library choices

When a component needs a library (toasts, drawers, command menus, charts, drag and drop, virtualization, motion,
state), read `.agents/skills/pick-ui-library/SKILL.md` and follow its pick. It sets `disable-model-invocation`, so
open it by path. As it says, check `package.json` first: `packages/ui` already ships `radix-ui`, `cmdk`, `motion`
and `class-variance-authority`. Prefer what is installed, and say so when the list recommends something else. A
new dependency is its own decision, so record it with the `decisions` skill.
