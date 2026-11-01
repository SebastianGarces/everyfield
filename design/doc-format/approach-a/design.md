# Approach A design: one page tree with typed tables

Approach A stores every Everyfield template and document as one JSON tree, `everyfield.doc/1`. Prose, cards,
sign-in sheets, agendas, checklists and budgets all use it. The tree has the ProseMirror shape (`type`, `attrs`,
`content`, `marks`, `text`), so a Tiptap editor can load it with custom nodes and no conversion step. Three ideas carry
the layout work, and they are the reason this is approach A and not "rich text plus some extras":

1. **Page setup owns the paper.** Size, margins, header, footer and *tiling* live in `page`. A 4-up card is one card's
   content with `tile: { across: 2, down: 2 }`. The editor does not draw four cards and keep them in step. It draws one,
   and the sheet repeats it.
2. **The table is typed.** Each column has a type (`text`, `number`, `money`, `check`, `index`, `formula`) and each row
   has a role (`item`, `group`, `subtotal`, `total`). One node gives the sign-in sheet, the checklists, the agenda run of
   show, the attendee list, the adoption signatures and the budget. A budget is a table, not a second format.
3. **Colors are theme tokens.** A node says `primary` or `accent`, never `#1F3A68`. The brand kit (WP-104) and the
   contrast rules stay in the renderer, so a user can rebuild a card cover and still get legible, on-brand output.

Everything else is ordinary rich text, so the common case (a policy or a letter) stays simple to edit.

Files: [`schema.json`](schema.json) is the machine-readable schema. [`format.js`](format.js) holds the validator, the
table math and forking, shared by Node and the browser. [`validate.mjs`](validate.mjs) runs the validator.

## Schema

