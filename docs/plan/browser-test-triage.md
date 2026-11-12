# Browser test triage (T-214)

This list sorts every file `git ls-files tests/ui` printed on this task's base (58 files) against test-standard's
rule in `.agents/skills/test-standard/SKILL.md`: "Use browser tests only for critical flows: sign-in, one meeting end
to end, Evry review and approve." Those three are the golden-set flows here. This is not the Evry eval golden set in
`tests/evry/evals/golden.approved.json`.

Nothing is deleted or moved by this task. A later deletion task reads this list.

## How to read the table

- **Runs**: `browser` means the file imports `tests/ui/setup.mjs`, which launches Playwright against a preview.
  `node` means it tests a model, a module or a render in node with no browser. The column also names the script that
  runs a node file today: `web` is `apps/web` `test:unit`, `domain` is `packages/domain` `test:unit`. `helper` is a
  setup file, seed or config, not a test.
- **Flow**: the golden-set flow the file covers, or "none". "(rules only)" marks a node test of one of those flows'
  rules. It does not drive the flow, so it cannot be the kept file for it.
- **Decision**:
  - `keep` stays in `tests/ui`.
  - `delete` removes a browser test that covers no golden-set flow.
  - `delete from browser suite` moves a node test out of `tests/ui`. It still protects domain or UI behavior, so it
    keeps running under its current `test:unit` script from a non-browser home (for example `tests/unit/<area>/`;
    the deletion task picks the name).

Only four files drive a browser today. The other 48 test files already run in node, and CI runs them through `test:unit`
(`tools/ci/ci-tests.ts` requires that). Even so, `pnpm test:ui` (`node --test 'tests/ui/**/*.test.mjs'`) and the
nightly browser run (`scripts/nightly.ts`) pick up every `.test.mjs` among them. Moving them out of `tests/ui` leaves
the browser suite holding only the critical flows.

## Table

