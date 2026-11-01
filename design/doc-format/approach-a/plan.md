# Approach A plan: wipe and rebuild every template

Nobody uses the templates yet, so this plan deletes the template code and rebuilds each template as one
`everyfield.doc/1` JSON file. Nothing migrates. The new path is built first, each template moves to it in batches, and
each old layout file is deleted when its last template has moved. Sebastian keeps approving templates one by one.

## Scope and counts

| Source | Count | Notes |
|---|---|---|
| `packages/domain/src/documents/templates/` | 13 ids | 11 rendered entries in `registry.ts` plus `bylaws` and `prayer-letter` from `church.ts`. `member-expectations`, `launch-team-commitment` and `follow-up-letter` are in both files and count once. |
| PR #395 (`task/wp-037`) | 4 ids | `board-minutes`, `conflict-of-interest-policy`, `financial-controls-policy`, `accountable-plan-reimbursement-policy`. All 4 are also in the catalog. |
| `docs/catalog/document-templates.json` `templates` | 38 ids | 11 `existing` + 7 `email` + 7 `planned` + 13 `named`. 13 of the 38 are the code ids above (the 11 existing plus `bylaws` and `prayer-letter`). 4 are PR #395's. |
| `maya_list` | 51 stated | 38 named (the 38 catalog ids) + 13 not yet named. The catalog note also records that the ask counts 11 + 7 + 7 + 33 = 58, not 51. That gap is still open, and this plan does not guess at it. |
| `.git/evf/runtime/templates/backlog.md` | 3 new ids | Quick wins with no template: the vision document (`share-vision-doc`), the core group covenant (`covenant`) and the worship team run sheet (`worship-run-sheet`). The launch day run sheet (`print-run-sheet`, `brief-leaders`) is the catalog's `launch-sunday-run-sheet`. Article checklist T.1 to T.9 are all catalog ids already (T.1 `vision-meeting-agenda`, T.2 `vision-meeting-kit-checklist`, T.3 `response-card`, T.4 `guest-sign-in-sheet`, T.5 `commitment-card`, T.6 `vision-meeting-self-assessment`, T.7 `follow-up-interview-questions`, T.8 `launch-sunday-checklists`, T.9 `ministry-team-checklists`). |
| `.git/evf/runtime/templates/asks/` | 0 new ids | The asks change how templates behave, not which exist. See [Asks](#asks). |

Total rows: 38 catalog ids + 13 unnamed Maya templates + 3 backlog ids = **54**. By action: 17 rewrite (13 from code,
4 from PR #395), 7 delete (the email rows), 14 new named, 3 new from the backlog and 13 new but blocked until Maya's
list names them.

## Checks

Each row names the checks it must pass before Sebastian sees its review renders.

| Code | Check |
|---|---|
| V | `validate.mjs` (later the zod port in contracts) passes on the template JSON. |
| R | Review renders for the owner: brand PNG, neutral PNG and every export, in `~/Desktop/everyfield-template-review/<task>/<id>/`. Sebastian approves each template in chat. |
| T | Text parity with today: the PDF from the JSON has the same page text, outline and form field names as the code template's PDF at main. Byte equality is not expected (the renderer changes). |
| C | Copy parity with PR #395: the JSON text equals the approved `policy-content.ts` text with `{church_name}` as a field. |
| D | The DOCX opens in Word and LibreOffice with the same text and headings as the PDF. |
| X | The XLSX opens; LibreOffice headless recalculation gives the same totals as `computeTable` for a seeded set of amounts. |
| M | The agenda renders from a seeded meeting (rows from `meeting.agenda`) and from an empty meeting (write-in rows). |
| F | Fork, edit, wipe: a document forked from the template validates after a full wipe, and its export still prints the class's fixed parts. |
| N | New content: copy review with the copy rules ("church plant", never bare "plant"; "Everyfield"; "Template, not legal advice" on formal or legal templates; doctrinal text only in slots). |

## Templates

Batches run in order. A batch starts when the one before it is approved. Inside a batch the order is the row order.

| # | Id | Source | Action | Batch | Check |
|---|---|---|---|---|---|
| 1 | `conflict-of-interest-policy` | PR #395 | rewrite (approach A example exists) | 1 | V C R D F |
| 2 | `commitment-card` | code | rewrite (example exists) | 1 | V T R D F |
| 3 | `guest-sign-in-sheet` | code | rewrite (example exists) | 1 | V T R D F |
| 4 | `budget-worksheet` | code | rewrite (example exists) | 1 | V X R D F |
| 5 | `response-card` | code | rewrite | 2 | V T R D F |
| 6 | `first-year-budget` | code | rewrite (two sheets become one table with year total and monthly average columns) | 2 | V X R D F |
| 7 | `vision-meeting-agenda` | code | rewrite (run of show and attendees read `meeting.agenda` and `meeting.attendees`) | 2 | V T M R D F |
| 8 | `board-meeting-agenda` | code | rewrite (same as row 7) | 2 | V T M R D F |
| 9 | `launch-sunday-checklists` | code | rewrite | 2 | V T R D F |
| 10 | `member-expectations` | code | rewrite | 2 | V T R D F |
| 11 | `launch-team-commitment` | code | rewrite | 2 | V T R D F |
| 12 | `follow-up-letter` | code | rewrite | 2 | V T R D F |
| 13 | `bylaws` | code | rewrite (statement-of-faith becomes a `slot` block) | 2 | V T R D F |
| 14 | `prayer-letter` | code | rewrite | 2 | V T R D F |
| 15 | `board-minutes` | PR #395 | rewrite | 2 | V C R D F |
| 16 | `financial-controls-policy` | PR #395 | rewrite | 2 | V C R D F |
| 17 | `accountable-plan-reimbursement-policy` | PR #395 | rewrite | 2 | V C R D F |
| 18 | `vision-meeting-invitation` | catalog, email | delete (catalog row; stays in the communication system) | 3 | `check-document-templates.py` passes without it |
| 19 | `vision-meeting-reminder` | catalog, email | delete (catalog row) | 3 | as row 18 |
| 20 | `vision-meeting-follow-up-attended` | catalog, email | delete (catalog row) | 3 | as row 18 |
| 21 | `vision-meeting-follow-up-no-show` | catalog, email | delete (catalog row) | 3 | as row 18 |
| 22 | `orientation-invitation` | catalog, email | delete (catalog row) | 3 | as row 18 |
| 23 | `team-meeting-invitation` | catalog, email | delete (catalog row) | 3 | as row 18 |
| 24 | `general-announcement` | catalog, email | delete (catalog row) | 3 | as row 18 |
| 25 | `group-exemption-rev-proc-2026-8` | catalog, Maya priority 1 | new | 4 | V N R D F |
| 26 | `child-protection-policy` | catalog, Maya priority 2 | new | 5 | V N R D F |
| 27 | `volunteer-application` | catalog, Maya priority 2 | new (form: `writeIn` rows and a references table) | 5 | V N R D F |
| 28 | `background-check-consent` | catalog, Maya priority 2 | new (formal/legal form with signature `writeIn`) | 5 | V N R D F |
| 29 | `church-planting-prospectus` | catalog, Maya priority 3 | new | 6 | V N R D F |
| 30 | `partnership-agreement` | catalog, Maya priority 3 | new | 6 | V N R D F |
| 31 | `residency-plan` | catalog, Maya priority 3 | new | 6 | V N R D F |
| 32 | `launch-sunday-run-sheet` | catalog, Maya priority 4; backlog `print-run-sheet`, `brief-leaders` | new (data-bound table like the agenda) | 7 | V N M R D F |
| 33 | `monthly-progress-report` | catalog, Maya priority 5 | new | 8 | V N R D F |
| 34 | `support-letter` | catalog, Maya priority 5 | new | 8 | V N R D F |
| 35 | `vision-meeting-kit-checklist` | catalog, planned (article T.2) | new | 9 | V N R D F |
| 36 | `vision-meeting-self-assessment` | catalog, planned (article T.6) | new | 9 | V N R D F |
| 37 | `follow-up-interview-questions` | catalog, planned (article T.7) | new | 9 | V N R D F |
| 38 | `ministry-team-checklists` | catalog, planned (article T.9) | new | 9 | V N R D F |
| 39 | `vision-document` | backlog (`share-vision-doc`, task-templates.ts) | new (register in the catalog first) | 9 | V N R D F |
| 40 | `core-group-covenant` | backlog (`covenant`, task-templates.ts) | new (register in the catalog first) | 9 | V N R D F |
| 41 | `worship-run-sheet` | backlog (`worship-run-sheet`, task-templates.ts) | new (register in the catalog first) | 9 | V N R D F |
| 42 | `maya-unnamed-01` | `maya_list`, not yet named | new, blocked until named | 10 | V N R D F |
| 43 | `maya-unnamed-02` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 44 | `maya-unnamed-03` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 45 | `maya-unnamed-04` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 46 | `maya-unnamed-05` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 47 | `maya-unnamed-06` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 48 | `maya-unnamed-07` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 49 | `maya-unnamed-08` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 50 | `maya-unnamed-09` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 51 | `maya-unnamed-10` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 52 | `maya-unnamed-11` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 53 | `maya-unnamed-12` | `maya_list` | new, blocked until named | 10 | V N R D F |
| 54 | `maya-unnamed-13` | `maya_list` | new, blocked until named | 10 | V N R D F |

Batch 1 is the four approach A examples. They cover the four layout families (prose policy, tiled card, write-in
table, ledger), so a renderer that passes batch 1 has every node it needs. Batch 2 finishes everything that exists
today. Batches 4 to 9 follow Maya's priority order from the backlog, then the planned and backlog items. Batch 10 waits
for names. Rows 39 to 41 need catalog ids before they are built; the ids above are proposals.

Some backlog and catalog items may turn out to be the same template under two names. The plan keeps one row for each
id and merges rows only when Sebastian or Maya confirms they are the same document.

## Build order and what gets deleted

### Batch 0: the new path, nothing deleted

1. `packages/contracts/src/documents/format/`: the schema as zod, a port of the `format.js` rules, the upgrade hook for
   later format versions, `computeTable` and `parseFormula`.
2. `packages/domain/src/documents/templates/<id>.json`: the built-in template files, and a loader that reads them,
   validates them at build time and gives `contentSnapshot()` their canonical JSON.
3. A generic Forme renderer for the tree (`layouts/doc.tsx`), built from the parts in `blocks.tsx`. Tiling first,
   because it is the riskiest Forme piece.
4. `docx.ts` and the ledger part of `xlsx.ts` as tree walkers.
5. Storage: `document_revision.body` holds the new JSON; `document.kind` gains `template` for church-owned templates.
   The `slot_not_deletable` check goes away.
6. The editor port (Tiptap with the approach A nodes), behind the existing documents route.
7. `mergePolicy`: add `packages/domain/src/documents/templates/*.json` to the template owner-approval class.

Exit check: the four example files render to PDF, DOCX and (budget) XLSX through the new path, and their PDFs pass the
same contrast log rules as today.

### Batches 1 and 2: move templates, then delete each old file when its last user moves

| Order | Delete | After |
|---|---|---|
| 1 | `templates/card-content.ts`, `layouts/card.tsx` | rows 2 and 5 (both cards) |
| 2 | `layouts/sign-in.tsx` (`SIGN_IN_ROWS`) | row 3 |
| 3 | `templates/agenda-content.ts`, `layouts/agenda.tsx`. `agenda-meeting.ts` stays; it now fills the `meeting.agenda` and `meeting.attendees` list fields | rows 7 and 8 |
| 4 | `templates/checklists-content.ts`, `layouts/checklists.tsx` | row 9 |
| 5 | In `xlsx.ts`: `firstYear`, `worksheet`, `block`, `INCOME_ROWS`, `EXPENSE_ROWS`. The workbook writer, styles and zip stay for the ledger exporter | rows 4 and 6 |
| 6 | `templates/church-content.ts`, `templates/text-content.ts`, PR #395's `policy-content.ts`, and in `templates/church.ts`: `ChurchTemplate`, `Frame`, `MERGE_FIELDS`, `resolveTokens`, `resolveBody`, `bodyOfSpec`, `PENDING_EDITABLE`, `NOT_EDITABLE`. Then `layouts/church-doc.tsx` | rows 1 and 10 to 17 |
| 7 | `templates/registry.ts` (replaced by the JSON loader) | all of batch 2 |
| 8 | `packages/contracts/src/documents/body.ts`: `churchBlock`, `churchBody`, `blockCount`, `slotIdsOf`. There is no data to migrate | step 6 |
| 9 | `layouts/shell.tsx`: `LETTER`, `CARD`, `LETTER_MARGIN`, `CARD_MARGIN` (now page presets) and `DoctrineSlot` (now the `slot` renderer). `Doc` stays | step 7 |
| 10 | `blocks.tsx`: trim exports the generic renderer does not use | step 9 |
| 11 | Per-layout render tests, replaced by one golden test per template file | each step above |

### Batch 3: catalog cleanup

- `docs/catalog/document-templates.json`: delete the 7 email rows (rows 18 to 24), delete the `editable` flag (every
  template is editable now), and rewrite `format_rule`: every document exports PDF and DOCX, a document with a ledger
  table also exports XLSX, emails are not documents.
- `docs/reference/document-templates.ts` points at the JSON files. `docs/catalog/check-document-templates.py` checks
  that each catalog id has a JSON file that validates.
- The product chapter (`docs/product/knowledge-documents.md`, DOC-001, DOC-019, DOC-020): the editable split goes away,
  the legal notice is a class rule, and doctrinal slots can be deleted.

### Batches 4 to 10: new templates

Each new template is authored as JSON. Once the editor port ships, an author builds it in the editor in template mode
and the saved JSON goes into the PR. Each PR carries one batch, and Sebastian approves each template in it.

## Asks

| Ask file | What it means for this plan |
|---|---|
| `agendas-from-meeting-data.md` | Rows 7, 8 and 32 use `table.source` with blank `writeInRows` as the fallback. Check M. |
| `doc-look-proto.md`, `wp036-api-engine.md` | The approved look is now renderer rules and tokens. Check T keeps it for rows 2 to 14. |
| `ops-79-editable-templates.md` | Superseded by Sebastian's Oct 31 quotes: every template is editable, so the `editable` flag goes (batch 3). PDF and DOCX for every document. |
| `ops-template-owner-approval.md` | Built-in JSON files join the owner-approval class (batch 0, step 7). Check R on every row. |
| `wp037-church-documents.md` | Church documents are `everyfield.doc/1` documents. DOC-019 is a class rule. DOC-020 holds as a visible blank, but the slot can be deleted (design doc, locked parts). |
| `wp104-api-brand-kit.md`, `ops-brand-kit-plan.md` | Tokens (`primary`, `accent`) and `image` slots (`logo`, `mark`, `photo`) read the brand kit at render time. |
