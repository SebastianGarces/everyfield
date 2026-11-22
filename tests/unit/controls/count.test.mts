import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { renderToStaticMarkup } = web("react-dom/server");
const { createElement } = web("react");
const { Count, CountChip } = await import("../../../packages/ui/src/controls/index.ts");

const readable = (html: string) =>
	html
		.replace(/<number-flow-react[\s\S]*?<\/number-flow-react>/g, "")
		.replace(/<[^>]+>/g, "")
		.trim();

test("INV-a11y: a changing count gives screen readers the plain number and hides the animated digits", () => {
	for (const value of [0, 7, 1234]) {
		const html = renderToStaticMarkup(createElement(Count, { value }));
		assert.match(html, new RegExp(`<span class="sr-only">${value}</span>`));
		assert.match(html, /<number-flow-react[^>]*aria-hidden="true"/);
		assert.equal(readable(html), String(value));
	}
	assert.equal(readable(renderToStaticMarkup(createElement(CountChip, { value: 12 }))), "12");
});
