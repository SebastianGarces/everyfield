// A task description in the task panel and in its list row (WP-026, REQ-TSK-016). They run in node against the
// components the screens draw; no browser.
//   AC:TARGET-TSK-016 INV-same-text: the panel and the row preview show the same readable text from one canonical value,
//     with its line breaks, and no script, event handler or javascript: link reaches the DOM. A cleared description
//     shows the empty state in the panel and no preview in the row.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DESCRIPTION_EXCERPT, normalizeDescription } from "../../../packages/contracts/src/tasks/index.ts";
import { DescriptionPreview, DescriptionView } from "../../../apps/web/src/features/tasks/description.ts";

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

// The TARGET-TSK-016 case input with more of what a person pastes: paragraphs, a list, a real link and an image's handler.
const pasted = [
	"Hello",
	"<script>alert(1)</script>",
	"[click](javascript:alert(1))",
	"",
	"Second paragraph,",
	"with its own line break.",
	"",
	"- bring the **keys**",
	'- see <img src=x onerror="alert(2)">[the map](https://example.org/map)',
].join("\n");

test("AC:TARGET-TSK-016 INV-same-text: the panel and the list preview read the same safe text", () => {
	const canonical = normalizeDescription(pasted);
	const full = html(DescriptionView, canonical);
	const preview = html(DescriptionPreview, canonical.slice(0, DESCRIPTION_EXCERPT));
	for (const markup of [full, preview]) {
		assert.doesNotMatch(markup, /<script|<img|<iframe/i);
		assert.doesNotMatch(markup, /\son[a-z]+=/i);
		assert.doesNotMatch(markup, /javascript:|data:/i);
		assert.doesNotMatch(markup, /alert\(/);
	}
	const expected = ["Hello", "click", "Second paragraph,", "with its own line break.", "bring the keys", "see the map"];
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
