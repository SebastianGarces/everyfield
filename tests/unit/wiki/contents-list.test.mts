import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { articleBlocks } from "../../../apps/web/src/features/wiki/model.ts";
import { ArticleBody } from "../../../apps/web/src/features/wiki/prose.tsx";
import { Toc } from "../../../packages/ui/src/display/index.ts";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");

test("AC:CASE-WIKI-002 each contents entry is a link the keyboard reaches and opens, at any width, to its own heading, repeated headings included", () => {
	const body = "## First step\nText\n### Detail\nText\n## Próximo paso\nText\n### Detail\nText";
	const items = articleBlocks("safe_mdx", body).flatMap((block) =>
		block.kind === "heading" ? [{ id: block.id, label: block.text, level: block.level }] : [],
	);
	const list: string = renderToStaticMarkup(createElement(Toc, { items, current: items[0]?.id }));
	assert.match(list, /^<nav aria-label="On this page"/);
	const links = [...list.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map((m) => ({ attributes: m[1]!, label: m[2] }));
	assert.deepEqual(
		links.map((link) => link.label),
		["First step", "Detail", "Próximo paso", "Detail"],
	);
	const page: string = renderToStaticMarkup(createElement(ArticleBody, { contentType: "safe_mdx", body }));
	const anchors = [...page.matchAll(/<h[23][^>]* id="([^"]+)"[^>]*>|<h[23] id="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
	const targets = links.map((link) => /href="#([^"]+)"/.exec(link.attributes)?.[1]);
	assert.deepEqual(targets, anchors);
	assert.equal(new Set(targets).size, 4);
	for (const { attributes } of links) assert.doesNotMatch(attributes, /tabindex|aria-hidden|disabled|inert/i);
	assert.doesNotMatch(list, /inert|aria-hidden|hidden=/);
});
