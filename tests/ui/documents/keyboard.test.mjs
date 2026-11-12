// T-122: the Church Document toolbar with the keyboard, its class overrides and its overlays, in Chromium against a
// real preview. The toolbar is one Tab stop, the arrow keys move from the focused button and skip disabled ones, Enter
// reaches the focused button once, the caret entering a link leaves focus in the document, the call sites' sizes and
// layouts apply, and the popover, menu and tooltip open inside the product root.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/keyboard.test.mjs
// Seed People, then Settings (the Settings seed removes any brand kit, so Insert offers "Open the brand kit"):
//   tests/ui/people/seed.mts up <preview-url>, then tests/ui/settings/seed.mts up
// SHOT_DIR names a folder outside the repository for the 390 and 1440 px screenshots of each state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const PAPER = ".ef-paper .ProseMirror";
const SHOTS = process.env.SHOT_DIR;
const LINKED = "The board hears the facts";

// Radix hands focus back to the button that opened a menu or popover in a timer after the overlay unmounts, so a step
// that focuses the document right after Escape can lose focus to that button a moment later. These wait for it.
const closeMenu = async (page) => {
	await page.keyboard.press("Escape");
	await page.getByRole("menu").waitFor({ state: "detached" });
	await page.waitForFunction(() => {
		const el = document.activeElement;
		return el?.getAttribute("aria-haspopup") === "menu" && el.getAttribute("aria-expanded") === "false";
	});
};
const escapeTo = async (page, opener) => {
	await page.keyboard.press("Escape");
	await page.waitForFunction((label) => document.activeElement?.getAttribute("aria-label") === label, opener);
};

const onPage = (run, size) =>
	withPage(
		chromium,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await run(page);
		},
		size,
	);

async function fork(page) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await page.getByRole("button", { name: "New from template" }).first().click();
	await page.getByRole("button", { name: /^Conflict of Interest Policy/ }).click();
	await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
}

const frames = (page) =>
	page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Sets the selection inside the text block that starts with `starts` (offsets in characters, -1 for its end). */
async function select(page, starts, from = 0, to = from) {
	await page.locator(PAPER).evaluate(
		(el, [s, a, b]) => {
			const ed = el.editor;
			let hit = null;
			ed.state.doc.descendants((node, pos) => {
				if (!hit && node.isTextblock && node.textContent.startsWith(s)) hit = { node, pos };
				return !hit;
			});
			if (!hit) throw new Error(`no text block starts with "${s}"`);
			const size = hit.node.content.size;
			ed.chain()
				.focus()
				.setTextSelection({ from: hit.pos + 1 + (a < 0 ? size : a), to: hit.pos + 1 + (b < 0 ? size : b) })
				.run();
		},
		[starts, from, to],
	);
	await frames(page);
}

const toolbar = (page) => page.getByRole("toolbar", { name: "Document formatting" });
const button = (page, name) => toolbar(page).getByRole("button", { name, exact: true });

/** What has focus: its accessible label, and whether it is in the toolbar or in the document. */
const focused = (page) =>
	page.evaluate(() => {
		const el = document.activeElement;
		return {
			label: el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 30) ?? "",
			inToolbar: !!el?.closest('[role="toolbar"]'),
			inDocument: !!el?.closest(".ProseMirror"),
		};
	});

/** The labels of the toolbar's enabled controls, in order: what the arrow keys move across. */
const enabledLabels = (page) =>
	toolbar(page).evaluate((bar) =>
		[...bar.querySelectorAll("button:not([disabled]), [tabindex]:not([disabled])")].map((el) =>
			el.getAttribute("aria-label"),
		),
	);

const inProductRoot = (locator) => locator.evaluate((el) => !!el.closest("[data-product-root]"));
const style = (locator, ...props) =>
	locator.evaluate((el, names) => {
		const s = getComputedStyle(el);
		return Object.fromEntries(names.map((n) => [n, s.getPropertyValue(n)]));
	}, props);

/** The overlay's box is inside the window and above the toolbar and the paper at its center. */
async function usable(page, locator, what) {
	const ok = await locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const top = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 12));
		return {
			inside: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1,
			onTop: !!top && el.contains(top),
		};
	});
	assert.ok(ok.inside, `${what}: the overlay fits in the window`);
	assert.ok(ok.onTop, `${what}: the overlay is above the toolbar and the paper`);
}

