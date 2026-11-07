// A task description in the task panel and in its list row (WP-026, REQ-TSK-016). They run in node against the
// components the screens draw; no browser.
//   AC:TARGET-TSK-016 INV-same-text: the panel and the row preview show the same readable text from one canonical value,
//     with its line breaks. Pasted HTML and script read as literal text (decisions.md D88): no script, image or frame element, event
//     handler or javascript: link reaches the DOM. A cleared description shows the empty state in the panel and no
//     preview in the row.
//   INV-one-link-rule: the normalizer and the renderer accept the same outside link addresses (safeLinkAddress).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DESCRIPTION_EXCERPT, normalizeDescription } from "../../../packages/contracts/src/tasks/index.ts";
import { DescriptionPreview, DescriptionView } from "../../../apps/web/src/features/tasks/description.ts";
import { safeLinkAddress } from "../../../packages/contracts/src/common/index.ts";
import { safeHref } from "../../../apps/web/src/features/evry/conversation/markdown.ts";

const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const html = (component, value) => renderToStaticMarkup(createElement(component, { value }));
/** The text a person reads: a line break or a block boundary is a new line; tags and entities become text. */
const readable = (markup) =>
	markup
		.replace(/<br\s*\/?>/g, "\n")
		.replace(/<\/(p|li|div)>/g, "\n")
		.replace(/<[^>]+>/g, "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#x27;", "'")
		.replaceAll("&amp;", "&")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join("\n");

// The TARGET-TSK-016 case input with more of what a person pastes: paragraphs, a list, a real link, an image's handler
// and an HTML comment.
const pasted = [
	"Hello",
	"<script>alert('x')</script>",
	"[click](javascript:alert(1))",
	"",
	"Second paragraph,",
	"with its own line break. <!-- note -->",
	"",
	"- bring the **keys**",
	'- see <img src=x onerror="alert(2)"> [the map](https://example.org/map)',
	"",
	"Bye",
].join("\n");
/** Every element tag in the markup, opening or closing; text between tags is not here. */
const tags = (markup) => markup.match(/<[^>]*>/g) ?? [];

test("AC:TARGET-TSK-016 INV-same-text: the panel and the list preview read the same text, HTML as inert literal text", () => {
	const canonical = normalizeDescription(pasted);
	const full = html(DescriptionView, canonical);
	const preview = html(DescriptionPreview, canonical.slice(0, DESCRIPTION_EXCERPT));
	for (const markup of [full, preview]) {
		const elements = tags(markup);
		assert.ok(elements.length > 0);
		for (const tag of elements) {
			assert.doesNotMatch(tag, /^<\/?(script|img|iframe|style|object|embed)\b/i, tag);
			assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, tag);
			assert.doesNotMatch(tag, /href="\s*(javascript|data):/i, tag);
		}
		assert.doesNotMatch(markup, /javascript:|data:/i);
		// The tags a person typed are escaped text, character for character.
		assert.ok(markup.includes("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;"), markup);
		assert.ok(markup.includes("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;"), markup);
		assert.ok(markup.includes("&lt;!-- note --&gt;"), markup);
	}
	const expected = [
		"Hello",
		"<script>alert('x')</script>",
		"click",
		"Second paragraph,",
		"with its own line break. <!-- note -->",
		"bring the keys",
		'see <img src=x onerror="alert(2)"> the map',
		"Bye",
	];
	assert.deepEqual(readable(full).split("\n"), expected);
	// The preview marks list items with a bullet; the words and their lines are the same.
	assert.deepEqual(
		readable(preview)
			.split("\n")
			.map((line) => line.replace(/^• /, "")),
		expected,
	);
	// The one safe link stays a link in the panel, to the address that was written.
	assert.match(full, /<a [^>]*href="https:\/\/example.org\/map"[^>]*>the map<\/a>/);
	assert.match(full, /<strong[^>]*>keys<\/strong>/);
	// The row is a single text node: it keeps line breaks and has no link inside the clickable row.
	assert.match(preview, /^<p [^>]*whitespace-pre-line[^>]*>[^<]*<\/p>$/);
});

test("AC:TARGET-TSK-016 INV-same-text: a cleared description shows the empty state in the panel and no preview", () => {
	const cleared = normalizeDescription("   \n\t ");
	assert.equal(cleared, "");
	assert.match(html(DescriptionView, cleared), /data-description="empty"[^>]*>No description\.<\/p>/);
	assert.equal(html(DescriptionPreview, cleared), "");
	assert.match(html(DescriptionView, null), /No description\./);
});

test("AC:TARGET-TSK-016 storage and render share one outside-link rule", () => {
	const addresses = [
		["https://example.org/a?b=1", "https://example.org/a?b=1"],
		["  http://example.org  ", "http://example.org"],
		["mailto:a@b.co", "mailto:a@b.co"],
		["HTTPS://EXAMPLE.ORG", "HTTPS://EXAMPLE.ORG"],
		["javascript:alert(1)", null],
		["JaVaScRiPt:alert(1)", null],
		["java\nscript:alert(1)", null],
		["data:text/html;base64,PHNjcmlwdD4=", null],
		["https:///no-host", null],
		["https://exa mple.org", null],
		["mailto:", null],
		["ftp://example.org", null],
		["", null],
	];
	for (const [raw, expected] of addresses) {
		assert.equal(safeLinkAddress(raw), expected, raw);
		// The normalizer keeps a link exactly when the shared rule accepts its address.
		const link = `[label](${raw})`;
		const kept = normalizeDescription(link) === link.trim();
		if (!raw.includes("\n")) assert.equal(kept, expected !== null, `normalizer: ${raw}`);
		// The Evry parser, which also draws task descriptions, links the same outside addresses.
		assert.deepEqual(safeHref(raw), expected === null ? null : { href: expected, external: true }, `render: ${raw}`);
	}
	// Only the render side adds app-relative paths; storage reduces them to their label.
	assert.deepEqual(safeHref("/tasks"), { href: "/tasks", external: false });
	assert.equal(normalizeDescription("[tasks](/tasks)"), "tasks");
});

test("AC:TARGET-TSK-016 the normalizer keeps HTML and text shaped like tags exactly as typed (D88)", () => {
	for (const typed of [
		"a<b and c>d",
		"Use `<div>` here",
		"Keep 3 < 4 and a > b",
		"<script>alert('x')</script>",
		"<style>p{}</style> <iframe src=x></iframe>",
		'<img src=x onerror="alert(2)">',
		"<!-- note -->",
		"<!-- unclosed",
	])
		assert.equal(normalizeDescription(typed), typed);
	// What it still does: LF endings, unsafe links to their label, trailing spaces, blank-line runs, the outer trim.
	assert.equal(
		normalizeDescription("  Hello  \r\n<b>x</b>\r\n\r\n\r\n\r\n[click](javascript:alert(1)) [ok](https://a.org)\t\n\n "),
		"Hello\n<b>x</b>\n\nclick [ok](https://a.org)",
	);
});
