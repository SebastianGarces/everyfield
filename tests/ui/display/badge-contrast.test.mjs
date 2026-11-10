// INV-contrast: every badge, chip and avatar initials label on the /design/display gallery reads at 4.5:1 in the dark
// and the light theme, measured on the real pixels behind each label with tests/ui/contrast.mjs (the T-22 helper). Both
// themes run the same steps (measureTheme) and differ only in the ef-theme cookie. Each test finds the chips and avatars
// in the "Badges, chips and avatars" section from the page itself and names each one by component, variant and label. A
// chip or avatar it cannot name fails, and so does a gallery variant that went missing. DeltaChips inside an InsightCard
// are the onInk variant, named with the card's tone. Avatars that show an image or no text have no label to read and are
// skipped.
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
	...["field", "sky", "sage", "rose"].flatMap((t) => [`DeltaChip onInk up on ${t}`, `DeltaChip onInk down on ${t}`]),
	"Avatar green xs",
	"Avatar blue sm",
	"Avatar amber md",
	"Avatar violet lg",
	"Avatar ink xl ring",
	"AvatarGroup Avatar blue sm",
	"AvatarGroup Avatar amber sm",
	"AvatarGroup Avatar green sm",
	"AvatarGroup counter sm",
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
			const card = el.closest(".ef-insight");
			if (card) return `DeltaChip onInk ${el.dataset.dir} on ${card.dataset.tone}`;
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

const AVATAR_SIZES = { "size-[26px]": "xs", "size-8": "sm", "size-10": "md", "size-16": "lg", "size-[92px]": "xl" };

/**
 * Names each avatar circle as "Avatar tone size", "AvatarGroup Avatar tone size" or "AvatarGroup counter size" with the
 * initials it shows. `skip` marks an avatar that shows an image or no text. Runs in the page.
 */
function describeAvatars(els, sizes) {
	return els.map((el) => {
		const label = el.textContent.trim();
		const skip = Boolean(el.querySelector("img")) || !label;
		const cls = el.className.split(/\s+/);
		const size = cls.map((c) => sizes[c]).find(Boolean);
		const grouped = el.parentElement?.getAttribute("role") === "img";
		const tone =
			el.className.match(/\bbg-(green|blue|amber|magenta|violet|teal)-100\b/)?.[1] ??
			(cls.includes("bg-surface-2") ? "ink" : null);
		let name = null;
		if (grouped && cls.includes("bg-ink") && label.startsWith("+")) name = `AvatarGroup counter ${size}`;
		else if (tone && size)
			name = [grouped ? "AvatarGroup Avatar" : "Avatar", tone, size, el.className.includes("green-500") ? "ring" : ""]
				.filter(Boolean)
				.join(" ");
		return { name, label, skip };
	});
}

/**
 * Opens the gallery in `theme`, checks it renders every variant, and asserts each chip and avatar label at AA at 1440
 * and 390 px.
 */
async function measureTheme(theme) {
	await withPage(chromium, async (page, context) => {
		await context.addCookies([{ name: "ef-theme", value: theme, url: BASE }]);
		await page.goto(`${BASE}/design/display`);
		await hydrated(page);
		assert.equal(await page.locator("html").getAttribute("data-theme"), theme, `the gallery shows its ${theme} theme`);
		const section = page.getByRole("region", { name: SECTION });
		// The chips sit in the specimens' wrapping rows; avatars (images, or hidden in a group) are found apart.
		const chips = section.locator(".flex-wrap > span:not([role='img']):not([aria-hidden='true'])");
		await chips.first().waitFor();
		const chipsFound = (await chips.evaluateAll(describeChips)).map((chip, i) => ({ ...chip, at: chips.nth(i) }));
		const unnamed = chipsFound.filter((chip) => !chip.name).map((chip) => chip.label);
		assert.deepEqual(unnamed, [], "every chip in the section is a StatusBadge, DeltaChip, Tag or StageChip");
		// Every round grid in the section is an Avatar or the AvatarGroup counter. The label measured is the span that
		// holds its initials, so the circle's edge, which the next avatar in a group overlaps, is not read as text.
		const avatars = section.locator("span.grid.rounded-full");
		const avatarsFound = (await avatars.evaluateAll(describeAvatars, AVATAR_SIZES))
			.map((avatar, i) => ({ ...avatar, at: avatars.nth(i).locator(":scope > span") }))
			.filter((avatar) => !avatar.skip);
		const unnamedAvatars = avatarsFound.filter((avatar) => !avatar.name).map((avatar) => avatar.label);
		assert.deepEqual(unnamedAvatars, [], "every avatar label in the section is named by tone and size");
		const found = [...chipsFound, ...avatarsFound];
		const names = found.map((chip) => chip.name);
		assert.deepEqual(
			GALLERY.filter((name) => !names.includes(name)),
			[],
			"the gallery still renders every badge, chip and avatar variant",
		);

		const failures = [];
		for (const width of [1440, 390]) {
			// Load the gallery at each width: right after a resize it still reflows.
			await page.setViewportSize({ width, height: 900 });
			await page.reload();
			await hydrated(page);
			for (const { name, label, at } of found) {
				// The app shell's sticky header and bars cover the viewport's edges, so each label is measured mid-screen.
				await at.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
				const measured = await contrastOf(at);
				const seen = `${name} "${label}", ${width} px, ${theme} theme: ${measured.ratio}:1, text ${measured.text} on ${measured.background}, threshold ${AA}:1`;
				console.log(`INV-contrast ${seen}`);
				if (SHOTS) writeFileSync(`${SHOTS}/${name.replaceAll(" ", "-")}-${width}-${theme}.png`, measured.shot);
				if (measured.ratio < AA) failures.push(seen);
			}
		}
		assert.deepEqual(failures, [], `every badge, chip and avatar label reads at ${AA}:1 or more in the ${theme} theme`);
	});
}

for (const theme of ["dark", "light"]) {
	test(
		`INV-contrast: every badge, chip and avatar label on /design/display reads at ${AA}:1 in the ${theme} theme (Chromium, 1440 and 390 px)`,
		{ timeout: 180_000 },
		() => measureTheme(theme),
	);
}
