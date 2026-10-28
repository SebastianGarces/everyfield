// Wiki article layout, Previous/Next and header (WP-034/ui, S2 review tasks 23 to 25). Needs a People-seeded preview:
// set UI_BASE_URL and PEOPLE_UI_FIXTURE (tests/ui/people/seed.mts). Both browser engines run. The seed writes one
// Frameworks group. The sidenav lists it by phase, then position: Setting up your website, Team handbook, Volunteer
// guide (phase 0, reading length), Financial planning for a plant, Choosing a meeting place (phase 1), Raising support
// (phase 2), Launch checklist 1 to 22 (phase 3). The reading and bookmark tests write the owner's own state, so run the
// suite once on a freshly seeded preview.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage as onPreview } from "../setup.mjs";

const withPage = (engine, path, run, size) =>
	onPreview(
		engine,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await page.goto(`${BASE}${path}`);
			await hydrated(page);
			await page.locator("h1").waitFor();
			await run(page, context);
		},
		size,
	);

/** The three scroll containers by name, read in the page. */
const tops = (page) =>
	page.evaluate(() => {
		const column = document.getElementById("wiki-scroll");
		return {
			side: column.previousElementSibling.scrollTop,
			article: column.scrollTop,
			toc: column.nextElementSibling.scrollTop,
			page: document.scrollingElement.scrollTop,
		};
	});

const fixed = (page) =>
	page.evaluate(() => ({
		doc: document.scrollingElement.scrollHeight <= innerHeight,
		bar: document.querySelector("header").getBoundingClientRect().top,
		title: document.querySelector("h1").getBoundingClientRect().top,
	}));

