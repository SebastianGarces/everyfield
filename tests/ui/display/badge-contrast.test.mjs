// INV-contrast: every badge and chip label on the /design/display gallery reads at 4.5:1 in the dark theme, measured on
// the real pixels behind each label with tests/ui/contrast.mjs (the T-22 helper). The light theme is not asserted
// (D-383). The test finds the chips in the "Badges, chips and avatars" section from the page itself and names each one
// by component, variant and label. A chip it cannot name fails, and so does a gallery variant that went missing.
//   UI_BASE_URL=https://wp-....localhost:1355 UI_ENGINE=chromium node --test tests/ui/display/badge-contrast.test.mjs
// SHOT_DIR (outside the repository) keeps each measured chip as a PNG.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { contrastOf } from "../contrast.mjs";
import { BASE, ENGINES, hydrated, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const SHOTS = process.env.SHOT_DIR;
const AA = 4.5;
const SECTION = "Badges, chips and avatars";

/** Every variant the gallery renders (packages/ui/src/display/preview/PreviewData.tsx, BadgesSection). */
const GALLERY = [
	...["positive", "measured", "attention", "risk", "unknown"].map((s) => `StatusBadge outline ${s}`),
	...["positive", "measured", "attention", "risk"].map((s) => `StatusBadge soft ${s}`),
	"StatusBadge plain unknown",
	"DeltaChip up",
	"DeltaChip down",
	"DeltaChip up risk",
	"DeltaChip up sm",
	...["green", "blue", "violet", "amber", "teal", "untoned"].map((t) => `Tag ${t}`),
	...["prospect", "attendee", "following", "interviewed", "core", "launch", "leader"].map((s) => `StageChip ${s}`),
];

/**
 * Names each chip as "Component variant" (null when it is not a badge or chip) with the label a reader sees, its text
 * without the screen-reader-only words. Runs in the page.
 */
function describeChips(els) {
	const nameOf = (el) => {
		const cls = el.className;
		if (el.dataset.status) {
			if (!el.querySelector(":scope > [aria-hidden='true']")) return `StatusBadge plain ${el.dataset.status}`;
			return `StatusBadge ${cls.includes("bg-surface-raised") ? "outline" : "soft"} ${el.dataset.status}`;
		}
		if (el.dataset.dir) {
			const arrow = el.querySelector(":scope > [aria-hidden='true']")?.className ?? "";
			const risk = el.dataset.dir === "up" && arrow.includes("magenta");
			return ["DeltaChip", el.dataset.dir, risk ? "risk" : "", /\bh-6\b/.test(cls) ? "sm" : ""]
				.filter(Boolean)
				.join(" ");
		}
		if (el.dataset.stage) return `StageChip ${el.dataset.stage}`;
		if (!cls.includes("rounded-md")) return null;
		const tone = cls.match(/\bbg-(green|blue|amber|magenta|violet|teal)-100\b/)?.[1];
		return `Tag ${tone ?? (cls.includes("bg-surface-2") ? "untoned" : "unknown")}`;
	};
	const labelOf = (el) => {
		const copy = el.cloneNode(true);
		for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
		return copy.textContent.trim();
	};
	return els.map((el) => ({ name: nameOf(el), label: labelOf(el) }));
}

test(
	`INV-contrast: every badge and chip label on /design/display reads at ${AA}:1 in the dark theme (Chromium, 1440 and 390 px)`,
	{
		timeout: 180_000,
	},
	async () => {
		await withPage(chromium, async (page, context) => {
			await context.addCookies([{ name: "ef-theme", value: "dark", url: BASE }]);
			await page.goto(`${BASE}/design/display`);
			await hydrated(page);
			assert.equal(await page.locator("html").getAttribute("data-theme"), "dark", "the gallery shows its dark theme");
			const section = page.getByRole("region", { name: SECTION });
			// The chips sit in the specimens' wrapping rows. Avatars are images (or hidden in a group) and are not measured.
			const chips = section.locator(".flex-wrap > span:not([role='img']):not([aria-hidden='true'])");
			await chips.first().waitFor();
			const found = await chips.evaluateAll(describeChips);
			const unnamed = found.filter((chip) => !chip.name).map((chip) => chip.label);
			assert.deepEqual(unnamed, [], "every chip in the section is a StatusBadge, DeltaChip, Tag or StageChip");
			const names = found.map((chip) => chip.name);
			assert.deepEqual(
				GALLERY.filter((name) => !names.includes(name)),
				[],
				"the gallery still renders every badge and chip variant",
			);

			const failures = [];
			for (const width of [1440, 390]) {
				await page.setViewportSize({ width, height: 900 });
				for (const [i, { name, label }] of found.entries()) {
					const measured = await contrastOf(chips.nth(i));
					const seen = `${name} "${label}", ${width} px, dark theme: ${measured.ratio}:1, text ${measured.text} on ${measured.background}, threshold ${AA}:1`;
					console.log(`INV-contrast ${seen}`);
					if (SHOTS) writeFileSync(`${SHOTS}/${name.replaceAll(" ", "-")}-${width}-dark.png`, measured.shot);
					if (measured.ratio < AA) failures.push(seen);
				}
			}
			assert.deepEqual(failures, [], `every badge and chip label reads at ${AA}:1 or more`);
		});
	},
);
