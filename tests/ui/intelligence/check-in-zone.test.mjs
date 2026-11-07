// The check-in time zone step (T-66, Nora QA 2026-11-05 Ask E). An Admin with no personal time zone chooses one on
// /me/check-in and goes straight on to the four areas, without being sent to Settings. The picker starts empty
// (REQ-IDN-033), the preview names the week before the save, a lost preview says the zone was not saved and offers a
// retry, and a lost save reply is asked again with the same request key. Real producer state on a seeded preview: set
// UI_BASE_URL, then seed Intelligence (tests/ui/intelligence/seed.mts). The save runs once per seed, on the first
// engine: the seeded "newcomer" Admin has a zone after it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const PATH = "/me/check-in";
const AREAS = ["Spiritually", "Marriage and family", "Financially", "Pace"];

async function open(page, context, seat) {
	await signIn(context, fixture("intelligence")[seat].cookie);
	await page.goto(`${BASE}${PATH}`);
	await hydrated(page);
}

/** Makes the next server action POST fail as `how`: "lost" never reaches the server; "reply" is applied, its reply lost. */
async function failNextAction(page, how) {
	const matcher = (url) => url.pathname === PATH;
	await page.route(matcher, async (route) => {
		if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) return route.fallback();
		if (how === "reply") await route.fetch();
		await route.abort("failed");
		await page.unroute(matcher);
	});
}

const [firstName, firstEngine] = ENGINES[0] ?? [];

test(`T-66 (${firstName}): an Admin with no zone picks one on the check-in, sees the week first, then the four areas`, async () => {
	await withPage(firstEngine, async (page, context) => {
		await open(page, context, "newcomer");
		const picker = page.getByRole("combobox", { name: "Your time zone" });
		await picker.waitFor();
		// Criterion 2: nothing chosen, nothing to save.
		assert.equal((await picker.innerText()).trim(), "Choose a time zone");
		const use = page.getByRole("button", { name: /^Use .* time( zone)?$/ });
		assert.ok(await use.isDisabled(), "the confirm button waits for a zone");
		assert.ok(await page.getByRole("link", { name: "Open Settings instead" }).isVisible());
		for (const area of AREAS) assert.equal(await page.getByText(area, { exact: true }).count(), 0, area);

		// Criterion 6: a preview that never reaches the server says the zone was not saved and offers a retry.
		await failNextAction(page, "lost");
		await picker.click();
		await page.getByPlaceholder("Search time zones").fill("Tokyo");
		await page.getByRole("option", { name: /Tokyo/ }).first().click();
		const alert = page.getByRole("alert").filter({ hasText: "Your time zone was not saved" });
		await alert.waitFor();
		assert.ok(await use.isDisabled(), "no save without a preview");
		await alert.getByRole("button", { name: "Try again" }).click();

		// Criterion 3: the preview names the zone and the week the check-in opens on.
		const preview = page.locator("[data-zone-preview]");
		await preview.waitFor();
		const text = await preview.innerText();
		assert.match(text, /Tokyo/);
		const week = text.match(/week of (Monday, \w+ \d+)/)?.[1];
		assert.ok(week, `the preview names a week: ${text}`);
		const save = page.getByRole("button", { name: "Use Tokyo time" });
		assert.ok(await save.isEnabled());

		// Criteria 4 and 6: the save's reply is lost once; the same request key asks again and the form opens in place.
		await failNextAction(page, "reply");
		await save.click();
		await page.getByRole("heading", { name: "This week" }).waitFor({ timeout: 30_000 });
		for (const area of AREAS) assert.ok(await page.getByText(area, { exact: true }).first().isVisible(), area);
		assert.match(await page.locator("main").innerText(), new RegExp(`Week of ${week}\\.`));
		assert.equal(new URL(page.url()).pathname, PATH);
		assert.equal(await page.getByRole("combobox", { name: "Your time zone" }).count(), 0);

		// Criterion 5: Settings shows the saved zone as yours.
		await page.goto(`${BASE}/settings/account`);
		await hydrated(page);
		await page.locator("[data-personal-zone]").waitFor();
		assert.match(await page.locator("[data-personal-zone]").innerText(), /Tokyo/);

		// Criterion 7: with a zone, the check-in opens straight on the form.
		await page.goto(`${BASE}${PATH}`);
		await hydrated(page);
		await page.getByRole("heading", { name: "This week" }).waitFor();
		assert.equal(await page.getByRole("combobox", { name: "Your time zone" }).count(), 0);

		// Settings shares the same choice and save (usePersonalZoneChoice): the saved zone asks the server nothing, and a
		// new zone is previewed, saved and shown in the row.
		await page.goto(`${BASE}/settings/account`);
		await hydrated(page);
		const row = page.locator("[data-personal-zone]").locator("xpath=..");
		await row.getByRole("button", { name: "Change" }).click();
		const dialog = page.getByRole("dialog");
		const choose = async (city) => {
			await dialog.getByRole("combobox", { name: "Your time zone" }).click();
			await page.getByPlaceholder("Search time zones").fill(city);
			await page
				.getByRole("option", { name: new RegExp(city) })
				.first()
				.click();
		};
		await choose("Tokyo");
		await dialog.getByText("This is already your time zone.").waitFor();
		assert.ok(await dialog.getByRole("button", { name: /^Use .* time( zone)?$/ }).isDisabled());
		await choose("Lisbon");
		await dialog.getByText(/Your week will start on Monday at midnight in Lisbon/).waitFor();
		await dialog.getByRole("button", { name: "Use Lisbon time" }).click();
		await row
			.locator("[data-personal-zone]")
			.filter({ hasText: /Lisbon/ })
			.waitFor();
	});
});

for (const [name, engine] of ENGINES) {
	test(`T-66 (${name}): a Member keeps the blocked page and gets no zone picker`, async () => {
		await withPage(engine, async (page, context) => {
			await open(page, context, "member");
			await page.getByRole("heading", { name: "The weekly check-in is for Owners and Admins", level: 2 }).waitFor();
			assert.equal(await page.getByRole("combobox", { name: "Your time zone" }).count(), 0);
		});
	});
}
