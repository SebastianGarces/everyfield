import test from "node:test";
import assert from "node:assert/strict";
import { loadStarter } from "../../../packages/reference/src/starter.ts";
import { hash, vectorHash } from "../../../packages/reference/src/hash.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { localEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import {
	checkSnapshot,
	loadApprovedSnapshot,
	WikiRefusal,
} from "../../../packages/reference/src/starter/verify/snapshot.ts";

test("INV-wiki-snapshot: approved bootstrap bytes match the recorded checksums and stay separate from document templates", async () => {
	const snapshot = await loadApprovedSnapshot();
	assert.equal(snapshot.articles.length, approvedWiki.articles);
	assert.equal(snapshot.sections.length, approvedWiki.sections);
	assert.equal(snapshot.templates.length, approvedWiki.systemTemplates);
	assert.equal(snapshot.discoveryIds.length, approvedWiki.discoveryArticles);
	assert.equal(new Set(snapshot.discoveryIds).size, approvedWiki.discoveryArticles);
	const starter = await loadStarter();
	assert.equal(starter.catalogs.documents.length, approvedWiki.documentTemplatesSeparate);
	const vector = localEmbedding("wiki");
	assert.equal(vector.length, approvedWiki.embeddingDimensions);
	assert.equal(vectorHash(vector), vectorHash(vector.map((value) => Math.fround(value))));
	const first = snapshot.articles[0];
	assert.ok(first);
	const unsafe = "<script>alert(1)</script>";
	const broken = {
		...snapshot,
		articles: [{ ...first, content: unsafe, contentSha256: hash(unsafe) }, ...snapshot.articles.slice(1)],
	};
	assert.throws(
		() => checkSnapshot(broken),
		(error: unknown) => error instanceof WikiRefusal && error.code === "incomplete_candidate",
	);
});
