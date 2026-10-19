// BUG-99d7882: following a second invitation fragment must replace the displayed invitation and clear its proof.
// Seed the isolated preview with invitation-seed.mts before running this regression.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const FIXTURE = process.env.INVITATION_UI_FIXTURE ?? "/tmp/everyfield-invitation-ui.json";
const seed = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

async function withPage(engine, run) {
	const browser = await engine.launch();
	try {
		// Portless previews use a local certificate the test browsers do not know.
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			reducedMotion: "reduce",
			ignoreHTTPSErrors: true,
		});
		await run(await context.newPage());
	} finally {
		await browser.close();
	}
}

for (const [name, engine] of ENGINES) {
	describe(`invitation acceptance (${name})`, () => {
		test("BUG-99d7882: another invitation link opened in the same tab shows that invitation and cleans the address", async () => {
			const { member, resident } = seed().flows[name];
			await withPage(engine, async (page) => {
				await page.goto(member.link);
				await page.getByRole("heading", { name: "Join Harvest Point" }).waitFor();
				// Only the fragment changes, so the browser does not load the page again.
				await page.goto(resident.link);
				await page.getByRole("heading", { name: "Link your account to Grace Church" }).waitFor();
				assert.equal(await page.getByRole("heading", { name: "Join Harvest Point" }).count(), 0);
				await page.waitForFunction(() => window.location.hash === "");
			});
		});
	});
}
