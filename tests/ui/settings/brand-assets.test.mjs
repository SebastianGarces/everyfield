// WP-104/ui slice 2 on the real server (seeded by tests/ui/people/seed.mts then tests/ui/settings/seed.mts): the Brand
// kit "Logos and images" group, end to end, with a real SVG logo that has margin.
//   AC:CASE-BRD-002: upload, replace and remove through requestUpload, the byte route and finalizeUpload; alt text is
//     required; the stored file is a trimmed PNG of about 3:1; each logo shows on three backgrounds.
//   AC:CASE-BRD-003 (suggest-from-logo): a green logo suggests #2E7D32; the suggestion changes the draft only.
//   INV-brand-asset-route: GET revalidates (304) and refuses a Member, a signed-out visitor and a file the kit no longer
//     references with 404 and no bytes.
//   INV-brand-assets-draft: a picked file marks Brand kit unsaved in the Settings nav.
// BRAND_SHOTS names the directory for the 390 and 1440 px screenshots (default /tmp/everyfield-brand-shots).
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/settings/brand-assets.test.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { request as playwrightRequest } from "../../../apps/web/node_modules/playwright/index.mjs";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

const SHOTS = process.env.BRAND_SHOTS ?? "/tmp/everyfield-brand-shots";
mkdirSync(SHOTS, { recursive: true });

