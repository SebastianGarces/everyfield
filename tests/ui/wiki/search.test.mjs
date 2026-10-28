// Wiki search modal (WP-034/ui, S2 review tasks 26 and 27). Needs a People-seeded preview: set UI_BASE_URL and
// PEOPLE_UI_FIXTURE (tests/ui/people/seed.mts). Both browser engines run. Server actions are cut off in the browser
// where a test needs a thrown action; nothing else is mocked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage as onPreview } from "../setup.mjs";

const withPage = (engine, run) =>
	onPreview(engine, async (page, context) => {
		await signIn(context, fixture("people").owner.cookie);
		await page.goto(`${BASE}/wiki`);
		await hydrated(page);
		await run(page, context);
	});

const header = (page) => page.getByRole("searchbox", { name: "Search the wiki" });
const dialog = (page) => page.getByRole("dialog", { name: "Search the wiki" });

for (const [name, engine] of ENGINES) {
	test(`BUG-wiki-search-close: Esc and X close the search modal and it stays closed (${name})`, async () => {
		await withPage(engine, async (page) => {
			for (const close of [
				() => page.keyboard.press("Escape"),
				() => dialog(page).getByRole("button", { name: /close/i }).click(),
			]) {
				await header(page).click();
				await dialog(page).waitFor();
				assert.equal(await dialog(page).getByText("Type a word to search the wiki.").count(), 1);
				assert.equal(await dialog(page).getByText("Search could not be loaded").count(), 0);
				await close();
				await dialog(page).waitFor({ state: "detached" });
				await page.waitForTimeout(1000);
				assert.equal(await dialog(page).count(), 0);
				assert.equal(await header(page).evaluate((el) => el === document.activeElement), true);
			}
		});
	});

	test(`BUG-wiki-search-lost: a thrown search action shows the error and clears Searching (${name})`, async () => {
		await withPage(engine, async (page, context) => {
			await context.route("**/*", (route) => {
				const r = route.request();
				if (r.method() === "POST" && r.headers()["next-action"]) return route.abort();
				return route.fallback();
			});
			await header(page).click();
			await dialog(page).getByRole("searchbox", { name: "Search words" }).fill("financial");
			await dialog(page).getByText("Search could not be loaded").waitFor();
			assert.equal(await dialog(page).getByText("Searching.").count(), 0);
		});
	});
}

for (const [name, engine] of ENGINES) {
	test(`BUG-wiki-search-hits: typing a word lists highlighted hits, and a hit opens its article and closes the modal (${name})`, async () => {
		await withPage(engine, async (page) => {
			await header(page).click();
			await dialog(page).getByRole("searchbox", { name: "Search words" }).fill("financial");
			const hit = dialog(page).getByRole("link", { name: /Financial planning for a plant/ });
			await hit.waitFor();
			assert.ok((await dialog(page).locator("mark").count()) > 0);
			assert.equal(await dialog(page).getByText("Search could not be loaded").count(), 0);
			await hit.click();
			await page.waitForURL(/\/wiki\/.+/);
			await dialog(page).waitFor({ state: "detached" });
		});
	});
}
