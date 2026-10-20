// BUG-PR99: a Sheet or CommandPalette opened from caller state (no Radix Trigger) returned focus to <body> on Esc.
// Both now return focus to the element that opened them. Found by the openai verifier on PR #99 (WP-089).
// It runs against a running app through the shared setup (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

for (const [name, engine] of ENGINES) {
	test(
		`BUG-PR99 (${name}): controlled Sheet and CommandPalette return focus to their opener on Esc`,
		{ timeout: 60_000 },
		() =>
			withPage(engine, async (page) => {
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
			}),
	);
}
