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
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { makePalette, NEUTRAL_THEME } from "../../../packages/domain/src/documents/theme.ts";
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
const neutral = makePalette(NEUTRAL_THEME);

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
	if (!colors) return;
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

/** Puts the cursor at the end of the last text block of the page header or footer. */
async function cursorInRegion(page, type) {
	await page.locator(PAPER).evaluate((el, t) => {
		const ed = el.editor;
		let end = null;
		ed.state.doc.descendants((node, pos) => {
			if (node.type.name === t)
				node.descendants((child, offset) => {
					if (child.isTextblock) end = pos + 1 + offset + 1 + child.content.size;
				});
			return end === null;
		});
		if (end === null) throw new Error(`no ${t}`);
		ed.chain().focus().setTextSelection(end).run();
	}, type);
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
	if (SHOTS) {
		const stem = `${String(++shotCount).padStart(2, "0")}-${slug(name)}`;
		await page.screenshot({ path: `${SHOTS}/${stem}.png` });
		if (process.env.SHOT_FILES === "1") await fileShots(page, stem);
	}
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
/**
 * Hand-check evidence (SHOT_DIR and SHOT_FILES=1): saves the document as it is after the action and writes a picture of
 * its PDF pages and of its Word pages next to the editor screenshot. The Word file goes through LibreOffice. All files
 * stay outside the repository.
 */
async function fileShots(page, stem) {
	const id = new URL(page.url()).pathname.split("/").at(-1);
	await button(page, "Save").click();
	await page.getByRole("status").filter({ hasText: /Saved/ }).waitFor();
	const revision = await revisionOf(page);
	const work = `${SHOTS}/work-${stem}`;
	mkdirSync(work, { recursive: true });
	for (const [format, label] of [
		["pdf", "pdf"],
		["docx", "word"],
	]) {
		const bytes = await file(page, id, format, revision);
		writeFileSync(`${work}/doc.${format}`, bytes);
		let pdfPath = `${work}/doc.pdf`;
		if (format === "docx") {
			execFileSync(
				"soffice",
				[
					"--headless",
					`-env:UserInstallation=file://${work}/profile`,
					"--convert-to",
					"pdf",
					"--outdir",
					`${work}/word`,
					`${work}/doc.docx`,
				],
				{ stdio: "ignore", timeout: 120_000 },
			);
			pdfPath = `${work}/word/doc.pdf`;
		}
		execFileSync("pdftoppm", ["-png", "-r", "45", pdfPath, `${work}/${label}`]);
		const pages = readdirSync(work)
			.filter((f) => f.startsWith(`${label}-`) && f.endsWith(".png"))
			.sort();
		const html = `<body style="margin:0;background:#dde1e6;display:flex;gap:8px;padding:8px;align-items:flex-start">${pages
			.map(
				(f) =>
					`<img style="box-shadow:0 0 0 1px #999;background:white" src="data:image/png;base64,${readFileSync(`${work}/${f}`).toString("base64")}">`,
			)
			.join("")}</body>`;
		const sheet = await page.context().newPage();
		await sheet.setContent(html);
		const box = await sheet.locator("body").boundingBox();
		await sheet.setViewportSize({ width: Math.ceil(box.width) + 16, height: Math.ceil(box.height) + 16 });
		await sheet.screenshot({ path: `${SHOTS}/${stem}-${label}.png`, fullPage: true });
		await sheet.close();
	}
	writeFileSync(`${SHOTS}/${stem}.revision`, String(revision));
	rmSync(work, { recursive: true, force: true });
}

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

/** Adds a primary box and an accent bar and reads the colors the paper paints for them, as [r, g, b]. */
async function paperColors(page) {
	await cursorIn(page, "The board makes decisions");
	await insert(page, "Colored box");
	await type(page, "Boxed text");
	await page.getByRole("radiogroup", { name: "Box fill" }).getByRole("radio", { name: "primary", exact: true }).click();
	await cursorIn(page, "The secretary writes");
	await insert(page, "Accent bar");
	return page.locator(PAPER).evaluate((el) => {
		const rgb = (css) => css.match(/\d+/g).slice(0, 3).map(Number);
		const box = el.querySelector('[data-ef-node="box"]');
		const bar = [...el.querySelectorAll('hr[data-line-weight="bar"][data-line-color="accent"]')].at(-1);
		return {
			fill: rgb(getComputedStyle(box).backgroundColor),
			text: rgb(getComputedStyle(box.querySelector("p")).color),
			bar: rgb(getComputedStyle(bar).backgroundColor),
		};
	});
}
const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

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
		// With no brand kit the document prints in the Everyfield-neutral theme, and the paper paints that theme.
		const colors = await paperColors(page);
		assert.equal(hex(colors.fill), neutral.primary, "a primary box paints the neutral primary");
		assert.equal(hex(colors.bar), neutral.accentLine.toUpperCase(), "an accent bar paints the neutral accent line");
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
			if (SHOTS) await page.screenshot({ path: `${SHOTS}/image-menu-missing-photo.png` });
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

// ------------------------------------------------------------------------------------------------ criterion 4, neutral

test("AC:DOC-LAYOUT-COLORS: the paper paints each token as the renderer's palette does (Chromium)", async (t) => {
	await onPage(async (page) => {
		await fork(page, "Conflict of Interest Policy");
		const colors = await paperColors(page);
		await t.test("a church theme: the brand kit's colors", () => {
			assert.equal(hex(colors.fill), palette.primary, "a primary box paints the brand primary color");
			assert.equal(
				hex(colors.text),
				palette.onPrimary.toUpperCase(),
				"text on it is the contrast color the PDF prints",
			);
			assert.equal(
				hex(colors.bar),
				palette.accentLine.toUpperCase(),
				"an accent bar paints the PDF's accent line color",
			);
		});
		await t.test("every swatch shows the color its token paints, and no control takes a hex value", async () => {
			await cursorInside(page, "box", 0);
			const swatches = await page
				.getByRole("radiogroup", { name: "Box fill" })
				.getByRole("radio")
				.evaluateAll((els) =>
					els.map((el) => [el.getAttribute("aria-label"), getComputedStyle(el.firstElementChild).backgroundColor]),
				);
			assert.deepEqual(
				swatches.map(([name]) => name),
				["none", "ink", "muted-text", "primary", "accent", "muted", "border"],
			);
			assert.equal(await page.locator('input[type="color"]').count(), 0, "no color picker");
			assert.equal(await page.getByRole("textbox", { name: /hex|color/i }).count(), 0, "no hex field");
			const primary = swatches
				.find(([name]) => name === "primary")[1]
				.match(/\d+/g)
				.slice(0, 3)
				.map(Number);
			assert.equal(hex(primary), palette.primary);
		});
	});
});

// ------------------------------------------------------------------------------------------------ files

const PDFJS = "../../../packages/db/node_modules/pdfjs-dist/legacy/build/";
let pdfjs;
/** pdf.js, loaded once. */
async function pdfLib() {
	if (!pdfjs) {
		globalThis.pdfjsWorker = await import(PDFJS + "pdf.worker.mjs");
		pdfjs = await import(PDFJS + "pdf.mjs");
	}
	return pdfjs;
}
/** The text items of one PDF page with their position, and the page's drawing operators. */
async function pdfPage(bytes, n = 1) {
	const lib = await pdfLib();
	const doc = await lib.getDocument({ data: new Uint8Array(bytes) }).promise;
	const page = await doc.getPage(n);
	const content = await page.getTextContent();
	const ops = await page.getOperatorList();
	const fills = [];
	ops.fnArray.forEach((fn, i) => {
		if (fn === lib.OPS.setFillRGBColor) {
			const args = ops.argsArray[i];
			fills.push(typeof args[0] === "string" ? args[0].toUpperCase() : hex(args.slice(0, 3).map((x) => Math.round(x))));
		}
	});
	return {
		pages: doc.numPages,
		items: content.items.map((i) => ({ text: i.str, x: i.transform[4], y: i.transform[5] })),
		operators: ops.fnArray.length,
		fills,
	};
}

/** Fetches one file of the open document through the file route, with the owner's session. */
async function file(page, id, format, revision, { download = false } = {}) {
	const response = await page
		.context()
		.request.get(
			`${BASE}/documents/church/${id}/file?format=${format}&revision=${revision}${download ? "&download=1" : ""}`,
		);
	assert.equal(response.status(), 200, `${format} file`);
	return Buffer.from(await response.body());
}
const revisionOf = async (page) =>
	Number(
		(
			await page
				.getByRole("status")
				.filter({ hasText: /Revision \d+/ })
				.innerText()
		).match(/Revision (\d+)/)[1],
	);

test("the brand kit gets a cover photo", async () => {
	await onPage(async (page) => {
		await brandKit(page, { colors: false, images: ["cover_photo"] });
	});
});

test("AC:DOC-LAYOUT-FILES: one document with everything of this slice, in its PDF and Word file (Chromium)", async (t) => {
	await onPage(async (page) => {
		const path = await fork(page, "Conflict of Interest Policy");
		const id = path.split("/").at(-1);
		// Build it with the editor's own controls.
		await cursorIn(page, "The board makes decisions");
		await insert(page, "2 columns");
		await type(page, "Column one text");
		await cursorInColumn(page, 1);
		await type(page, "Column two text");
		await cursorIn(page, "The member explains");
		await insert(page, "Colored box");
		await type(page, "Primary box text");
		await page
			.getByRole("radiogroup", { name: "Box fill" })
			.getByRole("radio", { name: "primary", exact: true })
			.click();
		await cursorIn(page, "The secretary writes");
		await insert(page, "Accent bar");
		for (const item of ["Write-in line", "Signature line", "Date line", "Logo", "Mark", "Photo"]) {
			await cursorIn(page, "The secretary writes");
			await insert(page, item);
		}
		await openSetup(page);
		await page.getByRole("combobox", { name: "Paper size" }).click();
		await page.getByRole("option", { name: "Legal" }).click();
		await radio(page, "Landscape").click();
		await panel(page).getByRole("switch", { name: "Header" }).click();
		await cursorInRegion(page, "pageHeader");
		await type(page, "Policy header ");
		await insert(page, "Page N");
		await cursorInRegion(page, "pageFooter");
		await type(page, "Footer text");
		await insert(page, "Page N of M");
		await button(page, "Save").click();
		await page.getByRole("status").filter({ hasText: "Revision 2" }).waitFor();
		const revision = await revisionOf(page);
		const saved = await snapshot(page);
		assert.ok(docDocument.safeParse(saved).success, "the saved document parses");

		const pdf = await file(page, id, "pdf", revision);
		const docx = await file(page, id, "docx", revision);
		const kitFiles = {};
		const kitSizes = {};
		for (const source of ["logo", "mark", "photo"]) {
			const src = await page.locator(`${PAPER} .ef-image[data-source="${source}"] img`).first().getAttribute("src");
			kitFiles[source] = Buffer.from(await (await page.context().request.get(BASE + src)).body());
			assert.ok(kitFiles[source].length > 100, `${source}: the brand asset route serves bytes`);
			kitSizes[source] = await page
				.locator(`${PAPER} .ef-image[data-source="${source}"] img`)
				.first()
				.evaluate((img) => [img.naturalWidth, img.naturalHeight]);
		}

		await t.test("the preview is the PDF Download gives", async () => {
			assert.equal(
				sha(await file(page, id, "pdf", revision)),
				sha(await file(page, id, "pdf", revision, { download: true })),
			);
		});
		await t.test("the PDF: size, columns, box, bar, fields, images, header, footer and page numbers", async () => {
			const doc = await PDFDocument.load(pdf);
			for (const p of doc.getPages()) {
				const { width, height } = p.getSize();
				assert.deepEqual([Math.round(width), Math.round(height)], [1008, 612], "Legal, landscape");
			}
			const first = await pdfPage(pdf, 1);
			const left = first.items.find((i) => i.text.includes("Column one text"));
			const right = first.items.find((i) => i.text.includes("Column two text"));
			assert.ok(left && right, "both column texts print");
			assert.ok(right.x > left.x + 100 && Math.abs(right.y - left.y) < 3, "the columns sit side by side");
			assert.ok(
				first.fills.includes(palette.primary),
				`the box fill ${palette.primary} is in the page: ${[...new Set(first.fills)].join(" ")}`,
			);
			const allFills = [];
			for (let n = 1; n <= first.pages; n++) allFills.push(...(await pdfPage(pdf, n)).fills);
			assert.ok(allFills.includes(palette.accentLine.toUpperCase()), "the accent bar is in the accent line color");
			// Write-in lines are fillable form fields with unique names.
			const names = doc
				.getForm()
				.getFields()
				.map((f) => f.getName());
			assert.equal(new Set(names).size, names.length, "form field names are unique");
			for (const key of ["name", "signature", "date"])
				assert.ok(
					names.some((n) => n.startsWith(key)),
					`a form field for ${key}`,
				);
			// The three images.
			const sizes = [];
			for (const [, obj] of doc.context.enumerateIndirectObjects()) {
				const dict = obj.dict ?? obj;
				const sub = dict.get?.(doc.context.obj("Subtype"));
				if (sub?.toString() === "/Image")
					sizes.push([Number(dict.get(doc.context.obj("Width"))), Number(dict.get(doc.context.obj("Height")))]);
			}
			for (const [source, bytes] of Object.entries(kitFiles)) {
				const png = kitSizes[source];
				assert.ok(bytes.length > 0);
				assert.ok(
					sizes.some(([w, h]) => w === png[0] && h === png[1]),
					`the PDF holds the ${source} (${png.join("x")}); images: ${JSON.stringify(sizes)}`,
				);
			}
			const pages = await pdfPages(pdf);
			pages.forEach((text, i) => {
				assert.match(
					text,
					new RegExp(`Policy header Page ${i + 1}\\b`),
					`page ${i + 1}: the header and its page number`,
				);
				assert.match(
					text,
					new RegExp(`Footer text\\s*Page ${i + 1} of ${pages.length}`),
					`page ${i + 1}: the footer and its page number`,
				);
			});
		});
		await t.test("the Word file: text, images, page size, header, footer and page numbers", async () => {
			const parts = docxParts(docx);
			const body = wordText(parts["word/document.xml"]);
			for (const text of ["Column one text", "Column two text", "Primary box text"])
				assert.ok(body.includes(text), `Word has ${text}`);
			assert.match(parts["word/document.xml"], /<w:pgSz[^>]*w:w="20160"[^>]*w:h="12240"/, "Legal landscape page size");
			assert.match(parts["word/document.xml"], /w:orient="landscape"/);
			const headers = Object.entries(parts).filter(([name]) => /^word\/header\d*\.xml$/.test(name));
			const footers = Object.entries(parts).filter(([name]) => /^word\/footer\d*\.xml$/.test(name));
			assert.ok(
				headers.some(([, xml]) => wordText(xml).includes("Policy header")),
				"the header text",
			);
			assert.ok(
				footers.some(([, xml]) => wordText(xml).includes("Footer text")),
				"the footer text",
			);
			assert.ok(
				headers.some(([, xml]) => /PAGE/.test(xml)),
				"the header counts pages",
			);
			assert.ok(
				footers.some(([, xml]) => /NUMPAGES/.test(xml)),
				"the footer counts pages in all",
			);
			const media = Object.values(docxMedia(docx));
			for (const [source, bytes] of Object.entries(kitFiles))
				assert.ok(media.includes(sha(bytes)), `the Word file embeds the ${source} bytes`);
		});
	});
});

// ------------------------------------------------------------------------------------------------ cards

test("AC:DOC-LAYOUT-CARDS: 4 cards per sheet with cut marks, in the editor, the preview, the PDF and the Word file (Chromium)", async (t) => {
	await onPage(async (page) => {
		const path = await fork(page, "Core Group Commitment Card");
		const id = path.split("/").at(-1);
		const base = bases.card;
		await openSetup(page);
		assert.ok(await page.getByText("4 per sheet").first().isVisible(), "the editor labels the card");
		await checked(
			page,
			"cards per sheet 1",
			async () => {
				await radio(page, "1 card per sheet").click();
			},
			{ base },
		);
		assert.equal(await page.getByText("4 per sheet").count(), 0, "no label with 1 card");
		await checked(
			page,
			"cards per sheet 4",
			async () => {
				await radio(page, "4 cards per sheet, 2 across and 2 down").click();
			},
			{ base },
		);
		assert.equal(
			await page.locator(".ef-paper").evaluate((el) => getComputedStyle(el).getPropertyValue("--page-w")),
			"445.33px",
			"one card at the tile size: 306 pt and its padding",
		);
		assert.equal((await snapshot(page, base)).page.tile.across, 2);
		await checked(
			page,
			"cut marks off",
			async () => {
				await panel(page).getByRole("switch", { name: "Cut marks" }).click();
			},
			{ base },
		);
		await button(page, "Save").click();
		await page.getByRole("status").filter({ hasText: "Revision 2" }).waitFor();
		const off = await revisionOf(page);
		await checked(
			page,
			"cut marks on",
			async () => {
				await panel(page).getByRole("switch", { name: "Cut marks" }).click();
			},
			{ base },
		);
		await button(page, "Save").click();
		await page.getByRole("status").filter({ hasText: "Revision 3" }).waitFor();
		const on = await revisionOf(page);
		await t.test(
			"the preview and the PDF print 4 cards on one sheet, with trim marks when cut marks are on",
			async () => {
				await button(page, "Preview").click();
				await page.getByRole("region", { name: "Preview" }).waitFor();
				const marked = await file(page, id, "pdf", on);
				const plain = await file(page, id, "pdf", off);
				assert.equal(
					sha(marked),
					sha(await file(page, id, "pdf", on, { download: true })),
					"preview bytes equal Download bytes",
				);
				const [a, b] = [await pdfPage(marked), await pdfPage(plain)];
				assert.equal(a.pages, 1, "one sheet");
				assert.equal(a.items.filter((i) => i.text.includes("My commitment")).length, 4, "4 copies of the card");
				assert.ok(
					a.operators > b.operators,
					`trim marks add drawing operators (${a.operators} against ${b.operators})`,
				);
				assert.equal(b.items.filter((i) => i.text.includes("My commitment")).length, 4);
			},
		);
		await t.test("the Word file shows the 2 x 2 card table", async () => {
			const parts = docxParts(await file(page, id, "docx", on));
			const xml = parts["word/document.xml"];
			assert.equal(wordText(xml).split("My commitment").length - 1, 4, "4 cards");
			assert.match(xml, /Card sheet/, "the card sheet table");
			assert.equal(xml.match(/<w:gridCol /g)?.length >= 2, true, "two columns across");
		});
	});
});

// ------------------------------------------------------------------------------------------------ access and look

/** The accessible name of an element: aria-label, aria-labelledby, a label or its own text. */
const NAME = `(el) => {
	const byId = (el.getAttribute("aria-labelledby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
	const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(" ").trim() : "";
	return el.getAttribute("aria-label") || byId || labels || el.textContent.trim();
}`;

test("AC:DOC-LAYOUT-ACCESS: every new control has a name, a tooltip and its cursor; 390 px fits; a Member sees no controls (Chromium)", async (t) => {
	let docId;
	await onPage(async (page) => {
		const path = await fork(page, "Conflict of Interest Policy");
		docId = path.split("/").at(-1);
		await cursorIn(page, "The board makes decisions");
		await insert(page, "2 columns");
		await cursorInColumn(page, 0);
		await insert(page, "Colored box");
		await openSetup(page);

		await t.test("every control in the block settings and the panel has an accessible name", async () => {
			for (const scope of [page.getByRole("group", { name: "Block settings" }), panel(page)]) {
				const named = await scope
					.locator("button, [role=radio], [role=switch], [role=combobox], input")
					.evaluateAll((els, fn) => els.map((el) => [el.tagName, new Function(`return ${fn}`)()(el)]), NAME);
				assert.ok(named.length > 5, "the scope holds controls");
				for (const [tag, name] of named) assert.ok(name && name.length > 0, `a ${tag} has no accessible name`);
			}
		});

		await t.test("each control shows its tooltip, and cursor-pointer when it can be pressed", async () => {
			const settings = page.getByRole("group", { name: "Block settings" });
			const probes = [
				[settings.getByRole("radio", { name: "3 columns" }), "3 columns"],
				[
					settings.getByRole("radiogroup", { name: "Box fill" }).getByRole("radio", { name: "accent", exact: true }),
					"accent",
				],
				[
					settings
						.getByRole("radiogroup", { name: "Box border" })
						.getByRole("radio", { name: "muted-text", exact: true }),
					"muted-text",
				],
				[button(page, "Page setup"), "Page setup"],
				[radio(page, "Landscape"), "Landscape"],
				[panel(page).getByRole("switch", { name: "Header" }), "Turn the page header on or off"],
				[page.getByLabel("Top margin"), "Top margin in inches"],
				[page.getByRole("combobox", { name: "Paper size" }), "Paper size"],
			];
			for (const [control, text] of probes) {
				await control.hover();
				await page.getByRole("tooltip").filter({ hasText: text }).first().waitFor({ timeout: 5_000 });
				const cursor = await control.evaluate((el) => getComputedStyle(el).cursor);
				assert.ok(["pointer", "text"].includes(cursor), `${text}: cursor ${cursor}`);
				await page.mouse.move(0, 0);
			}
			for (const control of [
				settings.getByRole("radio", { name: "3 columns" }),
				button(page, "Page setup"),
				radio(page, "Landscape"),
			])
				assert.equal(await control.evaluate((el) => getComputedStyle(el).cursor), "pointer");
		});

		await t.test("keyboard users reach and change every field of the panel", async () => {
			await page.getByRole("combobox", { name: "Paper size" }).focus();
			const reached = new Set();
			for (let i = 0; i < 40; i++) {
				const name = await page.evaluate(`(${NAME})(document.activeElement)`);
				const inside = await page.evaluate(() => !!document.activeElement?.closest('[aria-label="Page setup"]'));
				if (inside) reached.add(name);
				else if (reached.size > 3) break;
				await page.keyboard.press("Tab");
			}
			for (const name of [
				"Paper size",
				"Portrait",
				"Top margin",
				"Right margin",
				"Bottom margin",
				"Left margin",
				"1 card per sheet",
				"Header",
				"Footer",
			])
				assert.ok(
					[...reached].some((n) => n.startsWith(name)),
					`Tab reaches ${name}: ${[...reached].join(", ")}`,
				);
			// A field changes from the keyboard alone.
			const before = (await snapshot(page)).page;
			await page.getByLabel("Top margin").focus();
			await page.keyboard.press("ControlOrMeta+A");
			await page.keyboard.type("0.5");
			assert.equal((await snapshot(page)).page.margin.top, 36);
			await radio(page, "Portrait").focus();
			await page.keyboard.press("ArrowRight");
			assert.equal((await snapshot(page)).page.orientation, "landscape", "the arrow keys change the orientation");
			assert.notDeepEqual((await snapshot(page)).page, before);
		});

		await t.test("at 390 px the page setup panel and each block control fit with no sideways scroll", async () => {
			await page.setViewportSize({ width: 390, height: 844 });
			const fits = async (what) => {
				const [scroll, width, wide] = await page.evaluate(() => [
					document.documentElement.scrollWidth,
					innerWidth,
					[...document.querySelectorAll("body *")]
						.filter(
							(el) => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).position !== "fixed",
						)
						.slice(0, 6)
						.map(
							(el) =>
								`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(el.getBoundingClientRect().right)}`,
						),
				]);
				assert.ok(scroll <= width, `${what}: the page scrolls sideways (${scroll} > ${width}): ${wide.join(" | ")}`);
			};
			await fits("page setup open");
			await page.getByRole("combobox", { name: "Paper size" }).click();
			await page.getByRole("option", { name: "Custom" }).click();
			await page.keyboard.press("Escape");
			await fits("custom size fields");
			await radio(page, "4 cards per sheet, 2 across and 2 down").click();
			await fits("cards per sheet with cut marks");
			await panel(page).getByRole("switch", { name: "Header" }).click();
			await fits("header pages");
			await cursorInColumn(page, 0);
			await fits("box settings");
			await selectNodeIfAny(page);
		});
	});
	await t.test("a Member reads the document and sees no editing controls", async () => {
		await onPage(
			async (page) => {
				await page.goto(`${BASE}/documents/church/${docId}`);
				await hydrated(page);
				await page.getByRole("region", { name: "Preview" }).waitFor({ timeout: 60_000 });
				assert.equal(await page.getByRole("button", { name: "Page setup" }).count(), 0);
				assert.equal(await page.getByRole("button", { name: "Insert block" }).count(), 0);
				assert.equal(await page.locator(".ef-paper").count(), 0);
				assert.ok(await page.getByRole("link", { name: "Download PDF" }).isVisible());
			},
			undefined,
			"member",
		);
	});
});

/** Selects a divider when the body has one, so the divider settings can be measured too. */
async function selectNodeIfAny(page) {
	const has = await page.locator(PAPER).evaluate((el) => {
		let found = false;
		el.editor.state.doc.descendants((n) => {
			if (n.type.name === "divider") found = true;
			return !found;
		});
		return found;
	});
	if (has) {
		await selectNode(page, "divider", 0);
		const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
		assert.ok(scroll <= width, "the divider settings fit at 390 px");
	}
}
