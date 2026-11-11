// T-155: the meeting screens keep the revisions the server just wrote, and every conflict reloads the latest record.
// Finalize then a response card, a walk-in then Finish check-in, a settlement review that goes out of date while it
// loads, and Agenda, Edit meeting and Place saves that lose to another tab, then succeed on the retry. A link to a
// cancelled meeting shows a closed page. Seed with tests/ui/people/seed.mts, then tests/ui/meetings/seed.mts; set
// UI_BASE_URL. Both browser engines run, each on its own meetings. SHOTS=<dir> also saves the closed page at 390 and
// 1440 px.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

/** Each run writes its own words, so a rerun on the same seed never finds an earlier run's text. */
const RUN = Date.now().toString(36);
const CONFLICT = "Someone else changed this while you were working. The latest version is shown now.";

async function open(page, path) {
	await page.goto(`${BASE}${path}`);
	await hydrated(page);
}
/** A second tab of the same signed-in person: the "someone else" whose save lands first. */
async function otherTab(context, path) {
	const page = await context.newPage();
	await open(page, path);
	return page;
}
/**
 * The other tab's save is committed: a page shows an edit at once, before its answer, so the tab reloads and finds it
 * again before it closes.
 */
async function saved(page, find) {
	await find(page).waitFor();
	await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"], [aria-busy="true"] button'));
	await page.waitForLoadState("networkidle");
	await page.reload();
	await hydrated(page);
	await find(page).waitFor();
	await page.close();
}
/** The answer to the server action whose arguments carry `text`: the save's own reply, not a timer. */
const answerTo = (page, text) =>
	page.waitForResponse((r) => r.request().method() === "POST" && (r.request().postData() ?? "").includes(text));
const idle = (page) => page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
/**
 * Holds this page's server actions (POSTs with a Next-Action header) until `release` is called, so another tab can
 * change the record while the request is on its way.
 */
async function holdActions(page) {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let held = 0;
	await page.route("**/*", async (route) => {
		const r = route.request();
		if (r.method() !== "POST" || !r.headers()["next-action"]) return route.fallback();
		held++;
		await gate;
		return route.fallback();
	});
	return { release: () => release(), held: () => held };
}

