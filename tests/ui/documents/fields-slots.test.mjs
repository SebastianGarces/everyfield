// WP-036 slice 4 (T-17): merge fields, the doctrinal section, placeholders and version history in the Church Document
// editor, in Chromium against a real preview. Every editing action runs on a forked policy and is checked three times:
// the document after it, after Undo and after Redo must parse, and Undo and Redo give the earlier and later JSON exactly.
//   UI_BASE_URL=https://t17-....localhost:1355 node --test tests/ui/documents/fields-slots.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts). The Owner and the Member of that fixture sign in.
// SHOT_DIR (outside the repository) keeps one screenshot per action; CHECK_LOG appends one line per checked action.
//   AC:DOC-EDIT-FIELDS       criteria 1, 2 and 11 (insert each field, change its value, toolbar and keyboard Undo/Redo)
//   AC:DOC-EDIT-SLOT         criteria 3, 4, 5, 6, 7 and 11 (fill, delete and add back a doctrinal section; its exports)
//   AC:DOC-EDIT-PLACEHOLDERS criteria 8 and 9 (placeholders highlighted from the text in the editor, PDF and Word)
//   AC:DOC-EDIT-HISTORY      criterion 10 (saved revisions newest first; an older one read-only; the draft is kept)
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { SLOT_BLANK_NOTE } from "../../../packages/domain/src/documents/doc-values.ts";
import { documentFrom } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { docxParts, pdfOperators, pdfPages, wordText } from "../../integration/documents/fixtures/readers.mts";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const MOD = "ControlOrMeta";
const LOG = process.env.CHECK_LOG;
const SHOTS = process.env.SHOT_DIR;
const PAPER = ".ef-paper .ProseMirror";
const POLICY = await forkTemplate(docTemplateById("conflict-of-interest-policy"), { data: {} });
let shotCount = 0;
const slug = (text) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
const squash = (text) => text.replace(/\s+/g, " ").trim();

const onPage = (run, size) =>
	withPage(
		chromium,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await run(page, context);
		},
		size,
	);

async function fork(page, title) {
	await page.goto(`${BASE}/documents/church`);
	await hydrated(page);
	await page.getByRole("button", { name: "New from template" }).first().click();
	// The library also lists earlier copies by the same title: pick the template in the picker.
	await page
		.getByRole("dialog")
		.getByRole("button", { name: new RegExp(`^${title}`) })
		.click();
	await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 90_000 });
	await page.locator(PAPER).waitFor({ timeout: 90_000 });
	return new URL(page.url()).pathname;
}

const snapshot = async (page) => documentFrom(POLICY, await page.locator(PAPER).evaluate((el) => el.editor.getJSON()));
const button = (page, name) => page.getByRole("button", { name, exact: true });
const menu = async (page, trigger, item) => {
	await button(page, trigger).click();
	await page.getByRole("menuitem", { name: item }).first().click();
};

