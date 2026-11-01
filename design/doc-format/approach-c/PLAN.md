# Wipe and rebuild plan (approach C)

Nobody uses the templates yet, so nothing migrates. The old code goes, and each template comes back as one JSON file in
the format of [DESIGN.md](DESIGN.md). The four files in [`examples/`](examples/) are the first four rebuilt templates.

## Order

| Step | What happens | Ends when |
|---|---|---|
| 1 | Land the format: the schema and validator in `packages/contracts`, the editor model operations, and the PDF, DOCX and XLSX tree walkers in `packages/domain`. | The four examples render to PDF, DOCX and (budget) XLSX in the app's stack and their unit tests pass. |
| 2 | Switch the plumbing. `createFromTemplate` calls `fork()`. Templates load from `packages/domain/src/documents/templates/*.json`. Delete the old body schema, the frame types, the editable lists and the registry. | The four examples are the only templates, and create, edit, export and preview work for each. |
| 3 | Rewrite the other fixed layout that exists today (response card). Delete `card.tsx` and `sign-in.tsx`. | Both cards and the sign-in sheet come from JSON. |
| 4 | Rewrite the prose templates that exist today and the three other policies of PR #395. Delete `church-doc.tsx` and the content files. | Every prose template comes from JSON. |
| 5 | Rewrite agendas, checklists and the first-year budget. Delete `agenda.tsx`, `checklists.tsx` and the hand-written sheets in `xlsx.ts`. | All 11 existing templates and the 4 policies come from JSON. No template code remains. |
| 6 | Write Maya's missing templates in her priority order (1 to 5, then the rest). | Each named catalog entry has a JSON file. |
| 7 | Write the 13 stated-but-unnamed templates once Maya names them. | The catalog's `not_yet_named` is 0. |

Step 1 and 2 are code. From step 3 on, a template is a data file plus its checks, so the work per template is
writing, not building.

## How a template is checked

Each row below names the checks it needs, by letter.

- **V, valid.** The file passes the format check (today: `node check.mjs <file>`).
- **T, text parity.** A script compares the plain text, the headings and the field keys with the old source. For a
  rewrite, nothing is lost by accident. For a new template, the text matches the approved draft.
- **F, form fields.** The PDF's form field names equal the `fields` list that `registry.ts` records today
  (for example `guest_1_name` to `guest_18_invited_by`), so nothing that reads the filled PDF breaks.
- **R, render.** PDF, DOCX and (when the document has a table) XLSX open without errors. The PDF page count and the
  outline match the template's description. The card sheet prints as one sheet.
- **X, spreadsheet.** For the same inputs, the XLSX totals equal today's workbook and the editor's computed totals.
- **O, owner.** Sebastian approves each template on its own, with brand and neutral renders, as he asked on Oct 30
  ("I want to approve them one by one").

## Code today: `packages/domain/src/documents/templates/` and `layouts/`

