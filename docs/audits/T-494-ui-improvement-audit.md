# T-494: UI improvement audit (read-only)

This file is the whole change: no app code, style or dependency changed (owner ruling D-1716). It is a report only.

## How I checked

- I ran the app with `bin/app up` (a production build of ab42514cf on a throwaway Postgres with the QA seed) and drove it
  with `bin/app` (agent-browser). Personas: `owner` (Harvest Point) and `graceOwner` (Grace Austin pipeline).
- I entered the worst-case data myself in that throwaway app:
  - a person named "Maximiliana Alejandra Wolfeschlegelsteinhausen-Bergerdorff de la Cruz" with a 97-character email
  - a 1,500-row CSV import through the real People import flow, giving 1,515 people
  - an Evry message containing a 130-character unbroken URL
- Screenshots are viewport shots at exactly 390×844 or 1440×900, kept outside the repo in
  `~/dev/t494-shots/`. Item screenshots are named `itemNN-*.png`. The raw walk shots sit beside them.
- Lenses:
  - Emil Kowalski's pick-ui-library list
  - beautifului.dev, whose relevant components are Thinking, Streaming Text, Approval Card, Tool Chips, Task Rows, Prompt
    Bar, Context Cards, Records Table, Filter Table, Diff Table, Search and Insight Cards
  - Emil's mobile-native and break-ui checklists, plus a motion review
- File and line references are at ab42514cf.

## Ranked list (most valuable first)

Rank = how many users hit it × how bad it looks or feels ÷ effort. Each item is meant to be filed as one task.

### 1. Text inputs are 14 px, so iOS Safari zooms the page on every focus
- **Screen:** every form on a phone: Add person, Tasks, People and Wiki search, Settings, and the Evry composer. Source:
  the shared `inputBox` and `Textarea` in `packages/ui/src/controls/Field.tsx:73` and `:139` (`text-md`), the Combobox
  input at `packages/ui/src/controls/Combobox.tsx:41`, and the Evry composer at
  `apps/web/src/features/evry/conversation/EvryPanel.tsx:619`.
- **Wrong today:** at 390 px every text input measured `font-size: 14px` with `getComputedStyle`: the Add person fields,
  the People, Tasks and Wiki search boxes, and the Evry textarea. iOS zooms in on any input under 16 px, and the user then
  has to pinch back out.
- **Fix:** plain CSS. Add one unlayered rule in `packages/ui/src/controls/controls.css`:
  `@media (pointer: coarse) { [data-product-root] :is(input:not([type=checkbox],[type=radio],[type=file]), textarea, select) { font-size: max(16px, 1em) } }`.
  Desktop stays at 14 px.
- **Effort:** S
- **Done statement:** on a coarse-pointer 390 px viewport, every product text input, textarea and select computes to at
  least 16 px.
- **Screenshots:** `~/dev/t494-shots/item01-input-zoom-390.png` (Add person, with each field's
  measured size labelled on the page) and `~/dev/t494-shots/item01-input-zoom-search-390.png`
  (People search).

### 2. A long person name runs off the screen in the person header
- **Screen:** `/people/[id]` header. Source: `apps/web/src/features/people/PersonScreen.tsx:194`.
- **Wrong today:** the `<h1>` is a flex item without `min-w-0` or a wrap rule. At 390 px
  "Wolfeschlegelsteinhausen-Bergerdorff" is clipped at the right edge ("Alejandr…", "de la Cru…"). At 1440 px the name
  pushes the ⋯ menu below "Change stage".
- **Fix:** plain CSS. Add `min-w-0 wrap-anywhere` to the `h1`. `teams/parts.tsx:53` already uses `wrap-anywhere` for the
  same problem.
- **Effort:** S
- **Done statement:** a 70-character name with a 36-character word wraps inside the viewport at 390 px with no
  horizontal overflow.
- **Screenshots:** `~/dev/t494-shots/item02-person-name-overflow-390.png` and
  `~/dev/t494-shots/item02-person-name-1440.png`.

### 3. A long URL or token breaks out of the Evry user bubble
- **Screen:** the Evry panel, user message bubble. Source: `apps/web/src/features/evry/conversation/EvryPanel.tsx:381`.
- **Wrong today:** the bubble has `whitespace-pre-wrap` but no word-break rule. A pasted URL overflows the dark bubble
  and the sheet edge at 390 px.
