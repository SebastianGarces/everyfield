// WP-036 slice 3: layout and page setup in the Church Document editor, in Chromium against a real preview. Every action
// runs on a forked document; after each action, after Undo and after Redo the whole document JSON, `page` included, is
// checked: Undo gives the earlier JSON exactly, Redo gives the later JSON exactly, and each one parses with docDocument.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/layout.test.mjs
// Seed People, then Settings (the Settings seed removes any brand kit, so the first test starts with none):
//   tests/ui/people/seed.mts up <preview-url>, then tests/ui/settings/seed.mts up
// Tests run in file order: the first one sees no brand kit, the next ones add its colors, logo, mark and cover photo.
//   AC:DOC-LAYOUT-MISSING   criterion 6 (an asset the kit lacks: disabled menu item, reason and link)
//   AC:DOC-LAYOUT-ACTIONS   criteria 1 to 3, 5 to 10 and 11 (every action with Undo and Redo)
//   AC:DOC-LAYOUT-COLORS    criterion 4 (the paper paints each token as the renderer's palette does)
//   AC:DOC-LAYOUT-FILES     criteria 6 and 12 (PDF and Word of one document that holds all of it)
//   AC:DOC-LAYOUT-CARDS     criteria 8 and 12 (4 per sheet with cut marks in the editor, preview, PDF and Word)
//   AC:DOC-LAYOUT-ACCESS    criterion 13 (names, tooltips, cursors, 390 px, a Member)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { makePalette } from "../../../packages/domain/src/documents/theme.ts";
import { documentFrom } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { docxMedia, docxParts, pdfPages, wordText } from "../../integration/documents/fixtures/readers.mts";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MOD = "ControlOrMeta";
const LOG = process.env.CHECK_LOG;
const SHOTS = process.env.SHOT_DIR;
const PAPER = ".ef-paper .ProseMirror";
const slug = (text) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
let shotCount = 0;

const baseDoc = (id) => forkTemplate(docTemplateById(id), { data: {} });
const bases = { policy: await baseDoc("conflict-of-interest-policy"), card: await baseDoc("commitment-card") };

const PRIMARY = "#1F4E6B";
const ACCENT = "#D4731A";
const palette = makePalette({ name: "church", primary: PRIMARY, accent: ACCENT });