| File | Runs | Flow | Decision | Reason |
|---|---|---|---|---|
| `tests/ui/communication/body.test.mts` | node (web) | none | delete from browser suite | Editor HTML round trip and merge-field rules; unit test, keep its `web` entry. |
| `tests/ui/communication/capture.test.mts` | node (web) | none | delete from browser suite | Capture outbox rules (AC:CASE-COM-003, COM-012) on a temp directory; unit test. |
| `tests/ui/communication/route.test.mts` | node (web) | none | delete from browser suite | Messages URL parse and write-back; unit test. |
| `tests/ui/documents/editor-schema.test.mts` | node (web) | none | delete from browser suite | Editor schema, licence and conditional-text rules; unit test. |
| `tests/ui/documents/keyboard.test.mjs` | browser | none | delete | Toolbar keyboard and overlay checks (T-122). Not a critical flow, and it holds no domain behavior; test-standard proves other UI behavior broadly. |
| `tests/ui/documents/labels.test.mts` | node (web) | none | delete from browser suite | Block and paper label maps; unit test. |
| `tests/ui/documents/merge-too-long.test.mts` | node (web) | none | delete from browser suite | Merge-size refusal text reads the domain refusal path; unit test. |
| `tests/ui/documents/render-key.test.mts` | node (web) | none | delete from browser suite | Preview render-key and request dedupe; unit test. |
| `tests/ui/documents/save-chain.test.mjs` | node (web) | none | delete from browser suite | `SaveChain` ordering (INV-save-order), already moved out of the browser by T-259; unit test. |
| `tests/ui/documents/toolbar-disabled.test.mts` | node (domain) | none | delete from browser suite | Render test of the `data-disabled` attribute; keep its `domain` entry and the render tsconfig. |
| `tests/ui/evry/markdown.test.mjs` | node (web) | none | delete from browser suite | Safe markdown and streaming text rules; unit test. |
| `tests/ui/evry/model.test.mjs` | node (web) | none | delete from browser suite | Evry panel merge, retry and turn rules; unit test. |
| `tests/ui/evry/result-card-photos.test.mts` | node (domain) | none | delete from browser suite | `ResultCard` photo render (T-274); keep its `domain` entry and the render tsconfig. |
| `tests/ui/evry/result-card.test.mjs` | node (web) | none | delete from browser suite | Result card wording per tool; unit test. |
| `tests/ui/evry/review-model.test.mjs` | node (web) | Evry review and approve (rules only) | delete from browser suite | Review card phase and revise rules, without a browser; unit test next to the kept `evry/review.test.mjs`. |
| `tests/ui/evry/review.test.mjs` | browser | Evry review and approve | keep | The one browser file for this flow: a revised change approved and saved once, lost and unknown replies, Check again. |
| `tests/ui/evry/stream-cursor.test.mts` | node (web) | none | delete from browser suite | Stream route cursor parsing with stubbed imports; unit test. |
| `tests/ui/followups/model.test.mjs` | node (web) | none | delete from browser suite | Follow-up save and countdown rules (MTG-021, MTG-022, TSK-004); unit test. |
| `tests/ui/followups/stored-time.test.mjs` | node (web) | none | delete from browser suite | Stored-instant round trip (T-159); unit test. |
| `tests/ui/foundations/evry-geo.test.mjs` | node (web) | none | delete from browser suite | Evry geometry invariants; unit test. |
| `tests/ui/identity/invitation-seed.mts` | helper | sign-in | keep | Seeds the landing accounts that the kept `identity/landing.test.mjs` signs in as. |
| `tests/ui/identity/landing.test.mjs` | browser | sign-in | keep | The one browser file for this flow: the real sign-in form, the landing rule (IDN-001) and safe `returnTo` (IDN-028). |
| `tests/ui/intelligence/model.test.mjs` | node (web) | none | delete from browser suite | Check-in screen rules; unit test. |
| `tests/ui/intelligence/signals-model.test.mjs` | node (web) | none | delete from browser suite | Attestation rules, checked against `docs/reference/manual-signals.ts`; unit test. |
| `tests/ui/marketing/evry-follow.test.mjs` | node (web) | none | delete from browser suite | Follow-bot gaze loop on a fake page; unit test. |
| `tests/ui/meetings/attendance.test.mjs` | browser | meeting end to end | keep | The one browser file for this flow: door check-in, finalize and evaluation of a meeting (MTG-010, MTG-012, MTG-014). It starts from a seeded meeting; see the gap below. |
| `tests/ui/meetings/model.test.mjs` | node (web) | meeting end to end (rules only) | delete from browser suite | Evaluation issue mapping and roster projection; unit test. |
| `tests/ui/meetings/next-card.test.mjs` | node (web) | none | delete from browser suite | Next card day counting and Status menu (T-159); unit test. |
| `tests/ui/meetings/seed.mts` | helper | meeting end to end | keep | Seeds the meetings that the kept `meetings/attendance.test.mjs` reads. |
| `tests/ui/meetings/status-view.test.mjs` | node (web) | none | delete from browser suite | Past-meeting "Not closed" status (T-46); unit test. |
| `tests/ui/notifications/links.test.mts` | node (domain) | none | delete from browser suite | Feed entry link render (CASE-NTF-003); keep its `domain` entry and the render tsconfig. |
| `tests/ui/onboarding/connection.test.mjs` | node (web) | none | delete from browser suite | Onboarding port lost-reply rules on the preview fixtures; unit test. |
| `tests/ui/onboarding/model.test.mjs` | node (web) | none | delete from browser suite | Onboarding model over random interleavings; unit test. |
| `tests/ui/organizations/invitation-proof.test.mts` | node (web) | none | delete from browser suite | Invitation proof route with stubbed imports (T-207); unit test. |
| `tests/ui/people/activity-model.test.mjs` | node (web) | none | delete from browser suite | Activity wording for dismissals (T-269); unit test. |
| `tests/ui/people/corrections-model.test.mjs` | node (web) | none | delete from browser suite | Blocked-merge copy (PPL-016); unit test. |
| `tests/ui/people/duplicate-pairs.test.mjs` | node (web) | none | delete from browser suite | Duplicate dismiss and restore states (T-263); unit test. |
| `tests/ui/people/fields.test.mjs` | node (web) | none | delete from browser suite | Household Activity naming (PPL-009) and photo refusal; unit test. |
| `tests/ui/people/import-done.test.mts` | node (domain) | none | delete from browser suite | CSV import progress and Done screen render; keep its `domain` entry and the render tsconfig. |
| `tests/ui/people/model.test.mjs` | node (web) | none | delete from browser suite | People save, draft, request-key and URL rules; unit test. |
| `tests/ui/people/records.test.mjs` | node (web) | none | delete from browser suite | 4 C's, interview and commitment rules (PPL-012 to PPL-026); unit test. |
| `tests/ui/people/review-dismiss.test.mjs` | node (web) | none | delete from browser suite | Side-by-side dismiss states (T-268); unit test. |
| `tests/ui/people/seed.mts` | helper | Evry review and approve, meeting end to end | keep | Seeds the church, owner and people that the kept `evry/review.test.mjs` and `meetings/attendance.test.mjs` use, and that `meetings/seed.mts` builds on. |
| `tests/ui/phases/model.test.mjs` | node (web) | none | delete from browser suite | Journey phase rules; unit test. |
| `tests/ui/render.tsconfig.json` | helper | none | delete from browser suite | No kept file uses it. It is the `--tsconfig` of `packages/domain` `test:unit` for the five render tests, so it moves with them. |
| `tests/ui/save/model.test.mjs` | node (web) | none | delete from browser suite | Shared save-lane rules (C58 to C69); unit test. |
| `tests/ui/save/record-dialog-focus-lint.test.mjs` | node (web) | none | delete from browser suite | Web ESLint rule on fixtures (BUG-249); unit or lint test. |
| `tests/ui/seed-env.mts` | helper | all three | keep | The shared seed environment that all three kept seeds open. |
| `tests/ui/settings/brand-assets.test.mts` | node (web) | none | delete from browser suite | Brand asset upload steps on the fixture port (CASE-BRD-002); unit test. The server half is in `tests/integration/branding`. |
| `tests/ui/settings/brand-model.test.mts` | node (web) | none | delete from browser suite | Brand kit and Settings access rules; unit test. |
| `tests/ui/settings/drafts-model.test.mjs` | node (web) | none | delete from browser suite | Settings draft model over random interleavings; unit test. |
| `tests/ui/settings/notifications-model.test.mjs` | node (web) | none | delete from browser suite | Notification rows per producer; unit test. |
| `tests/ui/setup.mjs` | helper | all three | keep | The Playwright setup that all three kept browser files and `seed-env.mts` import. |
| `tests/ui/shell/boundaries.test.mts` | node (domain) | none | delete from browser suite | Not-found and error boundary render; keep its `domain` entry and the render tsconfig. |
| `tests/ui/shell/web-config.test.mts` | node (web) | none | delete from browser suite | Next config headers and dev log (T-163); unit test. |
| `tests/ui/tasks/description.test.mjs` | node (web) | none | delete from browser suite | Task description render (TSK-016); unit test. |
| `tests/ui/tasks/model.test.mjs` | node (web) | none | delete from browser suite | Tasks URL, deadline and count rules; unit test. |
| `tests/ui/teams/model.test.mjs` | node (web) | none | delete from browser suite | Ministry edit and history rules; unit test. |

