import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadStarter } from "../../../packages/reference/src/starter.ts";
import { packageStarter, validateBundle } from "../../../packages/reference/src/bundle.ts";
import { hash, vectorHash } from "../../../packages/reference/src/hash.ts";
import { approvedSource, approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { localEmbedding, resolveWikiEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import { wikiBundle, wikiPolicy } from "../../../packages/reference/src/starter/verify/generation.ts";
import { EmbeddingRefusal } from "../../../packages/reference/src/starter/verify/openai.ts";
import {
	checkSnapshot,
	loadApprovedSnapshot,
	WikiRefusal,
} from "../../../packages/reference/src/starter/verify/snapshot.ts";

test("INV-wiki-snapshot: approved living seed bytes match the recorded checksums and stay separate from document templates", async () => {
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
	const bundle = wikiBundle(
		snapshot,
		"R1",
		{
			chunker: approvedWiki.chunker,
			model: approvedWiki.embeddingProfile,
			dimensions: approvedWiki.embeddingDimensions,
		},
		[],
	);
	const report = validateBundle(bundle, wikiPolicy(snapshot.source, bundle, true));
	assert.equal(report.ok, true, report.blockers.join(","));
	assert.equal(bundle.entries.filter((entry) => entry.kind === "article").length, approvedWiki.articles);
	assert.equal(
		bundle.entries.some((entry) => entry.kind === "document_template"),
		false,
	);
	assert.equal(bundle.passages.length, 0);
});

test("WP-033 criterion 9: the pins and every packaged Wiki row follow the living seed, never the bootstrap payload", async () => {
	const snapshot = await loadApprovedSnapshot();
	const living = JSON.parse(
		await readFile(new URL("../../../docs/reference/wiki/seed.json", import.meta.url), "utf8"),
	) as { articles: { slug: string; content: string }[]; sections: unknown[]; templates: unknown[] };
	assert.equal(approvedSource.payloadPath, "docs/reference/wiki/seed.json");
	assert.equal(approvedSource.manifestPath, "docs/reference/wiki/manifest.json");
	assert.deepEqual(
		[approvedSource.articles, approvedSource.sections, approvedSource.systemTemplates],
		[living.articles.length, living.sections.length, living.templates.length],
	);
	assert.deepEqual(
		snapshot.articles.map((article) => [article.slug, article.content]).sort(),
		living.articles.map((article) => [article.slug, article.content]).sort(),
	);
	assert.ok(snapshot.articles.some((article) => article.slug === "administrative/legal/getting-your-churchs-ein"));
	const entries = packageStarter(await loadStarter(), snapshot);
	assert.equal(
		entries.some((entry) => entry.sourcePath.startsWith("docs/reference/bootstrap/")),
		false,
	);
	for (const entry of entries.filter((row) => ["article", "section", "mail_template"].includes(row.kind)))
		assert.deepEqual([entry.sourcePath, entry.sourceHash], [approvedSource.payloadPath, approvedSource.payloadSha256]);
});

test("INV-wiki-embedding: an OpenAI key stays unused until EVF_WIKI_EMBEDDINGS=openai", async () => {
	const key = "sk-test-wiki-opt-in";
	let idle = 0;
	const local = resolveWikiEmbedding(
		{ OPENAI_API_KEY: key },
		{
			fetch: async () => {
				idle += 1;
				return new Response("", { status: 500 });
			},
		},
	);
	assert.equal(local.profile, approvedWiki.embeddingProfile);
	assert.equal(local.dimensions, approvedWiki.embeddingDimensions);
	assert.equal(local.embedMany, undefined);
	assert.deepEqual(local.embed?.("wiki"), localEmbedding("wiki"));
	assert.equal(idle, 0);
	const injected = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{ embed: localEmbedding },
	);
	assert.equal(injected.profile, approvedWiki.embeddingProfile);
	assert.equal(injected.embedMany, undefined);

	let calls = 0;
	const missing = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai" },
		{
			fetch: async () => {
				calls += 1;
				return new Response("", { status: 500 });
			},
		},
	);
	await assert.rejects(
		async () => {
			await missing.embedMany?.(["wiki"]);
		},
		(error: unknown) => error instanceof EmbeddingRefusal && error.message === "openai_key_missing",
	);
	assert.equal(calls, 0);

	let seen: { url: string; authorization: string; body: { model?: string; input?: string[] } } | undefined;
	const selected = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{
			fetch: async (url, init) => {
				const headers = init.headers as Record<string, string>;
				seen = {
					url: String(url),
					authorization: headers.authorization ?? "",
					body: JSON.parse(String(init.body)) as { model?: string; input?: string[] },
				};
				const first = Array.from({ length: 1536 }, (_, index) => (index + 1) / 7);
				const second = Array.from({ length: 1536 }, (_, index) => (index + 2) / 9);
				return new Response(
					JSON.stringify({
						data: [
							{ index: 1, embedding: second },
							{ index: 0, embedding: first },
						],
						usage: { total_tokens: 12 },
					}),
					{ status: 200 },
				);
			},
		},
	);
	assert.equal(selected.embed, undefined);
	assert.equal(selected.profile, "openai-text-embedding-3-small");
	assert.equal(selected.dimensions, 1536);
	const embedded = await selected.embedMany?.(["one", "two"]);
	assert.equal(seen?.url, "https://api.openai.com/v1/embeddings");
	assert.equal(seen?.authorization, `Bearer ${key}`);
	assert.equal(seen?.body.model, "text-embedding-3-small");
	assert.deepEqual(seen?.body.input, ["one", "two"]);
	assert.equal(embedded?.vectors[0]?.[0], Math.fround(1 / 7));
	assert.equal(embedded?.vectors[1]?.[0], Math.fround(2 / 9));
	assert.equal(embedded?.vectors[0]?.length, 1536);
	assert.equal(embedded?.totalTokens, 12);

	const bare = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{
			fetch: async () =>
				new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.25) }] }), {
					status: 200,
				}),
		},
	);
	assert.equal((await bare.embedMany?.(["one"]))?.totalTokens, 0);

	const short = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{
			fetch: async () =>
				new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.5] }], usage: { total_tokens: 4 } }), {
					status: 200,
				}),
		},
	);
	await assert.rejects(
		async () => {
			await short.embedMany?.(["one"]);
		},
		(error: unknown) => {
			assert.ok(error instanceof EmbeddingRefusal);
			assert.equal(error.message, "openai_dimensions");
			assert.equal(error.usageTokens, 4);
			return true;
		},
	);

	const refused = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{ fetch: async () => new Response(`denied ${key}`, { status: 401 }) },
	);
	await assert.rejects(
		async () => {
			await refused.embedMany?.(["wiki"]);
		},
		(error: unknown) => {
			assert.ok(error instanceof EmbeddingRefusal);
			assert.equal(error.message.includes(key), false);
			assert.match(error.message, /^openai_http_401:/);
			assert.equal(error.usageTokens, 0);
			return true;
		},
	);
});