/** Puts the cursor in the text block that starts with `starts`, at `offset` characters (-1: the end). */
async function cursorIn(page, starts, offset = 0) {
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

/** Undo and Redo from the toolbar, or from the keyboard (Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z) with `keys`. */
async function undo(page, keys) {
	if (keys) {
		await page.locator(PAPER).focus();
		await page.keyboard.press(`${MOD}+z`);
	} else await button(page, "Undo").click();
}
async function redo(page, keys) {
	if (keys) {
		await page.locator(PAPER).focus();
		await page.keyboard.press(`${MOD}+Shift+z`);
	} else await button(page, "Redo").click();
}

/** One action, checked: it changes the document, one Undo gives the earlier JSON exactly and one Redo the later JSON. */
async function checked(page, name, act, { keys = false } = {}) {
	const before = await snapshot(page);
	await act();
	const after = await snapshot(page);
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${String(++shotCount).padStart(2, "0")}-${slug(name)}.png` });
	assert.ok(docDocument.safeParse(after).success, `${name}: the changed document parses`);
	assert.notDeepEqual(after, before, `${name}: the action changed the document`);
	await undo(page, keys);
	assert.deepEqual(await snapshot(page), before, `${name}: one Undo gives the earlier JSON`);
	await redo(page, keys);
	assert.deepEqual(await snapshot(page), after, `${name}: one Redo gives the later JSON`);
	if (LOG)
		appendFileSync(
			LOG,
			`${JSON.stringify({ action: name, undo: keys ? "Cmd/Ctrl+Z" : "toolbar", redo: keys ? "Cmd/Ctrl+Shift+Z" : "toolbar", result: "exact" })}\n`,
		);
	return { before, after };
}

async function save(page, revision) {
	await button(page, "Save").click();
	await page
		.getByRole("status")
		.filter({ hasText: `Revision ${revision}` })
		.waitFor({ timeout: 60_000 });
}
async function files(context, path, revision) {
	const get = async (format) =>
		Buffer.from(await (await context.request.get(`${BASE}${path}/file?format=${format}&revision=${revision}`)).body());
	const pdf = await get("pdf");
	const docx = docxParts(await get("docx"));
	return {
		pdf: squash((await pdfPages(pdf)).join(" ")),
		word: wordText(docx["word/document.xml"]),
		xml: docx["word/document.xml"],
	};
}
const fieldTexts = (page, key) =>
	page.locator(`${PAPER} span[data-ef-node="field"][data-ef-key="${key}"]`).allTextContents();

// ------------------------------------------------------------------------------------------------ criteria 1, 2, 11

test("AC:DOC-EDIT-FIELDS: insert each merge field and change a value, with Undo and Redo", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));
		const fields = [
			["church_name", "Church name"],
			["pastor_name", "Pastor"],
			["church_tagline", "Tagline"],
			["contact_line", "Contact line"],
			["meeting_date", "Meeting date"],
		];
		for (const [i, [key, label]] of fields.entries()) {
			const { after } = await checked(
				page,
				`insert the ${label} field`,
				async () => {
					await cursorIn(page, "The secretary writes", 0);
					await menu(page, "Insert block", new RegExp(`^${label}`));
				},
				{ keys: i % 2 === 1 },
			);
			assert.ok(
				after.fields.some((f) => f.key === key),
				`${label} is declared`,
			);
			const shown = await fieldTexts(page, key);
			assert.ok(shown.length >= 1, `${label} shows on the page`);
		}
		// A field with no value yet shows its label in brackets, highlighted as a placeholder.
		const meeting = page.locator(`${PAPER} span[data-ef-node="field"][data-ef-key="meeting_date"]`).first();
		assert.equal(await meeting.textContent(), "[meeting date]");
		assert.ok(
			await meeting.evaluate((el) => el.classList.contains("ef-placeholder")),
			"an unfilled field is a placeholder",
		);

		// Change the church name: every copy shows it, and one Undo puts the old value back.
		const copies = (await fieldTexts(page, "church_name")).length;
		assert.ok(copies >= 2, "the policy prints the church name more than once");
		await checked(page, "change the church name", async () => {
			await page.locator(`${PAPER} span[data-ef-node="field"][data-ef-key="church_name"]`).first().click();
			const input = page.getByRole("textbox", { name: "Value" });
			await input.fill("Grace Harbor Church");
			await input.press("Enter");
		});
		assert.deepEqual(await fieldTexts(page, "church_name"), Array(copies).fill("Grace Harbor Church"));
		await checked(
			page,
			"change the meeting date from the keyboard",
			async () => {
				await meeting.click();
				const input = page.getByRole("textbox", { name: "Value" });
				await input.fill("Sunday, March 8");
				await input.press("Enter");
			},
			{ keys: true },
		);
		await save(page, 2);
		const out = await files(context, path, 2);
		for (const [name, text] of [
			["PDF", out.pdf],
			["Word", out.word],
		]) {
			assert.ok(text.includes("Grace Harbor Church"), `the ${name} prints the new church name`);
			assert.ok(text.includes("Sunday, March 8"), `the ${name} prints the meeting date`);
		}
		assert.deepEqual(errors, [], "no page errors");
	});
});

// ------------------------------------------------------------------------------------------------ criteria 3 to 7, 11

test("AC:DOC-EDIT-SLOT: fill, delete and add back a doctrinal section; its PDF and Word file follow", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		const slot = page.locator(`${PAPER} section[data-ef-node="slot"]`);
		const slotItem = () => page.getByRole("menuitem", { name: "Doctrinal section", exact: true });

		// Add one from the block menu: an empty, marked section at the cursor.
		await checked(page, "add a doctrinal section", async () => {
			await cursorIn(page, "The secretary writes", -1);
			await menu(page, "Insert block", "Doctrinal section");
		});
		assert.equal(await slot.count(), 1);
		assert.ok(await slot.evaluate((el) => el.hasAttribute("data-empty")), "the new section is a marked blank");
		assert.ok((await slot.textContent()).includes("Statement of faith"), "it carries its label");
		// A second copy cannot be added: the item is disabled and says why.
		await button(page, "Insert block").click();
		assert.equal(await slotItem().getAttribute("aria-disabled"), "true", "a second section cannot be added");
		await page.getByText("This document already has one.").waitFor();
		await page.keyboard.press("Escape");

		// An empty section saves and exports as the marked blank, never default text.
		await save(page, 2);
		let out = await files(context, path, 2);
		assert.ok(out.pdf.includes(squash(SLOT_BLANK_NOTE)), "the PDF prints the marked blank");
		assert.ok(out.word.includes(SLOT_BLANK_NOTE), "the Word file prints the marked blank");

		// Delete the empty section, then add it back.
		await checked(page, "delete an empty doctrinal section", async () => {
			await slot.locator("p").first().click();
			await button(page, "Delete block").click();
		});
		assert.equal(await slot.count(), 0);
		await checked(page, "add the doctrinal section back", async () => {
			await cursorIn(page, "The secretary writes", -1);
			await menu(page, "Insert block", "Doctrinal section");
		});

		// Fill it: the typing is one Undo step.
		const STATEMENT = "We believe in one God, Father, Son and Holy Spirit.";
		await checked(
			page,
			"fill the doctrinal section",
			async () => {
				await slot.locator("p").first().click();
				await page.keyboard.insertText(STATEMENT);
			},
			{ keys: true },
		);
		assert.ok(!(await slot.evaluate((el) => el.hasAttribute("data-empty"))), "a filled section is not marked blank");
		await save(page, 3);
		out = await files(context, path, 3);
		assert.ok(
			out.pdf.includes(`STATEMENT OF FAITH ${STATEMENT}`) || out.pdf.includes(`Statement of faith ${STATEMENT}`),
			"the PDF prints the statement in its section",
		);
		assert.ok(out.word.includes(STATEMENT), "the Word file prints the statement");

		// Delete the filled section: nothing refuses, Undo brings its text back, Redo deletes it again.
		const { before } = await checked(page, "delete the filled doctrinal section", async () => {
			await slot.locator("p").first().click();
			await button(page, "Delete block").click();
		});
		assert.ok(JSON.stringify(before.body).includes(STATEMENT), "Undo brings the section back with its text");
		assert.equal(await page.getByRole("alertdialog").count(), 0, "nothing warns");
		await save(page, 4);
		out = await files(context, path, 4);
		for (const [name, text] of [
			["PDF", out.pdf],
			["Word", out.word],
		]) {
			assert.ok(!/statement of faith/i.test(text), `the ${name} has no section label`);
			assert.ok(
				!text.includes(STATEMENT) && !text.includes(SLOT_BLANK_NOTE),
				`the ${name} has no section and no blank`,
			);
		}
		// The text after it follows straight on: the paragraph the section followed, then the next heading.
		assert.match(out.word, /left the room\. (08 )?Yearly statement/);
		assert.match(out.pdf, /left the room\. (08 )?Yearly statement/);
		// The revision saved before the delete still prints the section.
		const earlier = await files(context, path, 3);
		assert.ok(earlier.pdf.includes(STATEMENT) && earlier.word.includes(STATEMENT), "revision 3 keeps the section");
	});
});

// ------------------------------------------------------------------------------------------------ criteria 8, 9

test("AC:DOC-EDIT-PLACEHOLDERS: placeholders are highlighted from the text in the editor, the PDF and the Word file", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		const marks = () => page.locator(`${PAPER} .ef-placeholder`).allTextContents();
		assert.deepEqual(await marks(), ["[number]", "[date]"], "the policy's placeholders are highlighted, nothing else");
		await cursorIn(page, "The secretary writes", 0);
		await page.keyboard.insertText("On [low amount] ");
		// The decoration follows the transaction; wait for the paint rather than read the DOM in the same tick.
		await page
			.locator(`${PAPER} .ef-placeholder`, { hasText: "[low amount]" })
			.waitFor({ timeout: 5_000 })
			.catch(() => {});
		assert.ok((await marks()).includes("[low amount]"), "a typed placeholder lights up as it is typed");
		// Removing the closing bracket ends the highlight; nothing is stored for it.
		await cursorIn(page, "On [low amount]", 15);
		await page.keyboard.press("Backspace");
		assert.ok(!(await marks()).some((t) => t.startsWith("[low")), "no highlight without the closing bracket");
		const json = JSON.stringify(await snapshot(page));
		assert.ok(!json.includes("placeholder"), "no mark or attribute is stored for a placeholder");
		await page.keyboard.type("]");
		await save(page, 2);
		const pdfBytes = Buffer.from(await (await context.request.get(`${BASE}${path}/file?format=pdf&revision=2`)).body());
		const fills =
			(await pdfOperators(pdfBytes)).match(/\/Artifact BMC\nq\n\/GS-\d+ gs\n0\.992\d* 0\.941\d* 0\.650\d* rg/g) ?? [];
		assert.equal(fills.length, 3, "the PDF paints three placeholder fills");
		const { xml } = await files(context, path, 2);
		for (const text of ["[number]", "[date]", "[low amount]"])
			assert.match(
				xml,
				new RegExp(
					`<w:shd w:val="clear" w:color="auto" w:fill="FDF0A6"/></w:rPr><w:t xml:space="preserve">\\${text.slice(0, -1)}\\]`,
				),
				`${text} is shaded in Word`,
			);
	});
});

// ------------------------------------------------------------------------------------------------ criterion 10

test("AC:DOC-EDIT-HISTORY: version history lists saved revisions newest first and keeps the draft", async () => {
	let path = "";
	await onPage(async (page) => {
		path = await fork(page, "Conflict of Interest Policy");
		for (const [n, word, anchor] of [
			[2, "Second", "The secretary writes"],
			[3, "Third", "Second."],
		]) {
			await cursorIn(page, anchor, 0);
			await page.keyboard.insertText(`${word}. `);
			await save(page, n);
		}
		await cursorIn(page, "Third.", 0);
		await page.keyboard.insertText("Unsaved draft. ");
		const draft = await snapshot(page);
		await button(page, "Version history").click();
		const list = page.getByRole("region", { name: "Version history" });
		const items = list.getByRole("listitem");
		await items.first().waitFor();
		const rows = await items.allTextContents();
		assert.equal(rows.length, 3);
		assert.match(rows[0], /^Revision 3Current/);
		assert.match(rows[1], /^Revision 2/);
		assert.match(rows[2], /^Revision 1/);
		assert.ok(
			!rows.some((r) => r.includes("A former member") || !r.includes("Saved by")),
			"each row names who saved it",
		);
		await list.getByRole("button", { name: /Revision 1/ }).click();
		await list.getByText("Revision 1, read-only").waitFor();
		await page.getByRole("img", { name: /revision 1, page 1/ }).waitFor({ timeout: 60_000 });
		assert.equal(await list.locator("[contenteditable=true]").count(), 0, "history has no editing controls");
		await button(page, "Back to editing").click();
		assert.deepEqual(await snapshot(page), draft, "the unsaved draft is kept");
		await page.getByRole("status").filter({ hasText: "Unsaved changes" }).waitFor();
		await button(page, "Undo").click();
		assert.ok(!JSON.stringify(await snapshot(page)).includes("Unsaved draft."), "the Undo history is kept");
	});
	// A Member opens history read-only.
	await withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people").member.cookie);
		await page.goto(`${BASE}${path}`);
		await hydrated(page);
		await button(page, "Version history").click();
		await page.getByRole("region", { name: "Version history" }).getByRole("listitem").first().waitFor();
		assert.equal(await page.locator("[contenteditable]").count(), 0, "no contenteditable");
		for (const name of ["Save", "Undo", "Delete all content"])
			assert.equal(await button(page, name).count(), 0, `no ${name} control`);
	});
});