- **Fix:** plain CSS. Add `wrap-anywhere` (overflow-wrap: anywhere) to the bubble.
- **Effort:** S
- **Done statement:** a 130-character unbroken URL wraps inside the bubble at 390 px.
- **Screenshot:** `~/dev/t494-shots/item03-evry-bubble-overflow-390.png`.

### 4. On phones, records tables hide every column but the first, with no hint that more exist
- **Screen:** shared `DataTable`, seen on `/people` (List view). It is also used by the Meetings list and the guest
  list. Source: `packages/ui/src/display/DataTable.tsx:115-121`.
- **Wrong today:** at 390 px the People table is 1,190 px wide inside a 309 px scroller. Only Person shows. Stage,
  Commitment, Source and Added sit off-screen, with no shadow, fade or sticky column to say the table scrolls.
- **Fix:** plain CSS, following the beautifului.dev Records Table pattern:
  - make the first column `position: sticky; left: 0` with the row background
  - add a right-edge fade while `scrollLeft < scrollWidth − clientWidth`, either with CSS scroll-driven animation
    (`animation-timeline: scroll(inline)`) or with a static mask on the region
- **Effort:** S
- **Done statement:** at 390 px the first `DataTable` column stays in view while scrolling sideways, and a right-edge fade
  shows whenever columns are hidden.
- **Screenshot:** `~/dev/t494-shots/item04-datatable-hidden-columns-390.png`.

### 5. Filter chips wrap into four or five rows on phones and push the list below the fold
- **Screen:** the filter rows on `/people` (`apps/web/src/features/people/PeopleScreen.tsx:225`) and `/tasks`
  (`apps/web/src/features/tasks/TasksScreen.tsx:1160`), built from the shared `FilterChip`
  (`packages/ui/src/controls/Combobox.tsx:185`).
- **Wrong today:** the rows use `flex flex-wrap`. At 390 px People shows search, then four rows of chips, then the view
  switch, and the first person starts around y=650. On Tasks the first row starts below the fold.
- **Fix:** plain CSS, in one new shared `FilterRow` wrapper in packages/ui that both screens adopt:
  - below `app-sm`, the chips sit on one line with `overflow-x-auto`, `scroll-snap-type: x`, no visible scrollbar and an
    edge fade
  - search stays full width above the chips
- **Effort:** M
- **Done statement:** at 390 px the People and Tasks filter chips take one scrollable line, and the first record is
  visible without scrolling.
- **Screenshots:** `~/dev/t494-shots/item05-filters-people-390.png` and
  `~/dev/t494-shots/item05-filters-tasks-390.png`.

### 6. Page header actions stack into several rows of buttons on phones
- **Screen:** shared `PageHeader` (`packages/ui/src/controls/PageHeader.tsx:68`). The worst case is
  `/organization/pipeline`, with five actions. People has three.
- **Wrong today:** the actions `flex-wrap`. At 390 px the Grace Austin pipeline shows Import, Export, Possible duplicates,
  Edit stages and Add person on three rows, and the primary action lands last. People spends two rows on Export, Import
  and Add person.
- **Fix:** below `app-sm`, `PageHeader` shows the primary action plus a ⋯ `Menu` that holds the secondary actions. The
  Menu comes from `packages/ui/src/controls/Menu.tsx`, which is Radix.
- **Effort:** M
- **Done statement:** at 390 px every `PageHeader` shows at most one primary button and one ⋯ menu, on a single row.
- **Screenshots:** `~/dev/t494-shots/item06-pageheader-actions-390.png` and
  `~/dev/t494-shots/item06-pageheader-people-390.png`.

### 7. People counts print raw: "of 1515 people", a "1503" column count, "All 1500"
- **Screen:** `/people` list footer and pipeline view. Sources:
  - `rangeText` in `apps/web/src/features/people/model.ts:184`
  - the shared `PipelineColumn` count at `packages/ui/src/display/Pipeline.tsx:98`
  - the import review segment count at `apps/web/src/features/people/import-export/ImportSteps.tsx:358`
- **Wrong today:** with 1,515 people the footer says "Showing 1–24 of 1515 people" and the Prospect column header says
  "1503". Overview ("1,515"), the import button ("Import 1,500 people") and Evry ("24 of 1,515") all format the same
  numbers.
- **Fix:** plain code: format these counts with `toLocaleString("en-US")` like the rest of the app. Animating changing
  counts is T-493 `NumberFlow` work, not this item.
