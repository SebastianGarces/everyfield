# Everyfield v3 design handoff

This folder hands the v3 interface design to the build. The design itself is one file, [`../everyfield-ui.html`](../everyfield-ui.html), a clickable prototype of every screen in light and dark mode. The files here turn it into things the Next.js build can use directly.

The build stack is in [`docs/architecture/architecture.md`](../../docs/architecture/architecture.md) and [`docs/dependencies.md`](../../docs/dependencies.md): Next.js, Tailwind CSS 4, and shadcn/ui on Radix in `packages/ui`.

## What is here

| File | What it is | Edit by hand? |
|---|---|---|
| [`tokens.css`](tokens.css) | Every design token for Tailwind 4: light and dark values, shadcn semantic names, `@theme` utilities, gradient tones | No, generated |
| [`assets/`](assets/) | The Everyfield mark and wordmark as SVG, colored with `currentColor` | No, generated |
| [`components.md`](components.md) | All 89 components, their parts, variants and the shadcn primitive to start from | No, generated |
| [`foundations.md`](foundations.md) | Rules for color, gradient cards, type, icons, shape, layout, motion, the Evry character and accessibility | Yes |
| [`screens.md`](screens.md) | Every screen with a proposed route, work packages, drawn states, phone needs, overlays and emails | Yes |
| [`export.py`](export.py) | Writes the generated files and checks them | Yes |

After any change to the prototype, run the export and commit the result with it.

```sh
python3 design/handoff/export.py          # write tokens.css, assets and components.md
python3 design/handoff/export.py --check  # fail if anything is stale or a route is missing from screens.md
```

## How to read the prototype

Open `design/everyfield-ui.html` in a browser. It needs no build step. Fonts and icons load from Google Fonts and the Hugeicons CDN, so you need a network connection.

- The top nav and the rail reach every app page. Routes are in the URL hash, such as `#/people`.
- The sun and moon in the rail switch the theme.
- The dark dock at the bottom opens the design-system pages: Foundations, Components, Inventory, Mobile and Emails.
- Preview in the dock switches the role between Owner and Member (view only), and the data state between live, first week, loading, error, no access and empty. Overview and People draw every state.
- Ask Evry (⌘J), Guide and Send feedback open overlays over any page.

All names and numbers in the prototype are invented sample data for one church, Harvest Point, in Phase 1.

Suggested reading order for a new engineer:

1. [foundations.md](foundations.md), then the Foundations page in the prototype.
2. [components.md](components.md) next to the Components page.
3. [screens.md](screens.md), then click through each route.

## What the prototype decides and what it does not

The prototype decides the visual system: tokens, components, layouts, states and wording style. It also shows how accepted product rulings look on screen, such as reviewed Evry changes (PD-001), Wiki source views (PD-025) and outcome-based follow-ups on the phone screen (PD-005).

It does not decide behavior, permissions or data. The module documents in [`docs/modules/`](../../docs/modules/) and the rulings in [`docs/decisions/user-rulings.md`](../../docs/decisions/user-rulings.md) do. When the prototype and an accepted ruling disagree, the ruling wins.

Four places in the prototype disagree with accepted rulings on purpose. The product owner chose to keep the components and fix the behavior during the build.

| Prototype shows | Ruling | Build does |
|---|---|---|
| "Share with coach" on Overview and Plant Intelligence, and a coach check-in under Coming up | PD-010 defers coaching | leave them out until coaching is approved |
| A background-check row on the person page | PD-010 defers background checks | leave it out |
| A toast with "Undo" after moving a person | OD-014 has no general undo | correct a record with history, or warn before an action that cannot be reversed |
| A single tick to close a follow-up on Tasks | PD-005 needs an outcome | use the outcome choice from the phone follow-up screen |

The prototype adds keyboard access to clickable cards and rows with a script. The build uses real buttons and links instead.

## Suggested first step

No work package owns the design system today. `packages/ui` exists in the architecture but no package builds it. Before feature work starts on screens, one slice should set up `tokens.css`, the two fonts through `next/font`, the icon package, `AppShell`, and the base components: Button, Card, Badge, Input, Tabs, Dialog, Popover, Skeleton, StatePanel and the Evry character. Otherwise each feature package rebuilds them its own way. This is a recommendation for the integration owner. This handoff does not change the plan in `docs/plan/`.

## Not designed yet

Rulings accepted after the prototype was drawn need these screens. They reuse existing components.

- **Wiki source order (PD-025, PD-026).** The planter keeps an ordered list of Wiki sources for each group, sending churches and networks, with the preferred source first. This needs a section in Settings, probably next to Sharing, with a reorderable list. The Source menu on an article should list sources in the same order.
- **Lead planter (PD-027).** Onboarding asks the Owner whether they are the lead planter. "No" lets them pick an existing member or invite someone. "Skip" leaves it unassigned, and Settings needs a place to assign it later.

## Open decisions

Each needs an owner's choice before the matching work starts.

**Icon library.** The design uses Hugeicons, stroke rounded, free set only. `docs/dependencies.md` lists lucide. I recommend Hugeicons through `@hugeicons/react` and `@hugeicons/core-free-icons`, because every screen was drawn with its shapes and the two sets differ in stroke and corner style. If lucide stays, each icon needs a matching replacement and a visual check. The dependency owner should update `docs/dependencies.md` either way.

**Charts.** The prototype draws its charts by hand: bar charts with a goal line, stacked bars, sparklines, ring meters and hatched planned values. `docs/dependencies.md` allows a chart library only for preserved feature needs. I recommend small owned SVG components in `packages/ui`, because there are few chart types and the hatch pattern, tooltips and keyboard access are easier to control. Visx is the fallback if the set grows.

**Wiki editor.** v2 Wiki content is MDX. The editor needs a rich-text library that can read and write that content without loss. Tiptap and Lexical are both candidates. I recommend a short spike in WP-035 that round-trips ten real articles before choosing.

**Email rendering.** I recommend React Email, because it uses the same React components and tokens as the app. The emails need fixed light colors, a 600px column and system font fallbacks. See [screens.md](screens.md#emails).

**Sliding highlights.** Lists, menus, tabs and the nav share one sliding highlight. Motion's `layoutId` does this in a few lines but adds a dependency. A small owned hook with CSS transforms also works. Choose one and use it everywhere.

**Gradient card rendering.** The cards use a large CSS blur. Profile Overview on a low-end laptop before launch. If painting is slow, pre-render each of the four tones to a static image and keep only the grain in CSS. See [foundations.md](foundations.md#gradient-cards).

**Help center.** The Guide panel builds on WIKI-008, but the help center and how-to articles are new in v3. A proposed ruling for the Guide, the help center and the feedback page details is waiting for the decisions owner. It was drafted as PD-018, but that number belongs to an older ruling, so it needs the next free number. Until it is accepted, no work package builds `/help`.

**Feedback page details.** The feedback dialog shows the page, address, church, role, browser, screen size, theme, app version and time. v2 stored only the page address (ADM-001). The extra fields need a schema change and a privacy check in WP-049.