const svg = (inner, w = 900, h = 600) =>
	Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`,
	);
const ASSETS = {
	full_logo: [
		"logo.svg",
		svg(`<rect x="300" y="250" width="300" height="100" rx="12" fill="${PRIMARY}"/>`),
		"Harvest Point logo",
	],
	mark: ["mark.svg", svg(`<circle cx="450" cy="300" r="90" fill="${PRIMARY}"/>`), "Harvest Point mark"],
	cover_photo: [
		"cover.svg",
		svg(
			'<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1F4E79"/><stop offset="1" stop-color="#D4A017"/></linearGradient></defs><rect width="900" height="600" fill="url(#g)"/>',
		),
		"Harvest Point cover photo",
	],
};

const onPage = (run, size, who = "owner") =>
	withPage(
		chromium,
		async (page, context) => {
			await signIn(context, fixture("people")[who].cookie);
			await run(page, context);
		},
		size,
	);

/** Sets the brand kit through the Brand kit screen: colors, then each named image (full_logo, mark, cover_photo). */
async function brandKit(page, { colors = true, images = [] } = {}) {
	await page.goto(`${BASE}/settings/brand`, { waitUntil: "networkidle" });
	await page.getByRole("heading", { name: "Logos and images" }).waitFor({ timeout: 60_000 });
	await hydrated(page);
	const slotOf = (name) => page.locator(`[data-slot-name="${name}"]`);
	for (const name of images) {
		const [file, buffer, alt] = ASSETS[name];
		await slotOf(name).locator('input[type="file"]').setInputFiles({ name: file, mimeType: "image/svg+xml", buffer });
		await slotOf(name)
			.getByLabel(/description/)
			.fill(alt);
		await slotOf(name).getByRole("button", { name: "Upload" }).click();
		await slotOf(name).getByRole("img", { name: alt }).first().waitFor();
		await page.waitForLoadState("networkidle");
	}
	if (colors) {
		await page.getByRole("textbox", { name: "Primary color", exact: true }).fill(PRIMARY);
		await page.getByRole("textbox", { name: "Accent color · Optional", exact: true }).fill(ACCENT);
	}
	const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.url().startsWith(BASE));
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await saved;
	await page.getByText("No unsaved changes.").waitFor();
}

/** Opens a new fork of a built-in template through "New from template" and waits for its editor. */
async function fork(page, title) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await page.getByRole("button", { name: "New from template" }).first().click();
	await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
	await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
	return new URL(page.url()).pathname;
}

const rawJson = (page) => page.locator(PAPER).evaluate((el) => el.editor.getJSON());
const snapshot = async (page, base = bases.policy) => documentFrom(base, await rawJson(page));
const button = (page, name) => page.getByRole("button", { name, exact: true });
const top = async (page) => (await snapshot(page)).body.content ?? [];

/** Lets the browser apply a cursor move before the next key: typing straight after it can otherwise be dropped. */
const settle = (page) =>
	page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/** Puts the cursor in the text block that starts with `starts`, `offset` characters in (-1 for the end). */
async function cursorIn(page, starts, offset = -1) {
	await page.locator(PAPER).evaluate(
		(el, [s, at]) => {
			const ed = el.editor;
			let hit = null;
			ed.state.doc.descendants((node, pos) => {
				if (!hit && node.isTextblock && node.textContent.startsWith(s)) hit = { node, pos };
				return !hit;
			});
			if (!hit) throw new Error(`no text block starts with "${s}"`);
			const pos = hit.pos + 1 + (at < 0 ? hit.node.content.size : at);
			ed.chain().focus().setTextSelection(pos).run();
		},
		[starts, offset],
	);
}

/** Puts the cursor in the first text block inside the n-th node of `type` (document order). */
async function cursorInside(page, type, n = 0) {
	await page.locator(PAPER).evaluate(
		(el, [t, index]) => {
			const ed = el.editor;
			let seen = -1;
			let target = null;
			ed.state.doc.descendants((node, pos) => {
				if (target) return false;
				if (node.type.name === t && ++seen === index) {
					let inner = null;
					node.descendants((child, offset) => {
						if (!inner && child.isTextblock) inner = pos + 1 + offset + 1;
						return !inner;
					});
					target = inner;
				}
				return !target;
			});
			if (target === null) throw new Error(`no ${t} number ${index}`);
			ed.chain().focus().setTextSelection(target).run();
		},
		[type, n],
	);
}

/** The columns block these tests add: the one right after the paragraph "The board makes decisions". */
const ours = (doc) => {
	const blocks = doc.body.content;
	const at = blocks.findIndex(
		(n) => n.type === "paragraph" && n.content?.[0]?.text?.startsWith("The board makes decisions"),
	);
	return blocks[at + 1]?.type === "columns" ? blocks[at + 1] : undefined;
};

/** Puts the cursor in the first text block of the k-th column of our columns block. */
async function cursorInColumn(page, k) {
	await page.locator(PAPER).evaluate((el, column) => {
		const ed = el.editor;
		const doc = ed.state.doc;
		let target = null;
		let offset = 0;
		doc.forEach((child, _o, i) => {
			const prev = i > 0 ? doc.child(i - 1) : null;
			if (child.type.name === "columns" && prev?.textContent.startsWith("The board makes decisions")) {
				let at = offset + 1;
				child.forEach((col, _x, ci) => {
					if (ci === column) {
						col.descendants((inner, o) => {
							if (target === null && inner.isTextblock) target = at + 1 + o + 1;
							return target === null;
						});
					}
					at += col.nodeSize;
				});
			}
			offset += child.nodeSize;
		});
		if (target === null) throw new Error(`no column ${column} in our columns block`);
		ed.chain().focus().setTextSelection(target).run();
	}, k);
}

/** Selects the n-th node of `type` as a block (a divider, an image, a write-in line). */
async function selectNode(page, type, n = 0) {
	await page.locator(PAPER).evaluate(
		(el, [t, index]) => {
			const ed = el.editor;
			let seen = -1;
			let at = null;
			ed.state.doc.descendants((node, pos) => {
				if (at !== null) return false;
				if (node.type.name === t && ++seen === index) at = pos;
				return at === null;
			});
			if (at === null) throw new Error(`no ${t} number ${index}`);
			ed.chain().focus().setNodeSelection(at).run();
		},
		[type, n],
	);
}

/**
 * One action, checked three times. `act` runs the action; the whole JSON after it, after Undo and after Redo must parse
 * with docDocument, and Undo and Redo must give back the earlier and the later JSON exactly. `shot` names a screenshot
 * of the state after the action (SHOT_DIR, outside the repository): the hand-check table links it.
 */
async function checked(page, name, act, { base = bases.policy } = {}) {
	const before = await snapshot(page, base);
	await act();
	const after = await snapshot(page, base);
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${String(++shotCount).padStart(2, "0")}-${slug(name)}.png` });
	assert.ok(docDocument.safeParse(after).success, `${name}: the changed document parses with docDocument`);
	assert.notDeepEqual(after, before, `${name}: the action changed the document`);
	await button(page, "Undo").click();
	const undone = await snapshot(page, base);
	assert.deepEqual(undone, before, `${name}: Undo gives the earlier JSON`);
	assert.ok(docDocument.safeParse(undone).success, `${name}: the undone document parses`);
	await button(page, "Redo").click();
	const redone = await snapshot(page, base);
	assert.deepEqual(redone, after, `${name}: Redo gives the later JSON`);
	assert.ok(docDocument.safeParse(redone).success, `${name}: the redone document parses`);
	if (LOG) appendFileSync(LOG, `${JSON.stringify({ action: name, undo: "exact", redo: "exact" })}\n`);
	return { before, after };
}

