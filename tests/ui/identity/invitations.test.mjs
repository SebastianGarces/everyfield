// BUG-99d7882: following a second invitation fragment must replace the displayed invitation and clear its proof.
// Seed the isolated preview with invitation-seed.mts before running this regression.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ENGINES, fixture, withPage } from "../setup.mjs";

const seed = () => fixture("invitation");

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