- **Effort:** S
- **Done statement:** with 1,515 people, the People footer, the pipeline column counts and the import segment all show
  "1,515"-style grouping.
- **Screenshots:** `~/dev/t494-shots/item07-counts-pager-1440.png` and
  `~/dev/t494-shots/item07-counts-pipeline-1440.png`.

### 8. Evry's context chip never says which record it is using
- **Screen:** the Evry panel opened on `/people/[id]`. Source: `apps/web/src/features/evry/conversation/EvryPanel.tsx:583-596`.
- **Wrong today:** the chip says "Using the person on this page", with no name or avatar. The user has to trust that Evry
  means the person they are looking at.
- **Fix:** follow the beautifului.dev Context Cards pattern: a compact card with the avatar, the display name (truncated)
  and the record type, keeping the Leave out / Include page toggle. Its data comes from the page reference the panel
  already builds.
- **Effort:** S
- **Done statement:** with Evry opened on a person page, the context chip shows that person's avatar and name.
- **Screenshot:** `~/dev/t494-shots/item08-evry-context-unnamed-1440.png`.

### 9. Evry turns show no trace of the reads they ran
- **Screen:** the Evry panel. Sources: `apps/web/src/features/evry/conversation/EvryPanel.tsx:459-463` and
  `apps/web/src/features/evry/conversation/model.ts:93-99`.
- **Wrong today:**
  - while waiting, the only signal is a grey "Reading…" line, which is not in a live region.
  - once text starts, nothing shows that more reads are still running.
  - afterwards, nothing summarises which reads Evry ran. Result cards appear between the paragraphs.
  - The QA runtime is scripted and answers at once, so the screenshot shows the finished turn. Real-model turns spend
    several seconds on "Reading…".
- **Fix:** follow the beautifului.dev Thinking and Tool Chips pattern: one collapsible line per assistant turn, such as
  "2 reads · People 24 of 1,515 · Households 1".
  - It is built from the turn's existing `tool_result` events, so it is UI only, with no new stream events.
  - While the turn is live it shows "Reading…" with elapsed seconds in a `role="status"` region.
- **Effort:** M
- **Done statement:** each finished Evry turn shows a collapsed one-line summary of its reads, and a live turn
  announces its progress in a status region.
- **Screenshots:** `~/dev/t494-shots/item09-evry-no-trace-1440.png` and
  `~/dev/t494-shots/item09-evry-no-trace-390.png`.

### 10. One long email squeezes the People table and wraps its short columns at 1440 px
- **Screen:** `/people` list columns. Source: `COLUMNS` in `apps/web/src/features/people/PeopleScreen.tsx:428-469`.
- **Wrong today:** the email line has `truncate`, but the Person column has no width cap. One 97-character email widens
  the column, and every row's "Not recorded" and "Nov 18, 2026" then wraps onto two lines.
- **Fix:** plain CSS:
  - cap the Person column (`width`/`max-w` of about `36ch`) so the email truncates
  - add `whitespace-nowrap` to the Commitment, Adult or child, Source and Added cells
- **Effort:** S
- **Done statement:** with a 97-character email in the list, no People table cell wraps at 1440 px.
- **Screenshot:** `~/dev/t494-shots/item10-people-columns-wrap-1440.png`.

### 11. A bulk import floods Overview's Recent changes with 20 identical rows
- **Screen:** `/overview` Recent changes. Source: `apps/web/src/features/overview/cards.tsx:90-104`.
- **Wrong today:** after a 1,500-row import, all 20 slots read "<Name> added to People · Daniel Reyes · 10:55 PM". Every
  other recent change is pushed out.
- **Fix:** collapse consecutive entries with the same actor and kind within a few minutes into one row: "1,500 people
  added to People · Daniel Reyes · 10:55 PM", linking to People.
  - If the read returns only the latest 20, the grouping belongs in the overview read.
  - This is a plain code change, not a library.
- **Effort:** M
- **Done statement:** after a 1,500-row import, Recent changes shows one grouped "people added" row, and the earlier
  changes stay visible.
- **Screenshot:** `~/dev/t494-shots/item11-recent-changes-flood-1440.png`.

### 12. Partial Evry results end in "Ask Evry for page 2" with no link to the full list
- **Screen:** Evry result cards. Sources: `apps/web/src/features/evry/conversation/resultView.ts:1202` and
  `apps/web/src/features/evry/conversation/ResultCard.tsx:157-175`.