/** Types text and waits until the editor holds it, so the next move of the cursor cannot drop it. */
const type = async (page, text) => {
	await settle(page);
	await page.keyboard.type(text);
	await page.waitForFunction(
		(t) => document.querySelector(".ef-paper .ProseMirror").editor.state.doc.textContent.includes(t),
		text,
	);
};
const insert = async (page, item) => {
	await button(page, "Insert block").click();
	await page.getByRole("menuitem", { name: item, exact: true }).click();
};
const items = async (page) => {
	await button(page, "Insert block").click();
	const names = await page.getByRole("menuitem").allInnerTexts();
	await page.keyboard.press("Escape");
	await page.getByRole("menu").waitFor({ state: "detached" });
	return names.map((n) => n.trim());
};
const radio = (page, name) => page.getByRole("radio", { name, exact: true });
const panel = (page) => page.getByRole("region", { name: "Page setup" });
const openSetup = async (page) => {
	if (!(await panel(page).count())) await button(page, "Page setup").click();
	await panel(page).waitFor();
};
const walk = (nodes, visit) => {
	for (const node of nodes ?? []) {
		visit(node);
		walk(node.content, visit);
	}
};
const nodesOf = (doc, type) => {
	const found = [];
	walk(doc.body.content, (n) => n.type === type && found.push(n));
	return found;
};

// ------------------------------------------------------------------------------------------------ criterion 6, no kit

