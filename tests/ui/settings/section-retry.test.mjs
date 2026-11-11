// BUG-551 (people/peo-12): a Settings section read whose call rejects (no connection) shows the retry state, not the
// skeleton forever, and Try again reads the section again. The section read is a server action (a POST with a
// Next-Action header); the browser aborts it, so the port's getSection promise rejects as it does offline.
// It runs against a running app seeded with the People fixture (tests/ui/people/seed.mts) through the shared setup
// (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const isAction = (request) => request.method() === "POST" && Boolean(request.headers()["next-action"]);

for (const [name, engine] of ENGINES) {
	test(`BUG-551 (people/peo-12, ${name}): a rejected section read shows the retry state and Try again reads it again`, async () => {
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			// Notifications reads its section with the page; Your account is read through the port once opened.
			await page.goto(`${BASE}/settings/notifications`, { waitUntil: "networkidle" });
			await hydrated(page);
			const dialog = page.getByRole("dialog").first();

			const abort = (route) => (isAction(route.request()) ? route.abort("failed") : route.fallback());
			await page.route("**/*", abort);
			await dialog.getByRole("link", { name: "Your account" }).click();
			await page.waitForURL("**/settings/account");
			await dialog.getByRole("heading", { name: "This section did not load" }).waitFor({ timeout: 30_000 });
			await dialog.getByText("Everyfield could not be reached. Check your connection.").waitFor();
			assert.equal(await dialog.getByText("Loading your account").count(), 0, "no skeleton");

			await page.unroute("**/*", abort);
			let reads = 0;
			page.on("request", (r) => isAction(r) && reads++);
			await dialog.getByRole("button", { name: "Try again" }).click();
			await dialog.getByLabel("Your name").waitFor({ timeout: 30_000 });
			assert.ok(reads >= 1, "Try again reads the section again");
			assert.equal(await dialog.getByText("This section did not load").count(), 0);
		});
	});
}