- **Wrong today:** "People · 24 of 1,515" ends with "More people match. Ask Evry for page 2." The only way onward is
  another chat turn, though the People screen can show the whole list.
- **Fix:** follow the beautifului.dev Streaming Text "sources" idea: the card footer links to its source screen, for
  example "Open all 1,515 in People →".
  - The link opens `/people` with the same filter, and only for operations that map to a list route.
  - Unmapped operations keep the current text.
- **Effort:** M
- **Done statement:** a partial People result card in Evry links to `/people` with the matching filter.
- **Screenshot:** `~/dev/t494-shots/item12-evry-partial-no-link-1440.png`.

### 13. The pipeline board drags only with a mouse, and moved cards jump instead of animating
- **Screen:** `/people?view=pipeline`. Source: `apps/web/src/features/people/PipelineBoard.tsx:244-262` (native HTML5
  `draggable` and `onDragStart`).
- **Wrong today:**
  - HTML5 drag and drop does nothing on touch, so phone users have only the ⋯ Move menu.
  - There is no keyboard drag.
  - Dropped or menu-moved cards teleport between columns with no drop animation.
- **Fix:** dnd kit, the pick-ui-library choice for drag and drop:
  - Pointer, Touch and Keyboard sensors with a `DragOverlay`, and a short layout transition on drop that is skipped under
    reduced motion.
  - Keep the ⋯ Move menu as the accessible fallback.
- **Effort:** M
- **Done statement:** on a touch viewport a pipeline card can be long-pressed and dragged to another stage, and the drop
  animates unless reduced motion is on.
- **Screenshots:** `~/dev/t494-shots/item13-pipeline-touch-390.png` and
  `~/dev/t494-shots/item13-pipeline-1440.png`.

### 14. Leadership conversations draws a trend as a row of number tiles
- **Screen:** `/organization/pipeline`, "Leadership conversations" card. Source:
  `apps/web/src/features/organizations/board/GoalsArea.tsx:219-262` (`Conversations` and `Row`).
- **Wrong today:** "By month" and "By quarter" are grids of grey tiles ("0 Jun 0 Jul … 2 Nov"). The trend, the reason the
  card exists, has to be read digit by digit.
- **Fix:** plain CSS bars, reusing the pattern Meetings already ships (`apps/web/src/features/meetings/Report.tsx:114`).
  Each bar's height is proportional to its count, with the count and label under it, and the grid stays a list for
  screen readers.
  - No chart library: six or four fixed bars don't justify recharts.
- **Effort:** S
- **Done statement:** the Leadership conversations card shows month and quarter counts as proportional bars, with the
  counts still readable.
- **Screenshot:** `~/dev/t494-shots/item14-conversations-tiles-1440.png`.

## Covered by T-493 (kept out of the ranked list)

- **Toasts:** `packages/ui/src/controls/Toast.tsx` is a hand-rolled Radix toast, and Sonner replaces it.
- **Phone side sheets:** the Evry panel, venues, the task sheet, templates and the wiki sheets. At 390 px the Evry sheet
  is a full-height side panel, and Vaul turns it into a bottom drawer.
- **Command menus:** `CommandPalette` and `Combobox` already run on cmdk 1.1.1. T-493 moves `MessageEditor`'s field menu
  and `WhoStep`'s picker onto it.
- **Changing numbers:** `NumberFlow` covers counts that change in place, such as Overview stat tiles and task totals.
  Item 7 is only about number formatting, which is a separate fix.

## pick-ui-library lens: what I checked

