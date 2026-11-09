// WP-036 escaped bug #420: the Commitment Card tagline, a merge-field chip in the filled cover header, drew white text
// on the paper's light gray chip. Axe read the styles and missed it; tests/ui/contrast.mjs measures the real pixels.
// The self-check runs the helper on static pages with no app; the BUG test needs a preview seeded with People.
//   UI_BASE_URL=https://wp-....localhost:1355 UI_ENGINE=chromium node --test tests/ui/documents/contrast.test.mjs
// Seed People first: tests/ui/people/seed.mts up <preview-url>. SHOT_DIR (outside the repository) keeps each measured
// chip as a PNG.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { contrastOf, luminance } from "../contrast.mjs";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const SHOTS = process.env.SHOT_DIR;
const AA = 4.5;

const header = (chip) => `
	<div style="background:#1f3a2e;color:#fff;padding:24px;font:16px/1.5 sans-serif">
		<p style="margin:0">Harbor City Church: <span id="chip" style="display:inline-block;padding:0 6px;border-radius:4px;${chip}">A new church plant.</span></p>
	</div>`;
// A dark picture as an <img>, so no style anywhere names its color.
const darkImage = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><rect width="400" height="80" fill="#14181f"/><rect width="200" height="80" fill="#2b1838"/></svg>',
)}`;
const SELF_CHECK = [
	{
		name: "white text on a light gray chip over a dark header (the #420 escape)",
		html: header("background:#edf0f4;box-shadow:inset 0 0 0 1px #d5dae2"),
		pass: false,
	},
	{
		name: "white text on a dark tint chip over the same header (the fix)",
		html: header(
			"background:color-mix(in srgb,#fff 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,#fff 45%,transparent)",
		),
		pass: true,
	},
	{
		name: "white text with light computed backgrounds, drawn over a dark image",
		html: `<div style="position:relative;background:#fafafa;width:400px;height:80px">
			<img src="${darkImage}" alt="" style="position:absolute;inset:0">
			<p style="position:relative;margin:0;padding:24px;background:rgba(255,255,255,0)"><span id="chip" style="color:#fff;font:16px sans-serif">A new church plant.</span></p>
		</div>`,
		pass: true,
		dark: true,
	},
];

test("BUG-#420 self-check: the contrast helper measures the pixels behind the text, not computed backgrounds (Chromium, no app)", async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 600, height: 300 } });
		for (const { name, html, pass, dark } of SELF_CHECK) {
			await page.setContent(`<body style="margin:0;background:#fff">${html}</body>`);
			await page.locator("img").evaluateAll((imgs) => Promise.all(imgs.map((img) => img.decode())));
			const measured = await contrastOf(page.locator("#chip"));
			const seen = `${name}: ${measured.ratio}:1, text ${measured.text} on ${measured.background}`;
			console.log(`self-check ${seen}`);
			assert.equal(measured.ratio >= AA, pass, `${seen}; expected ${pass ? "at least" : "under"} ${AA}:1`);
			if (dark) {
				const hex = measured.background
					.slice(1)
					.match(/../g)
					.map((c) => Number.parseInt(c, 16));
				assert.ok(luminance(hex) < 0.05, `${seen}; the background must come from the dark pixels`);
			}
		}
	} finally {
		await browser.close();
	}
});

const TAGLINE =
	'.ef-paper [data-ef-node="box"]:not([data-box-fill="none"]) span[data-ef-node="field"][data-ef-key="church_tagline"]';

test("BUG-#420: the Commitment Card tagline reads on the dark cover header (Chromium, 1440 and 390 px, light and dark)", async () => {
	await withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people").owner.cookie);
		await page.goto(`${BASE}/documents/church`);
		await hydrated(page);
		await page.getByRole("button", { name: "New from template" }).first().click();
		await page.getByRole("button", { name: /^Core Group Commitment Card/ }).click();
		await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
		const docUrl = page.url();
		const failures = [];
		for (const theme of ["light", "dark"]) {
			await context.addCookies([{ name: "ef-theme", value: theme, url: BASE }]);
			await page.goto(docUrl);
			await hydrated(page);
			assert.equal(await page.locator("html").getAttribute("data-theme"), theme, `the app shows its ${theme} theme`);
			for (const width of [1440, 390]) {
				await page.setViewportSize({ width, height: 900 });
				const chip = page.locator(TAGLINE).first();
				await chip.waitFor({ timeout: 90_000 });
				const measured = await contrastOf(chip);
				const seen = `${width} px, ${theme} theme: ${measured.ratio}:1, text ${measured.text} on ${measured.background}, threshold ${AA}:1`;
				console.log(`BUG-#420 ${seen}`);
				if (SHOTS) writeFileSync(`${SHOTS}/tagline-${width}-${theme}.png`, measured.shot);
				if (measured.ratio < AA) failures.push(seen);
			}
		}
		assert.deepEqual(failures, [], `the tagline chip reads at ${AA}:1 or more`);
	});
});
