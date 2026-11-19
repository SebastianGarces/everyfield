---
name: beautiful-ui-check
description: Use before building or changing any UI component. Checks https://beautifului.dev for an existing crafted component that fits (thinking traces, streaming text, approval cards, tool chips, task rows, chat, prompt bar, context cards, diff/records/filter tables, command search, insight cards, code block, selection actions), says how to install it, and adapts it to Everyfield's tokens, packages/ui primitives and lint rules instead of hand-rolling one.
---

# Beautiful UI check

Run this before you build a new component or rework an existing one. The aim is to start from a crafted
component when one fits, not to add a dependency.

## 1. Gather references when the screen has no prototype

`design/everyfield-ui.html` is the brand prototype. When the screen you are building or changing has no frame there,
collect 3 to 6 real-product references before you design it: Mobbin (https://mobbin.com), Linear, Notion and
beautifului.dev itself. Save each screenshot outside the repository, in the task evidence folder:

```bash
E=$(git rev-parse --path-format=absolute --git-common-dir)/evf-evidence/<task>/references
mkdir -p "$E"
```

Write `$E/notes.md` with one line for each reference: its product, its URL or Mobbin flow, and what it gives this
screen (layout, density, empty state, how an action is confirmed). Take one idea from each and compose them in
Everyfield's own tokens and voice. Never copy a reference 1:1. Name the folder in your summary.

When the prototype has the screen, follow the prototype and skip this step.

## 2. Look for a fit

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

## 3. Install it through the registry

beautifului.dev is a shadcn registry (items at `https://www.beautifului.dev/r/<name>.json`, schema
`https://ui.shadcn.com/schema/registry-item.json`); it publishes no npm package. The repo-root `components.json`
names it as the `@beautifului` registry, next to our aliases (`@everyfield/ui/controls`, `/display`,
`/foundations`, resolved by the root `tsconfig.json` into `packages/ui/src/`) and our CSS
(`packages/ui/src/foundations/product.css`). Run from the repository root, dry run first:

```bash
npx shadcn@latest add @beautifului/<name> --dry-run          # the files and dependencies it would write
npx shadcn@latest add @beautifului/<name> --dry-run --view   # their contents
npx shadcn@latest view @beautifului/<name>                   # the raw item JSON
```

The full URL works the same way: `npx shadcn@latest add https://www.beautifului.dev/r/<name>.json --dry-run`.

beautifului.dev items set an explicit `target` on every file, which shadcn follows instead of our aliases (and
`--path` does not change it). A real `add` would write `app/beautifui/foundation.css`, `components/primitives/*.tsx`
and `components/atoms/*.tsx` at the repository root. So never run `add` without `--dry-run` for a beautifului.dev
item: read the files with `--view`, follow each `registryDependencies` item (`foundation` is a Tailwind v4 CSS file
with its own tokens; `button` needs `class-variance-authority`), and port the code into `packages/ui` by hand
(step 4). Name the item you ported in your summary. The site is MIT licensed (https://beautifului.dev/license): keep
that credit in your summary or commit message, not in a code comment. Read the registry again when you use it,
because its items change.

## 4. Adapt it to Everyfield

Port, don't paste. The result must read like the rest of `packages/ui`:

- Tokens: drop `foundation.css` and its `--ink`, `--surface`, `--line`, `--accent` style variables. Map them to
  Everyfield's tokens in `packages/ui/src/foundations/product.css` and the Tailwind theme. Dark mode is
  `data-theme="dark"`, not a `.dark` class.
- Primitives: use our `Button`, `Menu`, `Popover`, `Dialog`, `Icon` and `cn` from `packages/ui`, not the
  item's atoms. Overlays use the Radix-based controls already there. Inside `packages/ui`, import with relative
  paths like the files around it, not through `@everyfield/ui/...`.
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

## 5. When nothing fits

Fall back to the route in `.agents/roles/ui-designer.md`: new components come from the shadcn CLI. With the root
`components.json`, shadcn's own items do follow our aliases: `npx shadcn@latest add <name> --dry-run` lists targets
such as `packages/ui/src/controls/<name>.tsx`. Then:

- If the dry run says `overwrite`, Everyfield already has that primitive (the file system ignores case, so
  `button.tsx` hits `Button.tsx`). Improve ours; never pass `--overwrite`.
- Otherwise run the `add`, then adapt the file as in step 4: rename it to PascalCase, replace the `cn` package
  import with our `cn`, do not add the `cn` dependency, and drop any `:root` or `.dark` variables shadcn writes
  into `product.css` in favour of our tokens.

Say in your summary which beautifului.dev items you checked and why none fit.

## 6. Library choices

When a component needs a library (toasts, drawers, command menus, charts, drag and drop, virtualization, motion,
state), read `.agents/skills/pick-ui-library/SKILL.md` and follow its pick. It sets `disable-model-invocation`, so
open it by path. As it says, check `package.json` first: `packages/ui` already ships `radix-ui`, `cmdk`, `motion`
and `class-variance-authority`. Prefer what is installed, and say so when the list recommends something else. A
new dependency is its own decision, so record it with the `decisions` skill.
