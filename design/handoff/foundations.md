# Foundations

The rules behind the prototype in `design/everyfield-ui.html`. Every value named here is a token in [`tokens.css`](tokens.css). The prototype is the reference when this page and the file disagree. In that case, fix this page.

Open the prototype and use the dock at the bottom of the screen to reach Foundations, Components, Inventory, Mobile and Emails.

This page describes the brand drawn in `design/everyfield-ui.html` and `design/everyfield-marketing.html`, approved on 2026-10-20. The app tokens, fonts and tone names follow it since R1. Where an earlier section and [Brand](#brand-approved-2026-10-20) at the end of this page disagree, the Brand section wins.

## Themes

Light is the default. Dark uses the same token names with dark values under `[data-theme="dark"]`. In the build, run next-themes with `attribute="data-theme"` so the tokens switch without class names.

Ink flips in dark mode. `--ef-ink` becomes a light tone, so primary buttons and the active nav item become light fills with dark text through `--ef-on-ink`. Emails ignore the theme and always use the light palette.

## Color roles

Each hue has one job. Token names stay generic so a hue can change later without renaming code.

| Hue token | Role | Built from |
|---|---|---|
| `green` | healthy, committed, positive, growth | new-growth `#1AF197` (500), text-safe `#026B40` (600) |
| `blue` | measured, actual, information | softened sky (500 `#6E9FCF`, 600 `#2A6296`) |
| `amber` | attention, waiting, draft | orange |
| `magenta` | risk, gap, overdue | rose-coral |
| `violet` | categories, Evry, top finding | the muted rose ramp |
| `teal` | categories only, such as pipeline stages | the muted sky ramp |

Every hue has the same steps. Use them like this.

- **600 and 700.** Text and icons on a tint or on a card. They reach 4.5:1 on their own 100 and 50 tints and on every surface, in both themes.
- **500.** Fills, dots, bars and progress. Text on a 500 fill is ink `#181D19`, never white. White text on the lighter 500 steps fails contrast.
- **300.** Hatch lines for planned or estimated values.
- **100.** Tints behind badges, chips and icon tiles.
- **50.** Washes behind large areas, such as a highlighted row.

`--ef-amber-display` (`#D9780F` light, `#FFA552` dark) is a brighter orange for large attention numbers only, such as "No contact 14 d · 11". It passes the 3:1 rule for large text and fails the 4.5:1 rule for body text, so never use it below 24px.

Semantic aliases exist for the most common uses: `--ef-positive`, `--ef-accent`, `--ef-measured`, `--ef-risk` and `--ef-attention`.

Neutrals are cool grey. Cream `#F6F0E9` is for brand moments and marketing, not app surfaces. New-growth `#1AF197` is the green 500 step, a fill only, never text. The logo is ink.

### Planned values

Planned, estimated or pending values use a diagonal hatch instead of a solid fill. The prototype draws it with `repeating-linear-gradient` at `--ef-hatch-w` (1.6px) lines and `--ef-hatch-gap` (5.5px) gaps, in the hue's 300 or 500 step. Examples are the benchmark bar on Overview and pending RSVPs.

### Text contrast

Measured on the final tokens:

| Token | Light, lowest | Dark, lowest |
|---|---|---|
| `--ef-text` | 14.9:1 | 13.1:1 |
| `--ef-text-2` | 6.7:1 | 7.5:1 |
| `--ef-text-3` | 4.6:1 on `surface-2` | 4.8:1 on `surface-2` |
| `--ef-focus` | 5.7:1 | 9.5:1 |

Every text token passes 4.5:1 on every surface. Do not add a lighter grey for text. Placeholders also use `text-3`.

## Gradient cards

The gradient card (`InsightCard`) is the signature surface. Use at most two per page, and only for one finding the person should act on. All four tones carry ink text.

| Tone | Use |
|---|---|
| `field` | default and growth |
| `sky` | neutral findings |
| `sage` | the most important summary on a page |
| `rose` | risk and needs attention |

The card has three layers. Build it the same way.

1. A base color, `--ef-grad-{tone}-base`.
2. A mesh of five radial gradients in a pseudo-element that extends 25% past the card on every side. Colors `-1` to `-4` are large soft blobs and `-5` is a small highlight in the top right. The gradients interpolate in OKLCH (`radial-gradient(in oklch ...)`) so blends stay bright and never pass through grey. The layer has `filter: blur(52px) saturate(1.1)`.
3. Film grain: a 260px tile of SVG fractal noise (`feTurbulence`, baseFrequency .95, 3 octaves, desaturated), blended with `mix-blend-mode: overlay` at 0.42 opacity on these ink-text tones.

Pills, counts, sparkline bars and glass buttons on a card take their colors from per-card variables (`--on`, `--on-2`, `--pill-bg`, `--spark`). Avatars on a gradient card have no ring.

The cards look the same in light and dark mode. In dark mode, the neutral tokens inside a card (`--ef-ink`, `--ef-text`, `--ef-text-2`, `--ef-text-3`, the surfaces, lines and `--ef-on-ink`) keep their light values. Panels, buttons and text nested in a card then stay readable on the light gradient. In the build, set these tokens on the card component for dark mode.

Performance is the risk with this card. A 52px blur on an element larger than the card is expensive to paint, and the cards can be large. Before launch, profile Overview on a low-end laptop. If paints are slow, render each tone once to a static WebP and keep only the grain as CSS. The tones never change at runtime, so a static image loses nothing visible.

## Type

| Family | Use | Weights |
|---|---|---|
| DM Serif Display | titles and large numbers at 24px and above | 400 |
| DM Serif Text | titles and numbers below 24px | 400 |
| DM Sans | everything else, including table numbers | 400 to 700 with the optical size axis |

Load all three with `next/font/google` and assign them to `--ef-font-display`, `--ef-font-title` and `--ef-font-body` (Tailwind `font-display`, `font-title`, `font-sans`). `apps/web/scripts/check-type-scale.mjs` fails a class string that pairs a serif with the wrong size. All three are licensed under the SIL Open Font License.

The scale is `--ef-text-xs` 12, `sm` 13, `md` 14 (default UI text), `lg` 16, `--ef-title-sm` 18, `md` 22, `lg` 28 and `--ef-display-sm` 40, `md` 56, `lg` 76. Both serifs use letter spacing -0.02em. Numbers in tables and counts use tabular figures (`font-variant-numeric: tabular-nums`).

Wiki and help articles cap their text at 700px and center it in the card.

## Icons

The prototype uses Hugeicons, stroke rounded style, from the free set only, loaded as an icon font from `https://use.hugeicons.com/font/icons.css`, the current build. The older `cdn.hugeicons.com/font` address is deprecated and frozen on a 2024 build, so do not use it. Markup is `<i class="hgi hgi-stroke hgi-rounded hgi-rocket-01"></i>`; the stylesheet only needs `hgi-stroke` and the icon name, so the shorter form also works. Icons are 24px in the rail and in the top-bar icon buttons (search, notifications), inside the same 46px and 44px buttons, 18px in buttons and 16px inline. In the build, use `@hugeicons/react` (1.1.10 on 2026-10-10) with `@hugeicons/core-free-icons` (4.3.5) so each icon is a tree-shaken component. Pin versions 1.0.0 or later. [`docs/dependencies.md`](../../docs/dependencies.md) records both packages. Do not add lucide or a second icon set.

Every icon-only button needs an accessible name. The prototype takes it from the button's `title`.

## Shape and elevation

All corners are square: every `--ef-radius-*` token reads a `--corner-*` variable (`card`, `control`, `pill`, `petal`, `media`), and all are 0. Avatars, status dots, radios and switch knobs stay round. The tokens keep their names (`xs`, `sm`, `md`, `lg`, `card`, `frame`, `pill`) so a later corner change is one edit. Navigation has its own pair. The top-bar pills and rail groups use `--ef-nav-radius` (20px), and the items inside them use `--ef-nav-item-radius` (14px): nav links, rail icons, the search and bell buttons, the Ask Evry chip, the active state and the sliding hover highlight. This replaced fully round pills on 2026-10-10. The prototype's Preview menu can still show the pill shape for comparison. Cards use `--ef-shadow-card`, floating controls `--ef-shadow-raised`, menus and dialogs `--ef-shadow-pop`, navigation pills `--ef-shadow-nav` and the active nav item `--ef-shadow-nav-active`.

Spacing is a 4px grid: `--ef-space-1` 4 to `--ef-space-10` 40. Card padding is 22 to 30px. Gaps between cards are 20px.

## Layout

The app shell is a top bar (`--ef-topbar-h` 60px, built from separate pills), an icon rail on the left and a content column. The top bar and rail span the full window. The content column stops at `--ef-content-max` (1536px) and centers in the space beside the rail. Pages with many columns (People, Meetings, Documents) set `data-width="wide"` and can grow to `--ef-content-max-wide` (1920px). At 1440px every page looks as designed.

The top bar has three parts: the logo pill, the main nav and the right-hand controls (search, notifications, Ask Evry, user menu). From 1640px up, it is a three-column grid with equal outer columns, so the nav is centered on the window. Below 1640px the right-hand controls no longer fit their half (measured at 1619px), so the bar becomes a flex row and the nav centers in the space between the logo and the controls. At 1520px and below the user menu drops the role line. At 1340px and below it drops the name, and the logo drops the wordmark. The phase is not shown in the top bar.

The main app is desktop only. Phone layouts exist only for door check-in, the follow-up call and pages opened from an email link. See [screens.md](screens.md).

Sign-in and onboarding use a bare shell without the top bar and rail.

## Motion

Hover backgrounds and active indicators share one movement: `--ef-slide-dur` (0.26s) with `--ef-slide-ease` (`cubic-bezier(.2,.8,.2,1)`). In lists, menus, tables, tabs, the top nav and the rail, one shared highlight slides to the hovered or focused item and rests on the current one. It follows keyboard focus as well as the pointer.

Pages reveal their blocks in reading order, top to bottom then left to right. Each block rises 14px and fades in over 0.4s. Each one starts 30ms after the one before it, with a 400ms cap. The theme switch cross-fades colors for 0.3s.

`prefers-reduced-motion: reduce` turns off the reveal, the slide and every Evry animation. Nothing depends on motion to make sense.

## Evry character

Evry is a brand-green blob with two ink eyes. It replaces any generic AI icon everywhere Evry appears.

| Size | px | Where |
|---|---|---|
| `xs` | 18 | command palette rows, inline pills |
| `sm` | 24 | Ask Evry chip, callout labels |
| `md` | 30 | chat messages |
| `lg` | 40 | panel header |
| `xl` | 96 | showcase and onboarding |

It has four moods. Idle blinks at a random interval between 3.8 and 6.8 seconds and glances around. Thinking squints, wobbles slowly and has a small orbiting dot. Talking moves a small mouth while an answer streams. Happy shows "^ ^" eyes and a bounce after an approved change. The body changes shape slowly in every mood. In the open panel the eyes follow the pointer, and only there. Medium sizes and up get a small highlight in each eye.

Build it as a React component with `size` and `mood` props and CSS animations. Emails cannot animate, so they use a still face.

## Accessibility rules

These rules held in the prototype checks. Keep them in the build.

- Text meets 4.5:1. Large numbers (24px and up) may use 3:1.
- Every interactive element shows a 2px `--ef-focus` ring with a 2px offset on keyboard focus only (`:focus-visible`). On gradient cards the ring is ink.
- Text inputs show focus on the whole field, not only the inner input.
- Tab order runs top bar, rail, then page. Closed menus, panels and dialogs are inert, so Tab never lands inside them.
- Anything that appears on hover also appears on focus. The rail labels are the example.
- Clickable rows and cards are real links or buttons. The prototype adds `tabindex` and roles with a script. Do not copy that.
- A failed load never looks like an empty list. Say what failed, keep the last known time, and offer "Try again".
- "Not recorded" is different from 0. Show "Not recorded" until someone enters a number.
- Overlays close with Esc. Settings and Feedback are dialogs with `aria-modal`.

## Brand (approved 2026-10-20)

Sebastian approved this brand on 2026-10-20. It is drawn in two prototypes:

- `design/everyfield-ui.html`: the dashboard.
- `design/everyfield-marketing.html` with `design/marketing-styles.css`: the marketing page.

`tokens.css`, `assets/` (symbol, wordmark and lockup), the product logo paths and `components.md` come from `design/everyfield-ui.html` through `export.py`. R1 moved the app tokens, fonts and gradient tone names to this brand. R2 restyles the dashboard components and R3 the marketing pages.

### Logo

Three SVG symbols, all one color through `currentColor`: the symbol (`#ef-mark`, 340x340), the wordmark (`#ef-wordmark`, 1052x241) and the lockup (`#ef-lockup`, 1308x241; the symbol is 192.33 high, centred on the wordmark band). The lockup is ink on light surfaces and cream on ink and on photos. A new-growth symbol on white is only 1.5:1, so use new-growth only as a tile behind an ink symbol.

### Color

| Token | Value | Role |
|---|---|---|
| `--ef-green` (green 500) | `#1AF197` new-growth | brand color, fills only, never text |
| `--ef-green-600` | `#026B40` | text-safe green: 6.4:1 on the marketing canvas, 5.8:1 on cream |
| `--ef-ink` | `#181D19` | brand ink: text, primary buttons, the logo |
| `--ef-cream` | `#F6F0E9` | marketing secondary surface, text on ink and on photos |
| marketing canvas | `#FCFBF8` | the marketing page background, unchanged |

App neutrals (frame, canvas, surfaces, lines, hover, light and dark) do not change. They keep the values above. The app has no cream in backgrounds, surfaces or hover states.

The green ramp keeps its OKLCH lightness steps on the new-growth hue (157). Status colors follow the muted palette: `blue` is softened (500 `#6E9FCF`, 600 `#2A6296`), `violet` takes the rose ramp and `teal` takes the sky ramp, so category hues match the photos. Amber, magenta and red stay bright for status and risk.

### Muted palette and gradient tones

Three muted ramps sampled from the landscape photos, in the same OKLCH lightness steps. The 700 step is text-safe (4.5:1 or more on white, cream, frame and canvas).

| Ramp | 100 | 300 | 500 | 700 |
|---|---|---|---|---|
| `sky` | `#D6EAF2` | `#B2D2DE` | `#83AAB8` | `#4C6F7C` |
| `sage` | `#E4EED9` | `#C6D6B4` | `#9BAE86` | `#5F6D4D` |
| `rose` | `#F9E4E1` | `#EAC6C0` | `#C79A93` | `#825D57` |

The gradient card keeps its three layers (base, blurred OKLCH mesh, grain) with four tones. `dawn` became `sage` and `lilac` became `rose`; the marketing-only `slate` tone is retired.

| Tone | Use |
|---|---|
| `field` | the brand card: default and growth, full new-growth |
| `sky` | neutral findings |
| `sage` | the most important summary on a page |
| `rose` | risk and needs attention |

All four tones carry ink text and look the same in light and dark mode.

### Type

| Family | Use |
|---|---|
| DM Serif Display | every heading and large stat number at 24px and above |
| DM Serif Text | headings below 24px, such as card titles |
| DM Sans | body, UI text, table and heat-map numbers |

Both serifs use letter-spacing -0.02em and weight 400 (`font-synthesis-weight: none`, so the browser never fakes bold). Fluid headings switch family at the viewport where the size reaches 24px. DM Sans has no tabular figures, so table numbers use proportional digits (see follow-ups in the PR). All three fonts use the SIL Open Font License.

### Shape

All corners are square: cards, controls, pills, tags, nav, icon tiles, icon buttons, pagination, switches and photos. Circles stay round: avatars, status dots, radios and the round checkbox. Product code reads the corners through the `rounded-xs|sm|md|lg|card|pill` utilities; `apps/web/scripts/check-corners.mjs` rejects fixed-pixel radii.

### Marketing photos

- **Treatment.** A photo surface has three CSS layers: the image, a flat black overlay of 20% (`brightness(.8)`), and film grain (SVG fractal noise, overlay blend, 0.34). The grain and the overlay are never baked into the image file. Text on a photo uses a stronger shade (`.photo-text`) where the pixel probe needs it.
- **Files.** Web-sized AVIF with a JPEG fallback in `design/assets/photos/`. The hero photo loads first; other photos load when they come near the viewport.
- **Rules.** (1) The phase-card rail uses the six blurred colorful photos. (2) A slot that holds a colorful UI card gets a muted gradient, not a photo. (3) Every other slot gets its own landscape photo; no photo repeats on a page. A rail card that would repeat the hero photo gets a gradient instead.
- **Heroes.** Fade style: the photo fades up from the canvas and the text stays ink. Home uses wildflowers, oversight uses bluebells.
- **On photos.** The cream symbol sits above the CTA headline. The primary button is cream with ink text. The focus ring is 2px cream.

### Brand specimens

On the Foundations page, the logo tiles, logo chips, brand swatches, palette ramps and gradient cards look the same in light and dark mode (`.brand-fixed` pins the brand tokens). Only the page around them follows the theme.
