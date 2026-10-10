# Foundations

The rules behind the prototype in `design/everyfield-ui.html`. Every value named here is a token in [`tokens.css`](tokens.css). The prototype is the reference when this page and the file disagree. In that case, fix this page.

Open the prototype and use the dock at the bottom of the screen to reach Foundations, Components, Inventory, Mobile and Emails.

## Themes

Light is the default. Dark uses the same token names with dark values under `[data-theme="dark"]`. In the build, run next-themes with `attribute="data-theme"` so the tokens switch without class names.

Ink flips in dark mode. `--ef-ink` becomes a light tone, so primary buttons and the active nav item become light fills with dark text through `--ef-on-ink`. Emails ignore the theme and always use the light palette.

## Color roles

Each hue has one job. Token names stay generic so a hue can change later without renaming code.

| Hue token | Role | Built from |
|---|---|---|
| `green` | healthy, committed, positive, growth | Field, the brand green `#1CE362` |
| `blue` | measured, actual, information | Sky |
| `amber` | attention, waiting, draft | Dawn |
| `magenta` | risk, gap, overdue | rose-coral |
| `violet` | categories, Evry, top finding | Lilac |
| `teal` | categories only, such as pipeline stages | lighter teal |

Every hue has the same steps. Use them like this.

- **600 and 700.** Text and icons on a tint or on a card. They reach 4.5:1 on their own 100 and 50 tints and on every surface, in both themes.
- **500.** Fills, dots, bars and progress. Text on a 500 fill is ink `#181D19`, never white. White text on the lighter 500 steps fails contrast.
- **300.** Hatch lines for planned or estimated values.
- **100.** Tints behind badges, chips and icon tiles.
- **50.** Washes behind large areas, such as a highlighted row.

`--ef-amber-display` (`#D9780F` light, `#FFA552` dark) is a brighter orange for large attention numbers only, such as "No contact 14 d · 11". It passes the 3:1 rule for large text and fails the 4.5:1 rule for body text, so never use it below 24px.

Semantic aliases exist for the most common uses: `--ef-positive`, `--ef-accent`, `--ef-measured`, `--ef-risk` and `--ef-attention`.

Neutrals are cool grey. Cream `#F6F0E9` is for brand moments and marketing, not app surfaces. The brand green `#1CE362` is the green 500 step and the color of the logo mark in the top bar. The wordmark next to it stays ink.

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
| `dawn` | attention and gaps |
| `lilac` | the most important summary on a page |

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
| Bricolage Grotesque | titles, numbers, the Evry and Guide panel titles | 400, 500, 600, 700 with the optical size axis (12 to 96) |
| Instrument Sans | everything else | 400, 500, 600, 700 |

Load both with `next/font/google` and assign them to `--ef-font-display` and `--ef-font-body`. Both are licensed under the SIL Open Font License.

The scale is `--ef-text-xs` 12, `sm` 13, `md` 14 (default UI text), `lg` 16, `--ef-title-sm` 18, `md` 22, `lg` 28 and `--ef-display-sm` 40, `md` 56, `lg` 76. Large display text uses negative letter spacing around -0.03em. Numbers in tables and counts use tabular figures (`font-variant-numeric: tabular-nums`).

Wiki and help articles cap their text at 700px and center it in the card.

## Icons

The prototype uses Hugeicons, stroke rounded style, from the free set only, loaded as an icon font from the Hugeicons CDN. Icons are 20px in the rail and nav, 18px in buttons and 16px inline. In the build, use `@hugeicons/react` with `@hugeicons/core-free-icons` so each icon is a tree-shaken component. `docs/dependencies.md` lists lucide instead, which is an open decision in the [README](README.md#open-decisions).

Every icon-only button needs an accessible name. The prototype takes it from the button's `title`.

## Shape and elevation

Radii run `--ef-radius-xs` 6, `sm` 10, `md` 14 (buttons and inputs), `lg` 20, `card` 26, `frame` 34 and `pill` 999. Navigation has its own pair. The top-bar pills and rail groups use `--ef-nav-radius` (20px), and the items inside them use `--ef-nav-item-radius` (14px): nav links, rail icons, the search and bell buttons, the Ask Evry chip, the active state and the sliding hover highlight. This replaced fully round pills on 2026-10-10. The prototype's Preview menu can still show the pill shape for comparison. Cards use `--ef-shadow-card`, floating controls `--ef-shadow-raised`, menus and dialogs `--ef-shadow-pop`, navigation pills `--ef-shadow-nav` and the active nav item `--ef-shadow-nav-active`.

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
