// Evry's answer text (WP-051): safe markdown as React elements, and the live text the stream delivers ahead of saved
// events. They run in node against the modules the panel uses; no browser.
//   INV-markdown: paragraphs, line breaks, bold, italic, lists, links and inline code render as elements; HTML in model
//     text stays text; only http, https, mailto and app-relative links are links.
//   INV-partial: while an answer streams, an unclosed marker never shows as a literal character; a finished answer
//     shows a really unmatched marker as text.
//   INV-live: live text adds only the characters the panel lacks, and a turn's end drops it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import { renderMarkdown } from "../../../apps/web/src/features/evry/conversation/view.ts";
import { safeHref } from "../../../apps/web/src/features/evry/conversation/markdown.ts";
import { EMPTY, merge, mergeLive, turnsOf } from "../../../apps/web/src/features/evry/conversation/model.ts";

const web = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement, Fragment } = web("react");
const html = (text, open = false) => renderToStaticMarkup(createElement(Fragment, null, ...renderMarkdown(text, open)));

test("INV-markdown: each element renders", () => {
	assert.equal(html("First.\n\nSecond.\nSame paragraph."), "<p><span>First.</span></p><p><span>Second.</span><span><br/>Same paragraph.</span></p>");
	assert.match(html("There are **19 prospects**."), /<strong class="[^"]*">19 prospects<\/strong>\./);
	assert.match(html("This is *italic* text"), /<em>italic<\/em>/);
	assert.match(html("Run `pnpm test` now"), /<code class="[^"]*">pnpm test<\/code>/);
	assert.match(html("- one\n- two\n"), /<ul[^>]*><li>one<\/li><li>two<\/li><\/ul>/);
	assert.match(html("1. first\n2. second"), /<ol[^>]*><li>first<\/li><li>second<\/li><\/ol>/);
	const link = html("See [the guide](https://example.com/a?b=1&c=2).");
	assert.match(link, /<a [^>]*href="https:\/\/example.com\/a\?b=1&amp;c=2"/);
	assert.match(link, /target="_blank"/);
	assert.match(link, /rel="noopener noreferrer"/);
	assert.match(link, />the guide<\/a>\.<\/span>/);
	assert.match(html("[people](/people)"), /<a [^>]*href="\/people"[^>]*>people<\/a>/);
	assert.doesNotMatch(html("[people](/people)"), /target=|rel=/);
	assert.match(html("[mail](mailto:a@b.co)"), /href="mailto:a@b.co"/);
	assert.match(html("**bold with *italic* and `code`**"), /<strong[^>]*>bold with <em>italic<\/em> and <code[^>]*>code<\/code><\/strong>/);
});

test("INV-markdown: HTML in model text renders as visible text", () => {
	const out = html("<img src=x onerror=alert(1)> and <script>alert(1)</script>");
	assert.ok(!out.includes("<img") && !out.includes("<script"));
	assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
	assert.ok(!readFileSync(new URL("../../../apps/web/src/features/evry/conversation/view.ts", import.meta.url), "utf8").includes("dangerouslySetInnerHTML"));
});

test("INV-markdown: only http, https, mailto and app-relative links are links", () => {
	for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "java\nscript:alert(1)", "file:///etc/passwd", "ftp://x.y"]) {
		assert.equal(safeHref(bad), null, bad);
		const out = html(`[click](${bad})`);
		assert.ok(!out.includes("<a "), bad);
		assert.ok(out.includes("click"), bad);
	}
	assert.deepEqual(safeHref("http://a.test"), { href: "http://a.test", external: true });
	assert.deepEqual(safeHref("/people/1"), { href: "/people/1", external: false });
});

test("INV-partial: an open marker never shows while streaming", () => {
	for (const partial of ["There are **19 pro", "There are *19 pro", "There are `19 pro", "See [the guide](", "See [the guide](https://exa", "See [the gu", "There are **", "There are *", "A **bold** and **"]) {
		const out = html(partial, true);
		assert.doesNotMatch(out.replace(/<[^>]+>/g, ""), /[*`\[\]()]/, partial);
	}
	assert.match(html("There are **19 pro", true), /<strong[^>]*>19 pro<\/strong>/);
	assert.match(html("Run `pnpm te", true), /<code[^>]*>pnpm te<\/code>/);
	assert.ok(html("See [the guide](https://exa", true).includes("the guide"));
	// Closing it later changes no text, only the element around it.
	assert.equal(html("There are **19 pro", true).replace(/<[^>]+>/g, ""), "There are 19 pro");
	assert.equal(html("There are **19 pro**", true).replace(/<[^>]+>/g, ""), "There are 19 pro");
});

test("INV-partial: a finished answer shows an unmatched marker as text", () => {
	assert.equal(html("There are **19 pro").replace(/<[^>]+>/g, ""), "There are **19 pro");
	assert.equal(html("5 * 3 = 15").replace(/<[^>]+>/g, ""), "5 * 3 = 15");
	assert.equal(html("a `b").replace(/<[^>]+>/g, ""), "a `b");
	assert.equal(html("a [b](c").replace(/<[^>]+>/g, ""), "a [b](c");
	assert.equal(html("a \\*b\\*").replace(/<[^>]+>/g, ""), "a *b*");
});

const T = "11111111-1111-4111-8111-111111111111";
const text = (sequence, body) => ({ sequence, turnId: T, kind: "assistant_text", body: { text: body }, createdAt: "2026-10-31T00:00:00Z" });
const ask = { sequence: 1, turnId: T, kind: "user_message", body: { text: "Hi", references: [] }, createdAt: "2026-10-31T00:00:00Z" };

test("INV-live: live text adds only what the panel lacks", () => {
	let s = merge(EMPTY, [ask]);
	s = mergeLive(s, T, 0, "Hello ");
	s = mergeLive(s, T, 0, "Hello wor");
	s = mergeLive(s, T, 6, "world");
	s = mergeLive(s, T, 20, "gap");
	assert.equal(s.live[T], "Hello world");
	assert.equal(mergeLive(s, T, 2, "llo"), s);
	assert.equal(turnsOf(s.events, s.live)[0].blocks[0].text, "Hello world");
	// A saved event covering the first part of the live text shows once, with the rest after it.
	s = merge(s, [text(2, "Hello ")]);
	const [turn] = turnsOf(s.events, s.live);
	assert.equal(turn.blocks.length, 1);
	assert.equal(turn.blocks[0].text, "Hello world");
	// The turn's end drops the live text; only saved text remains.
	s = merge(s, [text(3, "world"), { sequence: 4, turnId: T, kind: "status", body: { state: "completed", reason: "completed" }, createdAt: "2026-10-31T00:00:00Z" }]);
	assert.equal(T in s.live, false);
	assert.equal(turnsOf(s.events, s.live)[0].blocks[0].text, "Hello world");
});