Totals: 8 keep (3 browser tests, 5 helpers), 1 delete, 49 delete from browser suite (48 node tests and
`render.tsconfig.json`). Each flow has one kept test file.

## Gaps

- **Meeting end to end is only partly covered.** `meetings/attendance.test.mjs` starts from a meeting that
  `meetings/seed.mts` writes as already started. It drives check-in, finalize and evaluation, but no browser test
  creates and plans a meeting through to that point. No other browser file covers meetings, so the list keeps this
  file and names the gap instead of keeping an unrelated one. A later task can extend it to start from creating the
  meeting.

## What the deletion task does

**Delete** (1 file, a browser test that covers no golden-set flow):

- `tests/ui/documents/keyboard.test.mjs`

**Delete from the browser suite** (49 files). Each moves to a non-browser home with no change to its behavior, and its
`test:unit` entry keeps running it.

- Run by `apps/web` `test:unit` (43): `communication/body.test.mts`, `communication/capture.test.mts`,
  `communication/route.test.mts`, `documents/editor-schema.test.mts`, `documents/labels.test.mts`,
  `documents/merge-too-long.test.mts`, `documents/render-key.test.mts`, `documents/save-chain.test.mjs`,
  `evry/markdown.test.mjs`, `evry/model.test.mjs`, `evry/result-card.test.mjs`, `evry/review-model.test.mjs`,
  `evry/stream-cursor.test.mts`, `followups/model.test.mjs`, `followups/stored-time.test.mjs`,
  `foundations/evry-geo.test.mjs`, `intelligence/model.test.mjs`, `intelligence/signals-model.test.mjs`,
  `marketing/evry-follow.test.mjs`, `meetings/model.test.mjs`, `meetings/next-card.test.mjs`,
  `meetings/status-view.test.mjs`, `onboarding/connection.test.mjs`, `onboarding/model.test.mjs`,
  `organizations/invitation-proof.test.mts`, `people/activity-model.test.mjs`, `people/corrections-model.test.mjs`,
  `people/duplicate-pairs.test.mjs`, `people/fields.test.mjs`, `people/model.test.mjs`, `people/records.test.mjs`,
  `people/review-dismiss.test.mjs`, `phases/model.test.mjs`, `save/model.test.mjs`,
  `save/record-dialog-focus-lint.test.mjs`, `settings/brand-assets.test.mts`, `settings/brand-model.test.mts`,
  `settings/drafts-model.test.mjs`, `settings/notifications-model.test.mjs`, `shell/web-config.test.mts`,
  `tasks/description.test.mjs`, `tasks/model.test.mjs`, `teams/model.test.mjs` (all under `tests/ui/`).
