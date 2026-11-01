# Document format, approach B

Approach B makes every Everyfield template and document one JSON envelope holding a tree of blocks, edited in one block editor. Page layouts are blocks too: a card is a primary box, columns, a table and write-in rows, and a sign-in sheet is a table whose one row repeats 18 times. A budget is a ledger block with groups, lines and results. The app computes its totals, and the XLSX export compiles them to live formulas, so nobody types a cell formula that can break. Printing four cards on a Letter sheet is a page-setup setting (imposition), so the user designs one card. A write-in blank is a different thing from a merge field, and blocks name brand roles (primary, accent), never colors. The content tree has no locks: a fork can change or wipe everything. The one exception is the "Template, not legal advice" notice, which sits on the envelope and survives a wipe. The editor owns the block structure itself; production would use Tiptap only as the text editor inside each text block, and the prototype uses no library at all. Every document exports PDF (Forme) and DOCX, and budgets keep XLSX.

## Files

- Design doc: [`DESIGN.md`](DESIGN.md). Schema, page setup, layout primitives, fields, locks, envelope, versioning, rendering path, editor library, tradeoffs and risks.
- Wipe-and-rebuild plan: [`PLAN.md`](PLAN.md). Every template in scope by id, with what gets deleted, what gets written, the order and the checks.
- Format definition: [`format/schema.json`](format/schema.json) (JSON Schema) and [`format/validator.mjs`](format/validator.mjs) (schema check plus cross-reference rules).
- Examples, each with the content of today's template:
  - Policy: [`examples/conflict-of-interest-policy.json`](examples/conflict-of-interest-policy.json) (PR #395)
  - 4-up card sheet: [`examples/commitment-card.json`](examples/commitment-card.json)
  - Guest sign-in sheet: [`examples/guest-sign-in-sheet.json`](examples/guest-sign-in-sheet.json)
  - Budget: [`examples/first-year-budget.json`](examples/first-year-budget.json)
  - Invalid on purpose: [`examples/invalid/broken-budget.json`](examples/invalid/broken-budget.json)
- Prototype entry file: [`prototype/index.html`](prototype/index.html)

## Validate

Node 22 or later, from the repo root, with no install and no network:

```bash
node design/doc-format/approach-b/tools/validate.mjs                                          # the four examples: exit 0
node design/doc-format/approach-b/tools/validate.mjs design/doc-format/approach-b/examples/invalid/broken-budget.json   # exit 1, four problems
node --test design/doc-format/approach-b/tools/test.mjs                                       # 11 regression tests
```

## Open the prototype

```bash
cd design/doc-format/approach-b
python3 -m http.server 8104 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8104/prototype/>. Add `?open=first-year-budget` (or another example id) to open one example first. Serve the `approach-b` folder itself, not `prototype/`, because the prototype loads `../format/` and `../examples/`.

What to try:

1. Pick a template in the left column. It is read only; its fingerprint shows it never changes.
2. Click **Use this template**. You get a document. Click a block to see its controls: move, delete, **+ Below**, and settings for its type. Type in any text. Set a field value in **Fields**.
3. Change **Page setup** (size, orientation, margins, copies on a sheet). The print preview follows.
4. Click **+ Empty document** and build from nothing with **+ Add block**: a box, brand elements, a repeating table, a budget ledger.
5. **Export JSON** downloads the document. The status chip shows whether it passes the format check.
6. **Wipe document** (click twice) empties a document. The template stays as it was.

Under 1100 px wide, the prototype shows one panel at a time with tabs (Library and setup, Edit, Preview).

## Size and dependencies

The prototype has no build step and no vendored library: **0 KB of vendored code**. Its own code is 118 KB unminified: `prototype/` (HTML, CSS and three ES modules, 101 KB) plus the shared `format/` modules (17 KB) that the validator script also uses. It requests nothing from any origin other than the one that serves it; a Content-Security-Policy meta tag in `index.html` enforces that.
