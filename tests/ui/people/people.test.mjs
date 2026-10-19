// People screens (WP-011/ui) against the real WP-011 producer on a seeded preview. Each row fails when its guard is
// removed. Set UI_BASE_URL to the task preview and seed it first with tests/ui/people/seed.mts (it writes the fixture
// this file reads from PEOPLE_UI_FIXTURE, default /tmp/everyfield-people-ui.json):
//   UI_BASE_URL=http://wp-011-ui-....localhost:1355 corepack pnpm test:ui
//   INV-session: signed out goes to sign-in and comes back to the same list.
//   INV-no-access: an account with no seat, or a seat in an organization, sees the lock state, never a list.
//   INV-no-leak: a missing or malformed person link reads "not here", the same for both.
//   INV-member-read: a Member sees people and history but no add, move, edit, note or retire control.
//   INV-one-save: a double press sends one write.
//   INV-request-key: a lost answer keeps the draft; the retry replays the same request, so one note is saved.
//   INV-cursor: a filter change drops the page cursor; an expired cursor shows the first page and says so.
//   INV-discard: closing Edit profile with changes asks before discarding them.
//   INV-tags: repeated tag ids in the address filter for people with all of them; a chip removes one (D47).
//   INV-reorder-focus, INV-reorder-conflict: verifier findings on b4d2ec0 (focus kept, stale refusal kept).
//   BUG-church-date: adult or child has no date from the reader's clock; a church-future date says why it was refused.
//   BUG-hydration: WebKit and Node join date parts differently; dates are built from parts so hydration matches.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const FIXTURE = process.env.PEOPLE_UI_FIXTURE ?? "/tmp/everyfield-people-ui.json";
const seed = () => JSON.parse(readFileSync(FIXTURE, "utf8"));

/** Opens a page signed in as `who` (owner, member, seatless or null for signed out). */
async function withPage(engine, who, run, { width = 1440 } = {}) {
	assert.ok(BASE, "Set UI_BASE_URL to a running, seeded preview of this worktree.");
	const browser = await engine.launch();
	try {
		// Portless previews use a local certificate the test browsers do not know.
		const context = await browser.newContext({
			viewport: { width, height: 900 },
			reducedMotion: "reduce",
			ignoreHTTPSErrors: true,
		});
		if (who) {
			const [name, value] = seed()[who].cookie.split(/=(.*)/s);
			await context.addCookies([{ name, value, url: BASE, httpOnly: true, secure: BASE.startsWith("https:") }]);
		}
		const page = await context.newPage();
		await run(page, context);
	} finally {
		await browser.close();
	}
}

/** Server actions are POSTs with a Next-Action header. `handle` gets each one and decides what reaches the server. */
async function onActions(context, handle) {
	let n = 0;
	await context.route("**/*", async (route) => {
		const r = route.request();
		if (r.method() === "POST" && r.headers()["next-action"]) return handle(route, ++n);
		return route.fallback();
	});
}