| Category | Where I looked | Finding |
|---|---|---|
| Animated numbers (outside T-493) | Overview stat tiles, import review, Ministries "0/3" | Nothing outside T-493's "numbers that change". Static numbers need no library. Only the raw formatting in item 7. |
| OTP inputs | `features/identity/*` (`SignInScreen`, `RegisterScreen`, `RecoveryScreens`), plus a grep for `one-time-code` and `maxLength={6}` | None: sign-in is email + password and recovery uses links. input-otp has nothing to replace. |
| Charts | Meetings trend (`meetings/Report.tsx:114`, CSS bars), Leadership conversations (`GoalsArea.tsx:219`, tiles), Ministries org chart (`teams/OrgChart.tsx`) | Every series is small and fixed. Use CSS bars (item 14), not recharts. No real-time data, so Liveline doesn't apply. |
| Drag and drop | `people/PipelineBoard.tsx` (HTML5 drag and drop), document editor tables (`documents/church/editor/table-extension.ts`, `ProseMirror`) | Use dnd kit for the pipeline board (item 13). Leave the editor to `ProseMirror`. |
| Virtualization | People list (24 per page, `people/model.ts:92`), Tasks (50, `tasks/model.ts:256`), import review (paged, `ImportSteps.tsx:286-289`, max 2,000 rows), Evry history (paged), Evry result cards (6, then "Show all") | Nothing renders 1,000+ rows. Virtuoso not needed. |
| Motion | `motion` 14.2.0 is already a dependency (marketing and `components/motion/*`). The product uses CSS keyframes in `controls.css` and `product.css`. | Fine for the product. Item 13 is the one place a layout animation adds meaning. |

### Places that should NOT get a library
- **Dialog, popover, sheet and menu enter/exit** (`.ef-dialog`, `.ef-pop`, `.ef-sheet` in `controls.css:204-244`): CSS
  keyframes with a reduced-motion guard already do this, and Motion would add weight for nothing.
- **Skeleton shimmer** (`.ef-skel`, `controls.css:198`): one CSS animation.
- **Theme cross-fade** (`ProductRoot.tsx:24-30`, `product.css:76-90`): already skipped under reduced motion. A
  library's view transitions would add nothing.
- **`EvryBot` float, blink and orbit** (`product.css:160-218`, `foundations/evry-life.ts`): CSS plus a small JS driver,
  already reduced-motion safe.
- **Meetings trend and item 14 bars:** small fixed series. Plain CSS stays lighter than recharts.
- **The church document editor** (`documents/church/editor/*`): `ProseMirror`/Tiptap owns its drag, tables and selection,
  and dnd kit would fight it.
- **Selects and comboboxes** (`Select.tsx` on Radix, `Combobox.tsx` on cmdk): already accessible primitives. Moving to
  base-ui would be churn without a user-visible gain.
- **Classnames:** the repo has `cn` (`foundations/cn.ts`). Don't add clsx or cva just because the list names them.

## beautifului.dev lens: Evry

| Surface | Today | Finding |
|---|---|---|
| Thinking traces | `EvryBot` mood plus a "Reading…" line (`EvryPanel.tsx:459`) | Item 9 |
| Streaming text with sources | Markdown blocks via `view.ts`, with result cards between the paragraphs | The cards act as sources. The gap is that partial results don't link out (item 12). Inline citation markers are not worth it yet. |
| Approval cards | `evry/review/ReviewCard.tsx`: state-toned header, spinner while saving, before→after `<dl>`, Approve / Revise / Cancel, an "Approve by" hint, truncated targets | Fine as is. The QA runtime is scripted for reads only, so I reviewed it in code and could not render it. The pager ("1 / 3") from the beautifului card only matters if one turn yields several proposals. |
| Tool chips | None; finished reads show only as result cards | Folded into item 9 (the read summary line). |
| Task rows | Tasks show as generic `ResultCard` rows with a name, a detail and a tag | Fine for reads. A status or due column would only matter if Evry gained task-writing flows. |
| Prompt bar | Autosizing textarea (`field-sizing: content`), Enter to send, Stop while busy, a photo button, an 8,000-character limit with a count | Fine apart from the 14 px font (item 1). `field-sizing` falls back to `rows={2}` with scrolling in Safari and Firefox, which is acceptable. |
| Context cards | "Using the person on this page" chip | Item 8 |

## beautifului.dev lens: data views

| View | Today | Finding |
|---|---|---|
| Records | `DataTable` (People, Meetings, guest list), plus Cards and Pipeline views | Items 4 and 10 |
| Filter table | `FilterChip` rows on People and Tasks; Tasks' status totals sit in a separate side card | Layout fix in item 5. Counts on status chips (the Filter Table idea) would be a nice follow-up, not top 15. |
| Diff table | `ReviewCard` before→after (`ReviewCard.tsx:935-970`), import duplicate choices (`ImportSteps.tsx`) | Fine as is: both show before and after with explicit choices. |
| Command search | `CommandPalette` (cmdk) for wiki and app search; the input is 17 px, so it doesn't zoom | Fine as is, and cmdk is covered by T-493. |
| Insight cards | `InsightCard` (gradient card, e.g. "3 ministries have no leader"), Overview stat tiles, the Plant Intelligence card | Fine as is visually. The one weak card is Leadership conversations (item 14). |

