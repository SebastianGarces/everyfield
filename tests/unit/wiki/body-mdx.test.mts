import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ArticleBody } from "../../../apps/web/src/features/wiki/prose.tsx";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const html = (contentType: string, body: string): string =>
	renderToStaticMarkup(createElement(ArticleBody, { contentType, body }));
const tags = (markup: string) => [...new Set([...markup.matchAll(/<([a-zA-Z][\w.-]*)/g)].map((m) => m[1]!))].sort();
const ran = globalThis as { wikiBodyRan?: boolean };

test("INV-wiki-body: JSX, imports, exports and expressions in a safe_mdx body stay text: none runs and none becomes an element", () => {
	const out = html(
		"safe_mdx",
		[
			'import Widget from "./widget"',
			"",
			"export const total = 1 + 1",
			"",
			"Sum {1 + 41} and {globalThis.wikiBodyRan = true}",
			"",
			"<Widget onClick={() => alert(1)}>Inside widget</Widget>",
			"",
			"<script>globalThis.wikiBodyRan = true</script>",
			"",
			'Inline <img src="x" onError={alert(1)} /> and <iframe src="https://x.test"></iframe> end',
			"",
			'<Callout type="tip">Kept {2 + 2} <Widget /></Callout>',
			"",
			"- item <video autoPlay /> {3 + 3}",
			"",
			"> quote <Widget /> {4 + 4}",
			"",
			"| <Widget /> cell | {5 + 5} |",
		].join("\n"),
	);
	assert.deepEqual(tags(out), ["aside", "blockquote", "div", "li", "p", "table", "tbody", "td", "tr", "ul"]);
	assert.equal(ran.wikiBodyRan, undefined);
	for (const source of ["{1 + 41}", "{2 + 2}", "{3 + 3}", "{4 + 4}", "{5 + 5}"])
		assert.ok(out.includes(source), source);
	for (const result of ["Sum 42", "Kept 4", "quote 8"]) assert.equal(out.includes(result), false, result);
});

test("INV-wiki-body: an mdx node in a stored node body never reaches the page: its code is dropped and it names no element", () => {
	const node = (type: string, extra: object = {}) => ({ type, name: "Widget", value: "CODE", text: "CODE", ...extra });
	const out = html(
		"safe_nodes",
		JSON.stringify([
			{ type: "paragraph", children: [{ type: "text", text: "Kept" }, node("mdxjsEsm")] },
			node("mdxjsEsm", { children: [{ type: "paragraph", text: "CODE" }] }),
			node("import", { children: [{ type: "paragraph", text: "CODE" }] }),
			node("script", { children: [{ type: "paragraph", text: "CODE" }] }),
			node("mdxFlowExpression"),
			node("mdxJsxFlowElement"),
		]),
	);
	assert.equal(out.replace(/<[^>]*>/g, ""), "Kept");
	assert.deepEqual(tags(out), ["div", "p"]);
	const editor = html(
		"safe_nodes",
		JSON.stringify({
			format: "everyfield-editor-v1",
			blocks: [
				{ type: "paragraph", children: [{ type: "text", text: "Kept" }] },
				node("mdxjsEsm"),
				node("mdxJsxFlowElement", { children: [{ type: "text", text: "CODE" }] }),
			],
		}),
	);
	assert.equal(editor.replace(/<[^>]*>/g, ""), "Kept");
});
