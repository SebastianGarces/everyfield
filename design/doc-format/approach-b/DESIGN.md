# Approach B: one block tree, laid out by the page

Status: design proposal for OPS-104. Nothing here is built in the app. Sebastian compares this approach with the other two and picks.

## The idea

Every Everyfield template and every document is one JSON envelope with a tree of blocks. Prose, cards, sign-in sheets, agendas, checklists and budgets all use the same envelope and the same editor. There is no second kind of document for "fixed layouts". A card is a box, a row of columns, a table and two write-in rows. A sign-in sheet is a heading and a table whose one row repeats 18 times. A budget is a ledger block.

Four choices make this approach different from "put Tiptap JSON in a column":

1. **Printing several on a sheet is a page setting.** Today's commitment card is a 4.25 × 5.5 in page. People print four on a Letter sheet and cut. In approach B the user designs one card. The page setup says "impose 2 across, 2 down on Letter, with cut lines". The editor never shows four copies to keep in sync, and the PDF prints four.
2. **A budget is a ledger, not a grid of cells.** A ledger has groups (Income, Expenses), lines and results (Net = Income minus Expenses). The app computes totals. The XLSX exporter compiles the same structure into live formulas. Nobody types `=SUM(B4:B8)`, and a row can never break a formula.
3. **A write-in is not a field.** A field is a value the app knows (church name, meeting date). A write-in is blank space a person fills by hand or in a fillable PDF (a signature line, a check box, a table cell). Today's code mixes both under "fields". The format keeps them apart, so a sign-in sheet has 90 write-in cells and zero data fields.
4. **Blocks name brand roles, never colors.** A box is `primary`, a badge is `accent`. The church brand kit (WP-104) decides the color, and the renderer picks black or white text by contrast. A church cannot make an unreadable card.

## Schema

The machine-readable definition is [`format/schema.json`](format/schema.json) (JSON Schema draft 2020-12). [`format/validator.mjs`](format/validator.mjs) checks the schema plus the rules JSON Schema cannot state (unique ids, declared fields, table shape, ledger references, imposition fit). `node tools/validate.mjs` runs it with no install.

### Envelope

| Property | Type | Meaning |
|---|---|---|
| `format`, `formatVersion` | `"everyfield.doc"`, `1` | The format and its schema version. |
| `kind` | `template` or `document` | The one difference between a template and a document. |
| `id`, `version` | id, integer | Template id and version, or document id and revision. |
| `title`, `description` | text | Shown in the library. |
| `class` | `formal/legal`, `outward-facing`, `operational` | Picks the brand rules for the class. |
| `origin` | null or `{ templateId, templateVersion, forkedFrom? }` | Where a document came from. Null for a blank start. |
| `notices` | `[]` or `["template-not-legal-advice"]` | Renderer-printed notices. See "Locked or required parts". |
| `page` | page setup | Size, orientation, margins, imposition. |
| `fields` | field definitions | The merge data this document uses. |
| `header`, `footer` | blocks, optional | Printed on every page. |
| `body` | blocks | The content. |

### Blocks

Every block has a `type` and an `id` (lowercase, unique in the document). Ids make move, delete, comments and stable PDF form-field names possible.

| Block | Properties | Holds |
|---|---|---|
| `heading` | `level` 1 to 3 (1 is the title), `numbered` | inline content |
| `paragraph` | `variant` body, lead, note or kicker; `align` | inline content |
| `list` | `style` bullet, number or check | items, each with an id and inline content |
| `quote` | | inline content |
| `divider` | `weight` hair, rule or bar; `tone` | nothing |
| `spacer` | `size` in points | nothing |
| `pageBreak` | | nothing (top level of the body only) |
| `slot` | `label` | prose blocks only; prints a visible blank when empty |
| `brand` | `element` logo, name, tagline, contact or photo; fixed `width`, `height`; `align` | nothing; the brand kit fills it |
| `fillRow` | `cells`: label, `kind`, share `width`, optional `field` | labelled write-in boxes on one line |
| `columns` | `columns`: share `width` and blocks; `gap`; `valign` | 1 to 4 columns of blocks |
| `box` | `tone`, `padding`, `border`, `minHeight` | blocks |
| `table` | `columns` (label, share width, align), `header` style, `zebra`, `rules`, `rowHeight`, optional `repeat { count, source? }` | rows of cells |
| `ledger` | `sheet`, `currency`, `periods { count, label }`, `total { label, rule, factor? }`, `groups`, `results` | groups of lines with amounts |
| `ledgerSummary` | `sheet`, `ledger` (id), `show` total and/or average | nothing; it reads a ledger |

