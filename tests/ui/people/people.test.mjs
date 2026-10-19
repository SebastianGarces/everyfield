// People screens (WP-011/ui) against the real WP-011 producer on a seeded preview. Each row fails when its guard is
// removed. Set UI_BASE_URL to the task preview and seed it first with tests/ui/people/seed.mts (it writes the fixture
// this file reads from PEOPLE_UI_FIXTURE, default /tmp/everyfield-people-ui.json):
//   UI_BASE_URL=http://wp-011-ui-....localhost:1355 corepack pnpm test:ui
//   INV-session: signed out goes to sign-in and comes back to the same list.
//   INV-no-access: an account with no plant seat sees the lock state, never a list.
//   INV-no-leak: a missing or malformed person link reads "not here", the same for both.
//   INV-member-read: a Member sees people and history but no add, move, edit, note or retire control.
//   INV-one-save: a double press sends one write.
//   INV-request-key: a lost answer keeps the draft; the retry replays the same request, so one note is saved.
//   INV-cursor: a filter change drops the page cursor; an expired cursor shows the first page and says so.
//   INV-discard: closing Edit profile with changes asks before discarding them.
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
		const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
		if (who) {
			const [name, value] = seed()[who].cookie.split(/=(.*)/s);
			await context.addCookies([{ name, value, url: BASE, httpOnly: true }]);
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

	test(`INV-no-access (${name}): an account without a plant seat sees the lock state`, async () => {
		await withPage(engine, "seatless", async (page) => {
			await page.goto(`${BASE}/people`);
			await page.getByRole("heading", { name: "People is not part of your seat" }).waitFor();
			assert.equal(await page.getByRole("table").count(), 0);
			assert.equal(await page.getByRole("button", { name: "Add person" }).count(), 0);
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
		});
	});

	test(`AC:TARGET-PPL-001 INV-cursor (${name}): pages and filters share the address; old cursors fall back to page one`, async () => {
		await withPage(engine, "owner", async (page) => {
			await page.goto(`${BASE}/people?retired=include`);
			await page.getByRole("button", { name: "Next" }).click();
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
}
