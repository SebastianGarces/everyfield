---
name: wiki-article
description: Research, draft, fact-check or revise an EveryField Wiki article using primary sources, JSON drafts, rendered screenshots and independent Opus review before human approval.
---

# Writing a Wiki article

Sol writes. Opus reviews. Readers act on these articles, so every factual claim needs evidence
before human approval. Drafts are JSON rows with MDX in `content`, never separate MDX files.
Read [the draft shape](../../../docs/reference/wiki/README.md) and the assigned item in
`docs/reference/wiki/backlog.json`.

## Scope and approval

- Tier A: research and draft. Sebastian approves.
- Tier B: first put a stance memo in the task note with options, practical tradeoffs and fit with
  the Playbook. Draft after Bryan or Sebastian records a ruling. Bryan or Sebastian approves.
- Tier C: collect sources and a neutral summary for the human author. Do not draft or promote.
- Tier F: fact-check the named existing article and propose exact corrections, retaining its id.
  Sebastian approves the correction; route methodology or theology choices to the content owner.

Never copy or closely paraphrase PlanterPlan, Passion for Planting or another product's text.
PlanterPlan identifies missing topics; it is not a source. Never copy text from the NAMB reference
books in `.intent/attachments/reference-books/`. Write original text and cite the source in the
research metadata. Keep source quotations short and within the publisher's permission limits.

Do not decide theology, pastoral care or methodology. Record the question in `draft.rulings` and
the task note; resolve it before review. Do not contradict `docs/reference/playbook.md` or change
methodology to reconcile an article. Apply Bryan's rubric rulings, including the 50 to 100 adult
benchmark rather than a gate (C03) and not calling the core group factor "Unity" (C04), from
`docs/reference/bryan-comments-review.md`. EveryField does not provide finance, coaching or
background checks in the app (`docs/product/scope.md`); articles must not imply that it does.

## Procedure

1. In the task note, restate the backlog id, tier, topic, section, phase, content type and items
   closed. Read the nearest published articles in the seed and note what they already cover.
   Choose up to four related published article slugs.
2. For tier B, obtain the stance ruling above. Keep research questions and the outline in the
   task note. Ask from the planter's, treasurer's, network leader's and risk reviewer's viewpoints.
3. Research before writing. Keep `{claim, url, publisher, quote, accessed, kind}` entries in
   `draft.sources`, where kind is `primary`, `secondary` or `vendor`. Prefer agencies, statutes
   and the publisher's own product documentation. Use named secondary sources such as ECFA,
   Barna or Lifeway where no primary source exists. Skip content farms, unattributed listicles
   and AI summaries. Every number, fee, deadline, form name and threshold needs a primary source
   or it comes out. Match each outline section to its source claims.
4. Write `docs/reference/wiki/drafts/<slug>.json`. Copy the seed row shape, set `status` to `draft`
   and `published_at` to null, and add `draft` metadata. New articles get a UUID v4. Edits retain
   the existing id in both `id` and `draft.replaces_id`. Put review details in the JSON and task
   note, rather than adding Markdown collaboration files. Do not edit published seed rows by hand.
