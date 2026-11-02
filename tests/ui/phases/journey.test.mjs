// WP-038 round 1: at 390 px the "Signs that Phase N is wrapping up" tiles were two 150 px columns with the label and the
// badge side by side, so labels wrapped one word per line and the Unknown badge ran past its tile. At phone width the
// tiles are one full-width column; at every width each badge stays inside its tile. Runs on a seeded preview: seed with
// tests/ui/people/seed.mts, then set UI_BASE_URL (tests/ui/setup.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

for (const [name, engine] of ENGINES)
	for (const width of [1440, 390])
		test(`Signs tiles keep each badge inside its tile (${name} ${width}px)`, async () => {
			const { owner } = fixture("people");
			await withPage(
				engine,
				async (page, context) => {
					await signIn(context, owner.cookie);
					await page.goto(`${BASE}/intelligence`);
					await hydrated(page);
					const tiles = page.locator('section[aria-labelledby="signs-heading"] li');
					await tiles.first().waitFor();
					const list = await page.locator('section[aria-labelledby="signs-heading"] ul').boundingBox();
					for (const tile of await tiles.all()) {
						const box = await tile.boundingBox();
						const badge = await tile.locator("[data-status]").boundingBox();
						assert.ok(box && badge && list);
						assert.ok(badge.x + badge.width <= box.x + box.width + 0.5, "the badge stays inside its tile");
						if (width === 390) assert.ok(Math.abs(box.width - list.width) < 1, "one full-width column at phone width");
					}
				},
				{ width, height: 900 },
			);
		});