| Item | Action | Step | Check |
|---|---|---|---|
| `templates/church.ts` (`ChurchTemplate`, `Frame`, `MERGE_FIELDS`, `resolveTokens`, `CHURCH_TEMPLATES`, `PENDING_EDITABLE`, `NOT_EDITABLE`) | Delete. Merge fields become each template's `fields`. Frames become body content. Both lists go, because every template is editable. | 2 | No import remains; the type check passes; V for each template that used it. |
| `templates/church-content.ts` (`BYLAWS_BODY`, `PRAYER_LETTER_BODY`) | Rewrite as `bylaws.json` and `prayer-letter.json`; the statement of faith becomes a `slot`. Then delete the file. | 4 | V, T, R, O |
| `templates/text-content.ts` (`MEMBER_EXPECTATIONS`, `LAUNCH_TEAM_COMMITMENT`, `FOLLOW_UP_LETTER`) | Rewrite as three JSON files; signature slots become a `columns` row of write-in `field`s; the letter sign-off becomes paragraphs with the pastor-name field. Then delete. | 4 | V, T, F, R, O |
| `templates/card-content.ts` (`COMMITMENT_CARD`, `RESPONSE_CARD`) | Rewrite. `commitment-card.json` is [done](examples/commitment-card.json); `response-card.json` follows the same shape with 4 rows and no tiles. Then delete. | 2 and 3 | V, T, F, R, O |
| `templates/agenda-content.ts` (`VISION_AGENDA`, `BOARD_AGENDA`) | Rewrite as two JSON files with tables named `run`, `attendee` and `action`. The "print from a meeting" action forks the template and fills the `run` and `attendee` rows from the meeting; with no meeting data the blank rows stay. Then delete. | 5 | V, T, F, R, O; one render from a seeded meeting and one from an empty meeting |
| `templates/checklists-content.ts` (`CHECKLIST_TEAMS`) | Rewrite as `launch-sunday-checklists.json`: one `heading` and one `table` (Done check box, Task, Owner, Time) per team, a `pageBreak` after three teams. Then delete. | 5 | V, T, F, R, O |
| `templates/registry.ts` (`REGISTRY`, `contentSnapshot`) | Delete. Previews render the template JSON through the one renderer; the render engine version hashes the JSON files. | 2 | Preview of every template renders; the hash changes when a file changes. |
| `layouts/blocks.tsx` (`T`, `Field`, `Cellfield`, `DataTable`, `LogoSlot`, `Footer`, `Title`) | Rewrite as the node renderers of the PDF walker. The approved look stays in these functions. | 1 | Render of the four examples matches the approved look (the WP-036/ui merge-review renders) in brand and neutral. |
| `layouts/shell.tsx` (`Doc`, `LETTER`, `CARD`, margins, `DoctrineSlot`) | Rewrite: `Doc` and the theme stay; page sizes come from `page`; `DoctrineSlot` becomes the `slot` renderer. | 1 | Same as above. |
| `layouts/church-doc.tsx` | Delete. Its letterhead, kicker, title, frame and footer are body nodes and the page footer now. | 4 | No import remains. |
| `layouts/card.tsx` | Delete. | 3 | No import remains; the card sheet renders from JSON. |
| `layouts/sign-in.tsx` | Delete. | 2 | No import remains; F for the sign-in sheet. |
| `layouts/agenda.tsx` | Delete. | 5 | No import remains. |
| `layouts/checklists.tsx` | Delete. | 5 | No import remains. |
| `documents/docx.ts` and `documents/xlsx.ts` (renderers, outside the two folders) | Rewrite as tree walkers per the mapping table in DESIGN.md. | 1 | R and X for the four examples. |
| `packages/contracts/src/documents/body.ts` (`churchBlock`) | Delete; the format schema replaces it. | 2 | The type check passes; the stored body is the format's `body`. |

## PR #395's four policies

The text comes from `policy-content.ts` on `origin/task/wp-037`. If PR #395 merges first, these are rewrites of merged
code; if it closes, they are writes from that file.

| Template | Action | Step | Check |
|---|---|---|---|
| `conflict-of-interest-policy` | Rewrite. [Done](examples/conflict-of-interest-policy.json). | 2 | V, T, F (`adopt_*`), R, O |
| `board-minutes` | Rewrite. The sign frame (Secretary, Chair) becomes a `columns` row of write-in fields under the closing paragraph. | 4 | V, T, F, R, O |
| `financial-controls-policy` | Rewrite, same shape as the conflict-of-interest example. | 4 | V, T, F, R, O |
| `accountable-plan-reimbursement-policy` | Rewrite, same shape. | 4 | V, T, F, R, O |

## The catalog: every `templates` entry in `docs/catalog/document-templates.json`

The catalog's `editable` flag and its format rule change with step 2: every template is editable, every template
exports PDF and DOCX, and a template with a table also exports XLSX. That is a catalog and requirement change for the
spec task that follows Sebastian's pick, not for this design task.

