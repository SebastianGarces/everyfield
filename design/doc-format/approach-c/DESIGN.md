# Approach C: an owned block tree with typed tables

This is approach C to the brief in OPS-105. It is one of three independent answers. I did not read the other two.

## The idea in one page

Every template and every document is one JSON envelope with one body. The body is a tree of blocks. Everyfield owns
the tree and its schema (`format.mjs`). No editor library defines it.

Three decisions make the cards, the sign-in sheet and the budgets ordinary documents:

1. **Tables have typed cells.** A cell holds text, a number or a formula. Formulas use the Word table vocabulary
   (`sum(above)`, `sum(left)`) plus named cells (`@income_total`). That one choice gives the budget live totals in the
   editor, real formulas in XLSX and field codes in DOCX. A budget is no longer a special file type. It is a document
   with a table in it.
2. **`repeat` prints its content across and down the page.** The 4-up commitment card is one card inside a
   `repeat` of 2 x 2. Edit card 1 and the other three follow. The same node gives 2-up half sheets, 10-up name badges
   and 3 x 10 labels.
3. **A field is one thing.** A `field` names a value in the envelope's field list. If the value has a source (church
   name, pastor name, meeting date) it fills from data. If not, it prints as a labelled write-in line or a blank. The
   old split between "merge fields" and "fillable form fields" goes away.

The rest is subtraction. Today's template frames (letterhead, signature block, adoption table, sign-off) become
ordinary body content that the user can change or delete. The body has no locked parts. The only thing a user cannot
remove is the "Template, not legal advice" notice. It is not content: export adds it to every formal/legal document,
and the editor shows it in the page margin.

