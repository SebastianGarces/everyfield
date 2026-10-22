// The attendance flow a silent break would cost us: guests are checked in at the door on a phone, attendance is
// finalized with its generated work, and the meeting is evaluated. Seed with tests/ui/people/seed.mts, then
// tests/ui/meetings/seed.mts; set UI_BASE_URL. Both browser engines run, each on its own past meeting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const SCORES = [4, 5, 4, 3, 5, 4, 4, 3]; // average 32 / 8 = 4.0

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-MTG-010 AC:TARGET-MTG-012 AC:TARGET-MTG-014 (${name}): door check-in, finalize and evaluation`, async () => {
		const { meetingId, guests } = fixture("meetings").past[name];
		await withPage(
			engine,
			async (page, context) => {
				await signIn(context, fixture("people").owner.cookie);
				await page.goto(`${BASE}/meetings/${meetingId}/check-in`);
				await hydrated(page);
				for (const guest of guests) {
					await page.getByRole("button", { name: new RegExp(`^${guest}`) }).click();
				}
				// Each tap shows at once; a row stays busy until the server answers.
				await page.getByRole("radio", { name: /^Here 2/ }).click();
				await page.getByRole("button", { name: new RegExp(`^${guests[1]}`), pressed: true }).waitFor();
				await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
				await page.reload();
				await hydrated(page);
				await page.getByRole("radio", { name: /^Here 2/ }).waitFor();

				await page.getByRole("button", { name: "Finish check-in" }).click();
				const review = page.getByRole("dialog", { name: "Finalize attendance" });
				await review.getByText(`${guests[0]}, ${guests[1]}`).waitFor();
				await review.getByRole("button", { name: "Finalize" }).click();
				await page.getByText("Attendance is final. To change it", { exact: false }).waitFor();

				await page.setViewportSize({ width: 1440, height: 900 });
				await page.goto(`${BASE}/meetings/${meetingId}`);
				await hydrated(page);
				const attendance = page.getByRole("region", { name: "Attendance" });
				await attendance.getByText("Final", { exact: true }).waitFor();
				assert.equal(await attendance.getByText("0 of 2 done").count(), 1);

				await page.getByRole("button", { name: "Record evaluation" }).click();
				const form = page.getByRole("dialog", { name: "Evaluate the meeting" });
				const groups = form.getByRole("radiogroup");
				for (const [i, score] of SCORES.entries())
					await groups
						.nth(i)
						.getByRole("radio", { name: String(score), exact: true })
						.click();
				await form.getByText("4.0", { exact: true }).waitFor();
				await form.getByRole("button", { name: "Save evaluation" }).click();
				await page
					.getByText("The evaluation is saved. Its task is complete.")
					.filter({ visible: true })
					.first()
					.waitFor();
				await page.reload();
				await hydrated(page);
				const evaluation = page.getByRole("region", { name: "Meeting evaluation" });
				await evaluation.getByText("4.0", { exact: true }).waitFor();
				assert.equal(await page.getByRole("region", { name: "Attendance" }).getByText("Done").count(), 1);
			},
			{ width: 390, height: 844 },
		);
	});
}
