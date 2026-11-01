# Approach A: one page tree with typed tables

Approach A stores every template and document as one JSON tree, `everyfield.doc/1`, in the ProseMirror shape that
Tiptap reads. Prose stays plain rich text. Layout comes from a small set of blocks (columns, boxes, write-in fields,
image slots, dividers) and two ideas that do most of the work. First, page setup owns the paper: a 4-up card is one
card's content with `tile: { across: 2, down: 2 }`, so the editor draws one card and the sheet repeats it. Second, the
table is typed: columns are text, number, money, check, index or formula, and rows are items, groups, subtotals or
totals. That one node is the sign-in sheet, the checklists, the agenda (fed from the meeting's own data) and the
budget, whose totals are computed from structure instead of cell addresses and export to XLSX as live formulas. Colors
are theme tokens, so a rebuilt card still follows the church's brand kit and the contrast rules. Nothing in the body is
locked: a fork can be wiped to an empty, valid document. The legal notice is a class rule the renderer prints, not
content. The format leaves out emails, free positioning and conditional text, and the design doc says what that costs.

## Files

| What | File |
|---|---|
| Design doc (schema, page setup, layout, fields, locks, envelope, versioning, rendering, budgets, layout mapping, editor choice, emails, risks) | [design.md](design.md) |
| Wipe-and-rebuild plan (54 rows) | [plan.md](plan.md) |
| Machine-readable schema | [schema.json](schema.json) |
| Validator, table math and forking (Node and browser) | [format.js](format.js) |
| Validator command | [validate.mjs](validate.mjs) |
| Tests | [test.mjs](test.mjs) |
| Example: policy (PR #395's Conflict of Interest Policy) | [examples/conflict-of-interest-policy.json](examples/conflict-of-interest-policy.json) |
| Example: 4-up commitment card sheet | [examples/commitment-card-sheet.json](examples/commitment-card-sheet.json) |
| Example: guest sign-in sheet | [examples/guest-sign-in-sheet.json](examples/guest-sign-in-sheet.json) |
| Example: budget worksheet | [examples/budget-worksheet.json](examples/budget-worksheet.json) |
| Invalid samples and their expected messages | [invalid/expected.json](invalid/expected.json) |
| Prototype entry file | [prototype/index.html](prototype/index.html) |

## Run it

From the repository root, with Python 3 and Node 22 or later. Nothing to install.

```bash
# Validate the four examples and check that each invalid sample fails with its message
node design/doc-format/approach-a/validate.mjs

# Validate any file, for example one downloaded from the prototype
node design/doc-format/approach-a/validate.mjs ~/Downloads/untitled-abc.json

# Run the tests
node --test design/doc-format/approach-a/test.mjs

# Serve the prototype, then open http://localhost:8103/prototype/
python3 -m http.server 8103 --directory design/doc-format/approach-a
```

The prototype loads `schema.json`, `format.js` and the four example files from that server. It makes no request to
another host. Fonts are vendored. Open a specific example with `?open=<file name without .json>`, and add
`&mode=preview` or `&brand=church` to start in Preview or with the sample church brand.

## Prototype tour

- **Open** loads an example template. **Edit** and **Preview** switch modes. Preview fills merge fields with sample
  data and prints every card on the sheet.
- Click a block to select it. The **Block** tab shows its settings. **Insert block** adds a block after the selected
  one, and **+ Add a block here** fills an empty box or column. **↑**, **↓** and **Delete** move and remove the selected
  block.
- Select words and use **B**, **I**, **U**, **Link** and **Tag** (all five marks). **Insert field** puts a merge field at
  the cursor. Enter splits a paragraph or list item; Shift+Enter adds a line break.
- **Page** sets the paper, margins, tiles, header, footer, class and exports. **Fields** edits merge fields.
  **JSON** shows the serialized document live, with the validator result and **Download JSON**.
- **New from template** forks a template into a document. **Delete all content** wipes it. **Save** stores it in the
  browser and reports the validator result. **Open** lists saved documents.

### Build a 4-up card sheet from empty (criterion 10)

1. Click **New blank**. The **Page** tab opens.
2. Click **4 cards per Letter sheet**. The page becomes a Letter sheet with four 306 x 396 pt tiles and cut marks.
3. Click **Insert block**, then **Color panel**. Type the cover line, for example "Welcome to our church plant."
4. In the **Block** tab, click **Select the box around it**.
5. Click **Insert block**, then **Accent bar**.
6. Click **Insert block**, then **Title**. Type "My commitment".
7. Click **Insert block**, then **Checklist rows**. Click each row's text cell and type a commitment, for example
   "GROW Join a weekly group." Select "GROW" and click **Tag**.
8. Click the checklist table's edge to select it. Click **Insert block**, then **Columns**.
9. Click **+ Add a block here** in the left column and choose **Write-in field**. Do the same in the right column and
   choose **Signature line**.
10. Click **Preview**. The sheet shows four identical cards. The **JSON** tab shows `"tile": { "across": 2, "down": 2, ... }`
    and the validator result.

### Build a sign-in sheet from empty (criterion 11)

1. Click **New blank**.
2. Click **Insert block**, then **Title**. Type "Guest Sign-in Sheet".
3. Click **Insert block**, then **Table**. The table has a header row with three columns and 5 write-in rows.
4. Click each header cell and type its label: "#", "Name", "Email".
5. In the **Block** tab, click **Add column** and type "Phone" in the new column's **Label**.
6. In **Column 1**, set **Type** to **index** and **Width** to 26. The first column now numbers the rows.
7. Set **Write-in rows** to 18 and press Enter. The table now has 18 numbered empty rows.
8. Optional: set **Header fill** to **accent** and tick **Striped rows**.
9. Click **Preview**. The JSON stores `"writeInRows": 18`, not 18 copies of a row.

### Build a budget from empty (criterion 12)

1. Click **New blank**.
2. Click **Insert block**, then **Title**. Type "Launch Budget".
3. Click **Insert block**, then **Budget table**. It has one category ("Category"), one line item, a category total
   and a grand total.
4. Click the category label and type "Income". Click the line item label and type "Sending church support".
   Click the "Category total" label and type "Total income".
5. Click the line item's amount box and type 3000. The category total and the grand total show $3,000.
6. With the line item selected, click **Add line item** in the **Block** tab. Name it "Tithes and offerings" and type
   1200. The category total and the grand total change to $4,200.
7. Click **Add category**. Name the new category "Expenses". Click the "Expenses" row and set **Category sign** to
   **subtract**. Name its line item "Rent", type 1500 and name its total "Total expenses". The grand total changes to
   $2,700.
8. Change the first amount from 3000 to 3500. "Total income" changes to $4,700 and the grand total to $3,200.
9. The JSON stores only the typed amounts. Totals are computed and export to XLSX as `SUM` formulas.

### Fork and wipe (criterion 13)

1. Click **New from template** and choose **Conflict of Interest Policy**. The badge shows
   "Document · from conflict-of-interest-policy v1".
2. Click **Delete all content** and confirm. The body, the header and the footer are gone.
3. Click **Save**. The message says the document passes the validator. The footer still prints
   "Template, not legal advice" with a **Locked** badge, because the class prints it, not the content.

## Sizes

The prototype vendors no library code (0 bytes). It vendors DM Sans Regular, DM Sans Bold and DM Serif Display
(190,112 bytes, OFL, copied from `packages/domain/src/documents/fonts/`, with 9,087 bytes of license text). Its own code:

| File | Bytes |
|---|---|
| `prototype/app.js` | 75,334 |
| `prototype/style.css` | 17,422 |
| `prototype/index.html` | 4,587 |
| `format.js` (shared with Node) | 24,919 |
| `schema.json` (shared with Node) | 9,536 |
