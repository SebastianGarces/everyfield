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
		}
		assert.doesNotMatch(markup, /javascript:|data:/i);
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
	assert.deepEqual(
		readable(preview)
			.split("\n")
			.map((line) => line.replace(/^• /, "")),
		expected,
	);
	assert.match(full, /<a [^>]*href="https:\/\/example.org\/map"[^>]*>the map<\/a>/);
	assert.match(full, /<strong[^>]*>keys<\/strong>/);
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
		const link = `[label](${raw})`;
		const kept = normalizeDescription(link) === link.trim();
		if (!raw.includes("\n")) assert.equal(kept, expected !== null, `normalizer: ${raw}`);
		assert.deepEqual(safeHref(raw), expected === null ? null : { href: expected, external: true }, `render: ${raw}`);
	}
	assert.deepEqual(safeHref("/tasks"), { href: "/tasks", external: false });
	assert.equal(normalizeDescription("[tasks](/tasks)"), "tasks");
});

test("AC:TARGET-TSK-016 the normalizer keeps HTML and text shaped like tags exactly as typed", () => {
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
	assert.equal(
		normalizeDescription(
			"  Hello  \r\n<b>x</b>\r\n\r\n\r\n\r\n[click](javascript:alert(1)) [ok](https://a.org)\t\n\n ",
		),
		"Hello\n<b>x</b>\n\nclick [ok](https://a.org)",
	);
});