| Catalog id | Today | Action | Step | Check |
|---|---|---|---|---|
| `commitment-card` | code | Rewrite ([done](examples/commitment-card.json)) | 2 | V, T, F, R, O |
| `response-card` | code | Rewrite | 3 | V, T, F, R, O |
| `guest-sign-in-sheet` | code | Rewrite ([done](examples/guest-sign-in-sheet.json)) | 2 | V, T, F, R, O |
| `vision-meeting-agenda` | code | Rewrite (meeting fill) | 5 | V, T, F, R, O |
| `member-expectations` | code | Rewrite | 4 | V, T, F, R, O |
| `launch-team-commitment` | code | Rewrite | 4 | V, T, F, R, O |
| `follow-up-letter` | code | Rewrite | 4 | V, T, F, R, O |
| `board-meeting-agenda` | code | Rewrite (meeting fill) | 5 | V, T, F, R, O |
| `first-year-budget` | code (XLSX) | Rewrite: two tables, the second after a `pageBreak` with `sheet: "Annual summary"`, linked by named totals | 5 | V, T, R, X, O |
| `budget-worksheet` | code (XLSX) | Rewrite ([done](examples/budget-worksheet.json)) | 2 | V, T, R, X, O |
| `launch-sunday-checklists` | code | Rewrite | 5 | V, T, F, R, O |
| `vision-meeting-invitation` | email | Keep out of the format (see below) | none | Unchanged |
| `vision-meeting-reminder` | email | Keep out of the format | none | Unchanged |
| `vision-meeting-follow-up-attended` | email | Keep out of the format | none | Unchanged |
| `vision-meeting-follow-up-no-show` | email | Keep out of the format | none | Unchanged |
| `orientation-invitation` | email | Keep out of the format | none | Unchanged |
| `team-meeting-invitation` | email | Keep out of the format | none | Unchanged |
| `general-announcement` | email | Keep out of the format | none | Unchanged |
| `bylaws` | code | Rewrite (`slot` for the statement of faith) | 4 | V, T, F, R, O |
| `board-minutes` | PR #395 | Rewrite | 4 | V, T, F, R, O |
| `conflict-of-interest-policy` | PR #395 | Rewrite ([done](examples/conflict-of-interest-policy.json)) | 2 | V, T, F, R, O |
| `financial-controls-policy` | PR #395 | Rewrite | 4 | V, T, F, R, O |
| `accountable-plan-reimbursement-policy` | PR #395 | Rewrite | 4 | V, T, F, R, O |
| `group-exemption-rev-proc-2026-8` | not written (listed with Maya 1 in the backlog) | Write | 6, first | V, T, R, O |
| `child-protection-policy` | not written (Maya 2) | Write | 6 | V, T, R, O |
| `volunteer-application` | not written (Maya 2) | Write: write-in fields and a references table | 6 | V, T, F, R, O |
| `background-check-consent` | not written (Maya 2) | Write: consent text, write-in fields, a signature row | 6 | V, T, F, R, O |
| `church-planting-prospectus` | not written (Maya 3) | Write | 6 | V, T, R, O |
| `partnership-agreement` | not written (Maya 3) | Write | 6 | V, T, F, R, O |
| `residency-plan` | not written (listed with Maya 3 in the backlog) | Write | 6 | V, T, R, O |
| `launch-sunday-run-sheet` | not written (Maya 4) | Write: a time, segment, lead and notes table | 6 | V, T, F, R, O |
| `monthly-progress-report` | not written (Maya 5) | Write | 6 | V, T, R, O |
| `prayer-letter` | code (Maya 5) | Rewrite | 4 | V, T, F, R, O |
| `support-letter` | not written (Maya 5) | Write | 6 | V, T, R, O |
| `vision-meeting-kit-checklist` | not written (then the rest) | Write: a checklist table | 6 | V, T, F, R, O |
| `vision-meeting-self-assessment` | not written | Write: a rating table with check boxes | 6 | V, T, F, R, O |
| `follow-up-interview-questions` | not written | Write: numbered questions with answer boxes | 6 | V, T, R, O |
| `ministry-team-checklists` | not written | Write: one table per team, like the launch checklists | 6 | V, T, F, R, O |

### Maya's list beyond the named entries

The catalog's `maya_list` records 51 stated templates, 38 named in the repository (the table above) and 13 not yet
named.

| Group | Count | Action | Step | Check |
|---|---|---|---|---|
| Stated by Maya, not yet named in any repo file | 13 | Write, once Maya names them | 7 | V, T, R, O |

The ask also counts 11 + 7 + 7 + 33 = 58, which is not 51. That gap is open in the catalog today, and this plan does
not close it.

## The backlog (`.git/evf/runtime/templates/backlog.md`)

