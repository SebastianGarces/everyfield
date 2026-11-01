# Wiki sources and drafts

[seed.json](seed.json) is the living published Wiki source. It starts as a byte-identical copy
of `../bootstrap/global-seed-payload.json`, with the same article, section and template shape.
The bootstrap folder remains immutable original-import evidence, including its README and
verification record. Approved new versions update this living copy only.

[manifest.json](manifest.json) keeps the imported article/section/template hashes and records
`derivedFrom`, the original bootstrap payload path and SHA-256, plus a `releases` list for new
versions. `bin/wiki check-seed` verifies the living hashes and checks that the original bootstrap
payload still has its original hash. Historical chunk/embedding evidence stays unchanged.

One JSON file holds one draft at `drafts/<slug>.json`, with directories mirroring the slug.
For example, `drafts/administrative/legal/obtaining-an-ein.json`. The unchanged research backlog is
[backlog.json](backlog.json). Follow the [Wiki article skill](../../../.agents/skills/wiki-article/SKILL.md).

Use exactly the published seed row keys: `church_id` (null), `content` (MDX text), `content_type`
(`guide`, `reference`, `overview`, `tutorial` or `how_to`), `created_at`, `excerpt`, `id`, `phase`
(0–6), `published_at` (null), `read_time_minutes`, `related_article_slugs`, `section_id`, `slug`,
`sort_order`, `status` (`draft`), `title`, `updated_at`. Timestamps use ISO format. A new article
gets a version 4 UUID; an edit keeps the published id. Section ids and related slugs come from the seed.

Add exactly one metadata object:

```json
{
  "draft": {
    "backlog_id": "A1",
    "tier": "A",
    "closes": [],
    "approver": "Sebastian",
    "replaces_id": null,
    "sources": [],
    "claim_check": {"status": "pending", "reviewer": "", "notes": ""},
    "rulings": []
  }
}
```

Each source has string `claim`, `url`, `publisher`, `quote`, `accessed` (ISO date) and `kind`
(`primary`, `secondary` or `vendor`). `closes` lists backlog task identifiers. `rulings` records
resolved decisions; keep unresolved decisions in the task note until the owner rules. Edits
set `replaces_id` to the existing article id. Tier A/F requires Sebastian; B allows Bryan or
Sebastian after a stance ruling; C is human-led research only. The independent Opus reviewer
sets claim-check status to `passed` only after checking sources, scripture and screenshots.

Diagrams are fenced `diagram` blocks, never ASCII art; `.agents/skills/wiki-article/SKILL.md`
("Diagrams") gives the syntax. Lint fails ASCII-art diagrams, except the seed articles listed in
`tools/wiki/ascii-allowlist.json`, which warn until OPS-97 migrates them.

Sol drafts, runs `bin/wiki lint`, and creates desktop/mobile previews with `bin/wiki shot`.
Store previews outside the repository. `bin/wiki pr-images <pr> <png>... --update-body` maintains
one secret screenshot gist and a marked image block in the PR. Opus reviews and posts a verdict.
After human approval in chat or a PR comment, the coordinator runs
`bin/wiki promote <draft.json> --approved-by <name> --pr <n> --reviewed-sha <full-sha>`.
It requires passing lint, a passed claim check and draft bytes identical to the reviewed commit;
it updates the seed and manifest release log and deletes the draft. `bin/wiki check-seed`
checks the result. Commit promotion in the article PR; Sebastian merges after Opus review.
The app installs the living seed through the pins in `packages/reference/src/starter/manifest/approved.ts`.
After promotion, run `node packages/reference/src/starter/manifest/pin.mjs --write` and commit the new pins in the same PR.
After merge, `corepack pnpm --filter @everyfield/reference wiki:install` activates the new version on a database.
Without flags it writes only the shared development database; `--schema <ui_schema>` targets a `tests/ui` seed schema.
On production an operator runs it with `--production --operator <account-id>`, using an account that holds `reference_publish`.
A rerun is a no-op once that version is active.