for (const [name, engine] of ENGINES) {
	const signedIn = (run) =>
		withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await run(page, context);
		});
	const revisions = () => fixture("meetings").revisions[name];

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
			await page.getByRole("button", { name: "Add guest" }).last().waitFor();
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
			await idle(page);

			await page.getByRole("button", { name: "Finish check-in" }).click();
			const review = page.getByRole("dialog", { name: "Finalize attendance" });
			await review.getByText(`Door ${name}`).first().waitFor();
			await review.getByText(/^Counts 1 first/).waitFor();
			await review.getByRole("button", { name: "Finalize" }).click();
			await page.getByText("Attendance is final. To change it", { exact: false }).waitFor();
			assert.equal(await page.getByText("Someone else changed this").count(), 0, "no conflict after a walk-in");
		});
	});

	test(`BUG-T155 messages/com-8 (${name}): a review that goes out of date while it loads reloads the page, as a refused finalize does`, async () => {
		const { meetingId, guest } = revisions().preview;
		await signedIn(async (page, context) => {
			const path = `/meetings/${meetingId}/check-in`;
			await open(page, path);
			const hold = await holdActions(page);
			await page.getByRole("button", { name: "Finish check-in" }).click();
			const review = page.getByRole("dialog", { name: "Finalize attendance" });
			await review.getByText(guest).first().waitFor();
			// While the review is on its way, another tab takes the guest's check-in back.
			const other = await otherTab(context, path);
			await other.getByRole("button", { name: new RegExp(`^${guest}`), pressed: true }).click();
			await other.getByRole("button", { name: new RegExp(`^${guest}`), pressed: false }).waitFor();
			await idle(other);
			await other.close();
			assert.ok(hold.held() >= 1, "the review was held");
			hold.release();
			// The review was refused as out of date: the page read the check-in again and the review opened on it.
			await review.getByText(CONFLICT).waitFor();
			assert.equal(await review.getByText(guest).count(), 0, "the review starts from who is checked in now");
			await review.getByText(/^Counts 0 first/).waitFor();
			await review.getByRole("button", { name: "Finalize" }).click();
			await page.getByText("Attendance is final. To change it", { exact: false }).waitFor();
		});
	});

	test(`BUG-T155 messages/com-18 (${name}): an agenda save that loses to another tab shows the latest agenda, and the retry saves`, async () => {
		const path = `/meetings/${revisions().agenda}`;
		const firstTitle = async (dialog) => {
			if ((await dialog.getByLabel("Section 1 title").count()) === 0)
				await dialog.getByRole("button", { name: "Add section" }).click();
			return dialog.getByLabel("Section 1 title");
		};
		await signedIn(async (page, context) => {
			await open(page, path);
			await page.getByRole("button", { name: "Edit agenda" }).click();
			const editor = page.getByRole("dialog", { name: "Edit agenda" });
			const mine = await firstTitle(editor);

			const other = await otherTab(context, path);
			await other.getByRole("button", { name: "Edit agenda" }).click();
			const theirs = other.getByRole("dialog", { name: "Edit agenda" });
			await (await firstTitle(theirs)).fill(`Welcome from the other tab ${name} ${RUN}`);
			await theirs.getByRole("button", { name: "Save agenda" }).click();
			await saved(other, (p) =>
				p.getByRole("region", { name: "Agenda" }).getByText(`Welcome from the other tab ${name} ${RUN}`),
			);

			await mine.fill(`Welcome from this tab ${name} ${RUN}`);
			await editor.getByRole("button", { name: "Save agenda" }).click();
			// Refused as out of date: the editor opens again on the agenda as it is now, as its words say.
			const reopened = page.getByRole("dialog", { name: "Edit agenda" });
			await reopened.getByText(CONFLICT).waitFor();
			await page.waitForFunction(
				(want) => document.querySelector('[aria-label="Section 1 title"]')?.value === want,
				`Welcome from the other tab ${name} ${RUN}`,
			);
			// The person reads the latest agenda before editing again: the reload has settled.
			await page.waitForLoadState("networkidle");
			await reopened.getByLabel("Section 1 title").fill(`Welcome from this tab ${name} ${RUN}`);
			const retried = answerTo(page, `Welcome from this tab ${name} ${RUN}`);
			await reopened.getByRole("button", { name: "Save agenda" }).click();
			assert.equal((await retried).status(), 200);
			await reopened.waitFor({ state: "detached" });
			const agenda = page.getByRole("region", { name: "Agenda" });
			await agenda.getByText(`Welcome from this tab ${name} ${RUN}`).waitFor();
			// The save's answer has arrived before the page reloads: a reload would cut a request still on its way.
			await page.waitForLoadState("networkidle");
			await page.reload();
			await hydrated(page);
			await page.getByRole("region", { name: "Agenda" }).getByText(`Welcome from this tab ${name} ${RUN}`).waitFor();
		});
	});

	test(`BUG-T155 messages/com-18 (${name}): an Edit meeting save that loses to another tab opens on the latest meeting, and the retry saves`, async () => {
		const path = `/meetings/${revisions().plan}`;
		await signedIn(async (page, context) => {
			await open(page, path);
			await page.getByRole("button", { name: "Edit", exact: true }).click();
			const dialog = page.getByRole("dialog", { name: "Edit meeting" });
			await dialog.getByLabel("Title").waitFor();

			const other = await otherTab(context, path);
			await other.getByRole("button", { name: "Edit", exact: true }).click();
			const theirs = other.getByRole("dialog", { name: "Edit meeting" });
			await theirs.getByLabel("Title").fill(`Other tab title ${name} ${RUN}`);
			await theirs.getByRole("button", { name: "Save changes" }).click();
			await saved(other, (p) => p.getByRole("heading", { level: 1, name: `Other tab title ${name} ${RUN}` }));

			await dialog.getByLabel("Title").fill(`This tab title ${name} ${RUN}`);
			await dialog.getByRole("button", { name: "Save changes" }).click();
			// Refused as out of date: the page reads the meeting again and the dialog opens on it, as the notice says.
			await page.getByRole("dialog", { name: "Edit meeting" }).getByText(CONFLICT).waitFor();
			await page.waitForLoadState("networkidle");
			const reopened = page.getByRole("dialog", { name: "Edit meeting" });
			assert.equal(await reopened.getByLabel("Title").inputValue(), `Other tab title ${name} ${RUN}`);
			await reopened.getByLabel("Title").fill(`This tab title ${name} ${RUN}`);
			const retried = answerTo(page, `This tab title ${name} ${RUN}`);
			await reopened.getByRole("button", { name: "Save changes" }).click();
			assert.equal((await retried).status(), 200);
			await page.getByRole("heading", { level: 1, name: `This tab title ${name} ${RUN}` }).waitFor();
			// The save's answer has arrived before the page reloads: a reload would cut a request still on its way.
			await page.waitForLoadState("networkidle");
			await page.reload();
			await hydrated(page);
			await page.getByRole("heading", { level: 1, name: `This tab title ${name} ${RUN}` }).waitFor();
		});
	});

	test(`BUG-T155 messages/com-18 (${name}): a place save that loses to another tab shows the latest place, and the retry saves`, async () => {
		const venue = revisions().venue;
		const editPlace = async (page) => {
			await open(page, "/meetings");
			await page.getByRole("button", { name: "Places" }).click();
			await page.getByText(venue, { exact: true }).click();
			await page.getByRole("button", { name: "Change details" }).click();
			return page.getByRole("dialog", { name: "Change a place" });
		};
		await signedIn(async (page, context) => {
			const sheet = await editPlace(page);
			await sheet.getByLabel("Notes").waitFor();

			const other = await context.newPage();
			const theirs = await editPlace(other);
			await theirs.getByLabel("Notes").fill(`Other tab notes ${name} ${RUN}`);
			await theirs.getByRole("button", { name: "Save changes" }).click();
			await other.getByRole("button", { name: "Change details" }).waitFor();
			await other.getByText(`Other tab notes ${name} ${RUN}`).waitFor();
			await idle(other);
			await other.close();

			await sheet.getByLabel("Notes").fill(`This tab notes ${name} ${RUN}`);
			await sheet.getByRole("button", { name: "Save changes" }).click();
			// Refused as out of date: the form shows the place as it is now, as the notice says.
			await sheet.getByText(CONFLICT).waitFor();
			await page.waitForFunction(
				(want) => [...document.querySelectorAll("textarea, input")].some((e) => e.value === want),
				`Other tab notes ${name} ${RUN}`,
			);
			assert.equal(await sheet.getByLabel("Notes").inputValue(), `Other tab notes ${name} ${RUN}`);
			await sheet.getByLabel("Notes").fill(`This tab notes ${name} ${RUN}`);
			await sheet.getByRole("button", { name: "Save changes" }).click();
			// Saved: the sheet shows the place again, with these notes.
			await page.getByRole("button", { name: "Change details" }).waitFor();
			await page.getByText(`This tab notes ${name} ${RUN}`).waitFor();
			assert.equal(await page.getByText(CONFLICT).count(), 0);
		});
	});

	test(`BUG-T155 messages/com-15 (${name}): a link to a cancelled meeting shows a closed page with no answer buttons`, async () => {
		const { token } = revisions().closed;
		for (const width of [390, 1440])
			await withPage(
				engine,
				async (page) => {
					await open(page, `/rsvp/${token}`);
					await page.getByRole("heading", { level: 2, name: "This meeting is closed" }).waitFor();
					assert.equal(await page.getByRole("button").count(), 0, "no answer buttons");
					assert.equal(await page.getByText("will you come?").count(), 0);
					if (process.env.SHOTS) {
						mkdirSync(process.env.SHOTS, { recursive: true });
						await page.screenshot({
							path: join(process.env.SHOTS, `rsvp-closed-${name}-${width}.png`),
							fullPage: true,
						});
					}
				},
				{ width, height: 900 },
			);
	});
}