test("AC:DOC-LAYOUT-MISSING: with no brand kit, Logo, Mark and Photo are disabled with a reason and a link (Chromium)", async () => {
	await onPage(async (page) => {
		await fork(page, "Conflict of Interest Policy");
		await cursorIn(page, "The board makes decisions");
		await button(page, "Insert block").click();
		for (const name of ["Logo", "Mark", "Photo"]) {
			const item = page.getByRole("menuitem", { name, exact: true });
			assert.equal(await item.getAttribute("aria-disabled"), "true", `${name} is disabled`);
			assert.equal(
				await item.evaluate((el) => getComputedStyle(el).cursor),
				"not-allowed",
				`${name} shows not-allowed`,
			);
		}
		assert.equal(
			await page.getByRole("menuitem", { name: "Open the brand kit" }).count(),
			3,
			"each one links to the brand kit",
		);
		const link = page.getByRole("menuitem", { name: "Open the brand kit" }).first();
		assert.equal(await link.getAttribute("href"), "/settings/brand");
		await page.keyboard.press("Escape");
	});
});

// ------------------------------------------------------------------------------------------------ the brand kit

test("the brand kit gets its colors, a logo and a mark (no cover photo yet)", async () => {
	await onPage(async (page) => {
		await brandKit(page, { images: ["full_logo", "mark"] });
	});
});

// ------------------------------------------------------------------------------------------------ criteria 1 to 3, 5 to 10, 11

