// Access boundary screens (WP-006/ui): the guards a silent break would turn into a privacy leak or an open redirect.
// Each row fails when its guard is removed.
//   INV-notes-revoked: when the server stops allowing staff notes, every note already on screen goes away
//     (StaffNotesPanel replaces the list on an `unavailable` page, REQ-MUL-002).
//   INV-notes-director: a program director alone gets no staff notes panel and no hint that notes exist;
//     an administrator who also directs does get it (canReadStaffNotes, REQ-MUL-002).
//   INV-session-return: the session-ended screen keeps only a local return path (invalidSessionReturn, REQ-IDN-028).
// The screens run on contract-parsed fixtures at /design/access. It runs against a running app: set UI_BASE_URL.
//   UI_BASE_URL=https://wp-006-ui-....localhost:1355 corepack pnpm test:ui
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium, webkit } from "../../../apps/web/node_modules/playwright/index.mjs";

const BASE = process.env.UI_BASE_URL;
const NOTES = "/design/access/staff-notes";
const FIRST_NOTE = "First call after the assessment weekend";

const ENGINES = [
	["chromium", chromium],
	["webkit", webkit],
].filter(([name]) => !process.env.UI_ENGINE || process.env.UI_ENGINE === name);

for (const [name, engine] of ENGINES) {
	describe(`access guards (${name})`, () => {
		let browser;
		before(async () => {
			assert.ok(BASE, "Set UI_BASE_URL to a running preview of this worktree.");
			browser = await engine.launch();
		});
		after(async () => {
			await browser?.close();
		});

		async function open(path, run) {
			const context = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				reducedMotion: "reduce",
				ignoreHTTPSErrors: true,
			});
			try {
				const page = await context.newPage();
				await page.goto(BASE + path);
				await run(page);
			} finally {
				await context.close();
			}
		}

		test("INV-notes-revoked: notes on screen disappear when the next page is refused", () =>
			open(`${NOTES}?as=staff&notes=access-ended&delay=0`, async (page) => {
				await page.getByText(FIRST_NOTE).waitFor();
				await page.getByRole("button", { name: "Show more notes" }).click();
				await page.getByRole("heading", { name: "This is not available" }).waitFor();
				assert.equal(await page.locator("[data-note]").count(), 0);
				assert.equal(await page.getByText(FIRST_NOTE).count(), 0);
			}));

		test("INV-notes-director: a program director alone gets no notes panel; an admin who directs does", async () => {
			await open(`${NOTES}?as=director&delay=0`, async (page) => {
				await page.getByText("Your role with Jordan Ellis").waitFor();
				await page.waitForTimeout(300);
				assert.equal(await page.getByRole("heading", { name: "Staff notes" }).count(), 0);
				assert.equal(await page.getByText("Staff only").count(), 0);
			});
			await open(`${NOTES}?as=admin-and-director&delay=0`, async (page) => {
				await page.getByText(FIRST_NOTE).waitFor();
				assert.equal(await page.getByRole("heading", { name: "Staff notes" }).count(), 1);
			});
		});

		for (const [returnTo, href] of [
			["/people?view=core", "/signin?returnTo=%2Fpeople%3Fview%3Dcore"],
			["//evil.example/x", "/signin"],
			["https://evil.example/", "/signin"],
			["/%5Cevil.example", "/signin"],
		])
			test(`INV-session-return: ${returnTo} leads to ${href}`, () =>
				open(`/design/access/session-ended?returnTo=${encodeURIComponent(returnTo)}`, async (page) => {
					const link = page.getByRole("link", { name: "Sign in again" });
					assert.equal(await link.getAttribute("href"), href);
				}));
	});
}
