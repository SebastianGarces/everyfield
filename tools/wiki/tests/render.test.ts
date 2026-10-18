import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { inspect } from "../mdx.ts";
import { render } from "../render.ts";

const root = resolve(import.meta.dirname, "../../..");

test("BUG-0d8d60c: preview checklists hang-indent and code scrolls without page overflow", async (t) => {
	const out = await mkdtemp(join(tmpdir(), "wiki-mobile-"));
	const browser = await chromium.launch({ headless: true });
	try {
		const payload = JSON.parse(await readFile(resolve(root, "docs/reference/wiki/seed.json"), "utf8"));
		const content = [
			"## Mobile checklist",
			"- [ ] " +
				"Keep **formatted text** and [linked instructions](https://example.com) beside the checkbox. ".repeat(3),
			"- [x] " + "Completed checklist instructions should also stay beside their checkbox. ".repeat(3),
			"  - [ ] " + "Nested checklist instructions should stay indented beside their own checkbox. ".repeat(3),
			"",
			"## Loose checklist",
			"- [ ] " + "A paragraph in a loose checklist must hang-indent beside its checkbox. ".repeat(3),
			"",
			"  A second paragraph keeps the same indentation.",
			"",
			"- [x] Another completed item.",
			"",
			"## Code example",
			"```text",
			"A long preformatted line keeps all of its content: " + "0123456789".repeat(20),
			"A second line preserves its indentation.",
			"```",
		].join("\n");
		const result = await inspect(content, new Set(), true);
		assert.ok(result.code, result.errors.join("\n"));
		const file = await render(
			{ ...payload.articles[0], title: "Mobile preview regression", content },
			result.code,
			"Tooling",
			root,
			out,
		);
		for (const width of [390, 1280])
			await t.test(`${width}px`, async (t) => {
				const page = await browser.newPage({ viewport: { width, height: 900 } });
				await page.goto(pathToFileURL(file).href);
				await t.test("wrapped checklist lines stay beside the checkbox", async () => {
					const items = await page.locator(".task-list-item").evaluateAll((elements) =>
						elements.map((item) => {
							const checkbox = item.querySelector("input");
							if (!checkbox) throw new Error("Missing checklist checkbox");
							const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
							const lines: DOMRect[] = [];
							while (walker.nextNode()) {
								const node = walker.currentNode;
								if (!node.textContent?.trim() || node.parentElement?.closest(".task-list-item") !== item) continue;
								const range = document.createRange();
								range.selectNodeContents(node);
								lines.push(...range.getClientRects());
							}
							return {
								right: checkbox.getBoundingClientRect().right,
								lefts: lines.map((line) => line.left),
								tops: [...new Set(lines.map((line) => line.top))],
							};
						}),
					);
					assert.equal(items.length, 5);
					assert.ok(items[0].tops.length > 1, "Fixture must include wrapped text");
					for (const item of items) {
						assert.ok(item.lefts.length > 0, "Checklist text must render");
						assert.ok(
							item.lefts.every((left) => left >= item.right + 7),
							JSON.stringify(item),
						);
					}
				});
				await t.test("long code scrolls within its box and the page fits", async () => {
					const size = await page.evaluate(() => ({
						page: document.documentElement.scrollWidth,
						viewport: innerWidth,
					}));
					assert.equal(size.page, size.viewport);
					const code = await page.locator("pre").evaluate((pre) => {
						const start = pre.scrollLeft;
						pre.scrollLeft = pre.scrollWidth;
						return { width: pre.clientWidth, content: pre.scrollWidth, start, end: pre.scrollLeft };
					});
					assert.ok(code.content > code.width, "Fixture must need horizontal scrolling");
					assert.equal(code.start, 0);
					assert.ok(code.end > 0, "The end of the code must be reachable");
				});
				await page.close();
			});
	} finally {
		await browser.close();
		await rm(out, { recursive: true, force: true });
	}
});
