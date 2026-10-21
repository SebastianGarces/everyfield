// The Evry review card's approval on a seeded preview (WP-053/ui), in both engines at phone width. It needs the People
// seed (tests/ui/people/seed.mts) and a preview started with EVRY_SCRIPTED_MODEL=1 in its apps/web/.env.local.
//   AC:UI45-002 AC:INH-REGRESSION-REVISED-APPROVAL INV-revise: revising a reviewed value makes revision 2, which is
//     the one approved and saved.
//   AC:INH-REGRESSION-CONFIRM-REPLAY INV-lost-approval: an approval whose reply is lost after the server saved it shows
//     as saved, never as "not approved"; one approval was sent, the person changed once, and focus stays in the card.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

for (const [engine, launcher] of ENGINES)
	test(`AC:UI45-002 AC:INH-REGRESSION-CONFIRM-REPLAY INV-lost-approval: a revised change saves once (${engine})`, () =>
		withPage(
			launcher,
			async (page, context) => {
				const people = fixture("people");
				await signIn(context, people.owner.cookie);
				const approvals = [];
				await context.route("**/api/evry/proposals/*/approve", async (route) => {
					approvals.push(route.request().postData());
					// The server saves the approval; the browser never hears back.
					await route.fetch();
					await route.abort("connectionreset");
				});
				await page.goto(`${BASE}/people`);
				await hydrated(page);
				await page.getByRole("button", { name: "Ask Evry" }).click();
				const panel = page.getByRole("dialog", { name: "Evry" });
				await panel.getByRole("button", { name: "History" }).click();
				await panel.getByRole("button", { name: "New chat" }).click();
				const box = panel.getByLabel("Message Evry");
				await box.fill(`Change Maria's city to Dallas ${engine}`);
				await box.press("Enter");

				const card = panel.getByRole("region", { name: "Review before saving" });
				await card.getByRole("button", { name: "Revise" }).click({ timeout: 60_000 });
				const city = `Austin ${engine} ${Date.now().toString(36)}`;
				await card.getByLabel("City").fill(city);
				await card.getByRole("button", { name: "Update review" }).click();
				await card.getByText("Revision 2", { exact: true }).waitFor();

				// Keyboard use: Safari does not focus a button on a mouse click.
				await card.getByRole("button", { name: "Approve" }).focus();
				await page.keyboard.press("Enter");
				const saved = panel.getByRole("region", { name: "Saved" });
				await saved.waitFor({ timeout: 15_000 });
				assert.equal(approvals.length, 1);
				assert.equal(JSON.parse(approvals[0]).revision, 2);
				assert.match(await saved.innerText(), new RegExp(city));
				// The Approve button is gone; focus moved to the card's head, not to <body>.
				assert.equal(await saved.evaluate((el) => el.contains(document.activeElement)), true);
				const person = await page.evaluate(
					(id) => fetch(`/people/${id}`).then((r) => r.text()),
					people.people["Maria Santos"],
				);
				assert.match(person, new RegExp(city));
			},
			{ width: 390, height: 844 },
		));
