// WP-034/ui criteria 4 and 9: the app reads fenced blocks as code or diagrams, and fence lines never become markdown.
// No database: articleBlocks is the pure reader the article page renders, over wikiBlocks, the one block parser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { wikiBlocks } from "../../../packages/contracts/src/wiki/index.ts";
import { articleBlocks } from "../../../apps/web/src/features/wiki/model.ts";
import { helveticaPdf, printHtml } from "../../../packages/domain/src/wiki/pdf.ts";

const markdownBlocks = (body: string) => articleBlocks("safe_mdx", body);

const lines = (...text: string[]) => text.join("\n");

/** The app's global corpus: the living Wiki seed the reference bundle installs. */
async function appBody(slug: string): Promise<string> {
	const payload = JSON.parse(
		await readFile(new URL("../../../docs/reference/wiki/seed.json", import.meta.url), "utf8"),
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

test("AC:CASE-WIKI-001 backtick and tilde fences, with or without an info string, become code with the body byte for byte", () => {
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

test("AC:CASE-WIKI-001 AC:CASE-WIKI-002 a heading inside a fence adds no contents entry and an unterminated fence runs to the end", () => {
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

test("AC:CASE-WIKI-001 a diagram fence becomes the parsed diagram", () => {
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
				info: "diagram flow",
				source: "title: Welcome\n- Greet | At the door\n- Follow up",
			},
		],
	);
});

test("AC:CASE-WIKI-001 a malformed diagram fence renders as code that shows its source and no parser message", () => {
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

test("AC:CASE-WIKI-001 counting-procedures keeps its rule lines as code text", async () => {
	const body = await appBody("administrative/financial/counting-procedures");
	const fence = firstFence(body);
	assert.match(fence, /^ {2,}-{9}$/m);
	const blocks = markdownBlocks(body);
	const code = blocks.filter((block) => block.kind === "code");
	assert.deepEqual(code, [{ kind: "code", text: fence }]);
});

test("AC:CASE-WIKI-001 partner-organization-coordination keeps its dash lines as code text", async () => {
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

/** Every Tj string of the PDF, in page order. The fixture is ASCII, so latin1 reads it as written. */
const pdfLines = (pdf: Uint8Array) =>
	[
		...Buffer.from(pdf)
			.toString("latin1")
			.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g),
	].map((m) => m[1]!.replace(/\\([()\\])/g, "$1"));

test("INV-wiki-blocks: one body reads as the same blocks in the reader, the PDF text and the print HTML", () => {
	const body = lines(
		"## Welcome",
		"Greet every guest.",
		"",
		"> Love your neighbor.",
		"> Every week.",
		"",
		"1. Pray",
		"2. Invite",
		"",
		"| Week | Goal |",
		"|---|---|",
		"| 1 | Pray |",
		"",
		'<Callout type="tip">',
		"Smile first.",
		"</Callout>",
	);
	assert.deepEqual(articleBlocks("safe_mdx", body), [
		{ kind: "heading", level: 2, text: "Welcome", id: "welcome" },
		{ kind: "paragraph", text: "Greet every guest." },
		{ kind: "quote", text: "Love your neighbor. Every week." },
		{ kind: "list", ordered: true, items: ["Pray", "Invite"] },
		{
			kind: "table",
			rows: [
				["Week", "Goal"],
				["1", "Pray"],
			],
		},
		{ kind: "callout", label: "Tip", text: "Smile first." },
	]);
	const blocks = wikiBlocks("safe_mdx", body);
	assert.deepEqual(pdfLines(helveticaPdf("Plan", blocks)).slice(2, -1), [
		"Welcome",
		"Greet every guest.",
		"    Love your neighbor. Every week.",
		"1. Pray",
		"2. Invite",
		"Week | Goal",
		"1 | Pray",
		"Smile first.",
	]);
	const html = printHtml("Plan", blocks);
	assert.ok(
		html.includes(
			"<h2>Welcome</h2><p>Greet every guest.</p><blockquote><p>Love your neighbor. Every week.</p></blockquote>" +
				"<ol><li>Pray</li><li>Invite</li></ol><table><tr><td>Week</td><td>Goal</td></tr><tr><td>1</td><td>Pray</td></tr></table>" +
				"<aside><p>Smile first.</p></aside>",
		),
		html,
	);
});