A table cell is one of four kinds: `text` (inline content), `fill` (a write-in of a `kind`), `counter` (the row number of a repeating table) or `data` (a value from the repeat source, for example `item.time`).

Fill kinds: `text`, `date`, `number`, `checkbox`, `signature`, `email`, `phone`.

### Inline nodes and marks

| Inline node | Properties | Meaning |
|---|---|---|
| `text` | `text`, `marks` | A run of text. |
| `field` | `key` | A merge value. Prints the value, or `[label]` when empty. |
| `prompt` | `text` | A placeholder the church replaces, today's `[number]` and `[date]`. Prints as `[text]` so nobody misses it. |
| `badge` | `text`, `tone` | A short filled tag, for example GROW, PRAY, GIVE on the commitment card. |
| `pageNumber` | | "Page n of m". Header and footer only. |

Marks: `bold`, `italic`, `underline`, `link` (`href` must start with `https://`, `http://`, `mailto:` or `tel:`). There is no color, font or size mark. Type sizes come from the block (`heading` level, `paragraph` variant) and the page size.

## Page setup

```json
"page": {
  "size": "card",
  "orientation": "portrait",
  "margins": { "top": 14, "right": 14, "bottom": 14, "left": 14 },
  "imposition": { "sheet": "letter", "across": 2, "down": 2, "cutMarks": true }
}
```

- `size` is a preset (`letter`, `legal`, `a4`, `half-letter`, `card` 4.25 × 5.5 in) or `custom` with `width` and `height` in points.
- `orientation` swaps width and height.
- `margins` are in points (72 per inch). The validator refuses margins that leave less than half an inch.
- `imposition` is null, or a sheet with copies across and down. The validator checks that the grid fits the sheet in one orientation; the renderer picks that orientation. Each trim page is printed `across × down` times on its own sheet. Cut lines are optional.
- Type scales with the page: a page narrower than 420 pt sets smaller type, so a card and a Letter page use the same block styles.

The prototype's Page setup panel edits all of these, and the paged preview follows each change.

## Layout primitives

Layout comes from five blocks and the page. There is no absolute positioning.

