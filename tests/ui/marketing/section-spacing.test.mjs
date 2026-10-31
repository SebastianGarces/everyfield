// WP-097: the marketing section space halves on phones (Sebastian, Oct 31 2026: "reduce the section spacing... to maybe
// half of what it's now, while keeping what we have on desktop"). --spacing-section is 80 px at 640 px and narrower and
// 160 px above; the plain side of a photo section's neighbours is 1.5 times that (120 px, 240 px).
// Runs on any preview: UI_BASE_URL=<preview url> node --test tests/ui/marketing/
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

/** Width -> [section space, photo-neighbour space]. 640 is the last phone width, 641 the first wider one. */
const SPACE = { 390: [80, 120], 640: [80, 120], 641: [160, 240], 1440: [160, 240] };

/** The computed padding of the plain #problem section, the photo section and the plain sides of its neighbours. */
const measure = (page) =>
	page.evaluate(() => {
		const pad = (el) => {
			const c = getComputedStyle(el);
			return [Number.parseFloat(c.paddingTop), Number.parseFloat(c.paddingBottom)];
		};
		const photo = document.querySelector("main > section[data-photo-section]");
		return {
			plain: pad(document.getElementById("problem")),
			photo: pad(photo),
			before: pad(photo.previousElementSibling)[1],
			after: pad(photo.nextElementSibling)[0],
		};
	});

for (const [name, engine] of ENGINES) {
	for (const path of ["/", "/oversight"])
		test(`WP-097 ${path} section space: 80 px on phones, 160 px above 640 px, photo sides 1.5 times (${name})`, () =>
			withPage(engine, async (page) => {
				await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
				for (const [width, [space, photoSide]] of Object.entries(SPACE)) {
					await page.setViewportSize({ width: Number(width), height: 900 });
					assert.deepEqual(
						await measure(page),
						{ plain: [space, space], photo: [space, space], before: photoSide, after: photoSide },
						`${path} at ${width} px`,
					);
				}
			}));

	test(`WP-097 /access form section bottom space follows the token (${name})`, () =>
		withPage(engine, async (page) => {
			await page.goto(`${BASE}/access`, { waitUntil: "networkidle" });
			for (const [width, [space]] of Object.entries(SPACE)) {
				await page.setViewportSize({ width: Number(width), height: 900 });
				const bottom = await page.$eval("main > section:last-of-type", (el) =>
					Number.parseFloat(getComputedStyle(el).paddingBottom),
				);
				assert.equal(bottom, space, `/access at ${width} px`);
			}
		}));
}
