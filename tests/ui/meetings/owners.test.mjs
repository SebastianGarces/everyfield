// Who owns the follow-up calls a finalize creates (WP-023/api S2 batch 2, F07). The finalize picker starts at Needs owner
// and offers only people who may own a follow-up; Correct attendance starts at the owner the meeting's follow-ups already
// have, and its effects name the owner the way every other screen does. Seed with tests/ui/people/seed.mts, then
// tests/ui/followups/seed.mts (it makes Ruth Allen and Daniel Reyes eligible and adds Tomas Weaver, who holds a seat but
// cannot own follow-ups), then tests/ui/meetings/seed.mts; set UI_BASE_URL. Each engine runs on its own past meeting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-TSK-012 AC:TARGET-MTG-020 (${name}): finalize offers only eligible follow-up owners; Correct attendance starts at the current owner`, async () => {
		const { meetingId, guests } = fixture("meetings").past[name];
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}/meetings/${meetingId}/check-in`);
			await hydrated(page);
			await page.getByRole("button", { name: new RegExp(`^${guests[0]}`) }).click();
			await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
			await page.getByRole("button", { name: "Finish check-in" }).click();
			const review = page.getByRole("dialog", { name: "Finalize attendance" });

			// Finalize: no one is picked for the person. Only people who may own a follow-up are offered; the evaluation
			// keeps its seated rule, so Tomas Weaver is there.
			const calls = review.getByRole("combobox", { name: "Follow-up calls go to" });
			await calls.waitFor();
			assert.match(await calls.innerText(), /Needs owner/);
			await calls.click();
			const offered = async () => (await page.getByRole("option").allInnerTexts()).map((t) => t.trim());
			const forCalls = await offered();
			assert.deepEqual(forCalls.filter((t) => /Daniel Reyes|Ruth Allen|Tomas Weaver/.test(t)).sort(), [
				"Daniel Reyes",
				"Ruth Allen",
			]);
			await page.getByRole("option", { name: "Ruth Allen" }).click();
			await review.getByRole("combobox", { name: "Evaluation task goes to" }).click();
			assert.ok((await offered()).includes("Tomas Weaver"));
			await page.keyboard.press("Escape");
			await review
				.getByText(/Owner: Ruth Allen/)
				.first()
				.waitFor();
			await review.getByRole("button", { name: "Finalize", exact: true }).click();
			await page.getByText("Attendance is final. To change it", { exact: false }).waitFor();

			// Correct attendance: the picker already holds the owner of this meeting's follow-ups.
			await page.goto(`${BASE}/meetings/${meetingId}?tab=results`);
			await hydrated(page);
			await page.getByRole("button", { name: "Correct attendance" }).click();
			const correct = page.getByRole("dialog", { name: "Correct attendance" });
			const owner = correct.getByRole("combobox", { name: "Follow-up calls go to" });
			await owner.waitFor();
			await page.waitForFunction(
				() =>
					/Ruth Allen/.test(
						document.querySelector('[role="dialog"] [role="combobox"][aria-label="Follow-up calls go to"]')
							?.textContent ?? "",
					),
				null,
				{ timeout: 20_000 },
			);
			assert.doesNotMatch(await owner.innerText(), /Needs owner/);
			// A person added here gets a call owned by that same person, named the same way as everywhere else.
			await correct.getByRole("checkbox", { name: new RegExp(`^${guests[1]}`) }).check();
			await correct.getByText(new RegExp(`Follow-up call with ${guests[1]}.*Owner: Ruth Allen`)).waitFor();
		});
	});
}