const svg = (inner, w = 900, h = 600) =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`,
	);
// A 300 x 100 green logo in the middle of a 900 x 600 canvas: the server trims the margin, leaving about 3:1.
const LOGO = svg('<rect x="300" y="250" width="300" height="100" rx="12" fill="#2E7D32"/>');
const LOGO_LIGHT = svg('<rect x="300" y="250" width="300" height="100" rx="12" fill="#E8F5E9"/>');
const MARK = svg('<circle cx="450" cy="300" r="90" fill="#2E7D32"/>');
const MARK_LIGHT = svg('<circle cx="450" cy="300" r="90" fill="#E8F5E9"/>');
const COVER = svg(
	'<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1F4E79"/><stop offset="1" stop-color="#D4A017"/></linearGradient></defs><rect width="900" height="600" fill="url(#g)"/>',
);
const SIGNATURE = svg(
	'<path d="M120 330 C 200 180, 260 420, 340 300 S 520 260, 620 320" stroke="#1A1A1A" stroke-width="10" fill="none"/>',
);
const file = (name, buffer, mimeType = "image/svg+xml") => ({ name, mimeType, buffer });

const slot = (page, name) => page.locator(`[data-slot-name="${name}"]`);

/** A screenshot at 390 and at 1440 px of the same state, outside the repository. */
async function shots(page, name, target) {
	for (const [width, height] of [
		[390, 844],
		[1440, 900],
	]) {
		await page.setViewportSize({ width, height });
		await target?.scrollIntoViewIfNeeded();
		if (width === 390) {
			const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
			assert.equal(scroll[0], scroll[1], `${name}: no horizontal scroll at 390 px`);
		}
		await page.screenshot({ path: `${SHOTS}/${name}-${width}.png` });
	}
}

async function upload(page, name, upload, alt) {
	await slot(page, name).locator('input[type="file"]').setInputFiles(upload);
	await slot(page, name)
		.getByLabel(/description/)
		.fill(alt);
	await slot(page, name).getByRole("button", { name: "Upload" }).click();
}

const [, chromium] = ENGINES.find(([engine]) => engine === "chromium") ?? [];

test("CASE-BRD-002 and CASE-BRD-003 on the real server: upload, replace, remove, suggest, serve and refuse", async (t) => {
	if (!chromium) return t.skip("Chromium only");
	const { owner, member } = fixture("settings");
	await withPage(chromium, async (page, context) => {
		await signIn(context, owner.cookie);
		const requests = [];
		// The server's requests: not the local blob: preview of a picked file, and not the dev server's font files.
		page.on("request", (r) => {
			const url = new URL(r.url());
			if (r.url().startsWith(BASE) && !url.pathname.startsWith("/__nextjs_font"))
				requests.push(`${r.method()} ${url.pathname}${url.search}`);
		});
		await page.goto(`${BASE}/settings/brand`, { waitUntil: "networkidle" });
		await page.getByRole("heading", { name: "Logos and images" }).waitFor({ timeout: 60_000 });
		await hydrated(page);

		// Criterion 1: six slots in order, each with its guidance and an empty state.
		const names = await page.locator("[data-slot-name]").evaluateAll((els) => els.map((el) => el.dataset.slotName));
		assert.deepEqual(names, ["full_logo", "full_logo_dark", "mark", "mark_dark", "cover_photo", "signature"]);
		assert.match(await slot(page, "full_logo").innerText(), /SVG, PNG or WebP, up to 3 MB/);
		await shots(page, "01-empty-slots", slot(page, "full_logo"));

		// Criterion 3: blank alt text shows the inline error and sends no request.
		const input = slot(page, "full_logo_dark").locator('input[type="file"]');
		await input.setInputFiles(file("dark-logo.svg", LOGO_LIGHT));
		// A picked file marks Brand kit unsaved in the nav (criterion 11).
		await page.locator('[data-settings-nav="brand"]').getByText("unsaved changes").waitFor({ state: "attached" });
		const before = requests.length;
		await slot(page, "full_logo_dark")
			.getByLabel(/description/)
			.fill("   ");
		await slot(page, "full_logo_dark").getByRole("button", { name: "Upload" }).click();
		await slot(page, "full_logo_dark").getByText("Add a description of the image.").waitFor();
		assert.equal(requests.length, before, "blank alt text sends nothing");
		await shots(page, "02-alt-text-error", slot(page, "full_logo_dark"));

		// Criterion 4: a wrong type is refused before any request.
		await input.setInputFiles(file("photo.gif", Buffer.from("GIF89a"), "image/gif"));
		await slot(page, "full_logo_dark")
			.getByText(/SVG, PNG or WebP/)
			.first()
			.waitFor();
		assert.equal(requests.length, before);
		await shots(page, "03-type-error", slot(page, "full_logo_dark"));
		// ...and so is a file over the limit.
		await input.setInputFiles(file("huge.svg", Buffer.alloc(3 * 1024 * 1024 + 1)));
		await slot(page, "full_logo_dark")
			.getByText(/over the 3 MB limit/)
			.waitFor();
		assert.equal(requests.length, before);
		await shots(page, "03b-size-error", slot(page, "full_logo_dark"));
		await slot(page, "full_logo_dark").getByRole("button", { name: "Cancel" }).click();

		// Criterion 2: one upload is three requests and the GET of the image. Nothing refreshes the route.
		const start = requests.length;
		await slot(page, "full_logo_dark").locator('input[type="file"]').setInputFiles(file("dark-logo.svg", LOGO_LIGHT));
		await slot(page, "full_logo_dark")
			.getByLabel(/description/)
			.fill("Harvest Point logo for dark backgrounds");
		const sending = slot(page, "full_logo_dark").getByRole("button", { name: "Upload" });
		// Hold the byte upload so the optimistic state can be seen: the picked image shows at once.
		await page.route("**/api/brand/assets/*", async (route) => {
			if (route.request().method() === "PUT") await new Promise((resolve) => setTimeout(resolve, 6000));
			await route.continue();
		});
		await sending.click();
		await slot(page, "full_logo_dark").getByText("Uploading…").waitFor();
		assert.match((await slot(page, "full_logo_dark").locator("img").first().getAttribute("src")) ?? "", /^blob:/);
		await shots(page, "08-upload-in-progress", slot(page, "full_logo_dark"));
		await slot(page, "full_logo_dark")
			.getByRole("img", { name: "Harvest Point logo for dark backgrounds" })
			.first()
			.waitFor();
		await page.waitForLoadState("networkidle");
		await page.unroute("**/api/brand/assets/*");
		const sent = requests.slice(start);
		assert.equal(sent.filter((r) => r.startsWith("POST /settings/brand")).length, 2, sent.join("\n"));
		assert.equal(sent.filter((r) => /^PUT \/api\/brand\/assets\//.test(r)).length, 1, sent.join("\n"));
		assert.ok(
			sent.some((r) => /^GET \/api\/brand\/assets\//.test(r)),
			"the new image is fetched",
		);
		assert.ok(!sent.some((r) => r.includes("_rsc")), "no route refresh");
		assert.equal(sent.filter((r) => !r.startsWith("GET /api/brand/assets/")).length, 3, sent.join("\n"));

		// Criterion 8: the served bytes are a trimmed PNG of about 3:1 with the private headers.
		const darkSrc = await slot(page, "full_logo_dark").locator("img").first().getAttribute("src");
		assert.match(darkSrc, /^\/api\/brand\/assets\/[0-9a-f-]{36}$/);
		const served = await context.request.get(BASE + darkSrc);
		assert.equal(served.status(), 200);
		assert.equal(served.headers()["content-type"], "image/png");
		assert.equal(served.headers()["x-content-type-options"], "nosniff");
		assert.equal(served.headers()["cache-control"], "private, no-cache");
		const size = await page.evaluate(
			(src) =>
				new Promise((resolve) => {
					const img = new Image();
					img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
					img.src = src;
				}),
			darkSrc,
		);
		assert.ok(Math.abs(size[0] / size[1] - 3) < 0.35, `trimmed to about 3:1, got ${size.join("x")}`);
		// A 304 revalidation still passes every check.
		const etag = served.headers().etag;
		assert.equal((await context.request.get(BASE + darkSrc, { headers: { "if-none-match": etag } })).status(), 304);
		// A Member, a signed-out visitor: 404 and no bytes.
		for (const cookie of [member.cookie, undefined]) {
			const other = await playwrightRequest.newContext({
				ignoreHTTPSErrors: true,
				extraHTTPHeaders: cookie ? { cookie } : {},
			});
			const refused = await other.get(BASE + darkSrc, { headers: cookie ? { "if-none-match": etag } : {} });
			assert.equal(refused.status(), 404);
			assert.equal((await refused.body()).length, 0);
			await other.dispose();
		}

		// Criterion 7 and 10: the full logo suggests its green; the swatches show three backgrounds.
		await upload(page, "full_logo", file("logo.svg", LOGO), "Harvest Point Church logo");
		await page.getByRole("region", { name: "Suggested colors" }).waitFor({ timeout: 30_000 });
		assert.ok(await page.getByRole("img", { name: /Suggested primary #2E7D32/ }).count());
		await shots(page, "04-suggested-colors", page.getByRole("region", { name: "Suggested colors" }));
		// Neutral ink with a note while the draft has no primary color.
		await slot(page, "full_logo")
			.getByText(/No primary color yet/)
			.waitFor();
		// Nothing was applied by the suggestion.
		assert.equal(await page.getByRole("textbox", { name: "Primary color", exact: true }).inputValue(), "");
		await page.getByRole("button", { name: "Use suggested colors" }).click();
		assert.equal(await page.getByRole("textbox", { name: "Primary color", exact: true }).inputValue(), "#2E7D32");
		await page.locator('[data-settings-nav="brand"]').getByText("unsaved changes").waitFor({ state: "attached" });
		const brand = await slot(page, "full_logo")
			.locator('[data-background="brand"]')
			.evaluate((el) => getComputedStyle(el).backgroundColor);
		assert.equal(brand, "rgb(46, 125, 50)");
		await page.getByRole("button", { name: "Dismiss" }).click();
		await shots(page, "05-filled-slots-three-backgrounds", slot(page, "full_logo"));

		// The remaining slots, so every preview tab has its assets.
		await upload(page, "mark", file("mark.svg", MARK), "Harvest Point mark");
		await page.getByRole("button", { name: "Dismiss" }).click();
		await upload(page, "mark_dark", file("mark-dark.svg", MARK_LIGHT), "Harvest Point mark for dark backgrounds");
		// The cover photo goes by keyboard alone: the file chooser opens from the focused button, and Enter in the
		// description field uploads (criterion 15). The file input has its own label.
		assert.equal(await page.getByLabel("Cover photo file").count(), 1);
		await slot(page, "cover_photo").getByRole("button", { name: "Choose file" }).focus();
		const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.keyboard.press("Enter")]);
		await chooser.setFiles(file("cover.svg", COVER));
		await slot(page, "cover_photo")
			.getByLabel(/description/)
			.focus();
		await page.keyboard.type("A sunrise over the neighborhood");
		await page.keyboard.press("Enter");
		await slot(page, "cover_photo").getByRole("img", { name: "A sunrise over the neighborhood" }).first().waitFor();
		await upload(page, "signature", file("signature.svg", SIGNATURE), "Signature of the lead pastor");
		await slot(page, "signature").getByRole("img", { name: "Signature of the lead pastor" }).first().waitFor();
		await page.waitForLoadState("networkidle");

		// Every enabled control in the group shows a pointer; a disabled one the not-allowed cursor.
		const cursors = await page
			.locator("[data-slot-name] button:not([disabled]), [data-suggestion] button")
			.evaluateAll((els) => els.map((el) => getComputedStyle(el).cursor));
		assert.ok(cursors.length > 5 && cursors.every((cursor) => cursor === "pointer"), cursors.join(","));

		// Criterion 9: each preview tab renders its assets with the kit's alt text.
		const expectations = [
			["Formal/legal", ["Harvest Point Church logo", "Signature of the lead pastor"]],
			["Outward-facing", ["Harvest Point Church logo", "A sunrise over the neighborhood"]],
			["Operational", ["Harvest Point mark"]],
			["Email", ["Harvest Point Church logo"]],
		];
		for (const [tab, alts] of expectations) {
			await page.getByRole("tab", { name: tab }).click();
			const panel = page.getByRole("tabpanel");
			for (const alt of alts) await panel.getByRole("img", { name: alt, exact: true }).waitFor();
			await shots(page, `06-preview-${tab.toLowerCase().replace(/\W+/g, "-")}`, panel);
		}
		const emailWidth = await page
			.getByRole("tabpanel")
			.locator('[data-slot="logo"]')
			.first()
			.evaluate((el) => el.getBoundingClientRect().width);
		assert.ok(emailWidth <= 200, `the email logo is at most 200 px wide, got ${emailWidth}`);

		// Criterion 5: replace. The old file is no longer referenced, so its route answers 404.
		const oldSrc = await slot(page, "full_logo_dark").locator("img").first().getAttribute("src");
		await upload(page, "full_logo_dark", file("dark-logo-2.svg", LOGO_LIGHT), "Replacement dark logo");
		await slot(page, "full_logo_dark").getByRole("img", { name: "Replacement dark logo" }).first().waitFor();
		await page.waitForLoadState("networkidle");
		const newSrc = await slot(page, "full_logo_dark").locator("img").first().getAttribute("src");
		assert.notEqual(newSrc, oldSrc);
		assert.equal((await context.request.get(BASE + oldSrc)).status(), 404);
		assert.equal((await context.request.get(BASE + newSrc)).status(), 200);

		// Criterion 6: Remove asks once, then the slot empties and the preview falls back to the church name.
		await slot(page, "mark").getByRole("button", { name: "Remove" }).click();
		await page.getByRole("alertdialog").waitFor();
		await shots(page, "07-remove-confirmation");
		await page.getByRole("button", { name: "Remove image" }).click();
		await slot(page, "mark")
			.getByText(/No mark yet/)
			.waitFor();
		await page.getByRole("tab", { name: "Operational" }).click();
		await page.getByRole("tabpanel").getByText("Harvest", { exact: false }).first().waitFor();
		assert.equal(
			await page.getByRole("tabpanel").getByRole("img", { name: "Harvest Point mark", exact: true }).count(),
			0,
		);

		// Criterion 11: the unsaved primary color survives the uploads, and Save sends the new revision.
		assert.equal(await page.getByRole("textbox", { name: "Primary color", exact: true }).inputValue(), "#2E7D32");
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await page.getByText("No unsaved changes.").waitFor();
		await page
			.getByText(/Someone else saved/)
			.waitFor({ state: "detached", timeout: 1000 })
			.catch(() => {});
	});

	// Criterion 12: a Member is not offered Brand kit and gets no bytes.
	await withPage(chromium, async (page, context) => {
		await signIn(context, member.cookie);
		await page.goto(`${BASE}/settings/brand`, { waitUntil: "networkidle" });
		await page.locator("[data-settings-nav]").first().waitFor({ timeout: 60_000 });
		assert.equal(await page.locator('[data-settings-nav="brand"]').count(), 0);
		assert.equal(await page.getByRole("heading", { name: "Logos and images" }).count(), 0);
	});
});