| Item | Action | Step | Check |
|---|---|---|---|
| WP-036/ui document look prototype (approved Oct 30) | Rewrite: the look moves into the node renderers of step 1 | 1 | Renders match the approved merge-review renders |
| OPS-77 brand kit registration and WP-104 (brand kit) | Rewrite: the format reads the brand kit at render (`logo`, `tone`, fills); the kit stays out of the envelope | 1 | Brand and neutral renders of the four examples |
| WP-036/api Forme engine and rebuild of the 11 templates | Rewrite: the 11 templates are the code rows above, rebuilt as JSON | 2 to 5 | As per row |
| Quick win: vision document (`docs/reference/task-templates.ts` line 305) | Write `vision-document.json` | 6 | V, T, R, O |
| Quick win: core group covenant (`task-templates.ts` line 315) | Write `core-group-covenant.json` | 6 | V, T, F, R, O |
| Quick win: worship team run sheet (`task-templates.ts` line 566) | Write `worship-team-run-sheet.json` (same table shape as the launch run sheet) | 6 | V, T, F, R, O |
| Quick win: launch day run sheet (lines 800 and 816) | Write: this is `launch-sunday-run-sheet` in the catalog table | 6 | As per that row |
| Quick win: article checklist T.1 to T.9 (`docs/reference/article-checklist.md`) | Rewrite or write: T.1 vision-meeting-agenda, T.2 vision-meeting-kit-checklist, T.3 response-card, T.4 guest-sign-in-sheet, T.5 commitment-card, T.6 vision-meeting-self-assessment, T.7 follow-up-interview-questions, T.8 launch-sunday-checklists, T.9 ministry-team-checklists; all nine are catalog rows above | 2 to 6 | As per row |
| Maya's missing documents by priority | Write, in the order of the catalog table | 6 | As per row |
| Per-document better-interface review | Rewrite: it becomes check O, with the better-* review on brand and neutral renders | each step | O |
| Email templates review and church branding in emails | Keep out of the format (see below) | none | Unchanged |

## The asks (`.git/evf/runtime/templates/asks/`)

| Ask | Action | Step | Check |
|---|---|---|---|
| `agendas-from-meeting-data.md` | Rewrite the agendas so the meeting print action forks the template and fills the `run` and `attendee` tables from the meeting; blank rows when the meeting has none | 5 | Renders from a seeded meeting and from an empty one; O |
| `doc-look-proto.md` | Rewrite: the approved look lives in the node renderers | 1 | Renders match the approved look |
| `ops-79-editable-templates.md` | Rewrite: OPS-79 made prose editable and kept fixed layouts as field-filled PDFs; this format makes every template editable, so the "fixed-layout documents stay PDF only" rule goes | 2 | The catalog and DOC-001 change in the spec task after the pick |
| `ops-brand-kit-plan.md` | Rewrite: brand assets reach every template through `logo`, `tone` and fills | 1 | Brand and neutral renders |
| `ops-template-owner-approval.md` | Keep: every template PR stays an owner-approval PR | each step | O |
| `wp036-api-engine.md` (and its `.bak-1201` copy) | Rewrite: the Forme renderer walks the tree | 1 | R |
| `wp037-church-documents.md` | Rewrite: a Church Document stores the envelope; DOC-019 is derived from the class; DOC-020 is the `slot` node | 2 | V; the legal notice prints after a wipe |
| `wp104-api-brand-kit.md` | Keep: the brand kit API is unchanged; the format only reads it | 1 | Brand and neutral renders |

## The 7 email templates

The format does not cover them, on purpose. An email is not a page: it has no page size, no margins, no print and no
PDF or DOCX. It has things a page does not have: a subject, a preheader, a plain-text part, a call-to-action button
and the narrow CSS that mail clients accept. The communication system sends them, with their own merge data
(recipient, meeting link). Forcing them into the envelope would add a page-less mode, a button node and a second set
of render rules to every renderer, for 7 templates.

The inline part of the format (paragraphs, headings, lists, the seven marks and fields) would fit an email body well.
If Sebastian later wants one editor for emails too, the step is a "mail" profile: the same node subset, plus a
`button` node, with `page` replaced by a `mail` header. This plan leaves them in
`docs/reference/communication-system-templates.ts`.
