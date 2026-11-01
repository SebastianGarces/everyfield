// WP-034/ui criteria 4 and 9: the app reads fenced blocks as code or diagrams, and fence lines never become markdown.
// No database: markdownBlocks is the pure reader the article page renders.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { markdownBlocks } from "../../../apps/web/src/features/wiki/model.ts";

const lines = (...text: string[]) => text.join("\n");

/** The app's global corpus: the bootstrap payload the reference bundle installs. */
async function appBody(slug: string): Promise<string> {
	const payload = JSON.parse(
		await readFile(new URL("../../../docs/reference/bootstrap/global-seed-payload.json", import.meta.url), "utf8"),
	) as { articles: { slug: string; content: string }[] };
	const article = payload.articles.find((row) => row.slug === slug);
	assert.ok(article, slug);
	return article.content;
}

/** The exact lines between the first fence pair, as the source holds them. */
function firstFence(body: string): string {
	const all = body.split("\n");
	const open = all.findIndex((line) => line.startsWith("```"));
	const close = all.findIndex((line, index) => index > open && line.startsWith("```"));
	return all.slice(open + 1, close).join("\n");
}

test("WP-034/ui: backtick and tilde fences, with or without an info string, become code with the body byte for byte", () => {
	const body = lines(
		"Intro",
		"```",
		"  two spaces kept",
		"## not a heading",
		"```",
		"~~~text",
		"- not a list",
		"| not | a table |",
		"---",
		'<Callout type="tip">not a callout</Callout>',
		"> not a quote",
		"~~~",
		"After",
	);
	assert.deepEqual(markdownBlocks(body), [
		{ kind: "paragraph", text: "Intro" },
		{ kind: "code", text: "  two spaces kept\n## not a heading" },
		{
			kind: "code",
			text: '- not a list\n| not | a table |\n---\n<Callout type="tip">not a callout</Callout>\n> not a quote',
		},
		{ kind: "paragraph", text: "After" },
	]);
});

test("WP-034/ui: a heading inside a fence adds no contents entry and an unterminated fence runs to the end", () => {
	const blocks = markdownBlocks(lines("## Real", "````md", "## Inside", "```", "still inside"));
	assert.deepEqual(blocks, [
		{ kind: "heading", level: 2, text: "Real", id: "real" },
		{ kind: "code", text: "## Inside\n```\nstill inside" },
	]);
	assert.deepEqual(
		blocks.filter((block) => block.kind === "heading").map((block) => block.kind === "heading" && block.text),
		["Real"],
	);
});

test("WP-034/ui: a diagram fence becomes the parsed diagram", () => {
	assert.deepEqual(
		markdownBlocks(lines("```diagram flow", "title: Welcome", "- Greet | At the door", "- Follow up", "```")),
		[
			{
				kind: "diagram",
				diagram: {
					type: "flow",
					title: "Welcome",
					nodes: [{ label: "Greet", detail: "At the door" }, { label: "Follow up" }],
				},
			},
		],
	);
});

test("WP-034/ui: a malformed diagram fence renders as code that shows its source and no parser message", () => {
	const source = lines("title: Broken", "- One | two | three | four");
	const blocks = markdownBlocks(lines("Before", "```diagram flow", source, "```", "After"));
	assert.deepEqual(blocks, [
		{ kind: "paragraph", text: "Before" },
		{ kind: "code", text: source },
		{ kind: "paragraph", text: "After" },
	]);
	assert.equal(JSON.stringify(blocks).includes("at most three fields"), false);
	assert.deepEqual(markdownBlocks(lines("```diagram chart", "title: T", "- A", "```")), [
		{ kind: "code", text: "title: T\n- A" },
	]);
});

test("WP-034/ui: counting-procedures keeps its rule lines as code text", async () => {
	const body = await appBody("administrative/financial/counting-procedures");
	const fence = firstFence(body);
	assert.match(fence, /^ {2,}-{9}$/m);
	const blocks = markdownBlocks(body);
	const code = blocks.filter((block) => block.kind === "code");
	assert.deepEqual(code, [{ kind: "code", text: fence }]);
});

test("WP-034/ui: partner-organization-coordination keeps its dash lines as code text", async () => {
	const body = await appBody("launch-sunday/partner-organization-coordination");
	const fence = firstFence(body);
	assert.match(fence, /^- /m);
	const blocks = markdownBlocks(body);
	assert.deepEqual(
		blocks.filter((block) => block.kind === "code"),
		[{ kind: "code", text: fence }],
	);
	// No list item holds a line from inside the fence.
	const inside = new Set(fence.split("\n").map((line) => line.replace(/^- /, "").trim()));
	for (const block of blocks)
		if (block.kind === "list") for (const item of block.items) assert.equal(inside.has(item), false, item);
});
