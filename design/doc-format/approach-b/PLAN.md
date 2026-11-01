# Approach B: wipe-and-rebuild plan

This plan rebuilds every template in scope in the approach B format ([`DESIGN.md`](DESIGN.md)). Nobody uses the templates yet, so nothing migrates. Each template is rewritten as one JSON file, checked, shown to Sebastian and then the old code goes.

Sources read for this list (main at 6fc1c575): `packages/domain/src/documents/templates/`, PR #395 (`policy-content.ts` on `origin/task/wp-037`), `docs/catalog/document-templates.json` (38 ids), `.git/evf/runtime/templates/backlog.md` and the asks in `.git/evf/runtime/templates/asks/`.

## Order

1. **Phase 1: build the format into the app.** No template changes. Nothing is deleted yet.
   1. `packages/contracts/src/documents/format.ts`: the zod schema, its types, the cross-reference rules and the migration list. `z.toJSONSchema()` emits the JSON Schema. The validator rules and tests in this folder move there.
   2. `packages/domain/src/documents/render/`: one Forme walker (PDF), one DOCX walker, one ledger-to-XLSX compiler. The theme helpers (`LogoSlot`, `PhotoSlot`, contrast, fonts) move in from `layouts/blocks.tsx` and `layouts/shell.tsx`.
   3. Storage: a `document_revision` row stores the whole envelope. `createFromTemplate` becomes `fork`.
   4. `apps/web/src/features/documents/native.tsx`: the block editor (own structure editor, Tiptap core inside text blocks), page setup, fields panel, Forme preview.
   5. Gate: the four examples in [`examples/`](examples) render to PDF, DOCX and (budget) XLSX through the new path, and Sebastian approves the review renders.
2. **Phase 2: convert today's 17 templates.** A one-off converter reads today's TypeScript content and writes one JSON file per template (the way this folder's examples were made). Parity tests compare the JSON with the TypeScript before anything is deleted. Order inside the phase: prose first (closest to today's body format), then forms, then budgets.
3. **Phase 3: delete the old code** (list below) once every Phase 2 template passes its checks and Sebastian has approved it.
4. **Phase 4: write the templates that do not exist yet**, in Maya's priority order, as JSON only.
5. **Phase 5: email profile and the 7 email templates.**

## How each template is checked

Each row below names the checks it needs.

- **V (valid).** The file passes the format validator. CI runs it over every template file.
- **P (parity).** For a template that exists today: a test compares every string, list item, table column and field of the JSON with today's TypeScript content. It runs before Phase 3 deletes the TypeScript.
- **R (render).** The PDF renders with the expected page count and heading outline; the DOCX unzips, its XML parses and its text equals the PDF text; brand and neutral PNG review renders, the PDF and the DOCX go to `~/Desktop/everyfield-template-review/<task>/<template-id>/`. Sebastian approves each template in chat, one by one (his Oct 30 11:51 AM ask).
- **X (spreadsheet).** The XLSX opens; a formula evaluator test fills random amounts and checks every formula cell equals `computeLedger`; the sheet names and layout match today's workbook.
- **D (data).** The template renders from a seeded meeting with content and from an empty meeting (blank rows), per the Oct 30 4:38 PM agenda ask.
- **E (email).** The HTML mail and the text part render, the merge fields resolve and the WP-027 branding rules hold.

## Templates in scope

### Phase 2: today's templates (in `packages/domain/src/documents/templates/` on main) and PR #395