for (const [name, engine] of ENGINES) {
	test(`AC:WIKI-ARTICLE-LAYOUT: the header stays and the three columns scroll apart (${name})`, async () => {
		await withPage(engine, "/wiki/launch-checklist-3", async (page) => {
			const before = await fixed(page);
			assert.equal(before.doc, true);
			// A wheel over the article moves only the article column.
			const article = await page.locator("#wiki-scroll").boundingBox();
			await page.mouse.move(article.x + 200, article.y + 100);
			await page.mouse.wheel(0, 3000);
			await page.waitForTimeout(400);
			const long = await tops(page);
			assert.equal(long.side, 0);
			assert.equal(long.toc, 0);
			assert.equal(long.page, 0);
			// The reading columns of a long article scroll alone to their ends and the header does not move.
			await page.goto(`${BASE}/wiki/website-setup`);
			await page.locator("#wiki-scroll").waitFor();
			await page.mouse.move(article.x + 200, article.y + 100);
			await page.mouse.wheel(0, 100000);
			await page.waitForTimeout(600);
			const moved = await tops(page);
			assert.ok(moved.article > 1000);
			assert.equal(moved.side, 0);
			assert.equal(moved.toc, 0);
			assert.equal(moved.page, 0);
			const toc = await page.locator('nav[aria-label="On this page"]').last().boundingBox();
			await page.mouse.move(toc.x + 40, toc.y + 80);
			await page.mouse.wheel(0, 100000);
			await page.waitForTimeout(400);
			const after = await fixed(page);
			assert.equal(after.doc, true);
			assert.equal(after.bar, before.bar);
			assert.equal(after.title, before.title);
			assert.equal((await tops(page)).page, 0);
			for (const which of ["overscrollBehaviorY"]) {
				const values = await page.evaluate((key) => {
					const column = document.getElementById("wiki-scroll");
					return [column.previousElementSibling, column, column.nextElementSibling].map(
						(el) => getComputedStyle(el)[key],
					);
				}, which);
				assert.deepEqual(values, ["contain", "contain", "contain"]);
			}
		});
	});

	test(`AC:WIKI-ARTICLE-LAYOUT: a contents link scrolls the article column and marks its heading (${name})`, async () => {
		await withPage(engine, "/wiki/website-setup", async (page) => {
			await page.locator('nav[aria-label="On this page"]').last().getByRole("link", { name: "Section 6" }).click();
			await page.waitForFunction(() => location.hash === "#section-6");
			await page.waitForTimeout(500);
			const place = await page.evaluate(() => {
				const column = document.getElementById("wiki-scroll");
				const heading = document.getElementById("section-6");
				return {
					offset: heading.getBoundingClientRect().top - column.getBoundingClientRect().top,
					page: document.scrollingElement.scrollTop,
					current: document.querySelector('nav[aria-label="On this page"] [aria-current]')?.textContent,
				};
			});
			assert.ok(place.offset >= 0 && place.offset < 80, `heading offset ${place.offset}`);
			assert.equal(place.page, 0);
			assert.equal(place.current, "Section 6");
		});
	});

	test(`AC:WIKI-ARTICLE-LAYOUT: a sidenav click keeps the sidenav place and opens the article at its top (${name})`, async () => {
		await withPage(engine, "/wiki/launch-checklist-1", async (page) => {
			await page.evaluate(() => (document.getElementById("wiki-scroll").previousElementSibling.scrollTop = 120));
			await page.getByRole("link", { name: "Launch checklist 9" }).click();
			await page.waitForURL(/launch-checklist-9$/);
			await page.locator("h1", { hasText: "Launch checklist 9" }).waitFor();
			const place = await page.evaluate(() => {
				const column = document.getElementById("wiki-scroll");
				const side = column.previousElementSibling;
				const link = side.querySelector('[aria-current="page"]').getBoundingClientRect();
				const box = side.getBoundingClientRect();
				return {
					side: side.scrollTop,
					article: column.scrollTop,
					seen: link.top >= box.top && link.bottom <= box.bottom,
				};
			});
			assert.equal(place.side, 120);
			assert.equal(place.article, 0);
			assert.equal(place.seen, true);
		});
	});

	test(`AC:WIKI-ARTICLE-LAYOUT: reading progress follows the article column and persists (${name})`, async () => {
		// Each engine reads its own long article, so one engine's finished reading cannot hide the other's partial.
		const slug = name === "chromium" ? "team-handbook" : "volunteer-guide";
		await withPage(engine, `/wiki/${slug}`, async (page) => {
			const writes = [];
			page.on("request", (request) => request.method() === "POST" && writes.push(request.url()));
			await page.evaluate(() => {
				const column = document.getElementById("wiki-scroll");
				column.scrollTop = (column.scrollHeight - column.clientHeight) / 2;
			});
			await page.getByText(/^[1-9]\d?% read$/).waitFor();
			const partial = await page.getByText(/^\d+% read$/).textContent();
			await page.reload();
			await hydrated(page);
			assert.equal(await page.getByText(/^\d+% read$/).textContent(), partial);
			await page.evaluate(() => {
				const column = document.getElementById("wiki-scroll");
				column.scrollTop = column.scrollHeight;
			});
			await page.locator("h1 ~ * span", { hasText: /^Read$/ }).waitFor();
			await page.reload();
			await hydrated(page);
			assert.equal(await page.locator("h1 ~ * span", { hasText: /^Read$/ }).count(), 1);
			assert.equal(await page.getByText(/^\d+% read$/).count(), 0);
		});
	});

	test(`AC:WIKI-ARTICLE-HEADER: the header shows no source path and the controls share one row (${name})`, async () => {
		await withPage(engine, "/wiki/website-setup", async (page) => {
			const text = await page.locator("body").innerText();
			assert.equal(/docs\/|\.json|[0-9a-f]{40}/.test(text), false);
			const rows = await page.evaluate(() =>
				[
					document.querySelector('input[aria-label="Search the wiki"]').parentElement,
					...["Bookmark", "Download PDF", "Print"].map((label) =>
						document.querySelector(`button[aria-label="${label}"]`),
					),
				].map((el) => {
					const box = el.getBoundingClientRect();
					return { top: box.top, bottom: box.bottom, middle: (box.top + box.bottom) / 2 };
				}),
			);
			for (const row of rows) {
				assert.ok(Math.abs(row.top - rows[0].top) <= 1);
				assert.ok(Math.abs(row.bottom - rows[0].bottom) <= 1);
				assert.ok(Math.abs(row.middle - rows[0].middle) <= 1);
			}
		});
	});

	test(`AC:WIKI-BOOKMARK: a bookmark turns on, stays after a reload, lists on /wiki and turns off (${name})`, async () => {
		await withPage(engine, "/wiki/raising-support", async (page) => {
			const button = () => page.locator("button[aria-pressed]").first();
			const state = async () => ({
				pressed: await button().getAttribute("aria-pressed"),
				name: await button().getAttribute("aria-label"),
			});
			assert.deepEqual(await state(), { pressed: "false", name: "Bookmark" });
			await button().click();
			assert.deepEqual(await state(), { pressed: "true", name: "Remove bookmark" });
			// The on state is drawn, not only announced: the fill differs from the off state.
			assert.notEqual(await button().evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
			await page.waitForLoadState("networkidle");
			await page.reload();
			await hydrated(page);
			assert.deepEqual(await state(), { pressed: "true", name: "Remove bookmark" });
			await page.goto(`${BASE}/wiki`);
			await page.getByRole("heading", { name: "Bookmarks" }).waitFor();
			assert.equal((await page.getByRole("link", { name: /Raising support/ }).count()) > 0, true);
			await page.goBack();
			await hydrated(page);
			await button().click();
			assert.deepEqual(await state(), { pressed: "false", name: "Bookmark" });
			await page.waitForLoadState("networkidle");
			await page.reload();
			await hydrated(page);
			assert.deepEqual(await state(), { pressed: "false", name: "Bookmark" });
			await page.goto(`${BASE}/wiki`);
			await page.getByRole("heading", { name: "Recent" }).waitFor();
			assert.equal(await page.getByRole("heading", { name: "Bookmarks" }).count(), 0);
		});
	});

	test(`AC:WIKI-BOOKMARK: a failed bookmark write rolls back and shows a message (${name})`, async () => {
		await withPage(engine, "/wiki/raising-support", async (page) => {
			const button = page.locator("button[aria-pressed]").first();
			const errors = [];
			page.on("pageerror", (error) => errors.push(error));
			await page.route("**/*", (route) => (route.request().method() === "POST" ? route.abort() : route.continue()));
			assert.equal(await button.getAttribute("aria-pressed"), "false");
			await button.click();
			await page.getByText("That did not save. Try again.").waitFor();
			assert.equal(await button.getAttribute("aria-pressed"), "false");
			assert.equal(await button.getAttribute("aria-label"), "Bookmark");
			assert.deepEqual(errors, []);
		});
	});

	test(`AC:WIKI-PREV-NEXT: Previous and Next follow the sidenav order (${name})`, async () => {
		const card = (page, label) => page.getByRole("link", { name: new RegExp(`^${label}\\b`) }).last();
		const hasNoList = (page) => page.getByRole("heading", { name: "In this section" }).count();
		// The first article: Next only, on the right.
		await withPage(engine, "/wiki/website-setup", async (page) => {
			assert.equal(await hasNoList(page), 0);
			assert.equal(await card(page, "Previous").count(), 0);
			await page.locator('nav[aria-label="More articles"]').waitFor();
			const next = card(page, "Next");
			assert.match((await next.textContent()) ?? "", /Team handbook/);
			const box = await next.boundingBox();
			assert.ok(box.x > 720, "Next sits on the right");
		});
		// A middle article: both, then a click on Next opens the following article.
		await withPage(engine, "/wiki/financial-planning", async (page) => {
			assert.match((await card(page, "Previous").textContent()) ?? "", /Volunteer guide/);
			assert.match((await card(page, "Next").textContent()) ?? "", /Choosing a meeting place/);
			assert.equal(await card(page, "Next").evaluate((el) => getComputedStyle(el).cursor), "pointer");
			await card(page, "Next").click();
			await page.waitForURL(/meeting-place$/);
			await page.locator("h1", { hasText: "Choosing a meeting place" }).waitFor();
			assert.equal(await page.evaluate(() => document.getElementById("wiki-scroll").scrollTop), 0);
		});
		// The last article: Previous only.
		await withPage(engine, "/wiki/launch-checklist-22", async (page) => {
			assert.match((await card(page, "Previous").textContent()) ?? "", /Launch checklist 21/);
			assert.equal(await card(page, "Next").count(), 0);
		});
	});
}

for (const [name, engine] of ENGINES) {
	test(`AC:WIKI-ARTICLE-LAYOUT: below app-lg the page scrolls as one and the article cards stack (${name})`, async () => {
		await withPage(
			engine,
			"/wiki/financial-planning",
			async (page) => {
				const place = await page.evaluate(() => ({
					doc: document.scrollingElement.scrollHeight > innerHeight,
					column:
						document.getElementById("wiki-scroll") !== null &&
						getComputedStyle(document.getElementById("wiki-scroll")).overflowY,
					articles: [...document.querySelectorAll("button")].some((el) => el.textContent === "Articles"),
					wide: document.scrollingElement.scrollWidth <= innerWidth,
				}));
				assert.equal(place.doc, true);
				assert.equal(place.column, "visible");
				assert.equal(place.articles, true);
				assert.equal(place.wide, true);
				const previous = await page.getByRole("link", { name: /^Previous\b/ }).boundingBox();
				const next = await page.getByRole("link", { name: /^Next\b/ }).boundingBox();
				assert.ok(next.y > previous.y, "Next sits under Previous");
			},
			{ width: 390, height: 844 },
		);
	});
}