5. Look up scripture one verse at a time on [lsbible.org](https://lsbible.org/). Never bulk-download
   or scrape LSB text. Quote exactly, never from memory, with `(LSB)` after every reference:

   ```md
   <Callout type="scripture">
   *"verse text"* — Book 1:2 (LSB)
   </Callout>
   ```

   The preview includes the full LSB copyright notice once at its foot. Keep that notice intact.
6. Run the tools from the task worktree, writing HTML and screenshots outside the repository:

   ```sh
   bin/wiki lint docs/reference/wiki/drafts/<slug>.json
   bin/wiki render docs/reference/wiki/drafts/<slug>.json --out /tmp/wiki-review
   bin/wiki shot docs/reference/wiki/drafts/<slug>.json --out /tmp/wiki-review
   bin/wiki shot docs/reference/wiki/drafts/<slug>.json --out /tmp/wiki-review --mobile
   ```

   Fix errors and explain remaining warnings in the task note. Never split an article to satisfy
   a size limit. Open the article PR under the assigned workflow and post screenshots:

   ```sh
   bin/wiki pr-images <pr> /tmp/wiki-review/<image>.png --update-body
   ```

   This reuses one secret gist per PR and maintains the PR body markers:

   ```html
   <!-- wiki-screenshots-gist: gist-id -->
   <!-- wiki-screenshots -->
   <!-- Markdown images maintained by wiki pr-images -->
   <!-- /wiki-screenshots -->
   ```

7. Hand the draft, sources and screenshots to the coordinator for an independent Opus review.
   Report open rulings, contradictions, volatile facts with their as-of date, lint warnings and
   anything omitted. The writer cannot approve their own claims or publication.

## House style

Aim near 1,100 words, eight H2 sections and four callouts. Open with two short paragraphs about
why this matters to a planter, then `---`. Separate sections with `---`; use H3s as needed.
Address the reader as "you". Prefer short sentences. Use tables for comparisons and `- [ ]`
checklists for procedures. Include common mistakes where real failure modes warrant them.
Related articles belong in `related_article_slugs`, without a duplicate body section.

Only `<Callout type="tip|insight|warning|important|scripture">` is allowed. No imports, exports,
JavaScript expressions, H1s or other components. At least one scripture callout is required.
Volatile facts get an important callout asking the reader to confirm the current figure with
the named agency. Keep external sources in `draft.sources`; body links warn rather than fail.

Lint errors cover only extremes: fewer than 500 or more than 2,500 words, fewer than three or
more than 14 H2s, fewer than one or more than nine callouts, invalid MDX/row shape, placeholders,
unknown internal article links and invalid or missing scripture. Warnings cover words outside
800–1,600, more than 11 H2s, callouts outside 2–7, AI phrases, external links and read time more
than one minute away from rounded words divided by 200. These are editorial prompts.

Use the Wiki's terms: Core Group, Launch Team, Vision Meeting, Launch Sunday, Senior Pastor,
the 4 Pillars, Worship/Walk/Work/Witness. Avoid PlanterPlan terms such as "Opening Day",
"Vision Frame" and "Launch Strategy" unless the brief requires them.

## Review

The coordinator routes review to `verifier`, `claude-code`, `opus`, effort `medium`. Work in a
fresh context. Read every source URL again, rather than trusting the writer's quoted excerpt.
Match every factual sentence against `draft.sources`; mark unsupported or changed claims and
return them for correction. Verify every scripture quote word for word on lsbible.org, one
verse at a time. Check the full desktop and mobile screenshots for missing content, broken
rendering, unreadable tables or checklists, and the LSB notice. Re-run lint.

Record `draft.claim_check` with `status` (`pending`, `passed` or `failed`), reviewer and notes.
Post a verdict as a PR comment, identifying the reviewed commit and source/verse/rendering
findings. A passed Opus review still needs Sebastian's approval for A/F, or Bryan's or
Sebastian's approval for B, in chat or a PR comment. GitHub formal approvals are not required
here because agents use Sebastian's account and an author cannot approve their own PR.

## Promotion after approval

The coordinator runs promotion only after the human approves the reviewed draft. Save the
reviewed PR head SHA before promotion. The file must still match that commit byte for byte:

```sh
bin/wiki promote docs/reference/wiki/drafts/<slug>.json --approved-by Sebastian --pr <n> --reviewed-sha <full-sha>
bin/wiki check-seed
```

Use Bryan for a tier B approval by Bryan. The command requires passing lint and a passed
independent claim check, records approval metadata in `manifest.json` releases, updates the
seed hashes and removes the draft. It edits version-controlled reference files only, never
a database or a live release. Commit the generated changes in the same article PR. Changed
draft bytes require another review and approval. Sebastian merges after the Opus review.
