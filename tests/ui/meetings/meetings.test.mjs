// The one meeting flow a silent break would cost us: a guest answers through their personal link, the Admin sees that
// answer and corrects it, and the closed link cannot answer again. Seed with tests/ui/people/seed.mts, then
// tests/ui/meetings/seed.mts; set UI_BASE_URL. Both browser engines run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

for (const [name, engine] of ENGINES) {
	test(`AC:CASE-COM-010 AC:TARGET-MTG-008 AC:TARGET-MTG-009 (${name}): a link answer reaches the guest list, an Admin correction wins and the link stays closed`, async () => {
		const { meetingId, links } = fixture("meetings");
		const { token, first } = links[name];
		await withPage(engine, async (page, context) => {
			await page.goto(`${BASE}/rsvp/${token}`);
			await hydrated(page);
			await page.getByRole("button", { name: "Yes, I'll come" }).click();
			await page.getByRole("heading", { level: 1, name: `See you there, ${first}` }).waitFor();
			// The answer shows at once; this line appears when the server has recorded it.
			await page.getByText("This link is now closed.", { exact: false }).waitFor();

			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}/meetings/${meetingId}`);
			await hydrated(page);
			const row = page.getByRole("row", { name: new RegExp(first) });
			await row.getByText("from their link").waitFor();
			assert.equal(await row.getByText("Yes", { exact: true }).count(), 1);

			await row.getByRole("button", { name: /^Actions for/ }).click();
			await page.getByRole("menuitem", { name: "Set to No" }).click();
			// The badge changes at once; the toast says the server confirmed it.
			await page
				.getByText(/RSVP set to No\./)
				.first()
				.waitFor();
			await page.reload();
			await page
				.getByRole("row", { name: new RegExp(first) })
				.getByText("set by an Admin")
				.waitFor();
			assert.equal(
				await page
					.getByRole("row", { name: new RegExp(first) })
					.getByText("No", { exact: true })
					.count(),
				1,
			);

			await page.goto(`${BASE}/rsvp/${token}`);
			await page.getByText("Your answer: I can't make it").waitFor();
			assert.equal(await page.getByRole("button", { name: "Yes, I'll come" }).count(), 0);
		});
	});
}