const shot = async (page, width, name) => {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${width}-${name}.png` });
};

async function addLink(page) {
	await select(page, LINKED, 4, 9);
	await button(page, "Link").click();
	await page.getByPlaceholder("Paste a link...").fill("https://example.com/a");
	await page.keyboard.press("Enter");
	await page.locator(`${PAPER} a[href="https://example.com/a"]`).waitFor();
}

async function insert(page, item) {
	await button(page, "Insert block").click();
	await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("the toolbar with the keyboard, its overrides and its overlays (Chromium, 1440 px)", async (t) => {
	await onPage(async (page) => {
		await fork(page);
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));

		await t.test("criterion 1: the toolbar is one Tab stop, and Tab and Shift+Tab move in and out of it", async () => {
			await select(page, "This policy covers each board member", 0);
			const stops = await toolbar(page).evaluate((bar) => bar.querySelectorAll('[tabindex="0"]').length);
			assert.equal(stops, 1, "only one toolbar control is in the Tab order");
			// Back from the document: Shift+Tab reaches the toolbar (through the controls between them, if any).
			let at = await focused(page);
			for (let i = 0; i < 40 && !at.inToolbar; i++) {
				await page.keyboard.press("Shift+Tab");
				at = await focused(page);
			}
			assert.ok(at.inToolbar, "Shift+Tab from the document reaches the toolbar");
			const entry = at.label;
			// One more Shift+Tab leaves it for the element before it; Tab comes back to the same control.
			await page.keyboard.press("Shift+Tab");
			assert.equal((await focused(page)).inToolbar, false, "Shift+Tab leaves the toolbar for the element before it");
			await page.keyboard.press("Tab");
			at = await focused(page);
			assert.ok(at.inToolbar, "Tab moves into the toolbar");
			assert.equal(at.label, entry, "Tab enters at the same control");
			await shot(page, 1440, "toolbar-focused-button");
			// A further Tab leaves the toolbar: no trap.
			await page.keyboard.press("Tab");
			assert.equal((await focused(page)).inToolbar, false, "a further Tab leaves the toolbar");
			await page.keyboard.press("Shift+Tab");
			assert.equal((await focused(page)).label, entry, "Shift+Tab moves back into the toolbar");
		});

		await t.test("criteria 3 and 4: the arrows move from the focused button and skip disabled ones", async () => {
			await button(page, "Bold").focus();
			await page.keyboard.press("ArrowRight");
			assert.equal((await focused(page)).label, "Italic", "ArrowRight from Bold focuses Italic");
			await page.keyboard.press("ArrowLeft");
			assert.equal((await focused(page)).label, "Bold", "ArrowLeft goes back to Bold");
			// A fresh fork has no history: Undo and Redo are disabled and the arrows skip them.
			assert.ok(await button(page, "Undo").isDisabled(), "Undo starts disabled");
			const before = await enabledLabels(page);
			assert.ok(!before.includes("Undo") && !before.includes("Redo"), "the disabled buttons are not in the list");
			await button(page, "Text style").focus();
			await page.keyboard.press("ArrowLeft");
			assert.equal((await focused(page)).label, before.at(-1), "ArrowLeft from Text style skips Undo and Redo");
			// An edit turns Undo on: it rejoins the list right before Text style.
			await select(page, "This policy covers each board member", 0);
			await page.keyboard.type("A");
			await button(page, "Undo").waitFor({ state: "attached" });
			await page.waitForFunction(() => !document.querySelector('[aria-label="Undo"]')?.disabled);
			await button(page, "Text style").focus();
			await page.keyboard.press("ArrowLeft");
			assert.equal((await focused(page)).label, "Undo", "Undo rejoins the list once it turns on");
			// Enter on Undo undoes the edit once, and Undo turns off again.
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => document.querySelector('[aria-label="Undo"]')?.disabled === true);
			const text = await page.locator(PAPER).evaluate((el) => el.editor.getText());
			assert.ok(text.includes("This policy covers each board member"), "Enter on Undo undid the typed letter");
			assert.ok(!text.includes("AThis policy"), "the typed letter is gone");
			await button(page, "Text style").focus();
			await page.keyboard.press("ArrowLeft");
			assert.notEqual((await focused(page)).label, "Undo", "Undo leaves the list once it turns off");
		});

		await t.test("criterion 2: Enter activates the focused button natively, once", async () => {
			await select(page, "This policy covers each board member", 5, 11);
			await button(page, "Bold").focus();
			await page.keyboard.press("Enter");
			const bold = await page
				.locator(PAPER)
				.evaluate((el) => el.editor.isActive("bold") && el.editor.state.selection.content().size > 0);
			assert.ok(bold, "Enter on Bold made the selection bold (one toggle, not two)");
			await page.keyboard.press(`ControlOrMeta+Z`);
			// Enter on Text style opens its menu; Escape closes it and gives focus back to the button.
			await select(page, "This policy covers each board member", 0);
			await button(page, "Text style").focus();
			await page.keyboard.press("Enter");
			const menu = page.getByRole("menu", { name: "Text style" });
			await menu.waitFor();
			assert.ok(await inProductRoot(menu), "criterion 8: the menu renders inside the product root");
			await usable(page, menu, "Text style menu");
			await shot(page, 1440, "text-style-menu");
			await escapeTo(page, "Text style");
			assert.equal(await menu.count(), 0, "criterion 9: Escape closes the Text style menu");
			assert.equal((await focused(page)).label, "Text style", "criterion 9: Escape gives focus back to Text style");
		});

		await t.test("criteria 5 and 6: the caret entering a link keeps focus in the document", async () => {
			await addLink(page);
			const popover = page.getByPlaceholder("Paste a link...");
			await popover.waitFor({ state: "detached" });
			// The arrow keys move the caret into the link.
			await select(page, LINKED, 2);
			await page.keyboard.press("ArrowRight");
			await page.keyboard.press("ArrowRight");
			await page.keyboard.press("ArrowRight");
			await frames(page);
			assert.ok(await page.locator(PAPER).evaluate((el) => el.editor.isActive("link")), "the caret is in the link");
			assert.ok((await focused(page)).inDocument, "focus stays in the document after arrowing into a link");
			assert.equal(await popover.count(), 0, "the link popover stays closed");
			// A click in the link does the same.
			await page.locator(`${PAPER} a[href="https://example.com/a"]`).click();
			await frames(page);
			assert.ok((await focused(page)).inDocument, "focus stays in the document after a click in a link");
			assert.equal(await popover.count(), 0, "the link popover stays closed after the click");
			// The Link button opens the popover for the link under the caret, and editing it still works.
			await button(page, "Link").click();
			await popover.waitFor();
			assert.equal(await popover.inputValue(), "https://example.com/a", "the popover shows the current address");
			const card = page.locator("[data-radix-popper-content-wrapper]").filter({ has: popover });
			assert.ok(await inProductRoot(card), "criterion 8: the link popover renders inside the product root");
			await usable(page, card, "link popover");
			await shot(page, 1440, "link-popover");
			await popover.fill("https://example.com/b");
			await page.keyboard.press("Enter");
			await page.locator(`${PAPER} a[href="https://example.com/b"]`).waitFor();
			// Escape closes the popover and gives focus back to the Link button.
			await select(page, LINKED, 6);
			await button(page, "Link").click();
			await popover.waitFor();
			await escapeTo(page, "Link");
			assert.equal(await popover.count(), 0, "criterion 9: Escape closes the link popover");
			assert.equal((await focused(page)).label, "Link", "criterion 9: Escape gives focus back to the Link button");
		});

		await t.test("criterion 8: the tooltip renders inside the product root", async () => {
			await button(page, "Italic").hover();
			const tip = page.getByRole("tooltip").filter({ hasText: "Italic" });
			await tip.waitFor();
			assert.ok(await inProductRoot(tip), "the tooltip renders inside the product root");
			await usable(page, tip, "tooltip");
			await shot(page, 1440, "tooltip");
			await page.mouse.move(0, 0);
		});

		await t.test("criterion 7: the six class overrides show in computed styles", async (st) => {
			// Toolbar.tsx: the Text style button.
			const textStyle = await style(button(page, "Text style"), "justify-content", "min-width", "height");
			assert.deepEqual(
				textStyle,
				{ "justify-content": "space-between", "min-width": "104px", height: "36px" },
				"Text style: space-between, 104 px wide at least, 36 px tall",
			);
			// Toolbar.tsx: the merge field items and the inline brand kit link of the Insert menu.
			await select(page, "This policy covers each board member", 0);
			await button(page, "Insert block").click();
			const insertMenu = page.getByRole("menu", { name: "Insert block" });
			await insertMenu.waitFor();
			const field = insertMenu
				.getByRole("menuitem")
				.filter({ hasText: /Church name/ })
				.first();
			assert.deepEqual(
				await style(field, "flex-direction", "align-items", "column-gap"),
				{ "flex-direction": "column", "align-items": "flex-start", "column-gap": "normal" },
				"a merge field item stacks its name over its value",
			);
			const kit = insertMenu.getByRole("menuitem", { name: "Open the brand kit" }).first();
			// The link shows only while the brand kit lacks an image. Suites share one seed and layout.test.mjs fills the kit,
			// so on a seed whose kit is complete there is no link to measure.
			if (!(await kit.count())) st.diagnostic("the brand kit has every image: no inline brand kit link to check");
			else
				assert.deepEqual(
					await style(kit, "display", "padding-left", "padding-top", "text-decoration-line", "font-size"),
					{
						display: "inline-flex",
						"padding-left": "0px",
						"padding-top": "2px",
						"text-decoration-line": "underline",
						"font-size": await page.evaluate(() => {
							const probe = document.createElement("span");
							probe.className = "text-sm";
							document.querySelector("[data-product-root]").append(probe);
							const size = getComputedStyle(probe).fontSize;
							probe.remove();
							return size;
						}),
					},
					"the brand kit link is an inline underlined link with no side padding",
				);
			await closeMenu(page);
			// LayoutControls.tsx and ControlParts.tsx: the block settings bar of a columns block and its count buttons.
			await insert(page, "2 columns");
			const bar = page.getByRole("group", { name: "Block settings" });
			await bar.waitFor();
			assert.deepEqual(
				await style(bar, "flex-wrap", "overflow-x", "border-top-width", "border-bottom-width"),
				{ "flex-wrap": "wrap", "overflow-x": "visible", "border-top-width": "1px", "border-bottom-width": "0px" },
				"the block settings bar wraps, with a line on top and none under it",
			);
			const count = bar.getByRole("radio", { name: "2 columns" });
			assert.deepEqual(
				await style(count, "height", "min-width", "padding-left"),
				{ height: "32px", "min-width": "32px", "padding-left": "10px" },
				"a Segmented button is 32 px tall",
			);
			await shot(page, 1440, "layout-controls");
			// TableControls.tsx: the table action buttons.
			await select(page, "This policy covers each board member", 0);
			await insert(page, "Table");
			const addRow = page.getByRole("button", { name: "Add row below", exact: true });
			await addRow.waitFor();
			assert.deepEqual(
				await style(addRow, "height", "padding-left"),
				{ height: "32px", "padding-left": "10px" },
				"a table action button is 32 px tall",
			);
			await shot(page, 1440, "table-controls");
		});

		assert.deepEqual(errors, [], "no page errors");
	});
});

test("at 390 px the overlays open inside the product root, fit and stay usable (Chromium)", async (t) => {
	await onPage(
		async (page) => {
			await fork(page);
			await t.test("the focused toolbar button, the Text style menu, the tooltip and the link popover", async () => {
				await select(page, "This policy covers each board member", 0);
				await button(page, "Text style").focus();
				await shot(page, 390, "toolbar-focused-button");
				await page.keyboard.press("Enter");
				const menu = page.getByRole("menu", { name: "Text style" });
				await menu.waitFor();
				assert.ok(await inProductRoot(menu), "the menu renders inside the product root");
				await usable(page, menu, "Text style menu");
				await shot(page, 390, "text-style-menu");
				await menu.getByRole("menuitem", { name: "Lead", exact: true }).click();
				await menu.waitFor({ state: "detached" });
				assert.ok(
					await page.locator(PAPER).evaluate((el) => el.editor.state.selection.$from.parent.attrs.style === "lead"),
					"a menu item still applies at 390 px",
				);
				await button(page, "Bold").hover();
				const tip = page.getByRole("tooltip").filter({ hasText: "Bold" });
				await tip.waitFor();
				assert.ok(await inProductRoot(tip), "the tooltip renders inside the product root");
				await shot(page, 390, "tooltip");
				await page.mouse.move(0, 0);
				await button(page, "Link").scrollIntoViewIfNeeded();
				await addLink(page);
				await select(page, LINKED, 6);
				await button(page, "Link").click();
				const popover = page.getByPlaceholder("Paste a link...");
				await popover.waitFor();
				const card = page.locator("[data-radix-popper-content-wrapper]").filter({ has: popover });
				assert.ok(await inProductRoot(card), "the link popover renders inside the product root");
				await usable(page, card, "link popover");
				await shot(page, 390, "link-popover");
				await escapeTo(page, "Link");
			});
			await t.test("the layout controls bar and the table controls", async () => {
				await select(page, "This policy covers each board member", 0);
				await insert(page, "2 columns");
				await page.getByRole("group", { name: "Block settings" }).waitFor();
				await shot(page, 390, "layout-controls");
				await select(page, "This policy covers each board member", 0);
				await insert(page, "Table");
				await page.getByRole("button", { name: "Add row below", exact: true }).waitFor();
				await page.getByRole("group", { name: "Block settings" }).scrollIntoViewIfNeeded();
				await shot(page, 390, "table-controls");
			});
		},
		{ width: 390, height: 844 },
	);
});
