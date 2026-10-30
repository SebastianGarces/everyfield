// The meeting detail page (WP-020/ui, S2 corrections 6 and 7): what the organizer does next, the RSVP summary, the
// tabs in the address and the Agenda and Notes column that no tab switch touches. Seed with tests/ui/people/seed.mts,
// then tests/ui/meetings/seed.mts; set UI_BASE_URL. Both browser engines run. The pure next-step table
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

			// Top to bottom: header, then the tabs with Agenda and Notes beside them.
			const tabs = page.getByRole("tablist");
			const aside = page.getByRole("complementary", { name: "Agenda and notes" });
			assert.ok((await top(page.getByRole("heading", { level: 1 }))) < (await top(tabs)));
			assert.equal(await page.getByRole("list", { name: "Meeting steps" }).count(), 0, "no phase stepper");
			assert.equal(Math.round((await aside.boundingBox()).width), 320);
			assert.ok((await aside.boundingBox()).x > (await tabs.boundingBox()).x + (await tabs.boundingBox()).width - 1);
			// At 1280 px the page keeps two columns, with the 320 px reference column beside the tabs.
			await page.setViewportSize({ width: 1280, height: 800 });
			const narrow = await aside.boundingBox();
			assert.equal(Math.round(narrow.width), 320);
			assert.ok(narrow.x > (await tabs.boundingBox()).x + (await tabs.boundingBox()).width - 1);
			await page.setViewportSize({ width: 1440, height: 900 });

			assert.deepEqual(await tabNames(page), ["Guests", "Kit", "Results"]);
			// The RSVP summary sits above the guest list: the yes number, the bar's legend and the guest list after it.
			const rsvps = page.getByRole("region", { name: "RSVPs" });
			assert.equal(await rsvps.getByText("said yes").count(), 1);
			for (const word of ["Yes", "No", "Pending"])
				assert.equal(await rsvps.getByText(word, { exact: true }).count(), 1);
			assert.ok((await top(rsvps)) < (await top(page.getByRole("region", { name: "Guest list" }))));

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
			page.on("request", (r) => !["image", "font"].includes(r.resourceType()) && requests.push(r.url()));
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

	test(`AC:TARGET-MTG-001 (${name}): the page opens on Guests until the meeting is completed, then on Results, and check-in shows without a status change`, async () => {
		const { state } = fixture("meetings");
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await openMeeting(page, state[name].ready);
			assert.equal(await selectedTab(page), "Guests");
			assert.equal(await page.getByRole("list", { name: "Meeting steps" }).count(), 0);
			// The viewer is a guest: the invitation shows until they answer, then shrinks to one line with Change.
			await page.getByRole("heading", { name: /^You are invited/ }).waitFor();
			await page.getByRole("button", { name: "Yes, I'll come" }).click();
			await page.getByText("You're coming.").waitFor();
			assert.equal(await page.getByRole("heading", { name: /^You are invited/ }).count(), 0);
			await page.getByRole("button", { name: "Change" }).click();
			await page.getByRole("heading", { name: /^You are invited/ }).waitFor();
			await page.getByRole("button", { name: "Can't make it" }).click();
			await page.getByText("You can't make it.").waitFor();
			// Marking the first guest attended on a ready meeting shows that check-in has started; the status stays Ready.
			assert.equal(await page.getByText("Check-in started", { exact: false }).count(), 0);
			await page
				.getByRole("button", { name: /^Actions for/ })
				.first()
				.click();
			await page.getByRole("menuitem", { name: "Mark as attended" }).click();
			await page.getByText("Check-in started · 1 attended").waitFor();
			assert.equal(
				await page.getByRole("region", { name: "RSVPs" }).getByText("1 attended so far", { exact: false }).count(),
				1,
			);
			await openMeeting(page, state[name].completed);
			assert.equal(await selectedTab(page), "Results");
			// A completed meeting never asks the viewer to answer, answered or not.
			assert.equal(await page.getByRole("heading", { name: /^You are invited/ }).count(), 0);
			assert.equal(await page.getByRole("region", { name: "Your RSVP" }).count(), 0);
			await page.getByRole("link", { name: "Tasks" }).waitFor();
			// A tab in the address still wins.
			await openMeeting(page, state[name].completed, "?tab=guests");
			assert.equal(await selectedTab(page), "Guests");
		});
	});

	test(`AC:TARGET-MTG-013 (${name}): the Kit tab fills the page height and the checklist scrolls inside the card`, async () => {
		const { kit } = fixture("meetings");
		const noPageScroll = (page) =>
			page.evaluate(() => document.scrollingElement.scrollHeight === document.scrollingElement.clientHeight);
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			for (const [label, id] of [
				["with the kit", kit[name].open],
				["with the Cancelled card above", kit[name].cancelled],
			]) {
				for (const [width, height] of [
					[1440, 900],
					[1440, 1100],
					[1680, 1050],
				]) {
					await page.setViewportSize({ width, height });
					await openMeeting(page, id, "?tab=kit");
					const card = page.getByRole("region", { name: "Vision kit items" });
					await card.waitFor();
					await page.waitForFunction(() => document.querySelector("section[aria-labelledby=kit-title]") !== null);
					const section = page.locator("section[aria-labelledby=kit-title]");
					const box = await section.boundingBox();
					assert.equal(await noPageScroll(page), true, `${label} at ${width}x${height}: the page does not scroll`);
					// The card ends at the layout's bottom margin (24px) of the viewport.
					assert.ok(
						Math.abs(box.y + box.height - (height - 24)) <= 2,
						`${label} at ${width}x${height}: ${box.y + box.height}`,
					);
					assert.equal(await card.getAttribute("tabindex"), "0");
					assert.equal(
						await card.evaluate((el) => el.scrollHeight > el.clientHeight || el.clientHeight > 300),
						true,
						"the checklist is the card's scroll region",
					);
				}
			}
			// The checklist scrolls in the card when it is taller than the card.
			await page.setViewportSize({ width: 1440, height: 900 });
			await openMeeting(page, kit[name].open, "?tab=kit");
			const region = page.getByRole("region", { name: "Vision kit items" });
			await region.waitFor();
			assert.equal(await noPageScroll(page), true);
			assert.equal(await region.evaluate((el) => el.scrollHeight > el.clientHeight), true);
			// Guests and Results keep the normal page: no fixed height.
			await page.getByRole("tab", { name: /^Guests/ }).click();
			assert.equal(await page.locator("section[aria-labelledby=kit-title]").isHidden(), true);
		});
		// Below the two-column width the Kit tab is as before: the card keeps its 300px list and the page scrolls.
		await withPage(
			engine,
			async (page, context) => {
				await signIn(context, fixture("people").owner.cookie);
				await openMeeting(page, kit[name].open, "?tab=kit");
				const region = page.getByRole("region", { name: "Vision kit items" });
				await region.waitFor();
				assert.equal((await region.boundingBox()).height <= 300, true);
				assert.equal(await noPageScroll(page), false);
			},
			{ width: 390, height: 844 },
		);
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
					await top(page.getByRole("tablist")),
					await top(page.getByRole("heading", { name: "Agenda", exact: true })),
					await top(page.getByRole("heading", { name: "Notes", exact: true })),
				];
				assert.deepEqual(
					y,
					[...y].sort((a, b) => a - b),
					"primary action, tabs, Agenda, Notes",
				);
				assert.equal(
					await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
					true,
					"nothing scrolls sideways",
				);
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
			await form.getByRole("button", { name: "Add to list" }).click();
			await form.getByText("Chosen (1)").waitFor();
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
