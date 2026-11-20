# UI designer additions

Read `docs/architecture/patterns.md` and `docs/architecture/decisions.md` before planning or building.
Apply the shared patterns and durable rulings to the assigned scope.

UI tasks run in the `ui` seat, which reads this file and `implementor.md`. Follow `implementor.md` for the
task loop; these rules add to it, including the proof the implementor records.
Do not push: evf opens the PR (implementor step 6).

- Read the tier in your brief. UI-4: a design choice among prototypes belongs in evf's `prototype`
  workflow, where ideators build the options, a comparer builds the page to judge them and Sebastian picks.
- When only Sebastian can settle something else, ask with `evf ask owner`, then end your turn. You resume
  with the answer. Your brief gives the limits on each field.

  ```
  evf ask owner "<question>" --context "<the context>" \
    --option a="<choice>" --why a="<one-line why>" \
    --option b="<choice>" --why b="<one-line why>" \
    --recommend a
  ```

- Build against the contract in `packages/contracts/` and the merged api part of your package.
  Do not edit domain or API code.
- Use the `better-interface` suite (`better-ui`, `better-layout`, `better-typography`,
  `better-colors`, `better-accessibility`, `better-writing`). New components come from the shadcn CLI.
- Use the upstream `vercel-react-best-practices` skill for React and Next.js components, pages,
  data fetching, bundle size and performance work.
- Look at your work at mobile and desktop widths with `bin/app` (`app shot` takes both, `app cursor-audit`
  checks pointers).
  Read the console. Judge hierarchy, spacing and copy. The verifier checks Chromium and WebKit.
- Browser regression tests cover critical flows only, with `AC:<case-id>` markers. Use integration
  tests for other behavior and broad browser proof outside the repo. Follow `test-standard`.

## Banned styling

`everyfield/no-slop-styling` (`scripts/lint/slop-styling.mjs`, wired through the Everyfield plugin and
`apps/web/scripts/check-slop-styling.mjs` for CSS) fails `pnpm lint` on these in `apps/web/src/features/**`
and `packages/ui/src/**`:

- Eyebrow labels: a small uppercase or tracked label directly above a heading.
- Monospace with uppercase. Monospace stays for code and references, in normal case.
- Wide letter tracking (`tracking-wide*`, positive `tracking-[…]` or `letter-spacing`). Small uppercase labels
  use the `section-label` utility, or `letter-spacing: var(--ef-label-tracking)` in CSS.
- Serif type outside `--ef-font-display` and `--ef-font-title` (`font-display`, `font-title`, heading defaults).
- Beige palettes: `stone-*` and beige literals such as `#F5F5DC` or `#F6F0E9`. Cream is the brand color only
  through its `cream` token.
- Zero-padded step counters (`01`, `02`, or `padStart(2, "0")` whose result is not a time or date). Use a list or a
  plain number.
- Glowing orbs (large blurs, colored glow shadows) and gradients outside a named surface: `ef-insight` (the
  gradient card), `ef-scroll-fade`, `ef-top-fade`, `ef-skel`, `ef-ring`, `ef-none-swatch`, `hatch` and the
  document spacer (`[data-ef-node="spacer"]`).

The same rule covers the landing: `apps/web/src/marketing/**` and `apps/web/src/styles/marketing.css`. Sebastian
approved the looks the landing uses (D-1818). On those marketing paths only, each one is allowed only in its named
form, and every free-form version still fails:

- the uppercase eyebrow above the hero and page-hero `h1`: `mk-eyebrow`
- the uppercase group and phase labels: `mk-label`. The tracked step numbers: `mk-counter`
- zero-padded step numbers: `stepNumber()` from `apps/web/src/marketing/step-number.ts`
- gradients: `mk-corner-shade`, `mk-leaders-shade`, `mk-hatch`, `skeleton`, `hero-fade` and `mk-caret-fill`
- the canvas: the `mk-canvas` token (`--color-mk-canvas`) and the `mk-canvas-*` and `mk-cream-*` tints

These names fail in `apps/web/src/features/**` and `packages/ui/src/**`.

Where better-typography differs, this file wins. Use no em dashes in UI copy: use a period, comma or colon.
Uppercase comes only through `section-label`, and a section label never sits above a heading as an eyebrow.

## Principles to read in full at the start

Read these files before your first action. They are not in your skill list. The rest are in the
`AGENTS.md` principle list; open one when it applies.

- `.agents/skills/principle-experience-first/SKILL.md`
- `.agents/skills/principle-exhaust-the-design-space/SKILL.md`
- `.agents/skills/principle-laziness-protocol/SKILL.md`
