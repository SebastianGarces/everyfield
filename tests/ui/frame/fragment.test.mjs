import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn } from "../setup.mjs";

const WIDTHS = [390, 1440];

async function withMotionPage(engine, width, run) {
	assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
	const browser = await engine.launch();
	try {
		const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
		const page = await context.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await run(page, context);
		assert.deepEqual(errors, [], "no page error");
	} finally {
		await browser.close();
	}
}

const framesOf = (page, id, ms) =>
	page.evaluate(
		([id, ms]) =>
			new Promise((done) => {
				const rows = [];
				const t0 = performance.now();
				const tick = (now) => {
					const target = document.getElementById(id);
					rows.push(
						target ? target.getBoundingClientRect().top - parseFloat(getComputedStyle(target).scrollMarginTop) : null,
					);
					if (now - t0 < ms) requestAnimationFrame(tick);
					else done(rows);
				};
				requestAnimationFrame(tick);
			}),
		[id, ms],
	);

async function assertTargetHeldAtTop(page, id) {
	const offsets = await framesOf(page, id, 2000);
	const off = offsets.filter((offset) => offset === null || offset < -1 || offset > 8);
	assert.deepEqual(off, [], `#${id} sits within 8 px below its scroll margin on all ${offsets.length} frames`);
}

for (const [name, engine] of ENGINES)
	for (const width of WIDTHS) {
		test(
			`INV-fragment-lands (${name} ${width}): a fragment link clicked while /privacy loads lands with #intelligence at the top`,
			{ timeout: 90_000 },
			() =>
				withMotionPage(engine, width, async (page) => {
					await page.goto(BASE + "/privacy", { waitUntil: "commit" });
					const link = page.locator('a[href="/#intelligence"]').first();
					await link.waitFor({ state: "attached" });
					await link.click({ noWaitAfter: true });
					await page.waitForURL((url) => url.pathname === "/" && url.hash === "#intelligence");
					await page.waitForLoadState("load");
					await assertTargetHeldAtTop(page, "intelligence");
				}),
		);

		test(
			`INV-fragment-reload (${name} ${width}): reloading /people#main keeps #main at the top with the People heading`,
			{ timeout: 90_000 },
			() =>
				withMotionPage(engine, width, async (page, context) => {
					await signIn(context, fixture("people").owner.cookie);
					await page.goto(BASE + "/people#main");
					await hydrated(page);
					await page.waitForLoadState("networkidle");
					await page.reload({ waitUntil: "commit" });
					await page.getByRole("heading", { level: 1, name: "People" }).waitFor({ timeout: 60_000 });
					assert.equal(new URL(page.url()).pathname + new URL(page.url()).hash, "/people#main");
					await hydrated(page);
					await assertTargetHeldAtTop(page, "main");
				}),
		);
	}
