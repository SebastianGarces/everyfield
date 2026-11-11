// T-156: the PDF and print export read the shared block reader and print what a reader sees: WinAnsi text, no inline
// markdown markers, prose wrapped at spaces and a human credit in the footer. No database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { wikiBlocks as bodyBlocks } from "../../../packages/contracts/src/wiki/index.ts";
import { helveticaPdf, helveticaWidth, printHtml } from "../../../packages/domain/src/wiki/pdf.ts";

/** cp1252 bytes 0x80 to 0x9f, as the PDF viewer maps them under /WinAnsiEncoding. */
const CP1252_HIGH = "€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ";
const cp1252 = (bytes: Buffer) =>
	[...bytes]
		.map((byte) => (byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : String.fromCharCode(byte)))
		.join("");

/** Every Tj string in page order, read as cp1252 with the PDF string escapes undone. */
function shownLines(pdf: Uint8Array): string[] {
	const text = Buffer.from(pdf).toString("latin1");
	return [...text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((match) =>
		cp1252(Buffer.from(match[1]!.replace(/\\([()\\])/g, "$1"), "latin1")),
	);
}

const nodes = (blocks: unknown[]) => JSON.stringify({ format: "everyfield-editor-v1", blocks });
const run = (text: string) => [{ type: "text", text, marks: [] }];
const meta = { filename: "article.pdf", credit: "Ana Torres" };

test("T-156: an organization node body prints its headings, paragraphs and list items, never its JSON", () => {
	const body = nodes([
		{ type: "heading", level: 2, children: run("Welcome plan") },
		{ type: "paragraph", children: run("Greet every guest by name.") },
		{ type: "list", ordered: false, items: [run("Coffee"), run("Name tags")] },
		{
			type: "table",
			rows: [
				[run("Week"), run("Goal")],
				[run("1"), run("Pray")],
			],
		},
		{ type: "callout", label: "Tip", children: run("Smile first.") },
		{ type: "code", language: "text", text: "Total:   $__" },
	]);
	const blocks = bodyBlocks("safe_nodes", body);
	const pdf = Buffer.from(helveticaPdf("Welcome", blocks, meta)).toString("latin1");
	for (const raw of ['{"format"', '"type":', '"children"', "everyfield-editor-v1"])
		assert.equal(pdf.includes(raw), false, raw);
	assert.deepEqual(shownLines(helveticaPdf("Welcome", blocks, meta)).slice(0, 10), [
		"article.pdf",
		"Welcome",
		"Welcome plan",
		"Greet every guest by name.",
		"• Coffee",
		"• Name tags",
		"Week | Goal",
		"1 | Pray",
		"Smile first.",
		"Total:   $__",
	]);
	const html = printHtml("Welcome", blocks, meta);
	assert.ok(
		html.includes("<h2>Welcome plan</h2><p>Greet every guest by name.</p><ul><li>Coffee</li><li>Name tags</li></ul>"),
	);
	assert.ok(html.includes("<table><tr><td>Week</td><td>Goal</td></tr><tr><td>1</td><td>Pray</td></tr></table>"));
	assert.ok(html.includes("<aside><p>Smile first.</p></aside><pre><code>Total:   $__</code></pre>"));
	for (const raw of ["{&quot;", '"type"', "children"]) assert.equal(html.includes(raw), false, raw);
});

test("T-156: accented letters and typographic marks print as WinAnsi, and a letter outside it prints a fallback", () => {
	const words = "José, Señor and café – it’s “ready” … €5";
	const pdf = helveticaPdf("Año", bodyBlocks("safe_mdx", `${words}\nŐrült 漢 ok`), meta);
	const text = Buffer.from(pdf).toString("latin1");
	assert.equal((text.match(/\/Encoding \/WinAnsiEncoding/g) ?? []).length, 2);
	const lines = shownLines(pdf);
	assert.equal(lines[1], "Año");
	assert.equal(lines[2], words);
	assert.equal(lines[3], "Orült ? ok");
	// Each content stream's /Length counts its bytes, so the file stays readable.
	for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
		const start = match.index! + match[0].length;
		assert.equal(text.slice(start + Number(match[1]), start + Number(match[1]) + 10), "\nendstream");
	}
});

test("T-156: inline markdown markers never print; code keeps its text verbatim", () => {
	const body = [
		"Read **bold**, _italic_, *also*, `code` and [the guide](/wiki/guide) <Badge>tag</Badge> now.",
		"- A **listed** item",
		"",
		"Sign here: ____ date: ____",
		"",
		"Use __init__ now",
		"",
		"| **Week** | [Plan](https://example.com) |",
		"```",
		"keep **these** _marks_ [x](y)",
		"```",
	].join("\n");
	const blocks = bodyBlocks("safe_mdx", body);
	const lines = shownLines(helveticaPdf("Markers", blocks, meta));
	assert.deepEqual(lines.slice(2, 8), [
		"Read bold, italic, also, code and the guide tag now.",
		"• A listed item",
		// Underscore runs are fill-in blanks or names, not emphasis.
		"Sign here: ____ date: ____",
		"Use __init__ now",
		"Week | Plan",
		"keep **these** _marks_ [x](y)",
	]);
	const html = printHtml("Markers", blocks, meta);
	assert.ok(html.includes("<p>Read bold, italic, also, code and the guide tag now.</p>"));
	assert.ok(html.includes("<p>Sign here: ____ date: ____</p><p>Use __init__ now</p>"), html);
	assert.ok(html.includes("<pre><code>keep **these** _marks_ [x](y)</code></pre>"));
});

test("T-156: prose wraps at spaces within the text width; only a word longer than a line breaks inside", () => {
	const words = Array.from(
		{ length: 160 },
		(_, index) => ["community", "Welcome", "the", "WWW", "illuminating"][index % 5],
	);
	const long = "x".repeat(200);
	const lines = shownLines(helveticaPdf("Wrap", bodyBlocks("safe_mdx", `${words.join(" ")}\n${long}`), meta));
	const prose = lines.slice(2, lines.indexOf(lines.find((line) => line.startsWith("x"))!));
	assert.ok(prose.length > 3);
	assert.deepEqual(prose.join(" ").split(" "), words);
	const width = (468 * 1000) / 11;
	for (const [index, line] of prose.entries()) {
		assert.ok(helveticaWidth(line) <= width, line);
		const next = prose[index + 1]?.split(" ")[0];
		if (next) assert.ok(helveticaWidth(`${line} ${next}`) > width, `${line} could hold ${next}`);
	}
	const pieces = lines.filter((line) => line.startsWith("x"));
	assert.ok(pieces.length > 1);
	assert.equal(pieces.join(""), long);
	for (const piece of pieces) assert.ok(helveticaWidth(piece) <= width);
});
