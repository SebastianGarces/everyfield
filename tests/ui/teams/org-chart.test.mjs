import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const WIDTHS = [390, 1440];

for (const [name, engine] of ENGINES)
	for (const width of WIDTHS)
		test(
			`INV-org-chart-width (${name} ${width}): a chart wider than the screen scrolls in its own region and never scrolls the page sideways`,
			{ timeout: 90_000 },
			() =>
				withPage(
					engine,
					async (page, context) => {
						await signIn(context, fixture("people").owner.cookie);
						await page.goto(`${BASE}/ministries`);
						await hydrated(page);
						await page.getByRole("radio", { name: "Organization view" }).click();
						const region = page.getByRole("region", { name: /^Organization view, scrolls/ });
						for (const team of fixture("teams").names) await region.getByRole("link", { name: team }).waitFor();
						await page.evaluate(() => document.fonts.ready);
						const sizes = await region.evaluate((node) => ({
							page: [document.documentElement.scrollWidth, document.documentElement.getBoundingClientRect().width],
							region: [node.scrollWidth, node.clientWidth],
						}));
						assert.equal(sizes.page[0], sizes.page[1], `the page is wider than the screen: ${JSON.stringify(sizes)}`);
						if (width === 1440) {
							assert.ok(sizes.region[0] > sizes.region[1], `the region scrolls sideways: ${JSON.stringify(sizes)}`);
							await region.evaluate((node) => node.scrollTo({ left: node.scrollWidth }));
							assert.ok((await region.evaluate((node) => node.scrollLeft)) > 0);
						}
					},
					{ width },
				),
		);
