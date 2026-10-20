# Everyfield v3 design handoff

**Design status: strong guidance.** Build screens to look like the prototype and compose them from its components. Where a flow is not drawn, compose it from existing components and patterns. Behavior comes from the requirements; where they differ, the requirement wins for behavior and the prototype wins for look.

The dashboard (Overview) keeps the prototype look. Compose it from the built components; do not redesign it.

This folder hands the v3 interface design to the build. The design itself is one file, [`../everyfield-ui.html`](../everyfield-ui.html), a clickable prototype of every screen in light and dark mode. The files here turn it into things the Next.js build can use directly.

**Next brand.** Sebastian approved a new brand on 2026-10-20 (new logo, new-growth green, DM Serif and DM Sans, square corners, muted gradient tones). It is drawn in [`../everyfield-ui-rebrand.html`](../everyfield-ui-rebrand.html) and in the marketing prototype, and described in [foundations.md](foundations.md#next-brand-approved-2026-10-20-not-in-the-app-yet). It is the target for the app migration. Until then, `everyfield-ui.html` and the generated files here describe the app as it is, because the live app imports `tokens.css`.

The build stack is in [`docs/architecture/README.md`](../../docs/architecture/README.md) and [`docs/dependencies.md`](../../docs/dependencies.md): Next.js, Tailwind CSS 4, and shadcn/ui on Radix in `packages/ui`.

## What is here

| File | What it is | Edit by hand? |
|---|---|---|
| [`tokens.css`](tokens.css) | Every design token for Tailwind 4: light and dark values, shadcn semantic names, `@theme` utilities, gradient tones | No, generated |
| [`assets/`](assets/) | The Everyfield mark and wordmark as SVG, colored with `currentColor` | No, generated |
| [`components.md`](components.md) | All 106 components, their parts, variants and the shadcn primitive to start from | No, generated |
| [`foundations.md`](foundations.md) | Rules for color, gradient cards, type, icons, shape, layout, motion, the Evry character and accessibility | Yes |
| [`screens.md`](screens.md) | Every screen with its route, work packages, drawn states, phone needs, overlays, emails, and the [screen-to-feature map](screens.md#screen-to-feature-map) with the flows that are not drawn | Yes |
| [`export.py`](export.py) | Writes the generated files and checks them | Yes |

After any change to the prototype, run the export and commit the result with it.

```sh
python3 design/handoff/export.py          # write tokens.css, assets and components.md
python3 design/handoff/export.py --check  # fail if anything is stale, a route is missing from screens.md,
                                          # a routed feature has no status in the map, or a map row names a non-owner
```

## How to read the prototype

Open `design/everyfield-ui.html` in a browser. It needs no build step. Fonts and icons load from Google Fonts and the Hugeicons CDN, so you need a network connection.

- The top nav and the rail reach every app page. Routes are in the URL hash, such as `#/people`.
- The sun and moon in the rail switch the theme.
- The dark dock at the bottom opens the design-system pages: Foundations, Components, Inventory, Mobile and Emails.
- Preview in the dock switches the role between Owner and Member (own tasks only), and the data state between live, first week, loading, error, no access and empty. Overview and People draw every state. Tasks draws what a Member can do on their own tasks.
- Ask Evry (⌘J), Guide and Send feedback open overlays over any page.

All names and numbers in the prototype are invented sample data for one church, Harvest Point, in Phase 1.

Suggested reading order for a new engineer:

1. [foundations.md](foundations.md), then the Foundations page in the prototype.
2. [components.md](components.md) next to the Components page.
3. [screens.md](screens.md), then click through each route.

## What the prototype decides and what it does not

The prototype decides the look: tokens, components, layouts, states and wording style. It also shows how current requirements look on screen, such as reviewed Evry changes (EVR-012, REQ-EVR-012), Wiki source views (WIKI-001, REQ-KNOW-191), Unmerge (PPL-017, REQ-PPL-025) and outcome-based follow-ups on the phone screen (REQ-MTG-022).

It does not decide behavior, permissions or data. The product chapters in [`docs/product/`](../../docs/product/) and the requirements in [`docs/catalog/`](../../docs/catalog/) do, starting from [`docs/START-HERE.md`](../../docs/START-HERE.md). When the prototype and a requirement disagree, the requirement wins for behavior and the prototype wins for look.

Four places in the prototype disagree with current requirements on purpose. The product owner chose to keep the components and fix the behavior during the build.

| Prototype shows | Requirement | Build does |
|---|---|---|
| "Share with coach" on Overview and Plant Intelligence, and a coach check-in under Coming up | Coach access is excluded (REQ-IDN-018, REQ-IDN-025) | leave them out |
| A background-check row on the person page | Background-check tracking is excluded (REQ-TEAM-014) | leave it out |
| A toast with "Undo" after moving a person | No general undo; records are corrected with history (REQ-PPL-015, REQ-PPL-025) | correct a record with history, or warn before an action that cannot be reversed |
| A single tick to close a follow-up on Tasks | A follow-up closes with a typed outcome (REQ-MTG-022) | use the outcome choice from the phone follow-up screen |

The prototype adds keyboard access to clickable cards and rows with a script. The build uses real buttons and links instead.

## Who builds the design system

The live marketing site already imports `tokens.css` through `apps/web/src/styles/marketing.css`, loads Bricolage Grotesque and Instrument Sans through `next/font` in `apps/web/src/app/layout.tsx`, and uses Hugeicons, Motion and the color-literal lint in `apps/web/scripts/check-color-literals.mjs`. Static marketing is rendered with Server Components and interactive or animated leaves are client components. Share images and baked mesh assets have deterministic renderers and freshness locks in `apps/web/scripts/`.

WP-088 extends these foundations into the shared product UI and adds AppShell and product-only dark mode. Reuse the single token source, fonts, icon library, Motion and lint instead of creating a second foundation system. Marketing stays light only, independent of the product theme and system setting. WP-089 builds controls, surfaces and overlays; WP-090 builds data, content and domain display components from [components.md](components.md). These packages own separate directories within `packages/ui`. Feature packages compose their screens from these components and do not rebuild them. The UI part of a feature package waits for WP-088, WP-089 and WP-090; its contract and API parts do not.

WP-049 extends the rebuilt marketing frame and components, reuses the owner-reviewed vision section when merged, and retains feedback, reviewed planters/trust pages, sign-in links and the before-customer-data privacy update. Local R4/R6 prototypes do not establish shipped content.

## Not designed yet

Some flows have requirements but no drawing. Compose them from existing components and patterns. Their owning UI packages do this; this handoff does not draw them. The list with features and owners is in the [screen-to-feature map](screens.md#flows-not-drawn). Every feature with a route has one status there, and `export.py --check` enforces it.

Two flows need a note here because the prototype is close to them:

- **Wiki source order (WIKI-001, REQ-KNOW-191).** Each plant keeps one ordered list of Wiki sources for its sending churches and one for its networks. The first entry is the preferred source. This needs a section in Settings, probably next to Sharing, with a reorderable list. The Source menu on an article lists sources in the same order. When two sources compete and no order is set, show that an order is needed; never pick a winner.
- **Lead planter (IDN-014, REQ-IDN-014).** Onboarding asks the Owner a yes/no question. Yes gives the Owner's Person the ordinary lead ministry role. No changes nothing and shows no lead. The lead planter role grants no access. A separate operating lead is a real Person with an ordinary Admin invitation. Assign the role later on Ministries, like any other role.

## Remaining choices

The [release-gate register](../../docs/plan/release-gates.json) owns all open questions, including charts, the Wiki editor, sliding highlights and gradient rendering. Each entry names its slice, owner and decision deadline. The Wiki editor choice belongs before WP-032 freezes the sanitized-node contract.

## Settled

**Icon library.** Hugeicons, stroke rounded, free set only, through `@hugeicons/react` and `@hugeicons/core-free-icons`. Every screen was drawn with its shapes. [`docs/dependencies.md`](../../docs/dependencies.md) records both packages. Do not add lucide or a second icon set.

**Email rendering.** React Email (`@react-email/components`, rendered with `@react-email/render`), recorded in [`docs/dependencies.md`](../../docs/dependencies.md). It uses the same React components and tokens as the app. The emails need fixed light colors, a 600px column and system font fallbacks. See [screens.md](screens.md#emails).

**Network Intelligence.** Settled as PI-043 (REQ-PI-043): a separate network rubric over shared Plant Intelligence results, with no ranking and no people. The `#/network/intelligence` drawing follows it.

**Help center.** `/help` and `/help/[slug]` are a future feature, not in v3 scope. The design is kept for later. The Guide panel (WIKI-008) is in scope.

**Feedback dialog.** Keep the design as drawn. The feedback feature (ADM-001) is changed to match it.