const unique = (engine) => `Test ${engine} ${Date.now().toString(36)}`;
async function addPerson(page, name) {
	await page.goto(`${BASE}/people`);
	await page.getByRole("button", { name: "Add person" }).first().click();
	const dialog = page.getByRole("dialog", { name: "Add a person" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Add person" }).click();
	await page.getByRole("heading", { level: 1, name }).waitFor({ timeout: 30_000 });
	return page.url();
}
const activityTitles = (page) =>
	page.locator('ol[aria-label="Activity, oldest first"] > li').evaluateAll((rows) => rows.map((r) => r.innerText));

for (const [name, engine] of [
	["chromium", chromium],
	["webkit", webkit],
]) {
	test(`INV-session (${name}): signed out goes to sign-in with a return to the same list`, async () => {
		await withPage(engine, null, async (page) => {
			await page.goto(`${BASE}/people?stage=attendee`);
			await page.waitForURL(/\/signin/, { timeout: 30_000 });
			assert.equal(new URL(page.url()).searchParams.get("returnTo"), "/people?stage=attendee");
		});
	});

	test(`INV-no-access (${name}): no seat and an organization seat both see the lock state`, async () => {
		for (const who of ["seatless", "organization"])
			await withPage(engine, who, async (page) => {
				await page.goto(`${BASE}/people`);
				await page.getByRole("heading", { name: "People is not part of your seat" }).waitFor();
				assert.equal(await page.getByRole("table").count(), 0, who);
				assert.equal(await page.getByRole("button", { name: "Add person" }).count(), 0, who);
			});
	});

	test(`BUG-hydration (${name}): a person page with dated activity hydrates without a page error`, async () => {
		await withPage(engine, "owner", async (page) => {
			const errors = [];
			page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
			await page.goto(`${BASE}/people/${seed().people["Maria Santos"]}`, { waitUntil: "networkidle" });
			await page.getByRole("heading", { name: "Activity" }).waitFor();
			await page.waitForTimeout(1000);
			assert.deepEqual(errors, []);
		});
	});

	test(`INV-no-leak (${name}): a missing and a malformed person link read the same`, async () => {
		await withPage(engine, "owner", async (page) => {
			for (const id of ["0b0f6a7e-1d6f-4f7e-8c35-5b8f5c0f4d21", "not-a-person"]) {
				await page.goto(`${BASE}/people/${id}`);
				await page.getByRole("heading", { name: "This person is not here" }).waitFor();
			}
		});
	});

	test(`AC:TARGET-PPL-001 AC:TARGET-PPL-007 INV-member-read (${name}): a Member reads people without change controls`, async () => {
		await withPage(engine, "member", async (page) => {
			await page.goto(`${BASE}/people`);
			await page.getByRole("link", { name: "Maria Santos" }).waitFor();
			assert.equal(await page.getByRole("button", { name: "Add person" }).count(), 0);
			await page.goto(`${BASE}/people?view=pipeline`);
			await page.getByRole("region", { name: "Pipeline" }).waitFor();
			assert.equal(await page.getByRole("button", { name: /^Move / }).count(), 0);
			assert.equal(await page.locator('[draggable="true"]').count(), 0);
			await page.goto(`${BASE}/people/${seed().people["Maria Santos"]}`);
			await page.getByRole("heading", { name: "Activity" }).waitFor();
			assert.ok((await activityTitles(page)).some((t) => t.includes("Wants to lead worship")));
			for (const control of ["Change stage", "More actions", "Edit profile", "Save note", "Edit", "Delete"])
				assert.equal(await page.getByRole("button", { name: control, exact: true }).count(), 0, control);
		});
	});

	test(`AC:TARGET-PPL-002 AC:TARGET-PPL-008 INV-one-save (${name}): a double press on Save note saves one note`, async () => {
		await withPage(engine, "owner", async (page, context) => {
			await addPerson(page, unique(name));
			let writes = 0;
			await onActions(context, async (route) => {
				if (route.request().postData()?.includes("Double press")) {
					writes++;
					await new Promise((r) => setTimeout(r, 1200));
				}
				await route.continue();
			});
			await page.getByLabel(/^Add a note about/).fill("Double press note");
			const save = page.getByRole("button", { name: "Save note" });
			await save.click();
			await save.click({ force: true });
			await page
				.getByLabel(/^Add a note about/)
				.and(page.locator(":not([readonly])"))
				.waitFor({ timeout: 30_000 });
			await page.waitForFunction(
				() => document.body.innerText.includes("Double press note") && !document.querySelector('[aria-busy="true"]'),
			);
			assert.equal(writes, 1, "one write request");
			const notes = (await activityTitles(page)).filter((t) => t.includes("Double press note"));
			assert.equal(notes.length, 1);
		});
	});

	test(`AC:TARGET-PPL-008 INV-request-key (${name}): a lost answer keeps the note; the retry saves it once`, async () => {
		await withPage(engine, "owner", async (page, context) => {
			await addPerson(page, unique(name));
			const keys = [];
			await onActions(context, async (route) => {
				const body = route.request().postData() ?? "";
				if (!body.includes("Lost answer note")) return route.continue();
				keys.push(JSON.parse(body)[0]);
				// The first request reaches the server and commits; its answer is dropped on the way back.
				if (keys.length === 1) {
					await route.fetch();
					return route.abort();
				}
				return route.continue();
			});
			const composer = page.getByLabel(/^Add a note about/);
			await composer.fill("Lost answer note");
			await page.getByRole("button", { name: "Save note" }).click();
			await page.getByText("We did not hear back from the server").waitFor({ timeout: 30_000 });
			assert.equal(await composer.inputValue(), "Lost answer note", "the draft is kept");
			await page.getByRole("button", { name: "Save note" }).click();
			await page.waitForFunction(() => !document.body.innerText.includes("We did not hear back"), null, {
				timeout: 30_000,
			});
			await page.reload();
			await page.getByRole("heading", { name: "Activity" }).waitFor();
			assert.equal(keys.length, 2);
			assert.equal(keys[0], keys[1], "the retry sends the same request key");
			assert.equal((await activityTitles(page)).filter((t) => t.includes("Lost answer note")).length, 1);
		});
	});

	test(`AC:TARGET-PPL-006 (${name}): Change stage shows skipped stages, asks a reason and records the move`, async () => {
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			await page.getByRole("button", { name: "Change stage" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("combobox", { name: "New stage" }).click();
			await page.getByRole("option", { name: "Interviewed" }).click();
			await dialog.getByText("Skips 2 stages").waitFor();
			await dialog.getByRole("button", { name: "Move to interviewed" }).click();
			await dialog.getByText("Say why the stage changes.").waitFor();
			await dialog.getByLabel("Reason").fill("Interviewed after the vision meeting");
			await dialog.getByRole("button", { name: "Move to interviewed" }).click();
			await dialog.waitFor({ state: "detached", timeout: 30_000 });
			await page.waitForFunction(
				() => document.body.innerText.includes("Stage changed from prospect to interviewed"),
				null,
				{
					timeout: 30_000,
				},
			);
		});
	});

	test(`AC:TARGET-PPL-003 (${name}): retire with a reason, then restore; a merged person offers no restore`, async () => {
		await withPage(engine, "owner", async (page) => {
			const person = unique(name);
			await addPerson(page, person);
			await page.getByRole("button", { name: "More actions" }).click();
			await page.getByRole("menuitem", { name: "Retire person" }).click();
			const dialog = page.getByRole("dialog", { name: `Retire ${person}?` });
			await dialog.getByText("They have no open follow-up work.").waitFor();
			await dialog.getByLabel("Reason").fill("Moved away");
			await dialog.getByRole("button", { name: "Retire person" }).click();
			await page.getByRole("heading", { name: `${person} is retired` }).waitFor({ timeout: 30_000 });
			assert.equal(await page.getByRole("button", { name: "Change stage" }).count(), 0);
			await page.getByRole("button", { name: "Restore person" }).click();
			await page.getByRole("alertdialog").getByRole("button", { name: "Restore person" }).click();
			await page.getByRole("button", { name: "Change stage" }).waitFor({ timeout: 30_000 });
			const merged = Object.entries(seed().people).find(([n]) => n.startsWith("Guest 19"))[1];
			await page.goto(`${BASE}/people/${merged}`);
			await page.getByText("A merge is undone only with a reviewed Unmerge").waitFor();
			assert.equal(await page.getByRole("button", { name: "Restore person" }).count(), 0);
		});
	});

	test(`INV-discard (${name}): closing Edit profile with changes asks first; keeping edits keeps them`, async () => {
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			await page.getByRole("button", { name: "Edit profile" }).click();
			const dialog = page.getByRole("dialog", { name: "Edit profile" });
			await dialog.getByLabel("Phone").fill("512 555 0142");
			await page.keyboard.press("Escape");
			const confirm = page.getByRole("alertdialog", { name: "Discard your changes?" });
			await confirm.getByRole("button", { name: "Keep editing" }).click();
			assert.equal(await dialog.getByLabel("Phone").inputValue(), "512 555 0142");
			await dialog.getByRole("button", { name: "Save changes" }).click();
			await dialog.waitFor({ state: "detached", timeout: 30_000 });
			await page.getByRole("link", { name: "512 555 0142" }).waitFor();
			// Activity shows the saved change without a reload.
			await page.waitForFunction(
				() =>
					[...document.querySelectorAll('ol[aria-label="Activity, oldest first"] > li')].some((l) =>
						l.innerText.startsWith("Details changed"),
					),
				null,
				{ timeout: 30_000 },
			);
		});
	});

	test(`AC:TARGET-PPL-001 INV-cursor (${name}): pages and filters share the address; old cursors fall back to page one`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?retired=include`);
			await page.getByRole("button", { name: "Next", exact: true }).click();
			// Client navigation changes the address without a page load, so wait on the address itself.
			await page.waitForFunction(() => new URLSearchParams(location.search).has("after"), null, { timeout: 30_000 });
			await page.getByText(/^Showing 25/).waitFor();
			await page.getByRole("button", { name: /^Source/ }).click();
			await page.getByRole("option", { name: "Other" }).click();
			await page.waitForFunction(() => new URLSearchParams(location.search).get("source") === "other", null, {
				timeout: 30_000,
			});
			const url = new URL(page.url());
			assert.equal(url.searchParams.get("after"), null, "a filter change goes back to page one");
			assert.equal(url.searchParams.get("retired"), "include", "the sibling filter stays");
			await page.goto(`${BASE}/people?retired=include&after=expired.cursor`);
			await page.getByText("That page link has expired, so this is the first page.").waitFor();
			await page.getByText(/^Showing 1–/).waitFor();
		});
	});

	test(`AC:TARGET-PPL-007 INV-reorder (${name}): Move up saves the column order under its revision`, async () => {
		await withPage(engine, "owner", async (page) => {
			const column = () => page.getByRole("list", { name: "Following up people" });
			const names = () =>
				column()
					.getByRole("article")
					.evaluateAll((a) => a.map((x) => x.getAttribute("aria-label")));
			await page.goto(`${BASE}/people?view=pipeline`);
			await column().waitFor();
			const before = await names();
			assert.ok(before.length >= 2, "two people in Following up");
			await page.getByRole("button", { name: `Move ${before[1]}` }).click();
			await page.getByRole("menuitem", { name: "Move up" }).click();
			await page.getByText(`${before[1]} moved up.`).waitFor({ state: "attached", timeout: 30_000 });
			await page.reload();
			await column().waitFor();
			assert.deepEqual((await names()).slice(0, 2), [before[1], before[0]], "the server kept the new order");
		});
	});

	test(`AC:TARGET-PPL-001 INV-tags (${name}): a tag filter in the address shows a chip that removes it`, async () => {
		await withPage(engine, "owner", async (page) => {
			const tag = "0b0f6a7e-1d6f-4f7e-8c35-5b8f5c0f4d21";
			await page.goto(`${BASE}/people?retired=include&tag=${tag}`);
			await page.getByText("No one matches").first().waitFor();
			await page.getByRole("button", { name: "Remove tag filter" }).click();
			await page.waitForFunction(() => !new URLSearchParams(location.search).has("tag"), null, { timeout: 30_000 });
			assert.equal(new URL(page.url()).searchParams.get("retired"), "include", "the sibling filter stays");
			await page.getByRole("link", { name: "Maria Santos" }).waitFor({ timeout: 30_000 });
		});
	});

	test(`AC:TARGET-PPL-007 INV-reorder-focus (${name}): after keyboard moves in two columns, focus stays on the last moved card`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?view=pipeline`);
			/** Moves the second card of a column up with the keyboard; gives its name once the server order shows it first. */
			const moveSecondUp = async (label) => {
				const column = page.getByRole("list", { name: label });
				await column.waitFor();
				const revision = () =>
					page.evaluate(
						(l) =>
							document.querySelector(`[aria-label="${l}"]`)?.closest("[data-revision]")?.getAttribute("data-revision"),
						label,
					);
				const before = await revision();
				const second = (await column.getByRole("article").nth(1).getAttribute("aria-label")) ?? "";
				await page.getByRole("button", { name: `Move ${second}` }).focus();
				await page.keyboard.press("Enter");
				await page.getByRole("menuitem", { name: "Move up" }).waitFor();
				await page.keyboard.press("Home");
				await page.keyboard.press("Enter");
				await page.waitForFunction(
					([l, n]) => document.querySelector(`[aria-label="${l}"] article`)?.getAttribute("aria-label") === n,
					[label, second],
					{ timeout: 30_000 },
				);
				// Wait for the refresh: the column shows the server's new revision, so a remount would have happened.
				await page.waitForFunction(
					([l, r]) =>
						document.querySelector(`[aria-label="${l}"]`)?.closest("[data-revision]")?.getAttribute("data-revision") !==
						r,
					[label, before],
					{ timeout: 60_000 },
				);
				await page.waitForTimeout(500);
				return second;
			};
			const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
			const first = await moveSecondUp("Following up people");
			assert.equal(await focused(), `Move ${first}`);
			const core = await moveSecondUp("Core group people");
			assert.equal(await focused(), `Move ${core}`);
			const last = await moveSecondUp("Following up people");
			await page.waitForTimeout(1500);
			assert.equal(await focused(), `Move ${last}`, "an earlier column's request does not pull focus back");
		});
	});

	test(`AC:TARGET-PPL-007 INV-reorder-conflict (${name}): a stale page's Move up refuses and says why after the refresh`, async () => {
		await withPage(engine, "owner", async (a, context) => {
			const b = await context.newPage();
			const column = (p) => p.getByRole("list", { name: "Following up people" });
			for (const p of [a, b]) {
				await p.goto(`${BASE}/people?view=pipeline`);
				await column(p).waitFor();
			}
			const second = (await column(a).getByRole("article").nth(1).getAttribute("aria-label")) ?? "";
			await a.getByRole("button", { name: `Move ${second}` }).click();
			await a.getByRole("menuitem", { name: "Move up" }).click();
			await a.getByText(`${second} moved up.`).waitFor({ state: "attached", timeout: 30_000 });
			await b.getByRole("button", { name: `Move ${second}` }).click();
			await b.getByRole("menuitem", { name: "Move up" }).click();
			const message = b.getByText("The order changed somewhere else.", { exact: false });
			await message.waitFor({ timeout: 30_000 });
			// The refusal refreshes page B to the server's order; the message must survive that refresh.
			await b.waitForFunction(
				(n) => document.querySelector('[aria-label="Following up people"] article')?.getAttribute("aria-label") === n,
				second,
				{ timeout: 30_000 },
			);
			await b.waitForTimeout(1500);
			assert.equal(await message.count(), 1, "the refusal is still shown after the refresh");
		});
	});

	test(`AC:TARGET-PPL-007 INV-reorder-filtered (${name}): a filtered column offers no reorder and says to clear filters`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?view=pipeline&q=an`);
			await page.getByRole("list", { name: "Core group people" }).waitFor();
			await page.getByRole("button", { name: "Move Ana Lee" }).click();
			await page.getByText("Clear filters to reorder").waitFor();
			for (const item of ["Move up", "Move down"])
				assert.equal(await page.getByRole("menuitem", { name: item }).getAttribute("aria-disabled"), "true", item);
		});
	});

	test(`AC:TARGET-PPL-002 BUG-church-date (${name}): adult or child needs an explicit date; a church-future date is refused`, async () => {
		await withPage(engine, "owner", async (page) => {
			await addPerson(page, unique(name));
			await page.getByRole("button", { name: "More actions" }).click();
			await page.getByRole("menuitem", { name: "Record adult or child" }).click();
			const dialog = page.getByRole("dialog", { name: "Record adult or child" });
			const date = dialog.getByLabel("As of");
			// No default from the reader's clock: it can be the church's tomorrow (verifier finding on f0ea75d).
			assert.equal(await date.inputValue(), "");
			await dialog.getByLabel("Reason").fill("Said so at the vision meeting");
			await dialog.getByRole("button", { name: "Record" }).click();
			await dialog.getByText("Choose the date you learned this.").waitFor();
			// Three days ahead is in the future in every time zone.
			const ahead = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
			await date.fill(ahead);
			await dialog.getByRole("button", { name: "Record" }).click();
			await dialog.getByText("This date is after today at your church.").waitFor({ timeout: 30_000 });
			await date.fill("2026-01-15");
			await dialog.getByRole("button", { name: "Record" }).click();
			await dialog.waitFor({ state: "detached", timeout: 30_000 });
			await page.waitForFunction(() => document.body.innerText.includes("Adult or child recorded"), null, {
				timeout: 30_000,
			});
		});
	});
}
