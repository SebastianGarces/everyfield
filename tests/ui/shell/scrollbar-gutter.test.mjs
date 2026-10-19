// BUG-138-gutter: product pages always reserve the scrollbar's space, so the shell keeps one width whether the page
// scrolls or not and the top bar does not move between pages (WP-088 round 2). Marketing pages keep their own scrolling.
// The document is the scroll container, so the rule lives on <html> while a product root is mounted.
// Chromium runs without Playwright's --hide-scrollbars, so it draws classic scrollbars (as on Windows, Linux and macOS
// with "Show scroll bars: Always") and the still page must keep an empty gutter. Playwright's WebKit only draws overlay
// scrollbars, which take no space; there the shell must simply keep the full viewport width on both pages.
// It runs against a running app: set UI_BASE_URL to the task preview.
//   UI_BASE_URL=https://wp-088-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const SCROLLING = "/design/foundations";
const STILL = "/design/shell/owner";

for (const [name, engine, classic] of [
	["chromium", chromium, true],
	["webkit", webkit, false],
]) {
	test(
		`BUG-138-gutter (${name}): a scrolling and a still product page give the shell the same width`,
		{ timeout: 90_000 },
		async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			const browser = await engine.launch(classic ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {});
			try {
				const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
				const page = await context.newPage();
				const measure = async (path) => {
					await page.goto(BASE + path, { waitUntil: "networkidle" });
					return page.evaluate(() => {
						const html = document.documentElement;
						const shell = document.querySelector("[data-product-root]");
						return {
							scrolls: html.scrollHeight > html.clientHeight,
							gutter: shell ? window.innerWidth - shell.clientWidth : null,
							rule: getComputedStyle(html).scrollbarGutter,
						};
					});
				};

				const scrolling = await measure(SCROLLING);
				const still = await measure(STILL);
				assert.equal(scrolling.scrolls, true, `${SCROLLING} scrolls`);
				assert.equal(still.scrolls, false, `${STILL} fits the viewport`);
				assert.equal(still.gutter, scrolling.gutter, "the shell keeps one width with and without a scrollbar");
				if (classic) assert.ok(still.gutter > 0, "the page that does not scroll keeps the scrollbar's space empty");

				const marketing = await measure("/");
				assert.equal(marketing.gutter, null, "the marketing home page has no product root");
				assert.equal(marketing.rule, "auto", "marketing pages keep their own scrolling");
			} finally {
				await browser.close();
			}
		},
	);
}
