// T-28: the Guide registry resolves against the pinned living seed, the release planters read. A seed promotion that
// drops a mapped article or renames a mapped heading fails here before it reaches a planter as "No guide for this page".
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hash } from "../../../packages/reference/src/hash.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { GUIDE_ROUTES } from "../../../packages/domain/src/wiki/guides.ts";
import { sectionExcerpt } from "../../../packages/domain/src/wiki/excerpt.ts";

const bytes = await readFile(new URL(`../../../${approvedWiki.payloadPath}`, import.meta.url));
const seed = JSON.parse(bytes.toString("utf8")) as { articles: { slug: string; status: string; content: string }[] };
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*$/;

test("T-28 every Guide entry names a published article and one exact heading in the pinned living seed", () => {
	assert.equal(hash(bytes), approvedWiki.payloadSha256, "the test reads the pinned seed bytes");
	assert.equal(GUIDE_ROUTES.length, 13);
	for (const entry of GUIDE_ROUTES) {
		const matches = seed.articles.filter((article) => article.slug === entry.slug);
		assert.equal(matches.length, 1, `${entry.route}: article ${entry.slug}`);
		const article = matches[0]!;
		assert.equal(article.status, "published", entry.route);
		const found = article.content.split("\n").filter((line) => HEADING.exec(line)?.[1] === entry.heading);
		assert.equal(found.length, 1, `${entry.route}: heading "${entry.heading}" in ${entry.slug}`);
		// The excerpt opens at that heading, not at the article's start (the fallback for a missing heading).
		assert.equal(
			sectionExcerpt("safe_mdx", article.content, entry.heading).split("\n")[0],
			found[0]!.trim(),
			entry.route,
		);
	}
});