## Motion lens

**Missing motion:**
- Pipeline moves teleport between columns (item 13).
- New Evry blocks pop in with no fade, and `followEnd` (`EvryPanel.tsx:75-112`) sets `scrollTop` directly, so the panel
  jumps on each block. A 150 ms opacity/translate on new blocks (CSS `@starting-style`) and a reduced-motion-guarded
  smooth scroll would help. Too small to rank.
- Evry "Show all 14" (`ResultCard.tsx:157`) expands instantly. That is acceptable.

**Excessive or unguarded motion:**
- None found in the product. Every keyframe in `controls.css` and `product.css` sits under a
  `prefers-reduced-motion: reduce` guard, the theme fade checks `prefersReducedMotion()`, and `Spinner` has
  `motion-reduce:animate-none`.
- One smooth scroll is unguarded: `intelligence/CheckInScreen.tsx:150`
  (`scrollIntoView({ behavior: "smooth" })`). It should honour reduced motion. One line, not ranked.
- The `.reveal` stagger (`product.css:102`) is used only in the design previews.

## Mobile-native lens (390 px)

| Check | Result |
|---|---|
| Tap highlight | Not set anywhere: a grep for `tap-highlight` in apps/web and packages/ui finds nothing. iOS shows its grey flash on every link and button on top of our own pressed states. Fix: `-webkit-tap-highlight-color: transparent` on `[data-product-root]` in `controls.css`, which is S. Unranked because Chromium can't screenshot the flash. Code reference only. |
| `100vh` | Fine. The product uses `dvh` everywhere: `AppShell.tsx:51`, `Dialog.tsx:18`, `SettingsDialog.tsx:156`, `Bell.tsx:57`, the auth and RSVP screens. The only `100vh` is in the marketing `PinnedRail.tsx:182`, which is out of scope. |
| Input zoom | Fails: every input is 14 px (item 1, with measured screenshots). |
| Safe areas | `env(safe-area-inset-*)` is used in four places: the sticky Card footer at `Card.tsx:159`, the check-in footer at `meetings/CheckInScreen.tsx:275`, the wiki editor at `wiki/editor.tsx:367`, and `SiteNav.tsx:66`. The viewport (`components/viewport.ts:4`) does not set `viewportFit: "cover"`, so those insets are 0 in Safari tabs. That is harmless there, because Safari pads its own chrome. It matters only for a standalone or home-screen mode. No change needed today. |
| Hover on touch | Fine. Tailwind 4.3's `hover:` only fires under `(hover: hover)`. The only hover-revealed controls are in the document editor (`editor.css:247` and `:350`), and both also reveal on selection or `:focus-within`. The Teams card arrow (`teams/parts.tsx:57`) is decorative. The disabled Evry button's `title` tooltip ("Evry is off on this page") never shows on touch, which is minor. |

## Break-ui lens (entered data)

**Long names:**
- The person header overflows (item 2).
- The People list truncates the email but lets it widen the column (item 10).
- Pipeline cards truncate correctly ("Maximiliana Alej…").
- Recent changes wraps the name cleanly.

**Long tokens:** the Evry bubble overflows (item 3).

**Empty lists:**
- Tasks "Nothing on your list" with a Show all action, pipeline columns "No one at this stage", Evry's empty chat with
  suggestions, and Messages' empty filters are all designed and fine.

**Huge counts (1,515 people):**
- The People pager, pipeline counts and import segment are unformatted (item 7).
- Recent changes floods (item 11).
- Overview tiles ("1,515") and the Evry card ("24 of 1,515") are fine.
- Evry's prose says "1515 matched", but that text comes from the scripted QA runtime, not the UI.
- The People pager shows "1 2 3 … 64" and works.

## Evidence

- All screenshots: `~/dev/t494-shots/` (outside the repo).
- Proof bundle, all item screenshots in one HTML: `~/dev/t494-shots/proof-shots.html`.
- File-only diff: `~/dev/t494-shots/diff-check.txt`.

## Risk

None to the code: this audit file is the only change. The ranking (criterion 13) is my call and waits for Sebastian. Items 1, 2, 3,
4, 7 and 10 are S-sized CSS fixes that could ship as one batch if he prefers.
