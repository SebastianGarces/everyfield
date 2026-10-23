import test from "node:test";
import assert from "node:assert/strict";
import { loadStarter } from "../../../packages/reference/src/starter.ts";
import { hash, vectorHash } from "../../../packages/reference/src/hash.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { localEmbedding, resolveWikiEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
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

test("INV-wiki-embedding: an OpenAI key stays unused until EVF_WIKI_EMBEDDINGS=openai", async () => {
	const key = "sk-test-wiki-opt-in";
	const local = resolveWikiEmbedding({ OPENAI_API_KEY: key });
	assert.equal(local.kind, "local");
	assert.equal(local.profile, approvedWiki.embeddingProfile);
	assert.equal(local.dimensions, approvedWiki.embeddingDimensions);
	assert.deepEqual(local.embed("wiki"), localEmbedding("wiki"));
	const injected = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{ embed: localEmbedding },
	);
	assert.equal(injected.kind, "injected");
	assert.equal(injected.profile, approvedWiki.embeddingProfile);

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
			await missing.embed("wiki");
		},
		(error: unknown) => error instanceof Error && error.message === "openai_key_missing",
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
					}),
					{ status: 200 },
				);
			},
		},
	);
	assert.equal(selected.kind, "openai");
	assert.equal(selected.profile, "openai-text-embedding-3-small");
	assert.equal(selected.dimensions, 1536);
	const vectors = await selected.embedMany?.(["one", "two"]);
	assert.equal(seen?.url, "https://api.openai.com/v1/embeddings");
	assert.equal(seen?.authorization, `Bearer ${key}`);
	assert.equal(seen?.body.model, "text-embedding-3-small");
	assert.deepEqual(seen?.body.input, ["one", "two"]);
	assert.equal(vectors?.[0]?.[0], Math.fround(1 / 7));
	assert.equal(vectors?.[1]?.[0], Math.fround(2 / 9));
	assert.equal(vectors?.[0]?.length, 1536);

	const refused = resolveWikiEmbedding(
		{ EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: key },
		{ fetch: async () => new Response(`denied ${key}`, { status: 401 }) },
	);
	await assert.rejects(
		async () => {
			await refused.embed("wiki");
		},
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message.includes(key), false);
			assert.match(error.message, /^openai_http_401:/);
			return true;
		},
	);
});
