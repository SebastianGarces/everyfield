// The site text and image rules of WP-097 criterion 13, shared by the home and /oversight tests.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

/** The marketing photos (apps/web/src/marketing/photo/files): the only raster images a page may show. */
const PHOTOS = readdirSync(new URL("../../../apps/web/src/marketing/photo/files", import.meta.url)).map((f) =>
	f.replace(/\.jpg$/, ""),
);

/** The rendered text and aria-labels hold no "draft", "invitation email", "Maria", alpha date or bare "plant(s)"; every
 *  image is a marketing photo (next/image of photo/files) or the logo, so no picture of the app. */
export async function assertSiteRules(page) {
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
	const srcs = await page.$$eval("img", (imgs) => imgs.map((i) => decodeURIComponent(i.getAttribute("src") ?? "")));
	for (const src of srcs) assert.ok(PHOTOS.includes(/\/media\/([a-z]+)\./.exec(src)?.[1] ?? ""), src);
}