- `columns` puts blocks side by side with share widths out of 12. The card masthead is two columns (logo, kicker).
- `box` is a filled or bordered region with padding and a minimum height. The card cover is a `primary` box.
- `table` is a grid with typed columns. A static table has rows of text, write-ins or both. A repeating table has one row that prints `count` times, with an optional `counter` column. With `repeat.source` the rows come from app data (an agenda's items), and `count` blank rows print when the data is empty. This is how agendas meet Sebastian's Oct 30 ask that an agenda prints from the meeting record.
- `fillRow` is a line of labelled write-in boxes (Name, Email or phone).
- `ledger` and `ledgerSummary` lay out a budget.
- The page adds margins, a header and a footer on every page, and imposition.

Each of today's code layouts maps onto these:

| Today's layout (`packages/domain/src/documents/layouts/`) | Approach B |
|---|---|
| `card.tsx` | card page + imposition; `box` (primary) with `columns` (logo, tagline, photo); `divider` bar; `columns` (title, kicker); `table` with check-box, badge and text columns; two `fillRow`s; footer `brand contact` |
| `sign-in.tsx` | header `columns` (logo, kicker); `divider` bar; title; lead paragraph with a field; `fillRow` with meeting fields; repeating `table` with a `counter` column, 18 rows |
| `agenda.tsx` | meta `fillRow`s; repeating tables with `source: meeting.agenda_items` and `meeting.attendees`; a static action table |
| `checklists.tsx` | per team: a heading, a `fillRow` for the lead, a table with check-box, task, owner and time columns |
| `church-doc.tsx` + `blocks.tsx` + `shell.tsx` | header masthead, title, prose blocks, adoption table (repeating, 3 rows) or signature `fillRow`, footer with field text and `pageNumber` |
| `xlsx.ts` budgets | `ledger` (12 months or monthly × 12) and `ledgerSummary` |

## Fields and merge data

```json
"fields": [
  { "key": "church.name", "label": "Church name", "type": "text", "source": "church.name", "value": null, "required": true },
  { "key": "meeting.number", "label": "Meeting number", "type": "number", "source": "meeting.number", "value": null }
]
```

- A document declares every field it uses. The validator refuses an inline `field` or a `fill.field` with no declaration.
- `source` names app data from a fixed registry in code: `church.name`, `church.legal_name`, `pastor.name`, `meeting.date`, `meeting.number`, `meeting.agenda_items`, `meeting.attendees` and later more. `null` means the user types the value.
- At fork time the app copies each source value into `value`. The document owns the copy: a later change to the church profile does not rewrite a signed policy. A "Refresh from profile" action can pull values again on purpose.
- A field with no value prints `[label]` in lower case, as today's `blankFor` does. The renderer never invents a name.
- A `fill` cell can bind to a field (the meeting date box on the sign-in sheet prints the date when the meeting has one and stays a write-in box when not).
- Users add fields in the Fields panel and insert them into any text from the toolbar.

## Locked or required parts

The content tree has no locked blocks. A fork can change or delete any block, and a wipe removes all of them. Sebastian said "They can fork it and completely wipe it if they want", and a lock inside the tree would contradict that.

One thing is not content: the `notices` list on the envelope. Today it holds at most `template-not-legal-advice` (DOC-019). The renderer prints it in the footer of every page of the PDF and the DOCX. The editor has no control for it, a fork copies it and a wipe keeps it. The validator requires it on every `formal/legal` document.

How a user gets rid of it: a fork of a legal template keeps it, by DOC-019. A user who wants a document without it starts an empty document, which has no notice. The prototype shows the notice in the banner of a forked policy ("Required notice ... A wipe keeps it") and on every preview page.

If Sebastian reads "do whatever they want" to include the notice, the change is one rule: let the document settings clear `notices`. The format does not change.

Doctrinal slots (DOC-020) are ordinary `slot` blocks. A slot keeps its label and prints a visible blank until someone fills it. A user can delete it like any other block. Deleting a slot is a choice, and an empty slot never prints doctrine Everyfield wrote.

## Template envelope

A template is the same envelope with `kind: "template"`. There is no template-only wrapper, no frame and no layout code.

- Everyfield templates live as JSON files in the repo (one file per id) and load into the library. CI validates each file.
- Catalog facts that are not content stay in `docs/catalog/document-templates.json` (priority, phase, class). The `editable` flag goes away: every template is editable. The `formats` list becomes: PDF and DOCX for everything, plus XLSX for any document with a ledger.
- A church can save one of its documents as its own template: copy it, set `kind: "template"`, keep `origin`.

## Versioning and forking

- `formatVersion` is the schema version. A change to the schema ships a pure migration `vN → vN+1`. The app runs migrations on read and writes the new version on the next save. Old revisions migrate the same way when opened.
- A template `version` goes up when its content changes. Each version stays readable, because documents name the version they came from.
- Fork (`format/ops.mjs`, `fork`) is a deep copy: `kind` becomes `document`, a new `id`, `version` 1 and `origin { templateId, templateVersion }`. A fork of a document adds `forkedFrom`. The copy never follows later template changes, the same rule as today's `createFromTemplate`.
- Wipe (`wipe`) empties `body`, `header`, `footer` and `fields`. It keeps `id`, `origin`, `page` and `notices`.
- Each save stores the whole envelope as one `document_revision` row (today the row stores the body JSON). The revision list, restore and exact-byte saved exports (DOC-002, DOC-003) work as they do now.

## Rendering path

One tree, four renderers. Each is a walk over the blocks with one function per block type. No template has its own render code.

1. **Editor.** A block editor renders each block as a view with a control bar (move, delete, insert below, type settings). Text runs are editable in place. Layout blocks render their children as nested lists. The paged preview beside it paginates the same tree.
2. **PDF.** A generic Forme (`@formepdf/react`, already in the repo) walker replaces `card.tsx`, `sign-in.tsx`, `agenda.tsx`, `checklists.tsx` and `church-doc.tsx`. Write-ins become Forme fillable fields named `<blockId>.<row>.<column>`, so the names stay stable across edits. Imposition renders a sheet-size `Page` with the trim page placed `across × down` times.
3. **DOCX.** The `docx.ts` writer becomes a generic walker. Page setup goes to `w:sectPr`, the header and footer to `header1.xml` and `footer1.xml` with `PAGE` and `NUMPAGES` fields, layout blocks to tables.
4. **XLSX.** Only ledgers export to XLSX. Each `ledger` becomes a sheet and each `ledgerSummary` a sheet with formulas that read it. The rest of a budget document (title, note) becomes the sheet's title and note rows.

### Mapping table

| Node or mark | Editor view | PDF (Forme) | DOCX |
|---|---|---|---|
| page setup | Page setup panel; paged preview | `Page size` and `margin` | `w:pgSz`, `w:pgMar`, `w:orient` |
| imposition | Page setup panel; preview shows the sheet with cut lines | sheet-size `Page`, trim page placed in a grid of `View`s, cut lines as thin `View` borders | sheet-size section, grid table with exact row heights (`w:trHeight hRule="exact"`), one copy per cell |
| header, footer | "Header (every page)" and "Footer (every page)" lists | `Fixed position="header"` / `"footer"` | `header1.xml`, `footer1.xml` |
| notice | banner badge; footer line in preview | footer `Text`, bold, every page | footer paragraph, bold |
| `heading` | editable text, level and numbered controls | `Text` in the theme title style; level 1 in the display font | `Heading1` to `Heading3` styles; `numbered` uses a numbering definition |
| `paragraph` | editable text, variant and align controls | `Text` with the variant size and color | `w:p` with a paragraph style per variant |
| `list` | editable items; Enter adds an item | `View` rows with bullet, number or check box | `w:numPr` numbering; check style uses a ☐ glyph |
| `quote` | editable text | `View` with a left rule, italic `Text` | `Quote` style |
| `divider` | rule with weight and color controls | `View` with a top border | paragraph bottom border (`w:pBdr`) |
| `spacer` | hatched strip | empty `View` of the height | paragraph with exact spacing |
| `pageBreak` | dashed "Page break" line | `break` before the next `View` | `w:br w:type="page"` |
| `slot` | dashed region with label and child list | labelled `View`; blank note when empty | labelled paragraph; blank note when empty |
| `brand` | logo, name, tagline, contact or photo from the kit | `Image` in a fixed slot, or the church name set in type | inline `w:drawing` with fixed extent, or text |
| `fillRow` | labelled boxes with kind and width controls | label `Text` + Forme `TextField`, `Checkbox` or signature field | label paragraph + bordered empty cell in a borderless table |
| `columns` | side-by-side child lists | `View flexDirection="row"` with share widths | borderless one-row table with share widths |
| `box` | filled region with fill, padding and border controls | `View` with background, padding, `minHeight` | one-cell table with `w:shd` fill and padding |
| `table` | header labels, column kinds and widths, rows, repeat controls | table of `View` rows; `wrap` splits rows across pages; header row repeats | `w:tbl` with `w:gridCol` from shares; `w:tblHeader` repeats the header |
| cell `text` | editable text | `Text` | `w:p` in the cell |
| cell `fill` | kind hint | empty cell, or fillable field | empty cell; check box as ☐ |
| cell `counter` | row number | row number `Text` | row number text |
| cell `data` | `[path]` placeholder | value from the source row | value from the source row |
| `ledger` | amount inputs, live totals, line and group controls | table of computed amounts; empty inputs as boxed cells | table of computed amounts; note that live formulas are in the XLSX |
| `ledgerSummary` | computed summary | table of computed totals and averages | table of computed totals and averages |
| inline `text` | text | `Text` run | `w:r` |
| inline `field` | green chip with the value or `[label]` | the value or `[label]` | the value or `[label]` |
| inline `prompt` | yellow chip `[text]` | `[text]` on a light yellow background | `[text]` with `w:highlight="yellow"` |
| inline `badge` | filled tag | `View` with fill and contrast text | run with `w:shd` fill and contrast color |
| inline `pageNumber` | "Page 1 of 1" chip | `PageNumber format="Page {page} of {total}"` | `PAGE` and `NUMPAGES` fields |
| mark `bold`, `italic`, `underline` | B, I, U toolbar; Cmd+B, I, U | font weight, style, decoration | `w:b`, `w:i`, `w:u` |
| mark `link` | Link toolbar button | `Link` | `w:hyperlink` with a relationship |

### Budget nodes to XLSX cells

Budget export stays XLSX. The ledger maps to the same sheet shape `xlsx.ts` writes today, so the first-year budget workbook keeps its look. Row 1 is the title, row 2 the note, row 3 the header and data starts at row 4.

| Ledger part | XLSX cells |
|---|---|
| `ledger.sheet` | sheet name |
| `labelColumn`, period labels, `total.label` | header row: column A, columns B to M (12 periods) or B (1 period), then the total column |
| group | section row with the group label, styled as a section |
| line | label in column A; each amount is an input cell (empty when `null`); total cell `=SUM(B{r}:M{r})`, or `=B{r}*12` for the `times` rule |
| group subtotal | `=SUM(B{first}:B{last})` in each period column and the total column |
| result | per column, plus-group subtotals minus minus-group subtotals, for example `=B{income}-B{expenses}` |
| `ledgerSummary` | its own sheet; per line `='Monthly budget'!N{r}` for the total and `=B{r}/12` for the monthly average |

Budgets also get a PDF and a DOCX (today they are XLSX only). The PDF and DOCX print the computed numbers, so a treasurer can hand the board a printed budget. The XLSX keeps live formulas, so the board can try numbers in Excel.

## Editor library

Decision: **no editor library for the document structure.** Everyfield builds its own block editor for the tree. Inside a text block (heading, paragraph, list item, quote, table text cell), production uses Tiptap core (MIT) as the inline text editor, one small instance per text block, mounted only while that block has focus. The inline schema has one paragraph of text, the four marks and the four inline atoms. Tiptap's own history is off; the block editor keeps one undo stack of tree changes.

Why not one Tiptap document for everything, measured against the three layouts this format must build:

- **The 4-up card.** The card is a box holding columns holding brand blocks, and imposition lives in page setup. In Tiptap each of these is a custom node with a NodeView. Nested NodeViews inside one contenteditable are where selection and drag bugs live. In a block editor they are nested lists of blocks.
- **The sign-in sheet.** A repeating table is one row template with typed columns (counter, write-in, phone). `prosemirror-tables` models cells of rich text, with no column types and no "print this row 18 times". The table would need a custom NodeView anyway, and then Tiptap adds nothing.
- **The budget.** Ledger amounts are number inputs with live totals. Number inputs inside a ProseMirror contenteditable fight ProseMirror for focus and selection. A block editor renders them as ordinary inputs.
- **Pagination.** Tiptap's MIT core has no paged view. The paged preview here is a separate renderer of the tree, so it needs no editor support.

Where Tiptap is strong is the inline text: IME input, spellcheck, paste cleaning, marks, mobile keyboards. Keeping it at that level uses its strength and avoids its weakness.

The prototype goes one step further and uses no library at all: `contenteditable` text runs that parse back into inline nodes on each input ([`prototype/editor.mjs`](prototype/editor.mjs), `parseInline`). That is enough to prove the format and the layout building. It is not enough for production (IME and undo; see the risks).

## Tradeoffs and risks

**PDF fidelity of layouts.** The editor preview (HTML) and the PDF (Forme) are two renderers of one tree. Line breaks and page breaks will differ by a few points, so a block that ends a page in the preview can start the next page in the PDF. The prototype paginates block by block and cuts a block taller than a page; Forme splits paragraphs and table rows. Mitigation: in the app, the preview pane shows the real Forme PDF, rendered by the WASM engine in a worker, and the HTML view is the editing surface only. Risk left: render speed on long documents.

**DOCX fidelity of layouts.** Word has no fixed boxes. The format maps columns, boxes and imposition to tables. A 4-up card in Word is a 2 × 2 table with exact row heights; text that overflows a card cell is clipped in Word, where the PDF would show the problem in the preview. Fillable fields become empty cells, not Word form controls. Brand fills use cell shading, which some printers drop. The DOCX of a card or a sign-in sheet is good enough to edit, not identical in print. Prose documents (policies, letters) export to DOCX with no loss.

**Editor complexity.** Owning the block editor means owning cross-block selection, copy and paste of blocks, keyboard movement between blocks, drag to reorder, undo and redo of tree changes, focus management and screen-reader support for every control bar. That is weeks of work and a long bug tail. Tiptap inside text blocks removes the hardest part (text input), not the rest. Collaborative editing (two people typing at once) is out of reach without a CRDT layer; today's single-writer revisions stay.

**Budget formulas.** The ledger supports sums per line, subtotals per group, results that add and subtract groups, and the monthly-times-12 rule. It has no free formulas: no "giving is 10% of income", no growth rate, no IF. A church that needs those exports XLSX and works in Excel, and the app does not read the XLSX back. The way out is a small expression grammar over ledger ids in a later format version. Free cell formulas would bring back the broken-reference bugs the ledger avoids.

**No free positioning.** Layout is flow, columns, boxes and tables. A flyer with overlapping images, rotated text or a background image is out of reach. That is on purpose: every layout must survive DOCX and a phone screen.

**Imposition is step and repeat.** Four copies of one card fit. Four different cards on one sheet (for example one per guest name) do not, because v1 has no per-copy data merge.

**Two kinds of numbers on the page.** Field values are snapshots taken at fork time. A church that renames itself must refresh fields in old documents by hand. This is the right default for signed policies and the wrong one for a card printed every month.

**Brand roles only.** A user cannot pick a color for one box. Some churches will want that. The contrast rule and a consistent brand are the payoff.

**Data sources are code.** A repeating table with `source: meeting.agenda_items` needs that source in the registry. A new source is a code change, not something a church can set up.

**The validator is a subset.** `validator.mjs` implements the JSON Schema keywords this schema uses. Production would define the schema once in zod in `packages/contracts` and emit JSON Schema with `z.toJSONSchema()`, so the two cannot drift.

## Decisions recorded here

Reversible choices this design makes. Each one changes a rule, not the format shape.

- Imposition sits in page setup, not in the body.
- Budgets keep XLSX with live formulas and also gain PDF and DOCX.
- The legal notice is an envelope notice that a fork keeps and the editor does not edit.
- Field values are copied at fork time.
- Doctrinal slots are deletable.
- Type sizes come from block styles and page size; there are no size or color marks.
- The 7 email templates come into the format later, as an email profile (see [`PLAN.md`](PLAN.md)).