test("AC:DOC-LAYOUT-ACTIONS: every layout and page setup action is checked with Undo and Redo on a forked policy (Chromium)", async (t) => {
	await onPage(async (page) => {
		await fork(page, "Conflict of Interest Policy");
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await button(page, "Undo").waitFor();

		await t.test("criterion 1: columns", async () => {
			for (const count of [2, 3, 4]) {
				await checked(page, `insert ${count} columns`, async () => {
					await cursorIn(page, "The board makes decisions");
					await insert(page, `${count} columns`);
				});
				// The newest block sits right after the paragraph, so it is the first columns block.
				assert.equal(ours(await snapshot(page))?.content?.length, count, `${count} columns were added`);
			}
			// Each column takes typing. The block is after the block that held the cursor.
			await cursorInColumn(page, 0);
			await type(page, "Left text");
			await cursorInColumn(page, 1);
			await type(page, "Middle text");
			assert.ok(ours(await snapshot(page)), "Insert adds the columns after the current block");
			// The editor shows the columns side by side at the widths the PDF uses: equal shares of the width after the gaps.
			const rects = await page
				.locator(`${PAPER} > [data-ef-node="columns"]`)
				.nth(1)
				.evaluate((el) => {
					const box = el.getBoundingClientRect();
					return {
						width: box.width,
						gap: parseFloat(getComputedStyle(el).columnGap),
						columns: [...el.children].map((c) => ({
							x: c.getBoundingClientRect().x - box.x,
							w: c.getBoundingClientRect().width,
						})),
					};
				});
			const share = (rects.width - rects.gap * (rects.columns.length - 1)) / rects.columns.length;
			for (const c of rects.columns) assert.ok(Math.abs(c.w - share) < 1, `a column is ${c.w} px wide, not ${share}`);
			assert.ok(rects.columns[1].x > rects.columns[0].x + rects.columns[0].w - 1, "the columns sit side by side");
			// The Insert menu inside a column offers only the blocks a column holds.
			await cursorInColumn(page, 0);
			const inside = await items(page);
			for (const gone of ["Page break", "2 columns", "3 columns", "4 columns"])
				assert.ok(!inside.includes(gone), `inside a column the menu has no ${gone}`);
			for (const kept of ["Paragraph", "Colored box", "Accent bar", "Write-in line", "Logo"])
				assert.ok(inside.includes(kept), `inside a column the menu keeps ${kept}`);
			assert.equal(await button(page, "Page break").isDisabled(), true, "Page break is off inside a column");
		});

		await t.test("criterion 1: the count of columns goes up and down, and no content is lost", async () => {
			await cursorInColumn(page, 2);
			await type(page, "Third");
			await cursorInColumn(page, 3);
			await type(page, "Fourth");
			await checked(page, "4 columns to 3: the removed column's blocks join the one on its left", async () => {
				await cursorInColumn(page, 0);
				await radio(page, "3 columns").click();
			});
			const three = ours(await snapshot(page));
			assert.equal(three.content.length, 3);
			assert.deepEqual(
				three.content[2].content.map((p) => p.content?.[0]?.text),
				["Third", "Fourth"],
				"the fourth column's text moved to the end of the third",
			);
			await checked(page, "3 columns to 2", async () => {
				await cursorInColumn(page, 0);
				await radio(page, "2 columns").click();
			});
			const two = ours(await snapshot(page));
			assert.deepEqual(
				two.content[1].content.map((p) => p.content?.[0]?.text),
				["Middle text", "Third", "Fourth"],
				"no text was lost going down to 2",
			);
			await checked(page, "2 columns to 4", async () => {
				await cursorInColumn(page, 0);
				await radio(page, "4 columns").click();
			});
			const four = ours(await snapshot(page));
			assert.equal(four.content.length, 4);
			assert.ok(
				four.content.every((c) => c.attrs?.width === undefined),
				"the widths are equal after a change",
			);
		});

		await t.test("criterion 2: a colored box", async () => {
			await checked(page, "insert a colored box", async () => {
				await cursorIn(page, "The member explains");
				await insert(page, "Colored box");
			});
			await cursorInside(page, "box", 0);
			await type(page, "Boxed text");
			for (const token of ["primary", "accent", "muted"]) {
				await checked(page, `box fill ${token}`, async () => {
					await cursorInside(page, "box", 0);
					await page
						.getByRole("radiogroup", { name: "Box fill" })
						.getByRole("radio", { name: token, exact: true })
						.click();
				});
			}
			await checked(page, "box border ink", async () => {
				await cursorInside(page, "box", 0);
				await page
					.getByRole("radiogroup", { name: "Box border" })
					.getByRole("radio", { name: "ink", exact: true })
					.click();
			});
			const box = nodesOf(await snapshot(page), "box")[0];
			assert.equal(box.attrs.fill, "muted");
			assert.equal(box.attrs.border, "ink");
			// The box takes the blocks the format allows in a box, and not a box or a page break.
			await cursorInside(page, "box", 0);
			const inside = await items(page);
			assert.ok(inside.includes("2 columns") && inside.includes("Quote"), "a box holds columns and a quote");
			assert.ok(
				!inside.includes("Colored box") && !inside.includes("Page break"),
				"a box holds no box and no page break",
			);
		});

		await t.test("criterion 3: the accent bar and the divider control", async () => {
			await checked(page, "insert an accent bar", async () => {
				await cursorIn(page, "The secretary writes");
				await insert(page, "Accent bar");
			});
			assert.ok(
				nodesOf(await snapshot(page), "divider").some((d) => d.attrs?.weight === "bar" && d.attrs?.color === "accent"),
			);
			for (const [from, weight] of [
				["bar", "Hairline"],
				["hairline", "Rule"],
			]) {
				await checked(page, `divider weight ${weight}`, async () => {
					await selectNode(page, "divider", await dividerIndexOf(page, { weight: from, color: "accent" }));
					await page
						.getByRole("radiogroup", { name: "Divider weight" })
						.getByRole("radio", { name: `${weight} weight` })
						.click();
				});
			}
			await checked(page, "divider color primary", async () => {
				await selectNode(page, "divider", await dividerIndexOf(page, { weight: "rule", color: "accent" }));
				await page
					.getByRole("radiogroup", { name: "Divider color" })
					.getByRole("radio", { name: "primary", exact: true })
					.click();
			});
		});

		await t.test("criterion 5: write-in, signature and date lines with unique keys", async () => {
			for (const [item, kind] of [
				["Write-in line", "text"],
				["Signature line", "signature"],
				["Date line", "date"],
			]) {
				await checked(page, `insert a ${item.toLowerCase()}`, async () => {
					await cursorIn(page, "The member explains");
					await insert(page, item);
				});
				assert.ok(nodesOf(await snapshot(page), "writeIn").some((n) => n.attrs.kind === kind));
			}
			await checked(page, "edit a write-in label", async () => {
				const input = page.getByLabel("Label of this write-in line");
				await input.fill("Full name");
				await input.press("Enter");
			});
			// A second write-in line, and a copied and pasted one, each get a key no other line uses.
			await checked(page, "insert a second write-in line", async () => {
				await cursorIn(page, "The member explains");
				await insert(page, "Write-in line");
			});
			await checked(page, "copy and paste a write-in line", async () => {
				await selectNode(page, "writeIn", 0);
				await page.keyboard.press(`${MOD}+C`);
				await cursorIn(page, "The secretary writes");
				await page.keyboard.press(`${MOD}+V`);
			});
			const keys = nodesOf(await snapshot(page), "writeIn").map((n) => n.attrs.key ?? "name");
			assert.equal(new Set(keys).size, keys.length, `every write-in key is unique: ${keys.join(", ")}`);
			assert.ok(keys.length >= 5, "all five lines are there");
		});

		await t.test("criterion 6: Logo and Mark from the brand kit, with the image control", async () => {
			for (const [item, source] of [
				["Logo", "logo"],
				["Mark", "mark"],
			]) {
				await checked(page, `insert the ${item.toLowerCase()}`, async () => {
					await cursorIn(page, "The member explains");
					await insert(page, item);
				});
				assert.ok(nodesOf(await snapshot(page), "image").some((n) => n.attrs.source === source));
				await page.locator(`${PAPER} [data-ef-node="image"][data-source="${source}"] img`).first().waitFor();
				assert.ok(
					await page
						.locator(`${PAPER} [data-ef-node="image"][data-source="${source}"] img`)
						.first()
						.evaluate((img) => img.src.includes("/api/brand/assets/")),
					"the image comes from the brand asset route",
				);
			}
			// The cover photo is missing from the kit: its item is disabled with the reason.
			await button(page, "Insert block").click();
			assert.equal(
				await page.getByRole("menuitem", { name: "Photo", exact: true }).getAttribute("aria-disabled"),
				"true",
			);
			await page.getByText("Your brand kit has no cover photo.").waitFor();
			await page.keyboard.press("Escape");
			await checked(page, "image height", async () => {
				await selectNode(page, "image", 0);
				await page.getByLabel("Height (pt)").fill("60");
			});
			await checked(page, "image alignment", async () => {
				await selectNode(page, "image", 0);
				await page
					.getByRole("radiogroup", { name: "Image alignment" })
					.getByRole("radio", { name: "Align center" })
					.click();
			});
		});

		await t.test("criterion 7: the page setup panel: paper size, orientation and margins", async () => {
			await openSetup(page);
			await checked(page, "paper size Legal", async () => {
				await page.getByRole("combobox", { name: "Paper size" }).click();
				await page.getByRole("option", { name: "Legal" }).click();
			});
			await checked(page, "orientation landscape", async () => {
				await radio(page, "Landscape").click();
			});
			assert.equal(
				await page.locator(".ef-paper").evaluate((el) => getComputedStyle(el).getPropertyValue("--page-w")),
				"1344.00px",
				"the paper page is Legal landscape: 1008 pt",
			);
			await checked(page, "top margin 0.5 in", async () => {
				await page.getByLabel("Top margin").fill("0.5");
			});
			assert.equal((await snapshot(page)).page.margin.top, 36, "0.5 in is stored as 36 pt");
			await checked(page, "custom paper size", async () => {
				await page.getByRole("combobox", { name: "Paper size" }).click();
				await page.getByRole("option", { name: "Custom" }).click();
			});
			await checked(page, "custom width 6 in", async () => {
				await page.getByLabel("Width", { exact: true }).fill("6");
			});
			assert.equal((await snapshot(page)).page.width, 432);
			// A value the format refuses shows the format's message next to the field and is not applied.
			const before = await snapshot(page);
			await page.getByLabel("Width", { exact: true }).fill("2");
			await panel(page).getByText("the margins leave less than 72 pt for the content").waitFor();
			assert.deepEqual(await snapshot(page), before, "a refused width is not applied");
			await page.getByLabel("Left margin").fill("4");
			await panel(page)
				.getByText(/is outside 0 to 144/)
				.waitFor();
			assert.deepEqual(await snapshot(page), before, "a refused margin is not applied");
			await page.getByLabel("Left margin").fill("0.75");
			assert.equal((await snapshot(page)).page.margin.left, 54, "a valid value applies again");
		});

		await t.test("criteria 9 and 10: header, footer and page numbers", async () => {
			await openSetup(page);
			const policy = await snapshot(page);
			assert.ok(policy.page.footer, "the policy forks with a footer");
			await checked(page, "turn the header on", async () => {
				await panel(page).getByRole("switch", { name: "Header" }).click();
			});
			await page.locator(`${PAPER} header[data-ef-node="pageHeader"]`).waitFor();
			await checked(page, "type in the header", async () => {
				await page.locator(`${PAPER} header[data-ef-node="pageHeader"] p`).first().click();
				await type(page, "Harvest Point policy");
			});
			assert.equal((await snapshot(page)).page.header.content[0].content[0].text, "Harvest Point policy");
			await checked(page, "header prints on the first page", async () => {
				await page
					.getByRole("radiogroup", { name: "Header prints on" })
					.getByRole("radio", { name: "First page" })
					.click();
			});
			assert.equal((await snapshot(page)).page.header.pages, "first");
			await checked(page, "page number Page N in the footer", async () => {
				await page.locator(`${PAPER} footer[data-ef-node="pageFooter"] p`).last().click();
				await insert(page, "Page N");
			});
			await checked(page, "page number Page N of M in the header", async () => {
				await page.locator(`${PAPER} header[data-ef-node="pageHeader"] p`).first().click();
				await insert(page, "Page N of M");
			});
			const numbers = [];
			walk(
				[...(await snapshot(page)).page.header.content, ...(await snapshot(page)).page.footer.content],
				(n) => n.type === "pageNumber" && numbers.push(n.attrs.format),
			);
			assert.deepEqual(
				numbers.sort(),
				["page", "page-of-total", "page-of-total"],
				"the policy's own number and the two new ones",
			);
			// The body offers no page number.
			await cursorIn(page, "The board makes decisions");
			const body = await items(page);
			assert.ok(!body.includes("Page N") && !body.includes("Page N of M"), "the body menu has no page number");
			await checked(page, "turn the footer off", async () => {
				await panel(page).getByRole("switch", { name: "Footer" }).click();
			});
			assert.equal((await snapshot(page)).page.footer ?? null, null);
			// On a formal/legal document the notice stays below the footer and cannot be selected or removed.
			const notice = page.locator(".ef-notice");
			await notice.waitFor();
			assert.equal(
				await notice.evaluate((el) => !el.closest(".ProseMirror")),
				true,
				"the notice is outside the editable page",
			);
			assert.equal(await page.locator(`${PAPER} *`).filter({ hasText: "Template, not legal advice" }).count(), 0);
			assert.equal(
				await notice.evaluate((el) => getComputedStyle(el).userSelect),
				"none",
				"the notice cannot be selected",
			);
		});
		assert.deepEqual(errors, [], "no page errors");
	});
});

/** The index among dividers (document order) of the first divider with these attributes. */
async function dividerIndexOf(page, attrs) {
	const dividers = nodesOf(await snapshot(page), "divider");
	const at = dividers.findIndex((d) => Object.entries(attrs).every(([k, v]) => d.attrs?.[k] === v));
	assert.ok(at >= 0, `a divider with ${JSON.stringify(attrs)}`);
	return at;
}
