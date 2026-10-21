// BUG-PR171: the serif follows the rendered size (foundations.md, Type). DM Serif Display at 24px and up, DM Serif
// Text below 24px, both at -0.02em. A class lint cannot see inherited families or responsive sizes, so this checks the
// computed style of every visible serif element on pages that compose shared headings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, withPage } from "../setup.mjs";

const PATHS = ["/access", "/oversight", "/design/display", "/design/shell/owner"];

for (const [name, engine] of ENGINES) {
	for (const width of [390, 1440]) {
		test(
			`BUG-PR171 (${name}, ${width}px): each serif matches its size and tracks at -0.02em`,
			{ timeout: 120_000 },
			() =>
				withPage(
					engine,
					async (page) => {
						for (const path of PATHS) {
							await page.goto(BASE + path, { waitUntil: "networkidle" });
							await page.evaluate(() => document.fonts.ready);
							const wrong = await page.evaluate(() =>
								[...document.querySelectorAll("body *")].flatMap((el) => {
									const box = el.getBoundingClientRect();
									const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
									if (!ownText || box.width <= 1 || box.height <= 1) return [];
									const cs = getComputedStyle(el);
									const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
									if (family !== "DM Serif Display" && family !== "DM Serif Text") return [];
									const px = parseFloat(cs.fontSize);
									const tracking = cs.letterSpacing === "normal" ? 0 : parseFloat(cs.letterSpacing) / px;
									const want = px >= 24 ? "DM Serif Display" : "DM Serif Text";
									if (family === want && Math.abs(tracking + 0.02) <= 0.002) return [];
									return [`${el.textContent.trim().slice(0, 40)}: ${family} ${px}px ${tracking.toFixed(3)}em`];
								}),
							);
							assert.deepEqual(wrong, [], `${path} at ${width}px`);
						}
					},
					{ width },
				),
		);
	}
}
