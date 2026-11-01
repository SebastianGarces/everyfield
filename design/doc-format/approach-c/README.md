# Document format, approach C: an owned block tree with typed tables

Approach C stores every Everyfield template and document as one JSON envelope (title, class, page setup, a field
list) around one block tree that Everyfield owns, defined and checked by a dependency-free schema module instead of an
editor library's document model. Three general ideas let the same small node set build the policy, the 4-up card
sheet, the sign-in sheet and the budget. Tables have typed cells (text, number or formula, with Word-style
`sum(above)` and named cells), so a budget is a document with live totals that exports to real XLSX formulas. A
`repeat` node prints one card's content across and down the page, so the 4-up card is one card in a 2 x 2 repeat. A
`field` is one concept: it fills from church data when it has a source and prints as a labelled write-in blank when
it does not. Today's template frames (letterhead, signature and adoption blocks) become ordinary content, so the body
has no locked parts and a fork can be wiped completely; the "Template, not legal advice" notice survives because
export derives it from the document's class instead of storing it as content. The prototype edits all four examples
and builds the card sheet, the sign-in sheet and the budget from an empty document with a library-free editor in which
only text leaves are `contenteditable`; it trades Tiptap's mature text editing for full control of the layout nodes,
and the [design doc](DESIGN.md) is honest about that cost.

## Files

- Design doc: [DESIGN.md](DESIGN.md) (schema, page setup, layout primitives, fields, locks, envelope, versioning,
  rendering, the mapping table, why not Tiptap, the example sources, and the tradeoffs and risks)
- Wipe-and-rebuild plan: [PLAN.md](PLAN.md)
- Machine-readable schema, validator and formula engine: [format.mjs](format.mjs)
- Examples:
  - Policy: [examples/conflict-of-interest-policy.json](examples/conflict-of-interest-policy.json)
  - 4-up card sheet: [examples/commitment-card.json](examples/commitment-card.json)
  - Sign-in sheet: [examples/guest-sign-in-sheet.json](examples/guest-sign-in-sheet.json)
  - Budget: [examples/budget-worksheet.json](examples/budget-worksheet.json)
- Prototype entry file: [prototype/index.html](prototype/index.html) (with [prototype/app.mjs](prototype/app.mjs) and
  [prototype/editor.css](prototype/editor.css))
- Check: [check.mjs](check.mjs), its broken fixture
  [tests/broken/budget-worksheet-broken.json](tests/broken/budget-worksheet-broken.json), and the behavior tests
  [tests/format.test.mjs](tests/format.test.mjs)

## Open the prototype

Run a static file server in this folder, then open the prototype page:

```sh
cd design/doc-format/approach-c
python3 -m http.server 8000
# open http://localhost:8000/prototype/
```

It needs no build step and makes no request to another host. Opening `index.html` as a `file://` URL does not work,
because browsers block ES modules and `fetch` from `file://`. A hash opens one document directly, for example
`http://localhost:8000/prototype/#budget-worksheet`.

What to try: edit and format the policy; click "Use this template" to fork it, edit the copy, then "Delete all
content"; switch to Preview to see the fields filled from sample church data; click "New blank document" and use
"Insert block" to build a card sheet (Repeat), a sign-in sheet (Table) or a budget (Table, then set cell kinds in the
Inspect panel); open the JSON tab to see the serialized document and its check result; use "Print / PDF" for the page.

## Run the check

```sh
node design/doc-format/approach-c/check.mjs                 # all examples pass, the broken copy fails
node design/doc-format/approach-c/check.mjs my-copy.json    # check any file
node --test design/doc-format/approach-c/tests/format.test.mjs
```

Node 18 or newer, no install. The prototype's Check tab runs the same `validate()` in the browser.

## Library choice and size

No editor library. The vendored code is 0 bytes. The prototype is about 70 KB of JavaScript (`app.mjs`), 19 KB of CSS
and 7 KB of HTML, plus the 30 KB schema module it shares with the check. It also carries 260 KB of fonts (DM Sans
400, 500 and 700 and DM Serif Display, the faces the approved document look uses), copied with their OFL licenses
from `packages/domain/src/documents/fonts/`. DESIGN.md gives the reasons for not using Tiptap.