| Step | Id | Deleted (today's source) | Written (approach B blocks) | Checks |
|---|---|---|---|---|
| 2.1 | `member-expectations` | `MEMBER_EXPECTATIONS` in `text-content.ts`; its `fromSpec` entry in `church.ts` | header masthead; title; prose; signature `fillRow` from the old `sign` frame slots; footer | V P R |
| 2.2 | `launch-team-commitment` | `LAUNCH_TEAM_COMMITMENT` in `text-content.ts`; `church.ts` entry | same shape as 2.1 | V P R |
| 2.3 | `follow-up-letter` | `FOLLOW_UP_LETTER` in `text-content.ts`; `church.ts` entry | letter: date `fillRow`, greeting, prose, sign-off paragraph, `pastor.name` field | V P R |
| 2.4 | `prayer-letter` | `PRAYER_LETTER_BODY` in `church-content.ts`; `church.ts` entry | letter shape as 2.3 | V P R |
| 2.5 | `bylaws` | `BYLAWS_BODY` in `church-content.ts`; `church.ts` entry | numbered headings; `slot` "Statement of faith"; adoption paragraph; repeating table, 3 signers; legal notice | V P R |
| 2.6 | `board-minutes` | `BOARD_MINUTES_BODY` in PR #395 `policy-content.ts` | prose with prompts; attendance table; adoption table; legal notice | V P R |
| 2.7 | `conflict-of-interest-policy` | `CONFLICT_OF_INTEREST_BODY` in PR #395 | written: [`examples/conflict-of-interest-policy.json`](examples/conflict-of-interest-policy.json) | V P R |
| 2.8 | `financial-controls-policy` | `FINANCIAL_CONTROLS_BODY` in PR #395 | shape as 2.7 | V P R |
| 2.9 | `accountable-plan-reimbursement-policy` | `ACCOUNTABLE_PLAN_BODY` in PR #395 | shape as 2.7 | V P R |
| 2.10 | `commitment-card` | `COMMITMENT_CARD` in `card-content.ts`; `cardEntry` in `registry.ts` | written: [`examples/commitment-card.json`](examples/commitment-card.json); card page, 2 × 2 imposition on Letter | V P R |
| 2.11 | `response-card` | `RESPONSE_CARD` in `card-content.ts`; `cardEntry` | shape as 2.10; four check rows with no badges; Name, Email, Phone `fillRow`s | V P R |
| 2.12 | `guest-sign-in-sheet` | `SIGN_IN_ROWS` and `signInDocument` in `layouts/sign-in.tsx`; `registry.ts` entry | written: [`examples/guest-sign-in-sheet.json`](examples/guest-sign-in-sheet.json) | V P R |
| 2.13 | `launch-sunday-checklists` | `CHECKLIST_TEAMS` in `checklists-content.ts`; `layouts/checklists.tsx` | `launch.date` field; per team (6): heading, lead `fillRow`, table with check box, task, owner and time columns; page break after three teams | V P R |
| 2.14 | `vision-meeting-agenda` | `VISION_AGENDA` and row counts in `agenda-content.ts`; `layouts/agenda.tsx` | meta `fillRow`s bound to `meeting.*`; run-of-show table with `repeat.source: meeting.agenda_items`, 6 blank rows; attendee table with `source: meeting.attendees`, 8 rows; action table, 4 rows | V P R D |
| 2.15 | `board-meeting-agenda` | `BOARD_AGENDA` in `agenda-content.ts`; `layouts/agenda.tsx` | shape as 2.14; facilitator not from `pastor.name` | V P R D |
| 2.16 | `first-year-budget` | `firstYear`, `block`, `INCOME_ROWS`, `EXPENSE_ROWS` in `xlsx.ts`; `registry.ts` entry | written: [`examples/first-year-budget.json`](examples/first-year-budget.json); 12-month `ledger` and `ledgerSummary` | V P R X |
| 2.17 | `budget-worksheet` | `worksheet` in `xlsx.ts`; `registry.ts` entry | `ledger` with 1 period, `times` rule, factor 12 | V P R X |

### Phase 4: catalog ids with no content yet, and backlog items

Maya's priority order from the backlog. Each row writes one new JSON file; nothing is deleted except the id's entry in `PENDING_EDITABLE` or `NOT_EDITABLE` in `church.ts`, which Phase 3 removes as a whole.

| Step | Id | Priority | Written (approach B blocks) | Checks |
|---|---|---|---|---|
| 4.1 | `group-exemption-rev-proc-2026-8` | 1 | formal/legal prose with prompts; legal notice; adoption table | V R |
| 4.2 | `child-protection-policy` | 2 | formal/legal prose; legal notice; adoption table | V R |
| 4.3 | `volunteer-application` | 2 | form: `fillRow`s for contact data; check-list for ministry areas; table of references with write-in cells; signature `fillRow` | V R |
| 4.4 | `background-check-consent` | 2 | formal/legal form: consent prose; `fillRow`s; signature and date; legal notice | V R |
| 4.5 | `church-planting-prospectus` | 3 | outward-facing: primary `box` cover with brand blocks; columns; prose; a `ledgerSummary` is possible when the church has a budget document (a later source) | V R |
| 4.6 | `partnership-agreement` | 3 | formal/legal prose; two-party signature table; legal notice | V R |
| 4.7 | `residency-plan` | 3 | prose; table of milestones with date write-ins | V R |
| 4.8 | `launch-sunday-run-sheet` | 4 | landscape; table with time, segment, lead and notes; `repeat.source` for a run of show when the app stores one, blank rows when not. Backlog lines `task-templates.ts` L800 ("Print the launch day run sheet") and L816 ("Brief every team leader on the run sheet") point here | V R D |
| 4.9 | `worship-team-run-sheet` (new id, backlog `task-templates.ts` L566 "Prepare the worship team run sheet") | 4 | shape as 4.8 with song, key, leader and cue columns | V R |
| 4.10 | `monthly-progress-report` | 5 | outward-facing letter shape; a static table for numbers | V R |
| 4.11 | `support-letter` | 5 | letter shape as 2.3 | V R |
| 4.12 | `vision-meeting-kit-checklist` | rest (article T.2) | check-list blocks grouped by headings | V R |
| 4.13 | `vision-meeting-self-assessment` | rest (article T.6) | table: question text column and five check-box rating columns | V R |
| 4.14 | `follow-up-interview-questions` | rest (article T.7) | numbered questions, each followed by a one-column table with a tall write-in row | V R |
| 4.15 | `ministry-team-checklists` | rest (article T.9) | shape as 2.13 | V R |
| 4.16 | `vision-document` (new id, backlog `task-templates.ts` L305 "Share the vision document with the core group") | rest | outward-facing prose with a cover `box` | V R |
| 4.17 | `core-group-covenant` (new id, backlog `task-templates.ts` L315 key `covenant`) | rest | prose; signature `fillRow` | V R |
| 4.18 | Maya's 13 templates not yet named (catalog `maya_list.not_yet_named`) | rest | one row each when Maya names them; same steps | V R |

The article checklist T.1 to T.9 (`docs/reference/article-checklist.md`) maps onto ids above: T.1 `vision-meeting-agenda`, T.2 `vision-meeting-kit-checklist`, T.3 `response-card`, T.4 `guest-sign-in-sheet`, T.5 `commitment-card`, T.6 `vision-meeting-self-assessment`, T.7 `follow-up-interview-questions`, T.8 `launch-sunday-checklists`, T.9 `ministry-team-checklists`.

### Phase 5: the 7 email templates

| Step | Id | Deleted | Written | Checks |
|---|---|---|---|---|
| 5.1 | `vision-meeting-invitation` | its entry in `docs/reference/communication-system-templates.ts` and the send path's hard-coded body | email-profile JSON | V E |
| 5.2 | `vision-meeting-reminder` | same | same | V E |
| 5.3 | `vision-meeting-follow-up-attended` | same | same | V E |
| 5.4 | `vision-meeting-follow-up-no-show` | same | same | V E |
| 5.5 | `orientation-invitation` | same | same | V E |
| 5.6 | `team-meeting-invitation` | same | same | V E |
| 5.7 | `general-announcement` | same | same | V E |

**Does the format cover the emails? Yes, in format version 2, as an email profile, built last.** An email envelope replaces `page` with `medium: "email"` and allows a subset of blocks: heading, paragraph, list, quote, divider, spacer, brand, box, two-column `columns`, plus a new `button` block (a link styled as the brand's primary button). It uses the same field registry, so `church.name` and `meeting.date` mean the same thing in a letter and an email. The renderer writes table-based HTML mail and a plain-text part, with the WP-027 follow-up rules (header logo at most 200 px, primary button with a derived text color, web-safe fonts, footer with name and address).

Why cover them: a church edits its invitation in the same editor as its letters, and Sebastian asked for one format for all. Why last: emails have no pages, no write-ins and no print, they already send through a working path, and mail clients need their own renderer and test list. Building print first keeps v1 of the schema small.

## Code that gets deleted in Phase 3

- `packages/contracts/src/documents/body.ts` (the block array, `churchBlock`, `slotIdsOf`); `requests.ts` and `results.ts` switch to the envelope type.
- `packages/domain/src/documents/templates/`: `church.ts`, `church-content.ts`, `text-content.ts`, `card-content.ts`, `agenda-content.ts`, `checklists-content.ts`, `registry.ts`, and `policy-content.ts` if PR #395 has merged. Their content lives on as JSON files in `packages/domain/src/documents/templates/*.json`.
- `packages/domain/src/documents/layouts/`: `card.tsx`, `sign-in.tsx`, `agenda.tsx`, `checklists.tsx`, `church-doc.tsx`. `blocks.tsx` and `shell.tsx` are deleted after their theme helpers move into the generic renderer.
- `packages/domain/src/documents/docx.ts`: the per-template frame code goes; a generic block walker replaces it. The ZIP and XML helpers stay.
- `packages/domain/src/documents/xlsx.ts`: `firstYear`, `worksheet`, `block`, `INCOME_ROWS`, `EXPENSE_ROWS` and `buildBudget` go; the ledger compiler replaces them. The workbook writer stays.
- `PENDING_EDITABLE`, `NOT_EDITABLE`, `resolveTokens`, `resolveBody`, `SLOT_BLANK_NOTE` and the `Frame` type in `church.ts` (gone with the file).
- `catalog.ts`, `render.ts`, `church-render.ts` and `church-writes.ts` change to load template JSON and call `fork`.
- Tests rewritten against the new format: `tests/integration/documents/church.test.mts`, `church-render.test.mts`, `agenda.test.mts`, `engine.test.mts`, `packages/domain/test/legal-fixture.tsx`. The byte-hash fixtures (`tests/integration/documents/fixtures/hash-all.mts`) get new hashes, and the render engine version goes up.
- Docs: `docs/catalog/document-templates.json` drops `editable`, its `format_rule` becomes "PDF and DOCX for every document, XLSX for any document with a ledger, HTML mail for emails"; `docs/reference/document-templates.ts` and `packages/reference/src/artifacts.json` follow.

## What the asks change in this plan

| Ask in `.git/evf/runtime/templates/asks/` | Effect here |
|---|---|
| `agendas-from-meeting-data.md` | Agenda tables use `repeat.source` and `data` cells; check D on 2.14 and 2.15. |
| `ops-79-editable-templates.md` | Superseded: every template is editable, so the editable flag goes. DOC-019 and DOC-020 stay (notice and slots). |
| `wp037-church-documents.md` | Owner gate stays: review renders for every template, approved one by one (check R). |
| `ops-template-owner-approval.md` | Every template PR is still owner-approved; JSON template files sit under `packages/domain/src/documents/`, which that merge class already covers. |
| `doc-look-proto.md`, `wp036-api-engine.md` | The approved look becomes the generic renderer's theme; Forme stays the PDF engine. |
| `ops-brand-kit-plan.md`, `wp104-api-brand-kit.md` | `brand` blocks and tone roles read the church brand kit; fixed logo slots keep. |
