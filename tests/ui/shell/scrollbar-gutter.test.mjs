// BUG-138-gutter: product pages always reserve the scrollbar's space, so the shell keeps one width whether the page
// scrolls or not and the top bar does not move between pages (WP-088 round 2). Marketing pages keep their own scrolling.
// The document is the scroll container, so the rule lives on <html> while a product root is mounted.
// Chromium runs with classic scrollbars (as on Windows, Linux and macOS with "Show scroll bars: Always"): without
// Playwright's --hide-scrollbars, and on macOS with the AppleShowScrollBars default set to Always for that browser
// process only, because macOS draws overlay scrollbars by default and those take no space. The still page must keep
// the scrollbar's space empty. Playwright's WebKit only draws overlay scrollbars; there the shell must simply keep the
// full viewport width on both pages.
// It runs against a running app through the shared setup (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

const SCROLLING = "/design/foundations";
const STILL = "/design/shell/owner";
const OVERLAYS = "/design/controls";

/**
 * Launch options for Chromium with classic scrollbars. On macOS a Cocoa app reads defaults from its own arguments, and
 * Playwright refuses extra positional arguments, so a small launcher adds them.
 */
function classicChromium(engine) {
	const launch = { ignoreDefaultArgs: ["--hide-scrollbars"] };
	if (process.platform !== "darwin") return launch;
	const launcher = join(mkdtempSync(join(tmpdir(), "evf-gutter-")), "chromium.sh");
	writeFileSync(launcher, `#!/bin/sh\nexec "${engine.executablePath()}" "$@" -AppleShowScrollBars Always\n`);
	chmodSync(launcher, 0o755);
	return { ...launch, executablePath: launcher };
}

for (const [name, engine] of ENGINES) {
	const classic = name === "chromium";
	test(
		`BUG-138-gutter (${name}): a scrolling and a still product page give the shell the same width`,
		{ timeout: 90_000 },
		() =>
			withPage(
				engine,
				async (page) => {
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
				},
				{ launch: classic ? classicChromium(engine) : {} },
			),
	);
}

// BUG-139-dialog-shift: a modal overlay locks page scrolling (react-remove-scroll), which adds the scrollbar's width to
// the body as margin. The gutter already holds that space, so the page lost it twice and moved in from the right. The
// page behind an open dialog keeps its width and the dialog stays centered in it.
for (const [name, engine] of ENGINES) {
	const classic = name === "chromium";
	test(`BUG-139-dialog-shift (${name}): opening a dialog on a scrolling page moves nothing`, { timeout: 90_000 }, () =>
		withPage(
			engine,
			async (page) => {
				await page.goto(BASE + OVERLAYS, { waitUntil: "networkidle" });
				await page.locator("html[data-theme]").waitFor({ state: "attached", timeout: 60_000 });
				const right = () => page.locator("[data-product-root]").evaluate((el) => el.getBoundingClientRect().right);
				const before = await right();
				await page.getByRole("button", { name: "Move Maria to core group" }).click();
				const dialog = page.getByRole("dialog");
				await dialog.waitFor();
				assert.equal(await page.locator("body[data-scroll-locked]").count(), 1, "the dialog locks page scrolling");
				assert.equal(await right(), before, "the page behind the dialog keeps its width");
				const box = await dialog.boundingBox();
				assert.ok(Math.abs(box.x + box.width / 2 - before / 2) <= 1, "the dialog is centered in the page's width");
			},
			{ launch: classic ? classicChromium(engine) : {} },
		),
	);
}