The envelope is in [Template envelope](#template-envelope). The body is a `doc` node. Units are points (72 per inch).
An attribute with a default may be left out of the JSON. A missing attribute without a default is an error.

"Block" means any node in the `block` group: `paragraph`, `heading`, `bulletList`, `orderedList`, `quote`, `divider`,
`spacer`, `pageBreak`, `columns`, `box`, `image`, `writeIn`, `slot`, `table`. "Inline" means `text`, `field`,
`hardBreak`, `pageNumber`. "Token" means one of `none`, `ink`, `muted-text`, `primary`, `accent`, `muted`, `border`.

### Nodes

| Node | Attributes (default) | Allowed children |
|---|---|---|
| `doc` | none | block, zero or more. An empty `doc` is valid: a user can wipe everything. |
| `paragraph` | `align`: left, center, right (left). `style`: body, lead, small, kicker (body) | inline, zero or more |
| `heading` | `level`: 1 to 3 (2). `numbered`: bool (false). `align` (left) | inline, zero or more |
| `bulletList` | none | `listItem`, 1 to 200 |
| `orderedList` | none | `listItem`, 1 to 200 |
| `listItem` | none | `paragraph`, 1 to 20 (flat lists; no nesting in v1) |
| `quote` | none | `paragraph`, 1 to 50 |
| `divider` | `weight`: hairline, rule, bar (rule). `color`: token (ink) | none |
| `spacer` | `size`: 2 to 288 pt (12) | none |
| `pageBreak` | none | none. Allowed only in the body, not in a column, a box or a header or footer |
| `columns` | `gap`: 0 to 72 pt (12). `valign`: top, center, bottom (top) | `column`, 2 to 4 |
| `column` | `width`: 1 to 12, a share of the row (1). `align`: left, center, right (left) | block, zero or more, but no `columns` and no `pageBreak` |
| `box` | `fill`: token (none). `border`: token (border). `padding`: 0 to 72 pt (12). `keepTogether`: bool (true) | block, zero or more, but no `box` and no `pageBreak` |
| `image` | `source`: logo, mark, photo (logo). `width`, `height`: pt (150, 34). `align` (left). `alt`: text ("") | none |
| `writeIn` | `label`: text (Name). `key`: field key (name). `kind`: text, signature, date (text). `width`: pt, 0 fills the column (0) | none |
| `slot` | `label`: text (Statement of faith) | `paragraph`, `bulletList`, `orderedList`, zero or more |
| `table` | `columns`: 1 to 16 column specs (required). `style`: grid, rows, ledger (grid). `header`: bool (true). `headerFill`: token (muted). `zebra`: bool (false). `writeInRows`: 0 to 200 (0). `rowHeight`: pt, 0 is automatic (0). `source`: list field key or null (null). `sheet`: XLSX sheet name or null (null) | `row`, 0 to 1000 |
| `row` | `role`: item, group, subtotal, total (item). `sign`: add, subtract (add, group rows only) | `cell`, one for each column |
| `cell` | `value`: number or null (null). `checked`: bool (false) | inline, zero or more (text columns only) |
| `text` | none. Has `text` (non-empty) and optional `marks` | none |
| `field` | `key`: a declared field key (required) | none |
| `hardBreak` | none | none |
| `pageNumber` | `format`: page, page-of-total (page-of-total) | none. Allowed only in the page header or footer |

A column spec is `{ id, label, type, width, align?, formula?, format? }`. `type` is `text`, `number`, `money`, `check`,
`index` or `formula`. `width` is in points, and 0 shares the remaining width. A `formula` column needs `formula` and may
set `format` (`money` or `number`).

### Marks

| Mark | Attributes | Meaning |
|---|---|---|
| `bold` | none | Bold weight |
| `italic` | none | Italic style (the PDF needs DM Sans Italic; see risks) |
| `underline` | none | Underline |
| `link` | `href`: starts with `https://`, `http://` or `mailto:` | A link. Other schemes fail validation. |
| `tag` | none | The words print as a small caps label on an accent tile, like GROW, PRAY and GIVE on the card |

A mark may appear once on a text node. Marks have no color attribute on purpose. A user picks structure, not paint.

### Rules the content model cannot say

`format.js` adds these checks to the schema:

- Every `field` key and every table `source` is declared in `fields`. A `list` field feeds only a table.
- `writeIn` keys are unique in the document, because each becomes a PDF form field name.
- Each row has one cell for each column. A `value` sits only in a `number` or `money` cell of an `item` row. Only a
  `text` cell holds text. Only a `check` cell can be `checked`.
- `group`, `subtotal` and `total` rows need `style: "ledger"`. A `subtotal` follows a `group`. Only a `group` has a `sign`.
- A formula parses, reads only `number`, `money` or `formula` columns, and reads only columns to its left. That rule
  rules out cycles and reads like a spreadsheet.
- A template has no `data` and no `origin`. A document states its `origin` (null for a blank document).
- XLSX export needs at least one ledger table. A tile is at least 72 x 72 pt.
- Limits: 5,000 nodes, 20,000 characters for one text node, 2,000,000 bytes of JSON.

`node design/doc-format/approach-a/validate.mjs` checks the four examples and the four invalid samples in
[`invalid/`](invalid/). Each invalid sample must fail with the message in `invalid/expected.json`, for example
`body.content[0] (table).content[0] (row 1): the row has 4 cells but the table has 5 columns`.

## Page setup

```json
"page": {
  "size": "letter", "orientation": "portrait",
  "margin": { "top": 40, "right": 40, "bottom": 56, "left": 40 },
  "tile": { "across": 2, "down": 2, "padding": 14, "cutMarks": true },
  "header": { "pages": "all", "content": [ ...blocks ] },
  "footer": { "pages": "rest", "content": [ ...blocks ] }
}
```

- `size` is `letter`, `legal`, `a4`, `half-letter`, `card-4x6` or `custom` (then `width` and `height` in pt).
  `orientation` swaps the sides.
- `margin` is the page margin. On a tiled page it is the sheet margin, usually 0, and `tile.padding` is the margin
  inside each card.
- `tile` (or null) repeats the header, the body and the footer in a grid. The tile size is the content box divided by
  `across` and `down`. Letter at 2 x 2 with no sheet margin gives 306 x 396 pt, which is today's 4.25 x 5.5 in card.
  `cutMarks` prints trim marks. The body of a tiled document does not flow to a second tile: one tile is one card.
- `header` and `footer` (or null) are block lists. `pages` is `all`, `first` or `rest`. `rest` gives the "continued"
  running header of the checklists. Only these regions can hold a `pageNumber`.
- Pages are the content's own concern. The body flows from page to page, and `pageBreak` starts a new one.
- Type scale is a renderer rule, not an attribute. When the content box is narrower than 5 in (a card), headings use
  the compact scale (title 20 pt). That keeps one schema for Letter and card without a font-size attribute.

## Layout primitives

Approach A has six layout primitives. Each has one job, and the set is small enough to explain to a pastor in one
screen.

| Primitive | Job | Example |
|---|---|---|
| `tile` (page setup) | Repeat one design N-up on a sheet | 4 commitment cards on Letter |
| `columns` / `column` | Put blocks side by side, by share of width | Logo left and kicker right; Name and Email fields in one row |
| `box` | A panel with a token fill or border and padding | The card cover in `primary`; the agenda meta panel in `muted`; a doctrinal slot frame |
| `table` | Rows and typed columns, with write-in rows and computed numbers | Sign-in sheet, checklists, run of show, budget, signature table |
| `header` / `footer` regions | Repeated page furniture with page numbers | Letterhead footer, "continued" header |
| `divider`, `spacer`, `pageBreak` | Rules, fixed space and page control | The 4 pt accent bar under a card cover |

Two blocks fill the gaps that prose does not have. `writeIn` is a labelled box where a person writes (a fillable field
in the PDF). `image` is a fixed-size slot that the renderer fills from the brand kit. A missing or oddly shaped logo
never moves anything.

What approach A leaves out on purpose: absolute positioning, free-floating text frames, rotation, arbitrary colors,
custom fonts per node and nested tables. Each of those breaks DOCX export or gives non-technical users a way to make
an unreadable page. [Tradeoffs and risks](#tradeoffs-and-risks) names what that costs.

## Fields and merge data

```json
"fields": [
  { "key": "church_name", "label": "Church name", "type": "text", "source": "church.name", "required": true,
    "sample": "Harbor City Church" },
  { "key": "church_legal_name", "label": "Legal name", "type": "text", "source": "brand.legalName",
    "fallback": "{church_name}" },
  { "key": "agenda", "label": "Agenda items", "type": "list", "source": "meeting.agenda" }
]
```

- A template declares every field it uses. `type` is `text`, `date`, `number` or `list`. `source` names where the app
  fills it (`church.name`, `church.pastor`, `brand.tagline`, `brand.contactLine`, `meeting.date`, `meeting.agenda`).
  `fallback` is the text when the source is empty, and it may name other fields in braces. `sample` is preview data.
- Inline, a `field` node shows the value. In the editor it is a chip that the user inserts from the toolbar.
- A document keeps its `field` nodes and stores the values it was made with in `data`. The values are frozen at
  creation, the same rule as today's `input_provenance`, and the user can change them in the Fields panel. Keeping
  the field nodes (instead of replacing them with text once, as `resolveTokens` does today) means a corrected church
  name changes every place it prints, and a card sheet can later fill each tile from a different record.
- A table with `source` set reads a `list` field. Its rows come from the data, one row per entry, with column ids as the
  entry keys. When the list is empty, the table prints its `writeInRows` blank rows instead. That is the agenda ask
  ("generated from what's filled in on the app", with blank lines as the fallback) in one attribute.
- Bracketed prompts such as `[number]` in the policies stay plain text in v1. A later `prompt` inline node can make
  them visible to the editor and to a "still unfilled" check.

## Locked or required parts

Sebastian said a user can fork a template and "completely wipe it". Approach A takes that literally: nothing in the
body is locked. Any block, field, slot or table can be deleted, and an empty `doc` validates.

One part is fixed, and it is not body content. A document of class `formal/legal` always prints "Template, not legal
advice" in the footer (DOC-019). The renderer adds it from the class, so no edit can remove it. The editor shows it with
a "Locked" badge and a tooltip. The prototype shows the same: after "Delete all content" on a forked policy, the
notice still prints.

Doctrinal slots (DOC-020) become a `slot` block. An empty slot prints the visible blank note, the same text as today,
so Everyfield never prints invented doctrine. Unlike today (`slot_not_deletable`), the user can delete it. If a church
wants the slot back, it inserts "Doctrinal slot" from the block menu. This is the one deliberate change to a current
rule, and it is listed under risks.

Required merge fields (`required: true`) are a create-time rule, not a lock. Creating a document from a template
needs a value for each required field (today, the church name).

## Template envelope

```json
{
  "format": "everyfield.doc/1",
  "kind": "template",
  "id": "conflict-of-interest-policy",
  "version": 1,
  "title": "Conflict of Interest Policy",
  "description": "How the board handles a personal interest in a decision.",
  "class": "formal/legal",
  "exports": ["pdf", "docx"],
  "fields": [ ... ],
  "page": { ... },
  "body": { "type": "doc", "content": [ ... ] }
}
```

A template and a document are the same shape. `kind` tells them apart:

| Key | Template | Document |
|---|---|---|
| `id` | Catalog id (`conflict-of-interest-policy`) | Document id |
| `version` | Template version, bumped on any change | Always 1 in the file; the database keeps revisions |
| `class` | `formal/legal`, `outward-facing` or `operational`. Sets fixed parts and brand rules | Copied from the template |
| `exports` | Formats offered: `pdf`, `docx`, `xlsx` | Copied; the user can change it |
| `origin` | absent | `{ template, version, hash }`, or null for a blank document |
| `data` | absent | Frozen merge values |

Everything a template prints is in the file: the title, the kicker, the logo slot, the signature table, the footer. The
`frame` of today's `ChurchTemplate` (sign, adopt, letter) becomes ordinary blocks at the end of the body, so a user can
change the closing words or delete the signature table like any other content. There is no separate `kicker`,
`subject` or `style` key. The kicker is a `kicker` paragraph. The PDF subject is the title plus the church name.

## Versioning and forking

- **Format version.** `format` is `everyfield.doc/1`. A breaking schema change bumps it to `/2` with a pure upgrade
  function in contracts. The app upgrades on read and writes the new version on the next save, so no up-front data
  migration is needed.
- **Template version.** A template `version` is an integer. A published version never changes. Everyfield built-ins
  are JSON files in the repo (`packages/domain/src/documents/templates/<id>.json`), one per template, reviewed and
  approved one by one as today (`evf approve`). A church's own templates are rows with `kind = "template"`, and each
  published revision is a version.
- **Fork.** "New from template" copies the whole template, page setup included, into a new document. The document
  records `origin: { template, version, hash }`. The hash is sha256 of the template's canonical JSON (sorted keys), so
  the app can tell later whether the source changed. A document never follows template changes. A later "compare with
  the current template" view can diff the two trees by block, and the user accepts a change as a new revision.
- **Export uses the document, not the template.** Today `exportChurchDocument` reads the current code template for
  the frame. That is a latent bug: an old document changes when the code changes. In approach A the document holds
  its own frame, so the bug cannot happen.
- **Save as template.** A church can turn a document into its own template. That drops `origin` and `data` and keeps
  the rest.

`forkTemplate` and `templateHash` in [`format.js`](format.js) implement the fork, and the tests in
[`test.mjs`](test.mjs) check that a fork validates, records its origin and survives a full wipe.

## Rendering path

One tree feeds four outputs. Each renderer walks the same nodes, so a template has no layout code of its own.

### Editor

Production editor: Tiptap 3 (MIT core) on ProseMirror, as the earlier research chose. The ProseMirror shape of the
format means the prose nodes and marks map one to one to StarterKit, Underline and Link. Approach A adds custom nodes:

- `field` and `pageNumber`: inline atoms (Tiptap's mention pattern).
- `columns`, `column`, `box`, `slot`: block nodes with content holes, drawn by node views.
- `table`: one custom node with a node view, not Tiptap's generic table extension. Columns are typed and rows have
  roles, so the node view draws numeric inputs, computed cells (`computeTable` from `format.js`) and write-in rows.
  Cell text uses a nested ProseMirror editor per text cell.
- `image`, `writeIn`, `divider`, `spacer`, `pageBreak`: leaf nodes.
- Page setup, tiles, the header and the footer sit outside the ProseMirror doc. The page view (paper size, margins and
  page breaks) is a layout layer around the editor, as in OPS-101.

The prototype in [`prototype/`](prototype/) uses no library. See [Editor library](#editor-library) for why.

### PDF (Forme)

One generic Forme renderer replaces `card.tsx`, `sign-in.tsx`, `agenda.tsx`, `checklists.tsx` and `church-doc.tsx`.
It maps nodes to the building blocks that `blocks.tsx` already has:

| Node | Forme output |
|---|---|
| `paragraph`, `heading`, `quote`, lists | `T` with nested `Text` runs for marks; `Title` for heading 1; `SectionHead` (rule mode) for a numbered heading 2 |
| `columns` | `View` with `flexDirection: row`, widths from the shares |
| `box` | `View` with token fill, border and padding; `wrap={false}` when `keepTogether` |
| `table` | `DataTable` (tagged Table, TR, TH, TD). `writeIn` rows and empty text cells become `Cellfield`; `check` cells become `Box`; computed cells print the number |
| `writeIn` | `Field` |
| `image` | `LogoSlot` or `PhotoSlot` |
| `divider`, `spacer`, `pageBreak` | `View` with a border, a `View` of fixed height, a new `Page` |
| header / footer | `Fixed position="header"/"footer"`; `pageNumber` becomes `PageNumber` |
| `tile` | One `Page` with a wrapped row of fixed-size `View`s, each clipping its content, with field names suffixed per tile |

Tokens go through `makePalette`, and every text color still passes `ctx.log.pair`, so the contrast rules and the
brand kit work as today. Determinism (DOC-002, DOC-003) holds: same tree, same theme, same bytes.

### DOCX

`docx.ts` becomes a tree walker too. Paragraphs, headings, lists, quotes, marks and links map to `w:p` and `w:r`
directly. Layout nodes need care:

- `columns`: a borderless one-row table (DOCX section columns flow text, which is wrong for side-by-side blocks).
- `box`: a one-cell table with cell shading and borders.
- `table`: a real table. Computed numbers print as values. `writeIn` rows are empty rows.
- `writeIn`: a label paragraph and a bordered one-cell table, or a content control when Word forms matter.
- `tile`: a 2 x 2 table with exact row heights, or one card per section page at the tile size. Both are approximate;
  see risks.
- header / footer: Word headers and footers, with `PAGE` and `NUMPAGES` fields. `pages: "first"` and `"rest"` use the
  different-first-page setting.

### XLSX

A document offers XLSX when it holds a ledger table. Each ledger table becomes one sheet (its `sheet` attribute names
it). Columns become sheet columns. `money` cells become inputs with the boxed style, `formula` cells become Excel
formulas, and subtotal and total rows become `SUM` formulas. See [Budgets](#budgets).

## Budgets

**How numbers live in the format.** The file stores only what a person types: each `money` or `number` cell of an
`item` row holds `value` (or null). Totals and formula columns are never stored. They are computed from the structure:

- A `formula` column computes each item row from columns to its left. `monthly * 12` gives Annual. `sum(m1:m12)` gives
  a year total. `year / 12` gives a monthly average.
- A `subtotal` row adds the item rows of its category, that is, since the last `group` row.
- A `total` row adds every category so far, each with its group's `sign`. Income `add` and Expenses `subtract` give
  "Net (income minus expenses)".

The formulas name columns and row roles, not cell addresses. Inserting or deleting a line item cannot break a total,
which is the most common way a hand-built spreadsheet goes wrong. The editor computes totals live with
`computeTable`, and the PDF and DOCX print the computed numbers.

**XLSX export.** The exporter walks the ledger, assigns sheet rows, then writes real formulas:

- an item's formula column: `=B5*12` (column ids become letters in that row);
- a subtotal: `=SUM(B5:B9)` over its category's item rows;
- a total: `=B10-B22` built from the subtotal rows and the group signs (or `SUM` of the item ranges when a category
  has no subtotal row);
- `fullCalcOnLoad` stays set, so Excel and Numbers show the totals on open.

Styles carry over from today's `xlsx.ts`: title, note, header fill, boxed input cells, money format, bold totals and
frozen panes. The workbook stays a church's working spreadsheet with live formulas.

**What changes from today.** Budgets still export to XLSX with live formulas. Three things change, all on purpose:

1. A budget is now also a document. It previews in the app, prints to PDF and exports to DOCX, and a church can
   rename, add or delete categories and line items before export. Today the workbook is fixed code and nothing can be
   edited before download.
2. `first-year-budget` loses its second sheet. Today "Annual summary" reads the "Monthly budget" sheet with
   cross-sheet formulas. In approach A it becomes two formula columns in the same table, `Year total = sum(m1:m12)`
   and `Monthly average = year / 12`. Cross-sheet references would need a reference node that the editor must keep
   valid when rows move, and that is a lot of machinery for one summary view.
3. Labels, categories and the note under the title are now content the church can edit.

## Mapping today's layouts

Each file in `packages/domain/src/documents/layouts/` and the primitives that reproduce it.

| Layout | Reproduced by | Not reproducible, or changed |
|---|---|---|
| `card.tsx` (4.25 x 5.5 in card) | `page.tile` 2 x 2 on Letter, padding 14. Cover: `box` fill `primary` with `columns` (logo `image` and tagline `field` / photo `image`). Accent bar: `divider` bar `accent`. Title row: `columns` (heading / kicker paragraph, align right). Lead-in: `paragraph` small. Rows: `table` style `rows`, `check` column and `text` column with `tag`-marked GROW, PRAY, GIVE. Fields: `columns` of `writeIn`. Contact line: footer `field` with a hairline `divider` | Row padding that tightens when there are more than three rows (`rowCount > 3`) becomes a fixed compact padding. The SVG logo recolor on the primary fill stays a renderer rule for `image` in a `primary` box. Today's single card per 4.25 x 5.5 in page is still possible with `size: custom` and no tile |
| `sign-in.tsx` | Header `columns` (logo / kicker), `divider` bar `accent`, heading 1, lead `paragraph` with `field`, `columns` of two `writeIn` (meeting date, number), `table` grid with `index`, four `text` columns, `writeInRows: 18`, `zebra`, `headerFill: accent`, `rowHeight: 25`. Footer `columns` (legal name `field`, `pageNumber`) | Prefilled meeting date and number (`ctx.values`) need `writeIn` to show a field value. v1 prints it with a `field` paragraph instead. A `writeIn.prefill` attribute would close that gap |
| `agenda.tsx` | Header and title as for sign-in. Purpose: `paragraph` with `field`. Meta panel: `box` fill `muted` with `columns` of four `writeIn`. Run of show: numbered heading 2, `table` with `source: "agenda"`, columns time, segment, lead, notes, `writeInRows: 6` as the fallback. Attendees: `table` with `source: "attendees"` and a `check` column. Follow-up actions: `table` with `writeInRows: 4`. Letterhead footer | The two-column attendee table (name, role, here twice in one row) needs a wrapped data table. v1 prints one column of attendees, or two side-by-side `columns` tables when the list is blank. The overflow note ("This list shows the first N people") is conditional text. v1 has no conditions, so the note needs a later `if` node. The total duration beside "Run of show" becomes a `field` (`meeting.totalMinutes`) |
| `checklists.tsx` | Page 1: header `columns`, `divider` bar, heading 1, date `writeIn`, instruction `paragraph`, then per team a `columns` (numbered heading / "Team lead" `writeIn`) and a `table` with `check`, `text`, two empty `text` columns, `zebra`, `headerFill: accent`. `pageBreak` after three teams. `header` with `pages: "rest"` gives "Launch Sunday Checklists, continued" | The section number on an accent tile ("fill" mode of `SectionHead`) is a second numbered-heading look. v1 has one (rule mode). A `heading.numberStyle: tile` attribute would add it. `wrap={false}` per team maps to `box` with `keepTogether` |
| `blocks.tsx` | Its parts become the renderer's node mappers: `T` (paragraph runs), `Title` (heading 1), `SectionHead` (numbered heading), `Field` (`writeIn`), `Cellfield` (empty text cell, write-in row), `Box` (`check` cell), `DataTable` (`table`), `Cellt` (text cell), `Footer` (footer region and `pageNumber`), `LogoSlot` / `PhotoSlot` (`image`) | `Label` styling and the contrast log stay renderer rules, not attributes |
| `shell.tsx` | `LETTER`, `CARD` and margins become `page.size`, `page.margin` and the "4 cards per sheet" preset. `Doc` metadata comes from `title`, `class` and the church name. `DoctrineSlot` is the `slot` block | none |
| `church-doc.tsx` | Letterhead `columns` (logo / kicker), `divider` rule `primary`, heading 1. Body blocks map one to one (numbered heading 2 for `heading`, heading 3 for `subheading`, lead `paragraph` style for the muted intro, `quote`, lists, `slot`). Frames: `sign` is `columns` of `writeIn`; `adopt` is a closing `paragraph` and a grid `table` with `writeInRows`; `letter` is a sign-off `paragraph`, `spacer`, pastor-name `field` and a church `field`. Heading keep-with-next is a renderer rule | "Paragraphs before the first heading print muted" was positional. v1 makes it explicit with the `lead` style, so the policy example marks its first paragraph `lead`. The letter date `writeIn` is content, so a user can delete it |

Every one of today's 13 rendered templates can be expressed with these nodes. The gaps above are a look detail or
need conditional text. None needs layout code.

## Editor library

**Production: Tiptap.** The earlier research chose Tiptap core (MIT), and approach A keeps it. ProseMirror's schema,
transactions, undo, IME handling, paste rules and collaboration are hard to rebuild and easy to get wrong. The format
has the ProseMirror JSON shape, so `editor.getJSON()` writes the body and `setContent` reads it, with no mapping layer
for prose. The layout nodes are custom nodes and node views, which is Tiptap's normal extension path.

**Prototype: no library.** The prototype edits the JSON tree directly with `contenteditable` per text block and a
small model layer (`prototype/app.js`, about 1,800 lines). Three reasons:

- The brief asks for a prototype that opens from a static server with no build step. Tiptap ships as ES modules spread over many ProseMirror
  packages. Vendoring it needs a bundle step or a large hand-pinned import map.
- The prototype exists to prove the format, the validator and layout building, not the library. With no library, every
  behavior in the prototype comes from the format and `format.js`, so nothing hides in a library default.
- The same `format.js` runs in Node and in the browser, so the validator a reviewer runs on a downloaded file is the
  exact code the editor uses.

The cost is that the prototype has no undo across blocks and a simpler caret model than ProseMirror. That is fine for
a design review and not acceptable for the product.

**Vendored code size: 0 bytes.** The prototype vendors no library code. It vendors three DM fonts (OFL, copied from
`packages/domain/src/documents/fonts/`) so pages match the PDF type: 190,112 bytes of font files and 9,087 bytes of
license text. The prototype's own code is `app.js`, `style.css` and `index.html` in `prototype/`, plus the shared
`format.js` and `schema.json`; the README lists their sizes.

## Email templates

The format does not cover the 7 email templates (`vision-meeting-invitation`, `vision-meeting-reminder`,
`vision-meeting-follow-up-attended`, `vision-meeting-follow-up-no-show`, `orientation-invitation`,
`team-meeting-invitation`, `general-announcement`). An email is not a page. It has no paper size, no margins, no tiles
and no PDF, and mail clients ignore most layout (no grid, no reliable tables-as-layout, no fixed sizes). Its parts are
also different: a subject line, preview text, a button and an unsubscribe footer. Forcing emails into a page format
would add email-only nodes that every page renderer must ignore, or page nodes that the email renderer must reject.

They stay in the communication system (`docs/reference/communication-system-templates.ts`). The plan deletes their
rows from the document catalog. One overlap is worth keeping: the inline part of approach A (paragraphs, headings,
lists, marks, links and `field`) is a clean subset for an email body editor later. A future email format can reuse the
inline schema and the validator rules for marks and fields, with its own envelope.

## Tradeoffs and risks

**DOCX fidelity of the layout primitives.** Word has no tile, no box and no side-by-side block columns. The DOCX
renderer fakes `columns` and `box` with borderless and shaded tables, and a tiled card sheet with a fixed-height table.
These open correctly, but a user who edits the DOCX in Word fights table cells, and a long text in one card does not
clip the way the PDF does. Approach A accepts this: the PDF is the print artifact for cards and forms, and DOCX is the
editable artifact for prose. A form-heavy template could drop `docx` from `exports`, and the catalog can decide that
per template.

**Editor complexity for non-technical users.** One editor for prose and forms means a pastor who writes a letter sees
"Insert block" with Columns, Box, Table and Budget table. Typed columns, row roles and tile settings are real concepts.
Mitigations: presets in the menu (Color panel, Checklist rows, Budget table, 4 cards per sheet), defaults that print
well, an inspector that shows only the selected block's settings, and the fact that most users fork a template rather
than build from empty. The risk is still real. A card built from empty by an untrained user will look worse than the
approved template. The validator stops broken structure, not ugly design.

**PDF rendering with today's Forme engine.** The generic renderer builds on the parts `blocks.tsx` already uses, so the
main risks are specific:

- Tiling: Forme paginates flows, and it has no native N-up. Four fixed-size `View`s per page with `overflow: hidden`
  should work, but clipping inside a tagged PDF and per-tile footers (`Fixed` is page level) need a spike.
- Form field names repeat across tiles, so the renderer suffixes them (`full_name_t1` to `_t4`).
- Long tables: Forme splits a table across pages and repeats the header, which matches; `keepTogether` boxes taller
  than a page must fall back to wrapping.
- Italic: the bundled fonts have no italic face. The `italic` mark needs DM Sans Italic and Bold Italic added, and
  every brand-kit font must cover italic, or the mark falls back to a synthetic slant (bad for PDF/UA).
- Links: Forme link annotations were not checked here. A `link` that cannot annotate prints as text.
- Determinism: one renderer for all templates makes byte stability easier to test, but the render engine hash changes
  for every template at once, so all saved-export tests move together.

**Other costs and things approach A gives up.**

- Doctrinal slots can be deleted (see [Locked or required parts](#locked-or-required-parts)). That follows Sebastian's
  "completely wipe" and changes today's rule. If the network needs the slot to survive, a `slot.required` lint can
  warn on export without locking.
- No conditional content and no per-row repetition beyond a table `source`. The agenda overflow note and similar "if"
  text need a later `if` node or must live in the data.
- No free layout. A user cannot drag a text frame to an exact spot, rotate it or overlap it with an image. Certificates,
  name badges with photos at fixed spots and flyers are harder than in a canvas tool.
- No cross-sheet formulas. The first-year budget changes from two sheets to one.
- One custom table node view is the biggest piece of new editor code, and it is the riskiest part of the Tiptap port.
- A template is now data, and a church can break a template's look. Everyfield built-ins keep the owner's one-by-one
  approval because they are files in the repo.

## Explored and set aside

- **Absolute-positioned canvas** (Canva style: every element at x, y on the page). It builds any card or flyer, but
  prose cannot flow across pages, DOCX export is hopeless and accessibility tagging needs a reading order the user
  never sets. Rejected for a product whose main documents are policies.
- **Spreadsheet-first** (every document is a grid of cells). It is good for budgets and sign-in sheets and poor for a
  five-page bylaws document. Rejected.
- **Two formats** (rich text for prose, a form schema for the rest). Sebastian asked for one. It also doubles the
  renderers and the editor.
- **Generic table with free formulas** (A1 references in cells). Inserting a row breaks references unless the editor
  rewrites them, and a church that types `=B7*12` into a cell has a spreadsheet, not a template. Typed columns and row
  roles keep the formulas structural.
