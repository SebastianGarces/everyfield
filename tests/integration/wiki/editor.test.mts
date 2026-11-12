// T-156: the organization editor keeps tables, callouts, diagrams and code as read-only blocks, and a one-character
// edit saves on every seed article. No database: the model is the pure code the editor runs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
	humanCredit,
	ORGANIZATION_BODY_LIMIT,
	organizationArticleCommand,
	organizationBodyFits,
	visibleBodyLength,
} from "../../../packages/contracts/src/wiki/index.ts";
import {
	articleBlocks,
	editorBlocksFromBody,
	editorWriteBody,
	type EditorBlock,
} from "../../../apps/web/src/features/wiki/model.ts";

const markdownBlocks = (body: string) => articleBlocks("safe_mdx", body);

const seed = JSON.parse(await readFile(new URL("../../../docs/reference/wiki/seed.json", import.meta.url), "utf8")) as {
	articles: { slug: string; content: string | null }[];
};
const articles = seed.articles.filter((article) => article.content);

const fixedKinds = new Set(["table", "callout", "code", "diagram"]);
const fixed = (blocks: ReturnType<typeof markdownBlocks>) => blocks.filter((block) => fixedKinds.has(block.kind));

/** The first editable block with text, with one character added. */
function editOne(blocks: EditorBlock[]): EditorBlock[] {
	const index = blocks.findIndex((block) => block.kind !== "fixed" && block.text.trim());
	assert.ok(index >= 0);
	return blocks.map((block, at) =>
		at === index && block.kind !== "fixed" ? { ...block, text: `${block.text}x` } : block,
	);
}

test("T-156: a one-character edit then save passes the contract on every seed article and keeps its tables, callouts and code", () => {
	assert.ok(articles.length > 100);
	let tables = 0;
	for (const article of articles) {
		const content = article.content!;
		const blocks = editorBlocksFromBody("safe_mdx", content);
		const body = editorWriteBody(content, "safe_mdx", editOne(blocks));
		assert.notEqual(body, content, article.slug);
		assert.equal(JSON.parse(body).format, "everyfield-editor-v1", article.slug);
		assert.ok(organizationBodyFits(body), `${article.slug}: ${body.length} stored, ${visibleBodyLength(body)} visible`);
		const command = organizationArticleCommand.safeParse({
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { articleId: randomUUID(), organizationId: randomUUID(), body },
		});
		assert.ok(command.success, `${article.slug}: ${command.error?.message}`);
		// The published copy renders the same tables, callouts, code and diagrams as the seed.
		assert.deepEqual(fixed(articleBlocks("safe_nodes", body)), fixed(markdownBlocks(content)), article.slug);
		tables += markdownBlocks(content).filter((block) => block.kind === "table").length;
	}
	assert.ok(tables > 100);
});

test("T-156: the editor shows tables, callouts, diagrams and code read-only, in place", () => {
	const body = [
		"## Plan",
		"Intro text.",
		"| Week | Goal |",
		"|---|---|",
		"| 1 | **Pray** |",
		'<Callout type="tip">',
		"Keep it short.",
		"Second line.",
		"</Callout>",
		"```diagram hierarchy",
		"title: Leaders",
		"- Pastor | Vision",
		"  - Director",
		"    - Leader | | 4 teams",
		"```",
		"```diagram flow",
		"title: Guest path",
		"loop: Each season",
		"- First visit | Greeted | Week 1",
		"- Lunch",
		"```",
		"```",
		"Cash total:   $____",
		"```",
		"Outro.",
	].join("\n");
	const blocks = editorBlocksFromBody("safe_mdx", body);
	assert.deepEqual(
		blocks.map((block) => (block.kind === "fixed" ? `fixed:${block.block.kind}` : block.kind)),
		[
			"heading",
			"paragraph",
			"fixed:table",
			"fixed:callout",
			"fixed:diagram",
			"fixed:diagram",
			"fixed:code",
			"paragraph",
		],
	);
	const saved = editorWriteBody(body, "safe_mdx", editOne(blocks));
	const types = (JSON.parse(saved) as { blocks: { type: string }[] }).blocks.map((block) => block.type);
	assert.deepEqual(types, ["heading", "paragraph", "table", "callout", "diagram", "diagram", "code", "paragraph"]);
	const published = articleBlocks("safe_nodes", saved);
	assert.deepEqual(fixed(published), fixed(markdownBlocks(body)));
	assert.deepEqual(published.slice(0, 2), [
		{ kind: "heading", level: 2, text: "Planx", id: "planx" },
		{ kind: "paragraph", text: "Intro text." },
	]);
	// The saved document opens in the editor as the same blocks.
	assert.deepEqual(editorBlocksFromBody("safe_nodes", saved), editOne(blocks));
	// Visible text, not JSON, counts toward the cap.
	assert.ok(visibleBodyLength(saved) < saved.length / 2);
});

test("T-156: an unchanged save keeps the loaded body byte for byte", () => {
	for (const article of articles.slice(0, 20)) {
		const content = article.content!;
		assert.equal(editorWriteBody(content, "safe_mdx", editorBlocksFromBody("safe_mdx", content)), content);
	}
	const draft = editorWriteBody("Old.", "safe_mdx", [{ kind: "paragraph", text: "New." }]);
	assert.equal(editorWriteBody(draft, "safe_nodes", editorBlocksFromBody("safe_nodes", draft)), draft);
});

test("T-156: the visible-text cap and the stored bound refuse a body past either", () => {
	const doc = (text: string) =>
		JSON.stringify({
			format: "everyfield-editor-v1",
			blocks: [{ type: "paragraph", children: [{ type: "text", text, marks: [] }] }],
		});
	assert.equal(organizationBodyFits(doc("a".repeat(ORGANIZATION_BODY_LIMIT.visible))), true);
	assert.equal(organizationBodyFits(doc("a".repeat(ORGANIZATION_BODY_LIMIT.visible + 1))), false);
	assert.equal(organizationBodyFits("a".repeat(ORGANIZATION_BODY_LIMIT.visible + 1)), false);
	assert.equal(visibleBodyLength('{"not":"editor"}'), 16);
});

test("T-156: humanCredit keeps a person or church name and drops paths, ids and digests", () => {
	assert.equal(humanCredit("Ana Torres"), "Ana Torres");
	assert.equal(humanCredit("Grace Church"), "Grace Church");
	for (const credit of [
		"wiki/lead@abc1234def",
		"docs/reference/wiki/seed.json",
		"lead.mdx",
		"church:5f0c2a8e-8d2b-4b55-9a59-3b4c1b0f8b11",
		"5f0c2a8e-8d2b-4b55-9a59-3b4c1b0f8b11",
		"a".repeat(40).replace(/a/g, "f"),
		"",
		null,
	])
		assert.equal(humanCredit(credit), null, String(credit));
});
