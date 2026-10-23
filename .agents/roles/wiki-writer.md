# Wiki writer additions (Grok Build, through Intent `implementor`)

Grok Build (`xai`, effort `high`) researches and writes the assigned Wiki article. Sol (`codex`,
`gpt-6.1-sol`, `openai`) holds this seat until Grok Build runs in Intent or OpenAI access ends on Oct 24, 2026.
Opus (`claude-code`, `opus`, effort `medium`, Intent `verifier`) reviews it independently.
Use the existing specialists with this role; no custom specialist is needed.

1. Read your brief and `docs/reference/wiki/backlog.json`. Tier C means sources only.
2. Follow `.agents/skills/wiki-article/SKILL.md`. Draft one JSON row at
   `docs/reference/wiki/drafts/<slug>.json`; keep sources, claim check and rulings in its `draft`
   object, and planning/progress in the task note. Never create a separate MDX article file.
3. Keep research bulk outside the repository and summarize it in the note. Never copy PlanterPlan
   text or text from the NAMB reference books in `.intent/attachments/reference-books/`.
4. Use LSB scripture, checked one verse at a time on lsbible.org and tagged `(LSB)`. Never
   bulk-download or scrape scripture. Preserve the full LSB notice in the rendered preview.
5. Run lint, render desktop/mobile screenshots and put them in the article PR with `wiki pr-images`.
   Size warnings guide editing; never split an article to meet a limit.
6. Ask the coordinator to route an independent Opus claim, scripture and screenshot review.
   Rule reversible wording choices and record them. Theology, pastoral care and methodology
   require the content owner's ruling before the draft is ready.
7. Report the draft path, PR URL, lint/claim-check result, open rulings and anything left out.

Never approve your own claims or publish. Sebastian approves tier A and factual corrections;
Bryan or Sebastian approves tier B. The coordinator runs `wiki promote` only after human approval,
using the exact reviewed commit SHA. Do not edit the seed directly or access any database.
Wiki PRs never merge automatically and need no `evf verify`. Report the PR and wait. After Sebastian approves it in chat, merge with `bin/evf approve <PR> --owner-approval "<his words>"`.

## Principles to read in full at the start

- `.agents/skills/principle-prove-it-works/SKILL.md`
- `.agents/skills/principle-guard-the-context-window/SKILL.md`
- `.agents/skills/principle-never-block-on-the-human/SKILL.md`
- `.agents/skills/principle-boundary-discipline/SKILL.md`
