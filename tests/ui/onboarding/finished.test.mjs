// BUG-S2-task1: the "Setup is finished" screen had no way into the app. It must offer a primary "Go to dashboard" link to
// the product home (/people, the app shell's homeHref) and must not redirect by itself, so the "Still to do" list stays
// readable. Runs on the fixture preview (/design/onboarding?as=finished) through the shared setup (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

for (const [name, engine] of ENGINES)
	for (const width of [1440, 390])
		test(`BUG-S2-task1 finished setup links to the dashboard without redirecting (${name} ${width}px)`, async () => {
			await withPage(
				engine,
				async (page) => {
					await page.goto(`${BASE}/design/onboarding?as=finished`);
					const go = page.getByRole("link", { name: "Go to dashboard" });
					await go.waitFor();
					assert.equal(await go.getAttribute("href"), "/people");
					const classes = await go.getAttribute("class");
					assert.match(classes ?? "", /bg-ink|primary/, "the link uses the primary button style");
					assert.equal(await page.getByRole("button", { name: "Go to dashboard" }).count(), 0);
					assert.ok(await page.getByRole("heading", { name: "Still to do" }).isVisible());
					await page.waitForTimeout(10_500);
					assert.match(new URL(page.url()).pathname, /\/design\/onboarding$/, "no automatic redirect");
					assert.ok(await page.getByRole("heading", { name: "Setup is finished" }).isVisible());
					assert.ok(await page.getByRole("heading", { name: "Still to do" }).isVisible());
					assert.ok(await page.getByRole("button", { name: "Review answers" }).isVisible());
					const box = await go.boundingBox();
					const list = await page.getByRole("heading", { name: "Still to do" }).boundingBox();
					assert.ok(box && list && box.y > list.y + list.height, "the action sits below the list");
					await go.focus();
					await page.keyboard.press("Enter");
					await page.waitForURL((u) => !u.pathname.startsWith("/design/onboarding"));
				},
				{ width },
			);
		});
