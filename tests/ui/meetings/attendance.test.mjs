// The attendance flow a silent break would cost us: guests are checked in at the door on a phone, attendance is
// finalized with its generated work, and the meeting is evaluated. The next save after finalize or a walk-in goes through
// the first time (T-155). Seed with tests/ui/people/seed.mts, then tests/ui/meetings/seed.mts; set UI_BASE_URL. Both
// browser engines run, each on its own past meetings.
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
				// One list: no tabs and no radio. A tap marks the row in place and a second tap takes it back.
				assert.equal(await page.getByRole("radio").count(), 0, "check-in has no radio");
				const rowOf = (guest, pressed) =>
					page.getByRole("button", { name: new RegExp(`^${guest}`), ...(pressed === undefined ? {} : { pressed }) });
				const order = () => page.locator("ul button[aria-pressed]").allInnerTexts();
				const before = await order();
				await rowOf(guests[0]).click();
				await rowOf(guests[0], true).waitFor();
				await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
				await rowOf(guests[0]).click();
				await rowOf(guests[0], false).waitFor();
				await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
				for (const guest of guests) {
					await rowOf(guest).click();
					await rowOf(guest, true).waitFor();
					await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
				}
				assert.equal(
					await page.locator("ul button[aria-pressed=true]").count(),
					guests.length,
					"pressed rows = tapped",
				);
				assert.deepEqual(
					(await order()).map((t) => t.split("\n")[0]),
					before.map((t) => t.split("\n")[0]),
					"a tap never reorders the list",
				);
				await page.reload();
				await hydrated(page);
				// The counter reads "N of M" and never says "here".
				// Read the whole badge, so screen-reader-only text counts too.
				const badge = page.getByText(new RegExp(`^${guests.length} of \\d+\\s*checked in$`)).first();
				const counter = await badge.textContent();
				assert.match(counter, new RegExp(`^${guests.length} of \\d+ checked in$`));
				assert.doesNotMatch(counter, /here/i);
				assert.equal(await page.locator("ul button[aria-pressed=true]").count(), guests.length);

				await page.getByRole("button", { name: "Finish check-in" }).click();
				const review = page.getByRole("dialog", { name: "Finalize attendance" });
				await review.getByText(`${guests[0]}, ${guests[1]}`).waitFor();
				await review.getByRole("button", { name: "Finalize" }).click();
				await page.getByText("Attendance is final. To change it", { exact: false }).waitFor();

				await page.setViewportSize({ width: 1440, height: 900 });
				// Attendance and the evaluation are in the Results tab; a meeting with cards still to record opens on Guests.
				await page.goto(`${BASE}/meetings/${meetingId}?tab=results`);
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

for (const [name, engine] of ENGINES) {
	const signedIn = (run) =>
		withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await run(page);
		});
	const revisions = () => fixture("meetings").revisions[name];
	const open = async (page, path) => {
		await page.goto(`${BASE}${path}`);
		await hydrated(page);
	};

	test(`BUG-T155 messages/com-8 (${name}): finalize, then Record response card saves the first time`, async () => {
		const { meetingId, guest } = revisions().card;
		await signedIn(async (page) => {
			// Before the meeting closes, Finalize attendance is on the Results tab's attendance card.
			await open(page, `/meetings/${meetingId}?tab=results`);
			await page.getByRole("button", { name: "Finalize attendance" }).first().click();
			const review = page.getByRole("dialog", { name: "Finalize attendance" });
			await review.getByText(/^Counts /).waitFor();
			// Finalize's own answer, not a timer: the settle request carries its request key after the mode; the review's
			// preview does not.
			const finalized = page.waitForResponse(
				(r) => r.request().method() === "POST" && /^\["finalize","[0-9a-f-]{36}"/.test(r.request().postData() ?? ""),
			);
			await review.getByRole("button", { name: "Finalize" }).click();
			assert.equal((await finalized).status(), 200);
			// The toast is written from that answer once the page has applied it.
			await page
				.getByText(/: attendance is final\./)
				.first()
				.waitFor();

			await page.getByRole("tab", { name: /^Guests/ }).click();
			const row = page.getByRole("row", { name: new RegExp(guest) });
			await row.getByRole("button", { name: /^Actions for/ }).click();
			await page.getByRole("menuitem", { name: "Record response card" }).click();
			const form = page.getByRole("dialog", { name: "Record response card" });
			await form.getByText("Interested", { exact: true }).click();
			// The card's own answer: the save that carries this response, at the revision finalize returned.
			const answered = page.waitForResponse(
				(r) => r.request().method() === "POST" && (r.request().postData() ?? "").includes('"response":"interested"'),
			);
			await form.getByRole("button", { name: "Save card" }).click();
			assert.equal((await answered).status(), 200);
			// The guest list takes saves again once the answer is applied: Add guest is enabled.
			await page.waitForFunction(() =>
				[...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Add guest" && !b.disabled),
			);
			assert.equal(await page.getByText("Someone else changed this").count(), 0, "no conflict after finalize");
			await page.reload();
			await hydrated(page);
			await page.getByRole("tab", { name: /^Guests/ }).click();
			await page
				.getByRole("row", { name: new RegExp(guest) })
				.getByText("Interested")
				.waitFor();
		});
	});

	test(`BUG-T155 messages/com-9 (${name}): a walk-in, then Finish check-in finalizes the first time`, async () => {
		const meetingId = revisions().walkIn;
		await signedIn(async (page) => {
			await open(page, `/meetings/${meetingId}/check-in`);
			await page.getByRole("button", { name: "Add a walk-in" }).click();
			const walkIn = page.getByRole("dialog", { name: "Add a walk-in" });
			await walkIn.getByRole("radio", { name: "Someone new" }).click();
			await walkIn.getByLabel("Name").fill(`Door ${name}`);
			await walkIn.getByRole("button", { name: "Check in" }).click();
			await page.getByText(`Door ${name} is checked in.`).first().waitFor();
			await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));

			await page.getByRole("button", { name: "Finish check-in" }).click();
			const review = page.getByRole("dialog", { name: "Finalize attendance" });
			await review.getByText(`Door ${name}`).first().waitFor();
			await review.getByText(/^Counts 1 first/).waitFor();
			await review.getByRole("button", { name: "Finalize" }).click();
			await page.getByText("Attendance is final. To change it", { exact: false }).waitFor();
			assert.equal(await page.getByText("Someone else changed this").count(), 0, "no conflict after a walk-in");
		});
	});
}
