// The meeting detail page (WP-020/ui, S2 corrections 6 and 7): what the organizer does next, the lifecycle stepper, the
// tabs in the address and the Agenda and Notes column that no tab switch touches. Seed with tests/ui/people/seed.mts,
// then tests/ui/meetings/seed.mts; set UI_BASE_URL. Both browser engines run. The pure next-step table and stepper
// states are tested in tests/integration/meetings/next-step.test.mts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const INVITES = (id) => `/communication?meeting=${id}&template=invitation&recipients=guests`;
const top = async (locator) => (await locator.boundingBox()).y;
/** A tab's name without its count chip. */
const tabName = (text) => text.replace(/\s+/g, " ").trim().replace(/ \d+$/, "");
const selectedTab = async (page) => tabName(await page.getByRole("tab", { selected: true }).first().innerText());
const tabNames = async (page) => (await page.getByRole("tab").allInnerTexts()).map(tabName);

async function openMeeting(page, id, query = "") {
	await page.goto(`${BASE}/meetings/${id}${query}`);
	await hydrated(page);
	await page.getByRole("heading", { level: 1 }).waitFor();
}

for (const [name, engine] of ENGINES) {
	test(`AC:TARGET-MTG-001 (${name}): layout at 1440, the next step, Send invites and the tabs in the address`, async () => {
		const { meetingId } = fixture("meetings");
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await openMeeting(page, meetingId);
			assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);

			// Top to bottom: header, stepper, then the tabs with Agenda and Notes beside them.
			const steps = page.getByRole("list", { name: "Meeting steps" });
			const tabs = page.getByRole("tablist");
			const aside = page.getByRole("complementary", { name: "Agenda and notes" });
			assert.ok((await top(page.getByRole("heading", { level: 1 }))) < (await top(steps)));
			assert.ok((await top(steps)) < (await top(tabs)));
			assert.equal(Math.round((await aside.boundingBox()).width), 320);
			assert.ok((await aside.boundingBox()).x > (await tabs.boundingBox()).x + (await tabs.boundingBox()).width - 1);
			// At 1280 px the page keeps two columns, with the 320 px reference column beside the tabs.
			await page.setViewportSize({ width: 1280, height: 800 });
			const narrow = await aside.boundingBox();
			assert.equal(Math.round(narrow.width), 320);
			assert.ok(narrow.x > (await tabs.boundingBox()).x + (await tabs.boundingBox()).width - 1);
			await page.setViewportSize({ width: 1440, height: 900 });

			assert.deepEqual(await tabNames(page), ["Guests", "Kit", "Results"]);
			assert.match(await steps.getByRole("listitem").nth(0).innerText(), /Invite[\s\S]*\d+ invited/);
			assert.equal(await steps.locator('[aria-current="step"]').count(), 1);
			assert.equal(await steps.getByRole("button").count(), 0, "the stepper has no controls");
			assert.equal(await steps.getByRole("link").count(), 0);

			// Planning with guests: Send invites is the one primary, a link to Messages with the meeting carried.
			const invites = page.getByRole("link", { name: "Send invites" });
			assert.equal(await invites.count(), 1);
			assert.equal(await invites.getAttribute("href"), INVITES(meetingId));
			assert.equal(await page.getByRole("link", { name: "Start check-in" }).count(), 1);
			assert.equal(await selectedTab(page), "Guests");

			// A tab change is local: the address changes, nothing is requested, and the Agenda column stays the same node.
			await aside.evaluate((el) => (el.dataset.keep = "same"));
			await page.getByRole("radio", { name: /^Pending/ }).click();
			const requests = [];
			page.on("request", (r) => r.resourceType() !== "image" && requests.push(r.url()));
			await page.getByRole("tab", { name: "Results" }).click();
			assert.equal(new URL(page.url()).searchParams.get("tab"), "results");
			await page.getByRole("tab", { name: "Kit" }).click();
			assert.equal(new URL(page.url()).searchParams.get("tab"), "kit");
			await page.getByRole("tab", { name: /^Guests/ }).click();
			assert.equal(await aside.getAttribute("data-keep"), "same");
			assert.deepEqual(requests, [], "a tab switch asks the server for nothing");
			// The guest filter survives the round trip.
			assert.equal(await page.getByRole("radio", { name: /^Pending/ }).getAttribute("aria-checked"), "true");

			// The address picks the tab; a value this meeting does not have falls back to the default.
			await openMeeting(page, meetingId, "?tab=results");
			assert.equal(await selectedTab(page), "Results");
			await openMeeting(page, meetingId, "?tab=kit");
			assert.equal(await selectedTab(page), "Kit");
			await openMeeting(page, meetingId, "?tab=agenda");
			assert.equal(await selectedTab(page), "Guests");

			// A meeting that is not a Vision meeting has no Kit.
			const { orientationId } = fixture("meetings");
			await openMeeting(page, orientationId, "?tab=kit");
			assert.deepEqual(await tabNames(page), ["Guests", "Results"]);
			assert.equal(await selectedTab(page), "Guests");
			assert.equal(await page.getByRole("link", { name: "Send invites" }).count(), 1);
		});
	});

	test(`AC:TARGET-MTG-001 (${name}): at 390 the page is one column, in order, with no sideways scroll`, async () => {
		const { meetingId } = fixture("meetings");
		await withPage(
			engine,
			async (page, context) => {
				await signIn(context, fixture("people").owner.cookie);
				await openMeeting(page, meetingId);
				const y = [
					await top(page.getByRole("link", { name: "Send invites" })),
					await top(page.getByRole("list", { name: "Meeting steps" })),
					await top(page.getByRole("tablist")),
					await top(page.getByRole("heading", { name: "Agenda", exact: true })),
					await top(page.getByRole("heading", { name: "Notes", exact: true })),
				];
				assert.deepEqual(
					y,
					[...y].sort((a, b) => a - b),
					"primary action, stepper, tabs, Agenda, Notes",
				);
				assert.equal(
					await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
					true,
					"nothing scrolls sideways",
				);
				// Three steps do not fit in 390 px: the stepper scrolls and the keyboard can reach it.
				const steps = page.getByRole("list", { name: "Meeting steps" });
				assert.equal(await steps.getAttribute("tabindex"), "0");
			},
			{ width: 390, height: 844 },
		);
	});

	test(`AC:TARGET-MTG-001 (${name}): a viewer without write access sees no write action`, async () => {
		const { meetingId } = fixture("meetings");
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").member.cookie);
			await openMeeting(page, meetingId);
			await page.getByRole("tab", { name: /^Guests/ }).waitFor();
			assert.equal(await page.getByRole("link", { name: "Send invites" }).count(), 0);
			assert.equal(await page.getByRole("button", { name: "Add guest" }).count(), 0);
			assert.equal(await page.getByRole("button", { name: /^Status/ }).count(), 0);
		});
	});

	test(`AC:TARGET-MTG-001 (${name}): each next step does what it says, from Add guest to Record evaluation`, async () => {
		const { flow } = fixture("meetings");
		const id = flow[name];
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await openMeeting(page, id);

			// No guests: Add guest is the primary. It opens the form and focus lands in it.
			assert.equal(await page.getByRole("link", { name: "Send invites" }).count(), 0);
			await page.getByRole("button", { name: "Add guest" }).first().click();
			const form = page.getByRole("dialog", { name: "Add guest" });
			await form.waitFor();
			await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]') !== null);
			await form.getByRole("radio", { name: "Someone new" }).click();
			await form.getByLabel("Name").fill(`Flow ${name}`);
			await form.getByRole("button", { name: "Add guest" }).click();
			await page.getByRole("row", { name: new RegExp(`Flow ${name}`) }).waitFor();

			// Planning with a guest: the primary is Send invites, the link of the contract.
			assert.equal(await page.getByRole("link", { name: "Send invites" }).getAttribute("href"), INVITES(id));

			// In progress: Start check-in is the primary, Finalize attendance a secondary button, and Send invites moves
			// into the guest list's toolbar: one link in all.
			await page.getByRole("button", { name: /^Status/ }).click();
			await page.getByRole("menuitem", { name: "Start the meeting" }).click();
			await page.getByRole("link", { name: "Start check-in" }).waitFor();
			assert.equal(await page.getByRole("button", { name: "Finalize attendance" }).count(), 1);
			assert.equal(await page.getByRole("link", { name: "Send invites" }).count(), 1);
			assert.equal(await page.getByRole("link", { name: "Send invites" }).getAttribute("href"), INVITES(id));
			assert.equal(await page.getByRole("tabpanel").getByRole("link", { name: "Send invites" }).count(), 1);

			await page
				.getByRole("row", { name: new RegExp(`Flow ${name}`) })
				.getByRole("button", { name: /^Actions for/ })
				.click();
			await page.getByRole("menuitem", { name: "Mark as attended" }).click();
			await page
				.getByRole("row", { name: new RegExp(`Flow ${name}`) })
				.getByText("Attended")
				.first()
				.waitFor();
			await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
			await page.getByRole("button", { name: "Finalize attendance" }).click();
			const review = page.getByRole("dialog", { name: "Finalize attendance" });
			await review.getByRole("button", { name: "Finalize", exact: true }).click();

			// Final with a card still to record: the primary opens the Guests tab and focuses that guest's actions.
			await page.getByRole("button", { name: "Record response cards" }).waitFor();
			// A filter that hides the attended guest (their RSVP is pending) does not stop the focus move.
			await page.getByRole("tab", { name: /^Guests/ }).click();
			await page.getByRole("radio", { name: /^Yes/ }).click();
			await page.getByRole("tab", { name: "Results" }).click();
			await page.getByRole("button", { name: "Record response cards" }).click();
			assert.equal(new URL(page.url()).searchParams.get("tab"), "guests");
			await page.waitForFunction(
				(label) => document.activeElement?.getAttribute("aria-label") === label,
				`Actions for Flow ${name}`,
			);

			// With the card in, Record evaluation opens the Results tab and the evaluation dialog.
			await page.keyboard.press("Enter");
			await page.getByRole("menuitem", { name: "Record response card" }).click();
			const card = page.getByRole("dialog");
			await card.getByRole("radio").first().click();
			await card.getByRole("button", { name: /^Save/ }).click();
			await page.getByRole("button", { name: "Record evaluation" }).first().click();
			await page.getByRole("dialog", { name: "Evaluate the meeting" }).waitFor();
			assert.equal(new URL(page.url()).searchParams.get("tab"), "results");
		});
	});
}
