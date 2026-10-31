// WP-097: /oversight follows the OPS-82 prototype (design/everyfield-marketing.html at 00174437). The section order and
// anchors, the #every-plant tiles, the six plant cards, the leaders photo and its four stops, the sending-paths control,
// the FAQ accordion, reduced motion, hit areas and the site text rules. Copy comes from design/marketing-copy.json, so the
// expected strings are read from it. Runs on any preview: UI_BASE_URL=<preview url> node --test tests/ui/marketing/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";
import { assertSiteRules } from "./site-rules.mjs";

const COPY = JSON.parse(readFileSync(new URL("../../../design/marketing-copy.json", import.meta.url), "utf8"));
const O = COPY.shared.oversight_page;
const ORDER = ["top", "problem", "every-plant", "plants", "leaders", "sending-paths", "trust", "faq", "cta"];
/** The photo file of each next/image in a part of the page, in order. */
const photosIn = (loc) =>
	loc.evaluateAll((imgs) =>
		imgs.map((i) => /\/media\/([a-z]+)\./.exec(decodeURIComponent(i.getAttribute("src")))?.[1]),
	);

async function oversight(page) {
	await page.goto(`${BASE}/oversight`, { waitUntil: "networkidle" });
}

for (const [name, engine] of ENGINES) {
	test(`WP-097 /oversight order and anchors, no Evry and no old chapters (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			assert.deepEqual(await page.$$eval("main > section", (s) => s.map((el) => el.id)), ORDER);
			assert.equal(await page.locator("main ~ footer").count(), 1);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), O.hero.headline);
			const hero = page.locator("#top");
			assert.equal(await hero.getByRole("link", { name: O.hero.cta_secondary }).getAttribute("href"), "#every-plant");
			assert.equal(
				await hero.getByRole("link", { name: O.hero.cta_primary }).getAttribute("href"),
				"/access?role=network",
			);
			for (const old of ["All your plants, in one place.", "See the patterns across your plants.", "Sample data"])
				assert.equal(await page.getByText(old).count(), 0, old);
			// No EvryBot, no Evry chat or card anywhere on the page.
			assert.equal(await page.locator("[data-size][class*='group/eb']").count(), 0);
			assert.equal(
				await page
					.locator("main")
					.getByText(/\bEvry\b/)
					.count(),
				0,
			);
		}));

	test(`WP-097 #every-plant: two labelled rows of four tiles on one photo (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			const sec = page.locator("#every-plant");
			assert.equal(await sec.getByRole("heading", { level: 2 }).innerText(), O.gets.headline);
			const rows = sec.locator("ul");
			assert.equal(await rows.count(), 2);
			for (const [i, g] of O.gets.groups.entries()) {
				assert.deepEqual(
					await rows.nth(i).locator("h3").allInnerTexts(),
					g.items.map((x) => x[1]),
				);
				assert.equal(await sec.getByText(g.label, { exact: true }).count(), 1);
			}
			// One photo (the field band), and no product picture inside the tiles.
			assert.deepEqual(await photosIn(sec.locator("img")), ["field"]);
			assert.equal(await sec.locator(".ef-ui").count(), 0);
		}));

	test(`WP-097 #plants: six numbered photo cards with an icon box, no vignette or sample tag (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			const cards = page.locator("#plants li[data-card]");
			assert.deepEqual(
				await cards.evaluateAll((lis) => lis.map((li) => li.getAttribute("aria-label"))),
				O.plants.items.map((x, i) => `0${i + 1} · ${x.label}`),
			);
			assert.deepEqual(await photosIn(cards.locator("img")), [
				"wildflowers",
				"poppies",
				"blossom",
				"meadow",
				"marigolds",
				"lilies",
			]);
			assert.equal(await cards.locator("svg").count(), 6);
			assert.equal(await page.locator("#plants .ef-ui").count(), 0);
		}));

	test(`WP-097 #leaders: marigolds, four stops with their text, no walker (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			const sec = page.locator("#leaders");
			assert.equal(await sec.getByRole("heading", { level: 2 }).innerText(), O.leaders.headline);
			assert.equal(await sec.getByText(O.leaders.lead).count(), 1);
			assert.deepEqual(await photosIn(sec.locator("img")), ["marigolds"]);
			assert.deepEqual(
				await sec.locator("h3").allInnerTexts(),
				O.leaders.steps.map((s) => s.title),
			);
			// Four brand-green stops on a path drawn through them; nothing to press.
			assert.equal(await sec.locator("[aria-hidden=true] li").count(), 4);
			assert.match(await sec.locator("svg path").first().getAttribute("d"), /^M-20,[\d.]+( C[\d., -]+){5}$/);
			assert.equal(await sec.getByRole("button").count(), 0);
		}));

	test(`WP-097 sending paths: pause, play, and "next" under reduced motion (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			const sec = page.locator("#sending-paths");
			const shown = () => sec.locator("h3").filter({ visible: true }).innerText();
			// Reduced motion (the test default): no auto advance; the control shows the next path.
			await sec.scrollIntoViewIfNeeded();
			assert.equal(await shown(), O.paths.states[0].title);
			await page.waitForTimeout(6000);
			assert.equal(await shown(), O.paths.states[0].title);
			await sec.getByRole("button", { name: "Show the next sending path" }).click();
			assert.equal(await shown(), O.paths.states[1].title);
			// With motion: the same control pauses and plays.
			await page.emulateMedia({ reducedMotion: "no-preference" });
			const pause = sec.getByRole("button", { name: "Pause the sending paths" });
			await pause.waitFor();
			assert.equal(await pause.evaluate((b) => getComputedStyle(b).cursor), "pointer");
			await pause.click();
			const at = await shown();
			await page.waitForTimeout(6500);
			assert.equal(await shown(), at);
			await sec.getByRole("button", { name: "Play the sending paths" }).click();
			await page.waitForFunction(
				(t) => {
					const vis = [...document.querySelectorAll("#sending-paths h3")].filter((h) =>
						h.checkVisibility({ visibilityProperty: true }),
					);
					return vis.length === 1 && vis[0].textContent !== t;
				},
				at,
				{ timeout: 9000 },
			);
			// A hidden tab stops the timer.
			const before = await shown();
			await page.evaluate(() => {
				Object.defineProperty(document, "hidden", { value: true, configurable: true });
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await page.waitForTimeout(6500);
			assert.equal(await shown(), before);
		}));

	test(`WP-097 FAQ: all closed, several open at once (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			const qs = page.locator("#faq button[aria-expanded]");
			assert.deepEqual(
				(await qs.allInnerTexts()).map((q) => q.trim()),
				O.faq.items.map((x) => x.q),
			);
			assert.deepEqual(
				await qs.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-expanded"))),
				O.faq.items.map(() => "false"),
			);
			await qs.nth(0).click();
			await qs.nth(2).click();
			assert.deepEqual(
				await qs.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-expanded"))),
				O.faq.items.map((_, i) => String(i === 0 || i === 2)),
			);
			assert.ok(await page.getByText(O.faq.items[0].a).isVisible());
			assert.ok(await page.getByText(O.faq.items[2].a).isVisible());
			await qs.nth(0).click();
			assert.equal(await qs.nth(0).getAttribute("aria-expanded"), "false");
		}));

	test(`WP-097 /oversight reduced motion: still dashboard and paths (${name})`, () =>
		withPage(engine, async (page) => {
			await oversight(page);
			// No running animation anywhere on the page.
			const running = await page.evaluate(
				() =>
					document
						.getAnimations()
						.filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration) > 0).length,
			);
			assert.equal(running, 0);
			assert.equal(await page.locator("#sending-paths").getByRole("button", { name: /pause/i }).count(), 0);
		}));

	test(`WP-097 /oversight controls: names, focus rings and 44 px hit areas at 390 px (${name})`, () =>
		withPage(
			engine,
			async (page) => {
				await oversight(page);
				const controls = [
					page.locator("#top").getByRole("link", { name: O.hero.cta_primary }),
					page.locator("#top").getByRole("link", { name: O.hero.cta_secondary }),
					...(await page.locator("#faq button[aria-expanded]").all()),
					page.locator("#sending-paths").getByRole("button"),
					page.locator("#cta").getByRole("link", { name: O.cta.cta_primary }),
					page.locator("#cta").getByRole("link", { name: O.cta.cta_secondary }),
				];
				for (const c of controls) {
					await c.scrollIntoViewIfNeeded();
					const r = await c.evaluate((el) => {
						const b = el.getBoundingClientRect(),
							a = getComputedStyle(el, "::before");
						// The hit area: the box, or a larger positioned ::before ring around it.
						const grow = a.content !== "none" && a.position === "absolute" ? -parseFloat(a.top) * 2 : 0;
						el.focus();
						const f = getComputedStyle(el);
						return {
							name: el.getAttribute("aria-label") || el.innerText.trim(),
							w: b.width + grow,
							h: b.height + grow,
							ring: el.matches(":focus-visible") && f.outlineStyle !== "none" && parseFloat(f.outlineWidth) > 0,
						};
					});
					assert.ok(r.name, "accessible name");
					assert.ok(r.w >= 44 && r.h >= 44, `${r.name}: ${r.w}x${r.h}`);
					assert.ok(r.ring, `${r.name}: focus ring`);
				}
				// The visible sending-paths button keeps the prototype's 34 px.
				const box = await page.locator("#sending-paths").getByRole("button").boundingBox();
				assert.equal(Math.round(box.width), 34);
			},
			{ width: 390 },
		));

	for (const width of [390, 1440])
		test(`WP-097 site text rules on /oversight (${name}, ${width}px)`, () =>
			withPage(
				engine,
				async (page) => {
					await oversight(page);
					await assertSiteRules(page);
				},
				{ width },
			));
}
