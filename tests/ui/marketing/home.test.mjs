// WP-097 slice 1: the home page follows the OPS-82 prototype (design/everyfield-marketing.html at 00174437). The section
// order and anchors, the journey path's stops (click, arrow keys, aria-pressed, no play or pause control), the reduced
// motion still frame, the Evry card photos and the site text rules. Copy comes from design/marketing-copy.json, so the
// expected strings here are read from it. Runs on any preview: UI_BASE_URL=<preview url> node --test tests/ui/marketing/
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

const COPY = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));
const OPS = COPY.shared.ops82;
const STOPS = [...COPY.shared.week.steps, ...OPS.journey.steps].map((s) => s.title);
/** The marketing photos (apps/web/src/marketing/photo/files): the only raster images the page may show. */
const PHOTOS = readdirSync(new URL("../../../apps/web/src/marketing/photo/files", import.meta.url)).map((f) =>
	f.replace(/\.jpg$/, ""),
);
const ORDER = ["top", "problem", "vision", "features", "week", "evry", "sending", "cta"];

/** Opens / and waits until the journey has hydrated: its first layout shows the walker on stop 1. */
async function home(page, hash = "") {
	await page.goto(`${BASE}/${hash}`, { waitUntil: "networkidle" });
	await page.locator("#week [aria-hidden=true][style*='visibility: visible']").waitFor({ timeout: 60_000 });
}
const pressed = (page) =>
	page.$$eval("#week button[aria-pressed]", (bs) => bs.map((b) => b.getAttribute("aria-pressed") === "true"));
const only = (i) => STOPS.map((_, k) => k === i);

for (const [name, engine] of ENGINES) {
	test(`WP-097 home order and anchors (${name})`, () =>
		withPage(engine, async (page) => {
			await home(page);
			const ids = await page.$$eval("main > section", (s) => s.map((el) => el.id));
			assert.deepEqual(ids, ORDER);
			assert.equal(await page.locator("main + footer, main ~ footer").count(), 1);
			// The old sections are gone.
			for (const old of ["Know what needs you most.", "Stay close to the plant you sent."])
				assert.equal(await page.getByText(old).count(), 0, old);
			assert.equal(
				await page.getByRole("link", { name: COPY.directions[0].sections.hero.cta_secondary }).getAttribute("href"),
				"#vision",
			);
			// The footer's Plant Intelligence link (/#intelligence) lands on the journey section.
			await home(page, "#intelligence");
			const top = await page.locator("#week").evaluate((el) => el.getBoundingClientRect().top);
			assert.ok(Math.abs(top) < 200, `#week top is ${top}`);
		}));

	test(`WP-097 journey stops: click, arrow keys and aria-pressed, no play or pause control (${name})`, () =>
		withPage(engine, async (page) => {
			await home(page);
			const week = page.locator("#week");
			const stops = week.getByRole("button");
			assert.deepEqual(await stops.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label"))), STOPS);
			assert.deepEqual(await pressed(page), only(0));
			assert.equal(await week.getByRole("button", { name: /play|pause/i }).count(), 0);
			for (const b of await stops.all()) assert.equal(await b.evaluate((el) => getComputedStyle(el).cursor), "pointer");

			await week.getByRole("button", { name: STOPS[2] }).click();
			assert.deepEqual(await pressed(page), only(2));
			// Keyboard: a stop takes focus (WebKit does not focus a button on click), then the arrows move between stops.
			await week.getByRole("button", { name: STOPS[2] }).focus();
			await page.keyboard.press("ArrowRight");
			assert.deepEqual(await pressed(page), only(3));
			assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), STOPS[3]);
			await page.keyboard.press("ArrowLeft");
			await page.keyboard.press("ArrowLeft");
			assert.deepEqual(await pressed(page), only(1));
			// A card selects its stop too, and shows the pointer cursor.
			const card = week.locator("ol").nth(1).locator("li").nth(4);
			assert.equal(await card.evaluate((el) => getComputedStyle(el).cursor), "pointer");
			await card.click();
			assert.deepEqual(await pressed(page), only(4));
			assert.equal(await week.locator("p").filter({ hasText: OPS.journey.says[4] }).count(), 1);
		}));

	for (const width of [390, 1440])
		test(`WP-097 reduced motion: six stops and one still line, no play or pause control (${name}, ${width}px)`, () =>
			withPage(
				engine,
				async (page) => {
					await home(page);
					await page.locator("#week").scrollIntoViewIfNeeded();
					const stops = page.locator("#week").getByRole("button");
					assert.equal(await stops.count(), 6);
					for (const b of await stops.all()) assert.ok(await b.isVisible());
					const line = page.locator("#week p").filter({ hasText: OPS.journey.says[0] });
					assert.equal(await line.count(), 1);
					const at = await page.locator("#week [style*='visibility: visible']").getAttribute("style");
					// Longer than one auto-advance step: nothing moves.
					await page.waitForTimeout(5000);
					assert.deepEqual(await pressed(page), only(0));
					assert.equal(await page.locator("#week [style*='visibility: visible']").getAttribute("style"), at);
					assert.equal(await page.getByRole("button", { name: /play|pause/i }).count(), 0);
					// The hero shows its still final frame: Emily Carter in the core group.
					assert.match(await page.locator("#top [role=img]").getAttribute("aria-label"), /Emily Carter/);
				},
				{ width },
			));

	test(`WP-097 Evry cards on swirl, lupins and marigolds (${name})`, () =>
		withPage(engine, async (page) => {
			await home(page);
			const cards = page.locator("#evry li");
			assert.deepEqual(
				await cards.locator("h3").allInnerTexts(),
				OPS.evry.cards.map((c) => c[1]),
			);
			const photos = await cards.evaluateAll((lis) =>
				lis.map((li) => decodeURIComponent(li.querySelector("img")?.getAttribute("src") ?? "")),
			);
			photos.forEach((src, i) => assert.match(src, new RegExp(`/${["swirl", "lupins", "marigolds"][i]}\\.`), src));
		}));

	for (const width of [390, 1440])
		test(`WP-097 site text rules on / (${name}, ${width}px)`, () =>
			withPage(
				engine,
				async (page) => {
					await home(page);
					const text = await page.evaluate(() =>
						[
							document.body.innerText,
							...[...document.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label")),
						].join("\n"),
					);
					assert.doesNotMatch(text, /draft/i);
					assert.doesNotMatch(text, /invitation email/i);
					assert.doesNotMatch(text, /Maria/);
					assert.doesNotMatch(text, /\balpha\b/i);
					const bare = text.replace(/church plants?/gi, "").replace(/Plant Intelligence/g, "");
					assert.doesNotMatch(bare, /\bplants?\b/i);
					// Every image is a marketing photo (next/image of photo/files) or the logo: no picture of the app.
					const srcs = await page.$$eval("img", (imgs) =>
						imgs.map((i) => decodeURIComponent(i.getAttribute("src") ?? "")),
					);
					for (const src of srcs) assert.ok(PHOTOS.includes(/\/media\/([a-z]+)\./.exec(src)?.[1] ?? ""), src);
				},
				{ width },
			));
}