- Run by `packages/domain` `test:unit` (5), together with `tests/ui/render.tsconfig.json`, their `--tsconfig`:
  `documents/toolbar-disabled.test.mts`, `evry/result-card-photos.test.mts`, `notifications/links.test.mts`,
  `people/import-done.test.mts`, `shell/boundaries.test.mts` (all under `tests/ui/`).

**First, in the same change:**

- Update the moved paths in `apps/web/package.json` and `packages/domain/package.json` `test:unit`, including the
  `--tsconfig` path. Update the relative imports inside each moved file, since they climb `../../../` from `tests/ui/<area>`.
- Update `tools/ci/ci-tests.ts`, which globs `tests/ui/**/*.test.{mjs,mts}` to require that each node test is listed
  in a `test:unit`, so that it guards the new home. Check `tools/ci/select.ts`'s `tests/ui/**` path group as well.
- Update the source comments that name a moved test's path: `apps/web/src/features/documents/save-chain.ts`,
  `onboarding/model.ts`, `settings/drafts.ts`, `tasks/description.ts` and `tasks/model.ts`.
- Narrow `test:ui` in `package.json` and the nightly glob in `scripts/nightly.ts` to the kept browser files, or keep
  the glob once only they remain under `tests/ui`.
- No domain behavior has to move to an integration test before `documents/keyboard.test.mjs` goes. It checks only
  toolbar keyboard and overlay UI.
