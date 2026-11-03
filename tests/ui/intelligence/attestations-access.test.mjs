// Who may open /intelligence/attestations (WP-039, Nora's QA of qa-main-1528). A Member and a signed-in account without
// a church-plant seat get the lock page that /intelligence shows them, inside the app frame, never the bare Next 404.
// Owners and Admins keep the Attestations screen; a signed-out visitor still goes to sign in. Real producer state on a
// seeded preview: set UI_BASE_URL, then seed Attestations (tests/ui/intelligence/seed.mts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const PATH = "/intelligence/attestations";
// Seeded candidates and the first signal group: attestation data a locked page must never show.
const DATA = ["Alex Rivera", "Sam Ortiz", "Record a candidate", "Leadership candidates"];

async function open(page, context, cookie, path = PATH) {
	if (cookie) await signIn(context, cookie);
	const response = await page.goto(`${BASE}${path}`);
	await hydrated(page);
	return response;
}

/** The main region as tags and classes only, text left out: two pages with the same layout give the same string. */
const shape = (page) =>
	page.locator("main").evaluate((root) => {
		const walk = (el) =>
			`<${el.tagName.toLowerCase()} ${el.getAttribute("class") ?? ""} ${el.getAttribute("data-tone") ?? ""}>${[
				...el.children,
			]
				.map(walk)
				.join("")}</>`;
		return walk(root);
	});

async function assertFramedNotFoundFree(page, response) {
	assert.equal(response.status(), 200);
	assert.ok(await page.getByRole("navigation", { name: "Main" }).isVisible(), "the app menu is visible");
	const text = await page.locator("body").innerText();
	assert.doesNotMatch(text, /This page could not be found/);
}

for (const [name, engine] of ENGINES) {
	test(`AC:WP-039-1 (${name}): a Member gets an HTTP 200 page inside the app frame with the menu, not the Next 404`, async () => {
		await withPage(engine, async (page, context) => {
			const response = await open(page, context, fixture("intelligence").member.cookie);
			await assertFramedNotFoundFree(page, response);
			assert.equal(new URL(page.url()).pathname, PATH);
		});
	});

	test(`AC:WP-039-2 (${name}): the Member page has the Plant Intelligence header and one lock panel laid out as on /intelligence`, async () => {
		await withPage(engine, async (page, context) => {
			await open(page, context, fixture("intelligence").member.cookie);
			assert.deepEqual(await page.getByRole("heading", { level: 1 }).allInnerTexts(), ["Plant Intelligence"]);
			const panels = page.locator("main [data-tone]");
			assert.equal(await panels.count(), 1);
			assert.equal(await panels.getAttribute("data-tone"), "lock");
			assert.ok(await panels.locator("[aria-hidden=true] svg").isVisible(), "the lock icon shows");
			assert.deepEqual(await panels.getByRole("heading", { level: 2 }).allInnerTexts(), [
				"Attestations are for Owners and Admins",
			]);
			const body = await panels.locator("p").innerText();
			assert.match(body, /Member seat does not include the church.s attestations/);
			assert.match(body, /Ask an Owner or Admin/);
			const locked = await shape(page);

			await page.goto(`${BASE}/intelligence`);
			await hydrated(page);
			await page.getByRole("heading", { name: "The journey is for Owners and Admins", level: 2 }).waitFor();
			assert.equal(locked, await shape(page), "the same header, card and lock panel as /intelligence");
		});
	});

	test(`AC:WP-039-3 (${name}): the Member page shows no attestation data, tab or record button`, async () => {
		await withPage(engine, async (page, context) => {
			const response = await open(page, context, fixture("intelligence").member.cookie);
			// The server answer itself (HTML and React payload) carries no attestation data, not only the painted page.
			const html = await response.text();
			const text = await page.locator("main").innerText();
			for (const word of DATA) {
				assert.ok(!text.includes(word), `the page shows "${word}"`);
				assert.ok(!html.includes(word), `the server answer carries "${word}"`);
			}
			assert.equal(await page.getByRole("navigation", { name: "Plant Intelligence views" }).count(), 0);
			assert.equal(await page.getByRole("button", { name: "Record a candidate" }).count(), 0);
		});
	});

	test(`AC:WP-039-4 (${name}): an account with no church-plant seat gets the frame and the lock page /intelligence shows it`, async () => {
		await withPage(engine, async (page, context) => {
			const response = await open(page, context, fixture("intelligence").organization.cookie);
			await assertFramedNotFoundFree(page, response);
			const panel = page.locator("main [data-tone=lock]");
			const here = {
				header: await page.getByRole("heading", { level: 1 }).allInnerTexts(),
				panel: await panel.innerText(),
				shape: await shape(page),
			};
			assert.deepEqual(here.header, ["Plant Intelligence"]);
			assert.match(here.panel, /Plant Intelligence belongs to a church plant/);

			await page.goto(`${BASE}/intelligence`);
			await hydrated(page);
			assert.deepEqual(
				{
					header: await page.getByRole("heading", { level: 1 }).allInnerTexts(),
					panel: await panel.innerText(),
					shape: await shape(page),
				},
				here,
			);
		});
	});

	test(`AC:WP-039-5 (${name}): an Owner and an Admin still see the Attestations screen with its data`, async () => {
		for (const role of ["owner", "admin"]) {
			await withPage(engine, async (page, context) => {
				const response = await open(page, context, fixture("intelligence")[role].cookie);
				assert.equal(response.status(), 200, role);
				await page.getByRole("navigation", { name: "Plant Intelligence views" }).waitFor();
				assert.equal(
					await page.getByRole("link", { name: /Attestations/ }).getAttribute("aria-current"),
					"page",
					role,
				);
				assert.ok(await page.getByRole("button", { name: "Record a candidate" }).isVisible(), role);
				assert.ok(await page.getByRole("button", { name: "Update: Alex Rivera" }).isVisible(), role);
				assert.equal(await page.locator("main [data-tone=lock]").count(), 0, role);
			});
		}
	});

	test(`AC:WP-039-6 (${name}): a signed-out visitor is sent to sign in with the page as returnTo`, async () => {
		await withPage(engine, async (page) => {
			await page.goto(`${BASE}${PATH}`);
			const url = new URL(page.url());
			assert.equal(`${url.pathname}${url.search}`, "/signin?returnTo=%2Fintelligence%2Fattestations");
		});
	});
}