The editor in the prototype uses no library. Only text leaves (a paragraph, a heading, a table cell) are
`contenteditable`. All structure (tables, columns, cards, boxes) is plain DOM that the editor rebuilds from the model.
Section [Why not Tiptap](#why-not-tiptap) explains the choice and its cost.

## Schema

The machine-readable schema is [`format.mjs`](format.mjs). It exports `NODES`, `MARKS` and `ENVELOPE` as plain data,
and `validate(doc)` checks a document against them. The prototype's Inspect panel builds its forms from the same
`NODES` data, so the schema also drives the editor UI. [`check.mjs`](check.mjs) runs `validate` in Node with no install.

Every node is `{ "type", "attrs"?, "content"? }`. A text node is `{ "type": "text", "text", "marks"? }`. A missing
attribute takes its default. An unknown attribute or key fails the check.

### Node types

Groups: an **inline** node lives in a text run. A **block** node lives in a block container (the body, a box, a column,
a fill-in section or a repeat). A **part** node lives only inside its one parent.

| Node | Group | Attributes (default) | Allowed children |
|---|---|---|---|
| `text` | inline | `text` (non-empty string), `marks` (list of marks) | none |
| `field` | inline | `key` (a key in the envelope's `fields`), `display`: `inline` or `line` (`inline`), `width` (pt, optional) | none |
| `checkbox` | inline | `key` (optional, unique; the PDF form field name) | none |
| `hardBreak` | inline | none | none |
| `heading` | block | `level`: 0 to 3 (1). Level 0 is the display title. | inline |
| `paragraph` | block | `align`: `left`, `center`, `right` (`left`); `size`: `small`, `body`, `large` (`body`) | inline |
| `list` | block | `ordered` (false) | `listItem`, at least 1 |
| `listItem` | part | none | `paragraph` first, then `paragraph` or `list` |
| `quote` | block | none | `paragraph`, at least 1 |
| `divider` | block | `weight`: `hairline`, `thin`, `thick`, `bar` (`thin`); `tone`: `ink`, `muted`, `primary`, `accent` (`ink`) | none |
| `pageBreak` | block, top level only | `sheet` (optional; the XLSX sheet name that starts here) | none |
| `slot` | block | `id` (unique), `label` | blocks, may be empty |
| `box` | block | `fill`: `none`, `muted`, `primary`, `accent` (`none`); `border`: `none`, `thin`, `thick` (`none`); `padding` pt (8); `minHeight` pt (optional) | blocks, may be empty |
| `columns` | block | `gap` pt (12); `align`: `top`, `center`, `bottom` (`top`) | `column`, 2 to 4 |
| `column` | part | `width`: a share of the row, 1 to 12 (1) | blocks, may be empty |
| `table` | block | `name` (optional; prefix of form field names); `columns`: list of `{ key, width, align? }`; `headerRows` 0 to 5 (1); `rules`: `grid`, `rows`, `none` (`grid`); `zebra` (false); `headerFill` (`muted`); `minRowHeight` pt (optional); `size`: `small`, `body` (`body`); `fillable` (false) | `row`, at least 1 |
| `row` | part | none | `cell`, at least 1; the spans add up to the column count |
| `cell` | part | `kind`: `text`, `number`, `formula` (`text`); `value` (number or null; number cells only); `formula` (formula cells only); `name` (optional, unique); `format`: `plain`, `currency`, `integer`, `percent` (`plain`); `fill` (`none`); `align` (optional); `colspan` 1 to 12 (optional) | inline, for text cells only |
| `repeat` | block, not inside another repeat | `across` 1 to 4 (2); `down` 1 to 6 (2); `gap` pt (0); `padding` pt (18); `cutMarks` (true) | blocks, may be empty |
| `logo` | block | `height` pt (34); `align` (`left`) | none |

Rules the validator adds to the table: field keys must exist in the envelope, slot ids and cell names and checkbox
keys are unique, header cells hold text only, a table needs a body row under its header, every formula parses and
evaluates without a missing name or a cycle, and a document holds at most 5,000 nodes and 2 MB of JSON.

### Mark types

| Mark | Attributes | Meaning |
|---|---|---|
| `bold` | none | Bold weight. |
| `italic` | none | Italic. |
| `underline` | none | Underline. |
| `strike` | none | Strikethrough. |
| `link` | `href` (starts with `https://`, `http://`, `mailto:` or `tel:`) | A hyperlink. |
| `tone` | `tone`: `muted`, `primary`, `accent` | Text color from the theme. Never a raw color, so the brand kit and the contrast rules stay in charge. |
| `caps` | none | Uppercase with letter spacing, for kickers and tiles. |

A text node holds each mark at most once. Marks serialize in a fixed order, so equal text gives equal JSON.

### Formulas

```
expr    := term (("+" | "-") term)*
term    := unary (("*" | "/") unary)*
unary   := "-" unary | primary
primary := number | "@" name | "sum(above)" | "sum(left)" | "above" | "left" | "(" expr ")"
```

`sum(above)` adds the number and formula cells straight above, up to the first text cell or the header. This is the
rule Word uses for `=SUM(ABOVE)`, and it maps to one Excel `SUM` range. `left` and `above` read the next cell. `@name`
reads a named cell anywhere in the document. An empty number cell counts as 0. A formula that names a missing cell,
reads a text cell, divides by zero or depends on itself is a validation error, and the editor shows `#ERROR` with the
reason. A new row copies the kinds and formulas of the row it came from, so `left * 12` keeps working on an added
budget line.

## Page setup

The envelope's `page` holds `size` (`letter`, `legal`, `a4`, `half-letter`), `orientation` (`portrait`,
`landscape`), `margins` in points (`top`, `right`, `bottom`, `left`, 0 to 144) and an optional `footer` (inline
content, so it can hold a field such as the church name). One page setup applies to the whole document. A
`pageBreak` starts a new page. A `repeat` divides the content area of the page into equal cells.

The 4-up card sheet uses letter portrait with zero page margins and an 18 pt padding inside each card, so each card is
exactly 4.25 x 5.5 inches and the cut lines fall on the quarter lines of the sheet. The padding keeps the content
inside the printable area of a home printer.

I left out per-section page setup (a landscape page inside a portrait document). No template in scope needs it.
Adding it later means a `section` node with its own `page`, and the envelope's `page` stays the default.

## Layout primitives

Eight general nodes do all the layout: `columns`, `box`, `table`, `repeat`, `divider`, `logo`, `field` and `checkbox`.
None of them knows which template it is in.

| Layout | The general nodes it uses |
|---|---|
| 4-up commitment card | `repeat` (2 x 2, cut marks) holding one card: a `box` with `fill: primary` (the cover) with a `logo` and a tagline `field`; a `divider` with `weight: bar` and `tone: accent`; `columns` for the title and the kicker; a `table` with `rules: rows` whose cells hold a `checkbox`, an accent-filled tile cell and the text; two `columns` rows of `field`s with `display: line` (Name, Email or phone, Signature, Date); a `divider` and a paragraph with the pastor-name `field`. |
| Guest sign-in sheet | `columns` with the `logo` and a kicker; a `divider` bar; a level-0 `heading`; a paragraph with the church-name `field`; a paragraph with two `field`s as write-in lines with widths 170 and 110 pt; a `table` with `headerFill: accent`, `zebra`, `minRowHeight: 25`, `fillable` and 18 blank body rows; the page `footer`. |
| Budget worksheet | A level-0 `heading` with the church-name `field`; a muted paragraph; one `table` with `headerFill: primary`, `rules: rows`, muted-fill section rows, `number` cells for the monthly amounts, `formula` cells `left * 12` for the annual amounts, `sum(above)` totals with names, and a net row `@income_monthly - @expenses_monthly`. |
| Policy | `columns` with the `logo` and a kicker; a `divider`; a level-0 `heading`; level-1 `heading`s (numbered by the theme); paragraphs and lists with fields; the closing paragraph; an adoption `table` with `fillable` blank rows. |

### One format for all

All four examples have the same envelope keys and use the same node and mark set. No node is tied to a template:

- `tests/format.test.mjs` builds one document that uses every node type and every mark at once, and it passes the
  check.
- In the prototype the reviewer inserts every block type, a `repeat` and a `table` included, into the policy copy. The
  result passes the check (proof for criterion 9).
- The reviewer builds a card sheet, a sign-in sheet and a budget from an empty document with the same insert menu.

Which example uses which node today:

| Node or mark | Policy | Card sheet | Sign-in | Budget |
|---|---|---|---|---|
| `text`, `field`, `heading`, `paragraph`, `table`, `row`, `cell`, `bold`, `tone` | yes | yes | yes | yes |
| `divider`, `columns`, `column`, `logo` | yes | yes | yes | no |
| `caps` | yes | yes | yes | no |
| `list`, `listItem` | yes | no | no | no |
| `checkbox`, `box`, `repeat` | no | yes | no | no |
| `hardBreak`, `quote`, `pageBreak`, `slot`, `italic`, `underline`, `strike`, `link` | no | no | no | no |

The last row is used by other templates in scope (the bylaws need a `slot` for the statement of faith; the first-year
budget needs a `pageBreak` with `sheet: "Annual summary"`) and by the policy edits in the prototype.

## Fields and merge data

The envelope's `fields` is a list of `{ key, label, source, default?, type }`.

- `source` is one of a fixed list (`church.name`, `church.legal_name`, `church.tagline`, `church.address`,
  `church.phone`, `church.email`, `church.web`, `pastor.name`, `meeting.date`, `meeting.number`, `today`) or `null`.
- A `field` node in the body names a key. It is an atom in the text: the user cannot type inside it, and the
  validator rejects a key that the list does not hold.
- At render the value is, in order: a value the render call passes (for example the meeting the user prints an agenda
  from), the source value, the `default`, then nothing.
  With nothing, an `inline` field prints `[church name]` (today's blank rule in `church.ts`) and a `line` field prints
  a write-in line with its label under it.
- A field with `source: null` is a write-in: Name, Signature, Date on the card.
- Tables with `fillable: true` name each empty body cell `{table name}_{row}_{column key}`, for example
  `guest_3_email`. These are the same PDF form field names that `sign-in.tsx` and `church-doc.tsx` make today.

The user adds a field in the Fields panel (label, source, default) and inserts it from the toolbar. Changing a field's
label changes every place it prints. Removing a field that the body still uses is refused.

Merge happens at render time, not at creation. Today `createFromTemplate` writes the church name into revision 1. In
this format the body keeps the field, so a church that changes its name gets the new name on the next export. A user
who wants fixed text deletes the field and types the name.

## Locked or required parts

**The body has no locked parts.** Sebastian's words decide this: "They are a template, the user can do whatever they
want with them. They can fork it and completely wipe it if they want." A lock in the body would contradict that, and
it would also need lock rules for every node (can a locked table get rows? can text go between two locked blocks?).

Two product rules survive without locks:

- **DOC-019, the legal notice.** "Template, not legal advice" is not a node. `noticesOf(doc)` derives it from
  `meta.class === "formal/legal"`. Export prints it in the page margin of every page, and the editor shows it in the
  margin with a tooltip that says it is added at export. Wiping the body cannot remove it. A document made from a
  template keeps the template's class, and the prototype does not let a copy change it.
- **DOC-020, doctrinal slots.** The statement of faith becomes a `slot` node. It prints a labelled blank box until
  someone fills it. It is not locked: a church that deletes the section has made a choice the format respects. If the
  product wants a stronger rule, the right place is an export-time warning ("this bylaws document has no statement of
  faith"), not a lock in the editor.

Required parts (for example "a sign-in sheet must have a table") are not part of the format. A template that needs a
part says so in its description.

## The template envelope

```json
{
  "format": "everyfield.doc",
  "formatVersion": 1,
  "kind": "template",
  "id": "guest-sign-in-sheet",
  "version": 1,
  "origin": null,
  "meta": { "title": "Guest Sign-in Sheet", "description": "Sign-in sheet for a vision meeting.", "class": "operational" },
  "page": { "size": "letter", "orientation": "portrait", "margins": { "top": 40, "right": 40, "bottom": 56, "left": 40 }, "footer": [] },
  "theme": { "numberHeadings": false },
  "fields": [{ "key": "church_name", "label": "Church name", "source": "church.name", "type": "text" }],
  "body": []
}
```

A template and a document have the same shape. `kind` says which one it is, and `origin` says where a document came
from. There is no `formats` list: every document exports PDF and DOCX, and every document with at least one table also
exports XLSX. The brand kit (colors, logo, fonts) is not in the envelope. Render reads it from the church, so one
template looks right for every church.

Storage stays as it is today: the `document` row holds the envelope minus the body, and `document_revision.body`
holds the body JSON. Templates live as JSON files in the repository (one file per template) instead of TypeScript.

## Versioning and forking

- `formatVersion` is the schema version. A change that can break old documents bumps it and ships a pure migration
  function `migrate_N_to_N+1(doc)`. The loader migrates on read and the next save writes the new version. Adding an
  optional attribute or a new node type does not bump it.
- A template's `version` goes up when its content changes. A document's `version` counts its revisions.
- Forking copies the whole envelope: `fork(template, id)` sets `kind: "document"`, `version: 1` and
  `origin: { template, version }`. The copy never follows later template changes, as `createFromTemplate` does today.
  The prototype shows this: the copy's bar reports "template unchanged" with a fingerprint, and the template's JSON is
  byte-for-byte the same after the copy is edited.
- `wipe(doc)` empties the body and the footer. The envelope (title, class, page setup, field list) stays, so a wiped
  document is still valid and still prints its legal notice when it is formal/legal.
- `origin` is kept only as information ("made from Bylaws v3"). A later feature can offer "compare with the current
  template" by diffing two bodies. No merge is planned.

## Rendering path

One tree, four renderers. Each renderer is a function from (envelope, brand kit, field values) to output. None of them
knows template ids.

- **Editor.** The block tree renders to DOM. Text leaves are `contenteditable`. Every keystroke parses the leaf DOM
  back into inline nodes (`parseInline`) and writes them to the model. Marks, fields, Enter, Backspace and Tab are
  model operations: the editor computes character offsets, changes the inline array and re-renders the leaf. Structure
  changes (insert, delete, move, table rows and columns, inspector edits) change the model and re-render the page.
  Undo is a stack of model snapshots.
- **PDF.** The production path walks the same tree into Forme (`@formepdf/react`) components: `table` to `DataTable`
  and `Cellfield`, `field` with `display: line` to `Field`, `box` to a filled `View`, `repeat` to a `View` grid with
  fixed cell sizes on one `Page` per sheet. The prototype proves the layout with the browser's print to PDF: `@page`
  takes the document's size and margins, and the footer and legal notice print in the page margin boxes.
- **DOCX.** Today's `docx.ts` writes WordprocessingML by hand. The new renderer walks the tree into the same XML.
- **XLSX.** Today's `xlsx.ts` writes the budget sheets by hand. The new renderer walks the tree: each `table` becomes a
  cell range, text blocks become single-cell rows above it, and a `pageBreak` with a `sheet` name starts a new sheet.

### Mapping table

| Node or mark | PDF (Forme) | DOCX | XLSX | Lossy cases |
|---|---|---|---|---|
| `heading` | `Text`; level 0 in DM Serif Display, level 1 with the numbered tile when `numberHeadings` | `Heading 1` to `Heading 3` and `Title` styles; numbering through a numbered-heading style | One bold row (title style for level 0) | XLSX drops the numbering tile. |
| `paragraph` | `Text` with size and alignment | `w:p` with `w:jc` and size | One row, text in column A | XLSX: long text stays in one cell. |
| `text` + marks | Nested `Text` runs | `w:r` with `w:b`, `w:i`, `w:u`, `w:strike`, `w:caps`, theme color | Rich-text run in the cell | XLSX rich text supports all marks but `link` and `caps`; a link becomes a cell hyperlink only when it is the whole cell. |
| `link` | PDF link annotation | `w:hyperlink` | Cell hyperlink (whole cell) | Partial-cell links in XLSX. |
| `tone` | Theme color, after the contrast step | Theme color as RGB | Font color | None. |
| `field` | The value, or a `Field` write-in box | The value, or a content control with the label as placeholder | The value, or an empty cell | DOCX and XLSX have no fillable write-in line; they print an underlined blank. |
| `checkbox` | AcroForm check box with `key` | Check box content control | `☐` text | XLSX has no check box. |
| `hardBreak` | Line break | `w:br` | Line break in the cell | None. |
| `list`, `listItem` | Bullet or number column `View` | `w:numPr` numbering | One row per item with a bullet or number prefix | XLSX flattens nesting into an indent. |
| `quote` | `View` with a left rule | Quote paragraph style | Indented row | XLSX loses the rule. |
| `divider` | `View` border | Paragraph bottom border | A bottom border on the row | None. |
| `pageBreak` | New `Page` | `w:br w:type="page"` | New sheet named by `sheet` | None. |
| `slot` | Labelled bordered `View`; the blank note when empty | Bordered paragraph group or a one-cell table | Label row, then content rows | XLSX loses the box. |
| `box` | `View` with fill, border, padding | One-cell table with shading | Cell fill on the rows it covers | XLSX approximates padding with an empty row. |
| `columns`, `column` | Row `View` with flex widths | A borderless table with one row | Columns become side-by-side column groups only for simple text; otherwise stacked rows | XLSX stacks complex columns. |
| `table`, `row` | `DataTable` with widths, rules, zebra, header fill | `w:tbl` with grid widths, borders, header row repeat | A cell range; header row frozen; column widths from the shares | None. |
| `cell` text | `Cellt` or `Cellfield` (when `fillable` and empty) | `w:tc` | Text cell | DOCX has no form field per cell. |
| `cell` number | The formatted value in an input box | The formatted value | A boxed input cell with the number format | None. |
| `cell` formula | The computed value | A Word `=SUM(ABOVE)` style field with the cached value, or the static value when the formula uses `@name` | A live Excel formula with A1 references, cached value 0 and `fullCalcOnLoad` | DOCX: `@name` and `left * 12` have no Word table field, so they export as static values. |
| `repeat` | A grid of fixed-size `View`s per page, dashed cut marks | A table with fixed row heights, one cell per copy | Not supported: export prints the content once | DOCX: a card that overflows its cell grows the row and breaks the sheet; the editor shows an overflow warning so the author sees it first. XLSX: no n-up. |
| `logo` | The brand logo image, or the church name in DM Serif Display | Inline image, or the name in the display font | The church name as text | XLSX has no logo. |
| page `footer` | `Fixed position="footer"` | Footer part | Page footer (`&L`) | None. |
| legal notice | `Fixed` footer text | Footer part | Page footer (`&R`) | None. |

### Budget export

Budgets keep XLSX, and the file looks the same as today: a title row, a note row, a frozen header, boxed input cells,
`SUM` totals and the net row. Run the worksheet example through the mapping and you get today's
`worksheet()` sheet, cell for cell, because the example was written from it.

Two things change, and I think both are improvements:

1. The workbook comes from the document. A church that adds a "Childcare" line in the editor gets that line in the
   XLSX, with its `left * 12` formula and inside the `SUM` range. Today the XLSX ignores anything the church does.
2. A budget also exports to PDF and DOCX, because every document does. A church can print the budget for a board
   meeting without opening Excel.

What the format cannot express that Excel can: cross-sheet references beyond named cells, conditional formatting,
charts, data validation and cell protection. The first-year budget's "Annual summary" sheet reads the monthly sheet
through named totals (`@income_year`), which the format supports. Its twelve month columns make a wide table that
prints on legal landscape.

## Why not Tiptap

Tiptap (ProseMirror) is a strong text editor. I did not use it, for three reasons:

1. **The hard parts here are not text.** Typed table cells with formulas, linked repeat copies and page-sized grids
   are structure. In ProseMirror each of them is a custom node view that fights the document model: table cells with
   computed values need decorations and transaction filters, and a repeat with live copies needs a node view that
   renders the same content four times while ProseMirror owns one of them. In this approach they are plain components.
2. **The stored format should not be an editor's format.** Tiptap JSON is ProseMirror's document shape. Choosing it
   ties storage, the PDF renderer, DOCX and XLSX to one editor library's node model and its upgrade path. Here the
   format is ours, and an editor (this one, or Tiptap later) is a view of it.
3. **Self-contained and small.** The prototype ships 0 bytes of library code. The editor is about 70 KB of readable
   JavaScript.

What this costs, honestly: cross-block text selection (select three paragraphs and make them bold) does not work,
because each leaf is its own editing host. IME composition, spellcheck, paste cleaning and accessibility of a custom
editor are work that ProseMirror has already done. If Sebastian picks this format but wants Tiptap's text editing, the
path is to use a ProseMirror instance per text leaf, or one ProseMirror document whose schema is generated from
`NODES`. The stored format does not change either way.

## The examples and their sources

| Example | Rebuilds | Source files |
|---|---|---|
| [`examples/conflict-of-interest-policy.json`](examples/conflict-of-interest-policy.json) | `conflict-of-interest-policy` | `packages/domain/src/documents/templates/policy-content.ts` (`CONFLICT_OF_INTEREST_BODY`) and the `policy(...)` entry in `church.ts`, both on PR #395 (`origin/task/wp-037`); the frame layout in `layouts/church-doc.tsx` |
| [`examples/commitment-card.json`](examples/commitment-card.json) | `commitment-card` | `templates/card-content.ts` (`COMMITMENT_CARD`) and `layouts/card.tsx` |
| [`examples/guest-sign-in-sheet.json`](examples/guest-sign-in-sheet.json) | `guest-sign-in-sheet` | `layouts/sign-in.tsx` (`SIGN_IN_ROWS = 18`) and its entry in `templates/registry.ts` |
| [`examples/budget-worksheet.json`](examples/budget-worksheet.json) | `budget-worksheet` | `packages/domain/src/documents/xlsx.ts` (`worksheet()`, `INCOME_ROWS`, `EXPENSE_ROWS`, `block()`) |

What each example keeps, part by part:

- **Policy.** The 9 numbered sections and their text, both lists, the intro, the kicker "Board policy", the logo slot
  and the primary rule, the title, the adoption closing "The board of {church_name} adopted this policy. Each board
  member signs and dates below.", the adoption table (Board member, Role, Signature, Date; 3 blank rows; form fields
  `adopt_1_name` to `adopt_3_date`), the footer `{church} | Conflict of Interest Policy`, the merge fields
  `church_name` and `pastor_name`, the formal/legal class and with it the legal notice. Changed: the PDF subject
  ("The conflict of interest policy of {church_name}") is derived from the title instead of stored.
- **Card.** The cover with logo and tagline (`church_tagline`, default "A new church plant. You are welcome here."),
  the accent bar, "My commitment" and "Core group", the lead-in, the GROW, PRAY and GIVE rows with check boxes
  `commit_grow`, `commit_pray`, `commit_give`, the fields `full_name`, `contact`, `signature`, `signed_date` and the
  contact line "Return this card to {pastor_name}." Changed: one card per 4.25 x 5.5 page becomes four per letter
  sheet, as the brief asks. Not kept: the optional cover photo (no `image` node yet) and the letterhead-contact branch
  of the contact line (the format has no conditional text, so the template picks the pastor-name branch).
- **Sign-in sheet.** The logo, "Vision meeting", the accent bar, the title, the purpose line with the church name,
  `meeting_date` (170 pt) and `meeting_number` (110 pt), the table (#, Name, Email, Phone, Who invited you?) with 18
  numbered zebra rows of 25 pt and the form field names `guest_{n}_name`, `guest_{n}_email`, `guest_{n}_phone`,
  `guest_{n}_invited_by`, and the footer. Changed: the footer uses the church name, where today it prefers the
  letterhead legal name.
- **Budget worksheet.** The title "{church} Budget Worksheet", the note, the header (Category, Monthly, Annual), the 5
  income rows, Total income, the 10 expense rows, Total expenses and the net row, the formulas (annual = monthly x 12,
  `SUM` totals, net = income minus expenses), currency format and the column widths 36, 16, 16.

## Tradeoffs and risks

- **Editor complexity is ours.** No library means we own caret handling, IME, paste, undo and accessibility. The
  prototype handles typing, marks, Enter, Backspace, Tab, plain-text paste and snapshot undo. It does not handle
  cross-block selection, collaborative editing or rich paste from Word. That is the largest cost of this approach.
- **DOCX fidelity.** Word has no n-up layout and no fillable write-in lines without legacy form fields. A card sheet
  in DOCX is a fixed-height table that Word may stretch. Formulas other than `sum(above)` and `sum(left)` export as
  static values. The PDF is the reference output for fixed layouts; DOCX is "editable, close enough".
- **Spreadsheet behavior.** A budget table computes like a spreadsheet only inside the table vocabulary. No cell
  ranges like `B4:B9`, no `IF`, no cross-table references except named cells. If a church wants a real spreadsheet,
  XLSX export is the exit. I think that is the right line for church budgets, but it is a line.
- **Layout power.** The format has no absolute positioning, no free-floating text boxes and no images other than the
  logo. Every layout in scope fits columns, boxes, tables and repeat. A future template that needs a poster layout
  will push on this.
- **Performance.** A structure change re-renders the whole page. The 18-row sign-in sheet and the 25-block policy
  re-render in a few milliseconds. A 300-row table or a 50-page document will need keyed, per-block re-rendering.
  The model is already path-addressed, so that change stays inside the view.
- **Schema evolution.** Owning the schema means owning migrations. Every breaking change needs a `formatVersion` bump
  and a migration, tested against every stored revision. The validator is strict (unknown keys fail), which keeps
  stored data clean but makes a forgotten migration fail loudly instead of quietly.
- **Mobile.** The editor shows the real page, scaled to the screen. At 390 px a letter page is about 45% size: fine
  for checking a layout, poor for writing a long policy. A production editor wants a reflowed "text view" for phones.
- **Merge at render time** means an export can change when church data changes. Saved exports keep exact bytes
  (DOC-002 and DOC-003), so the stored file does not move, but two exports of one revision a month apart can differ.
- **No locks** means a church can delete the adoption table from its bylaws or the statement-of-faith slot. That is
  what Sebastian asked for. The product may still want export-time warnings for formal/legal documents.
