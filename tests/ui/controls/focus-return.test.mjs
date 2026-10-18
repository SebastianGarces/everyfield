// BUG-PR99: a Sheet or CommandPalette opened from caller state (no Radix Trigger) returned focus to <body> on Esc.
// Both now return focus to the element that opened them. Found by the openai verifier on PR #99 (WP-089).
// It runs against a running app: set UI_BASE_URL to the task preview.
//   UI_BASE_URL=http://wp-089-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;

for (const [name, engine] of [
	["chromium", chromium],
	["webkit", webkit],
]) {
	test(
		`BUG-PR99 (${name}): controlled Sheet and CommandPalette return focus to their opener on Esc`,
		{ timeout: 60_000 },
		async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			const browser = await engine.launch();
			try {
				const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
				await page.goto(BASE + "/design/controls");
				const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
				const returnsTo = (label) =>
					page
						.waitForFunction((l) => document.activeElement?.textContent?.trim().startsWith(l), label, { timeout: 2000 })
						.then(
							() => true,
							() => false,
						);

				for (const opener of ["Open the guide", "Command palette"]) {
					await page.getByRole("button", { name: opener }).focus();
					await page.keyboard.press("Enter");
					await page.getByRole("dialog").waitFor();
					assert.notEqual(await focused(), opener, `${opener}: focus moves into the panel`);
					await page.keyboard.press("Escape");
					await page.getByRole("dialog").waitFor({ state: "detached" });
					assert.ok(await returnsTo(opener), `${opener}: Esc returns focus to the opener`);
				}
			} finally {
				await browser.close();
			}
		},
	);
}
