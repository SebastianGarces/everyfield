// WP-036 slice 2: the Church Document editor in Chromium against a real preview. Every action runs on a forked policy;
// after each action, after Undo and after Redo the editor JSON is checked: Undo gives the earlier JSON exactly, Redo gives
// the later JSON exactly, and each one parses with docDocument.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/editor.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts). The Owner and the Member of that fixture sign in.
//   AC:DOC-EDIT-ACTIONS  criteria 5 to 9 and 10, 12 (Undo and Redo of every action)
//   AC:DOC-EDIT-SAVE     criterion 11 (Save, status, revision, conflict, leave guard)
//   AC:DOC-EDIT-PREVIEW  criterion 13 (preview equals Download after an edit; 4 cards per sheet)
//   AC:DOC-EDIT-MARKS-PDF criterion 7 (bold and italic saved in the editor print in their own faces in the PDF)
//   AC:DOC-EDIT-LEGAL    criterion 12 (Delete all content keeps only the notice in the PDF and the Word file)
//   AC:DOC-EDIT-MEMBER   criterion 14 (a Member sees no editing controls)
//   AC:DOC-EDIT-CHUNKS   criterion 15 (no editor code on the library or the Member page)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { test } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { documentFrom } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { docxParts, pdfFontFaces, pdfPages, wordText } from "../../integration/documents/fixtures/readers.mts";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MOD = "ControlOrMeta";
const LOG = process.env.CHECK_LOG;
const PAPER = ".ef-paper .ProseMirror";
const SHOTS = process.env.SHOT_DIR;
const slug = (text) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
let shotCount = 0;

const baseDoc = (id) => forkTemplate(docTemplateById(id), { data: {} });
const bases = { policy: await baseDoc("conflict-of-interest-policy"), card: await baseDoc("commitment-card") };

const onPage = (run, size) =>
	withPage(
		chromium,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await run(page, context);
		},
		size,
	);

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

/** Selects text inside the textblock that starts with `starts`: offsets in characters, -1 for the end of the block. */
async function select(page, starts, from = 0, to = -1) {
	await page.locator(PAPER).evaluate(
		(el, [s, a, b]) => {
			const ed = el.editor;
			let hit = null;
			ed.state.doc.descendants((node, pos) => {
				if (!hit && node.isTextblock && node.textContent.startsWith(s)) hit = { node, pos };
				return !hit;
			});
			if (!hit) {
				const all = [];
				ed.state.doc.descendants((node) => {
					if (node.isTextblock) all.push(node.textContent.slice(0, 30));
				});
				throw new Error(`no text block starts with "${s}"; blocks: ${JSON.stringify(all)}`);
			}
			const start = hit.pos + 1;
			const size = hit.node.content.size;
			ed.chain()
				.focus()
				.setTextSelection({ from: start + (a < 0 ? size : a), to: start + (b < 0 ? size : b) })
				.run();
		},
		[starts, from, to],
	);
}
async function cursorIn(page, starts, offset = 0) {
	await select(page, starts, offset, offset);
}
const top = async (page) => (await rawJson(page)).content ?? [];
const kinds = async (page) => (await top(page)).map((n) => n.type);
const findText = (nodes, starts) => {
	for (const node of nodes) {
		if (node.type === "text" && node.text.startsWith(starts)) return node;
		const hit = node.content && findText(node.content, starts);
		if (hit) return hit;
	}
	return null;
};

/**
 * One action, checked three times. `act` runs the action; the snapshot after it, after Undo and after Redo must parse
 * with docDocument, and Undo and Redo must give back the earlier and the later JSON exactly.
 */
async function checked(page, name, act, { same = false, base = bases.policy } = {}) {
	const before = await snapshot(page, base);
	await act();
	const after = await snapshot(page, base);
	// Hand-check evidence: SHOT_DIR names a folder outside the repository; one screenshot per action, after the action.
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${String(++shotCount).padStart(2, "0")}-${slug(name)}.png` });
	assert.ok(docDocument.safeParse(after).success, `${name}: the changed document parses with docDocument`);
	if (!same) assert.notDeepEqual(after, before, `${name}: the action changed the document`);
	await button(page, "Undo").click();
	const undone = await snapshot(page, base);
	assert.deepEqual(undone, before, `${name}: Undo gives the earlier JSON`);
	assert.ok(docDocument.safeParse(undone).success, `${name}: the undone document parses`);
	await button(page, "Redo").click();
	const redone = await snapshot(page, base);
	assert.deepEqual(redone, after, `${name}: Redo gives the later JSON`);
	assert.ok(docDocument.safeParse(redone).success, `${name}: the redone document parses`);
	if (LOG) appendFileSync(LOG, `${JSON.stringify({ action: name, change: !same, undo: "exact", redo: "exact" })}\n`);
	return { before, after };
}

const menu = async (page, trigger, item) => {
	await button(page, trigger).click();
	await page.getByRole("menuitem", { name: item, exact: true }).click();
};
const setStyle = (page, item) => menu(page, "Text style", item);
const PURPOSE = "The board makes decisions";

// ------------------------------------------------------------------------------------------------ criteria 5 to 9, 12

test("AC:DOC-EDIT-ACTIONS: every editing action is checked with Undo and Redo on a forked policy (Chromium)", async (t) => {
	await onPage(async (page) => {
		await fork(page, "Conflict of Interest Policy");
		const errors = [];
		page.on("pageerror", (e) => errors.push(e.message));

		await t.test("criterion 4: the toolbar is complete right after load", async () => {
			for (const name of ["Bold", "Italic", "Underline", "Link", "Bulleted list", "Numbered list", "Quote"])
				await button(page, name).waitFor({ timeout: 5_000 });
		});

		await t.test("criterion 5: typing, Enter, Shift+Enter, copy and paste", async () => {
			await checked(page, "type text", async () => {
				await select(page, PURPOSE, -1, -1);
				await page.keyboard.type(" Typed here.");
			});
			const typed = await top(page);
			assert.ok(findText(typed, "The board makes decisions"), "typed text went in at the cursor");
			await checked(page, "Enter starts a new paragraph", async () => {
				await select(page, PURPOSE, -1, -1);
				await page.keyboard.press("Enter");
			});
			await checked(page, "Shift+Enter adds a hard break", async () => {
				await select(page, PURPOSE, -1, -1);
				await page.keyboard.press("Shift+Enter");
			});
			assert.ok(JSON.stringify(await rawJson(page)).includes('"hardBreak"'), "the hard break is in the body");
			await checked(page, "Enter starts a new list item", async () => {
				await select(page, "A financial interest", -1, -1);
				await page.keyboard.press("Enter");
			});
			// Copy and paste inside the document keep text, marks and blocks.
			await checked(page, "copy and paste inside the document", async () => {
				await select(page, "This policy covers each board member", 0, 20);
				await page.keyboard.press(`${MOD}+C`);
				await select(page, "The secretary writes", -1, -1);
				await page.keyboard.press(`${MOD}+V`);
			});
			// A paste from outside with a color, a font, an image and an h4 gives only what the format allows.
			const pastedBase = JSON.stringify(await rawJson(page));
			await checked(page, "paste from outside", async () => {
				await select(page, "The secretary writes", -1, -1);
				await page.locator(PAPER).evaluate((el) => {
					const html =
						'<p style="color:red;font-family:Comic Sans MS">Red <b>bold</b> <i>italic</i> text <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></p>' +
						"<h4>Fourth level</h4><p>After</p>";
					const data = new DataTransfer();
					data.setData("text/html", html);
					data.setData("text/plain", "Red bold italic text Fourth level After");
					el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
				});
			});
			const pasted = JSON.stringify(await rawJson(page));
			assert.equal(
				pasted.split('"type":"image"').length,
				pastedBase.split('"type":"image"').length,
				"no image arrived",
			);
			for (const bad of ["Comic", "font-family", "color:red", '"level":4', "<img"])
				assert.ok(!pasted.includes(bad), `the paste carried no ${bad}`);
			assert.ok(pasted.includes("Fourth level"), "the h4 text arrived as a paragraph");
		});

		await t.test("criterion 6: text styles and headings, numbered headings", async () => {
			for (const style of ["Lead", "Small", "Kicker"]) {
				await checked(page, `text style ${style}`, async () => {
					await cursorIn(page, "The board makes decisions");
					await setStyle(page, style);
				});
			}
			for (const level of [1, 2, 3]) {
				await checked(page, `Heading ${level}`, async () => {
					await cursorIn(page, "The member explains");
					await setStyle(page, `Heading ${level}`);
				});
			}
			await checked(page, "Body back from a heading", async () => {
				await cursorIn(page, "Purpose");
				await setStyle(page, "Body");
			});
			await checked(page, "numbered heading off", async () => {
				await cursorIn(page, "Who this policy covers");
				await button(page, "Numbered heading").click();
			});
			await checked(page, "numbered heading on", async () => {
				await cursorIn(page, "Who this policy covers");
				await button(page, "Numbered heading").click();
			});
			// The editor shows the numbers the PDF prints: 01, 02 for level 2; level 3 prints 2.1.
			const numbers = await page.locator(".ef-heading-number").allTextContents();
			assert.ok(numbers.length > 3 && numbers[0] === "01", `heading numbers: ${numbers.slice(0, 3).join(",")}`);
		});

		await t.test("criterion 7: marks, tag and links", async () => {
			for (const [name, key] of [
				["Bold", "B"],
				["Italic", "I"],
				["Underline", "U"],
			]) {
				await checked(page, `${name} from the toolbar`, async () => {
					await select(page, "This policy covers each board member", 5, 11);
					await button(page, name).click();
				});
				await checked(page, `${name} from the keyboard`, async () => {
					await select(page, "This policy covers each board member", 5, 11);
					await page.keyboard.press(`${MOD}+${key}`);
				});
			}
			await checked(page, "tag label", async () => {
				await select(page, "The secretary writes", 4, 13);
				await button(page, "Tag").click();
			});
			// A link that does not start the allowed way gets a message and no mark.
			await select(page, "The board hears the facts", 4, 9);
			await button(page, "Link").click();
			await page.getByPlaceholder("Paste a link...").fill("ftp://example.com");
			await page.keyboard.press("Enter");
			await page.getByRole("alert").filter({ hasText: "https://" }).waitFor();
			assert.ok(!JSON.stringify(await rawJson(page)).includes('"link"'), "no link mark was written");
			await page.keyboard.press("Escape");
			await checked(page, "add a link", async () => {
				await select(page, "The board hears the facts", 4, 9);
				await button(page, "Link").click();
				await page.getByPlaceholder("Paste a link...").fill("https://example.com/a");
				await page.keyboard.press("Enter");
			});
			await checked(page, "edit a link", async () => {
				await cursorIn(page, "The board hears the facts", 6);
				await button(page, "Link").click();
				await page.getByPlaceholder("Paste a link...").fill("mailto:board@example.com");
				await page.keyboard.press("Enter");
			});
			await checked(page, "remove a link", async () => {
				await cursorIn(page, "The board hears the facts", 6);
				await button(page, "Link").click();
				await button(page, "Remove link").click();
			});
		});

		await t.test("criterion 8: lists, quote, divider, spacer and page break", async () => {
			await checked(page, "bulleted list", async () => {
				await cursorIn(page, "Each board member signs");
				await button(page, "Bulleted list").click();
			});
			await checked(page, "numbered list", async () => {
				await cursorIn(page, "This policy covers each board member");
				await button(page, "Numbered list").click();
			});
			await checked(page, "quote", async () => {
				await cursorIn(page, "The board hears the facts");
				await button(page, "Quote").click();
			});
			await checked(page, "divider", async () => {
				await cursorIn(page, "A board member who has a personal interest");
				await button(page, "Divider").click();
			});
			await checked(page, "spacer", async () => {
				await cursorIn(page, "A board member who has a personal interest");
				await button(page, "Spacer").click();
			});
			await checked(page, "page break", async () => {
				await cursorIn(page, "A board member has an interest");
				await button(page, "Page break").click();
			});
			// Lists stay flat: Tab does not nest a list item.
			const flat = JSON.stringify(await rawJson(page));
			await cursorIn(page, "A financial interest");
			await page.keyboard.press("Tab");
			assert.equal(JSON.stringify(await rawJson(page)), flat, "Tab left the list as it was");
			// A page break started inside a list goes in after the list, at the top level.
			await checked(page, "page break from inside a list", async () => {
				await cursorIn(page, "A financial interest");
				await button(page, "Page break").click();
			});
			const body = await top(page);
			const at = body.findIndex((n) => n.type === "bulletList" && JSON.stringify(n).includes("A financial interest"));
			assert.equal(body[at + 1]?.type, "pageBreak", "the page break sits right after the list");
			await checked(page, "page break from inside a column", async () => {
				await page.locator(".ef-block[data-ef-node=columns]").first().click();
				await button(page, "Page break").click();
			});
			assert.equal(
				(await kinds(page))[1],
				"pageBreak",
				"the page break from a column sits after the whole columns block",
			);
		});

		await t.test("criterion 9: add, move and delete a block", async () => {
			for (const [kind, name] of [
				["paragraph", "Paragraph"],
				["heading", "Heading"],
				["bulletList", "Bulleted list"],
				["orderedList", "Numbered list"],
				["quote", "Quote"],
				["divider", "Divider"],
				["spacer", "Spacer"],
				["pageBreak", "Page break"],
			]) {
				await checked(page, `insert ${name}`, async () => {
					await cursorIn(page, "The secretary writes");
					await menu(page, "Insert block", name);
				});
			}
			await checked(page, "move block down", async () => {
				await cursorIn(page, "Each board member signs");
				await button(page, "Move block down").click();
			});
			await checked(page, "move block up", async () => {
				await cursorIn(page, "Each board member signs");
				await button(page, "Move block up").click();
			});
			await checked(page, "move block down from the keyboard", async () => {
				await cursorIn(page, "Each board member signs");
				await page.keyboard.press(`${MOD}+Alt+ArrowDown`);
			});
			await checked(page, "delete block", async () => {
				await cursorIn(page, "Each board member signs");
				await button(page, "Delete block").click();
			});
			// Later-slice blocks move and delete as whole blocks.
			await checked(page, "move a later-slice block up", async () => {
				await page.locator(".ef-block[data-ef-node=table]").click();
				await button(page, "Move block up").click();
			});
			await checked(page, "delete a later-slice block", async () => {
				await page.locator(".ef-block[data-ef-node=table]").click();
				await button(page, "Delete block").click();
			});
			await checked(page, "delete a block from the keyboard", async () => {
				await cursorIn(page, "The secretary writes");
				await page.keyboard.press(`${MOD}+Alt+Backspace`);
			});
			// Move up is disabled on the first block, Move down on the last.
			await page.locator(".ef-block[data-ef-node=columns]").first().click();
			assert.equal(await button(page, "Move block up").isDisabled(), true, "Move up is disabled on the first block");
			await page.locator(PAPER).evaluate((el) => {
				const doc = el.editor.state.doc;
				el.editor.commands.setNodeSelection(doc.content.size - doc.lastChild.nodeSize);
			});
			assert.equal(await button(page, "Move block down").isDisabled(), true, "Move down is disabled on the last block");
		});

		await t.test("criterion 12: Delete all content, with Undo", async () => {
			const { before, after } = await checked(page, "delete all content", async () => {
				await button(page, "Delete all content").click();
				await page.getByRole("alertdialog").getByRole("button", { name: "Delete all content" }).click();
				await page.getByRole("alertdialog").waitFor({ state: "detached" });
			});
			assert.ok(before.page.footer, "the policy has a footer to bring back");
			// The page itself is empty, not only the state: no block is drawn, and Undo draws them all again.
			assert.equal(await page.locator(`${PAPER} > *`).count(), 0, "no block is on the page");
			await button(page, "Undo").click();
			assert.ok((await page.locator(`${PAPER} > *`).count()) > 20, "Undo draws the blocks again");
			await button(page, "Redo").click();
			assert.equal(await page.locator(`${PAPER} > *`).count(), 0, "Redo empties the page again");
			assert.deepEqual(after.body.content ?? [], [], "the body is empty");
			assert.equal(after.page.header ?? null, null, "the header is empty");
			assert.equal(after.page.footer ?? null, null, "the footer is empty");
			await page.getByText("Template, not legal advice").first().waitFor();
			assert.equal(
				await page.locator(`${PAPER} *`).filter({ hasText: "Template, not legal advice" }).count(),
				0,
				"the notice is outside the editable body",
			);
		});
		assert.deepEqual(errors, [], "no page errors");
	});
});

// ------------------------------------------------------------------------------------------------ criterion 11

test("AC:DOC-EDIT-SAVE: Save and Cmd/Ctrl+S, the status, the header revision, the conflict and the leave guard", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		const status = page.getByRole("status").filter({ hasText: /Saved|Unsaved|Saving|Not saved/ });
		await status.filter({ hasText: "Saved" }).waitFor();
		await select(page, PURPOSE, -1, -1);
		await page.keyboard.type(" One.");
		await status.filter({ hasText: "Unsaved changes" }).waitFor();
		// The editor keeps its content, cursor and undo history across a save.
		const saved = [];
		page.on("request", (r) => r.method() === "POST" && saved.push(r.url()));
		await button(page, "Save").click();
		await status.filter({ hasText: "Saved" }).filter({ hasText: "Revision 2" }).waitFor();
		assert.ok(await page.getByText("Revision 2").first().isVisible(), "the header shows revision 2");
		assert.equal(saved.length, 1, "one request saved the document");
		// A pause longer than the undo group delay (500 ms), as a person would take, so Two is its own undo step.
		await page.waitForTimeout(700);
		await page.keyboard.type(" Two.");
		await page.keyboard.press(`${MOD}+S`);
		await status.filter({ hasText: "Revision 3" }).waitFor();
		const text = await page.locator(PAPER).innerText();
		assert.match(text, /One\. Two\./, "content and cursor stay after a save");
		await button(page, "Undo").click();
		assert.doesNotMatch(await page.locator(PAPER).innerText(), /Two\./, "the undo history survives a save");
		await status.filter({ hasText: "Unsaved changes" }).waitFor();

		// A save after another tab saved first shows the conflict message, and the edits stay.
		const other = await context.newPage();
		await other.goto(`${BASE}${path}`);
		await other.locator(PAPER).waitFor({ timeout: 60_000 });
		await select(other, PURPOSE, -1, -1);
		await other.keyboard.type(" Other tab.");
		await other.getByRole("button", { name: "Save", exact: true }).click();
		await other.getByRole("status").filter({ hasText: "Revision 4" }).waitFor();
		await button(page, "Save").click();
		await status.filter({ hasText: "Not saved" }).waitFor();
		assert.match(await status.innerText(), /newer revision/);
		await button(page, "Retry").waitFor();
		assert.match(await page.locator(PAPER).innerText(), /One\./, "the edits stay after a conflict");
		await other.close();

		// Leaving with unsaved changes asks first, in an Everyfield dialog: no browser confirm, alert or prompt.
		const native = [];
		page.on("dialog", async (dialog) => {
			native.push(dialog.type());
			await dialog.dismiss();
		});
		const ask = page.getByRole("dialog", { name: "Leave without saving?" });
		await page.getByRole("link", { name: "Church documents" }).first().click();
		await ask.waitFor();
		await ask.getByRole("button", { name: "Cancel" }).click();
		await ask.waitFor({ state: "detached" });
		assert.match(page.url(), /\/documents\/church\/[0-9a-f-]{36}$/, "the page stayed");

		// The Back button asks too. Cancel keeps the page; a save that fails keeps it; Leave without saving leaves.
		await page.evaluate(() => history.back());
		await ask.waitFor();
		await ask.getByRole("button", { name: "Cancel" }).click();
		await ask.waitFor({ state: "detached" });
		assert.match(page.url(), /\/documents\/church\/[0-9a-f-]{36}$/, "Back stayed on the page after Cancel");
		await page.evaluate(() => history.back());
		await ask.getByRole("button", { name: "Save and leave" }).click();
		await ask.waitFor({ state: "detached" });
		await status.filter({ hasText: "Not saved" }).waitFor();
		assert.match(page.url(), /\/documents\/church\/[0-9a-f-]{36}$/, "a failed save keeps the page");
		await page.evaluate(() => history.back());
		await ask.getByRole("button", { name: "Leave without saving" }).click();
		await page.waitForURL(/\/documents\/church$/, { timeout: 30_000 });
		assert.deepEqual(native, [], "no browser dialog opened");
	});
});

test("AC:DOC-EDIT-SAVE: Save and leave saves, then follows the link", async () => {
	await onPage(async (page) => {
		const path = await fork(page, "Conflict of Interest Policy");
		await select(page, PURPOSE, -1, -1);
		await page.keyboard.type(" Saved on the way out.");
		await page.getByRole("link", { name: "Church documents" }).first().click();
		const ask = page.getByRole("dialog", { name: "Leave without saving?" });
		await ask.getByRole("button", { name: "Save and leave" }).click();
		await page.waitForURL(/\/documents\/church$/, { timeout: 30_000 });
		await page.goto(`${BASE}${path}`);
		await page.locator(PAPER).waitFor({ timeout: 60_000 });
		assert.match(await page.locator(PAPER).innerText(), /Saved on the way out\./);
		assert.ok(await page.getByText("Revision 2").first().isVisible(), "the save made revision 2");
	});
});

// ------------------------------------------------------------------------------------------------ criterion 13

async function files(context, path, revision) {
	const get = async (format) =>
		Buffer.from(await (await context.request.get(`${BASE}${path}/file?format=${format}&revision=${revision}`)).body());
	return { pdf: await get("pdf"), docx: await get("docx") };
}

// The server bundle once loaded DMSans-Regular for every face, so bold, italic and the serif title printed regular
// while the PDF still named each face. Each embedded font program must hold the face the PDF names.
test("AC:DOC-EDIT-MARKS-PDF: bold and italic saved in the editor print in their own faces", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		await select(page, "The board makes decisions", 0, 9);
		await button(page, "Bold").click();
		await select(page, "The board makes decisions", 10, 15);
		await button(page, "Italic").click();
		await button(page, "Save").click();
		await page.getByRole("status").filter({ hasText: "Revision 2" }).waitFor({ timeout: 60_000 });
		const { pdf } = await files(context, path, 2);
		const faces = await pdfFontFaces(pdf);
		for (const face of faces) {
			const [family, style = "Regular"] = face.baseFont.split("-");
			assert.equal(
				face.family.replace(/ 14pt$/, "").replaceAll(" ", ""),
				family,
				`${face.baseFont} holds ${face.family}`,
			);
			assert.equal(face.style.replaceAll(" ", ""), style, `${face.baseFont} holds the ${face.style} style`);
		}
		const names = faces.map((f) => f.baseFont);
		for (const name of ["DMSans", "DMSans-Bold", "DMSans-Italic", "DMSerifDisplay"])
			assert.ok(names.includes(name), `the PDF embeds ${name}: ${names}`);
		assert.ok((await pdfPages(pdf))[0].includes("The board makes decisions"), "the marked words print");
	});
});

test("AC:DOC-EDIT-PREVIEW: Preview saves first, equals Download, has one more page and keeps 4 cards", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		const first = await files(context, path, 1);
		const pagesBefore = (await PDFDocument.load(first.pdf)).getPageCount();
		await cursorIn(page, "The board makes decisions");
		await button(page, "Page break").click();
		await button(page, "Preview").click();
		await page.getByRole("img", { name: /, page 1/ }).waitFor({ timeout: 60_000 });
		const url = new URL(page.url());
		assert.ok(await page.getByText("Revision 2").first().isVisible(), "Preview saved first: revision 2");
		const preview = await context.request.get(`${BASE}${url.pathname}/file?format=pdf&revision=2`);
		const download = await context.request.get(`${BASE}${url.pathname}/file?format=pdf&revision=2&download=1`);
		assert.equal(sha(await preview.body()), sha(await download.body()), "Preview and Download are the same bytes");
		const after = await PDFDocument.load(await preview.body());
		assert.equal(after.getPageCount(), pagesBefore + 1, "the page break added a page");
		// The image the page drew is the same file: its page count matches the label.
		await page
			.getByText(new RegExp(`Page \\d of ${pagesBefore + 1}`))
			.first()
			.waitFor();

		// An edit to the commitment card still gives 4 cards on each sheet.
		const cardPath = await fork(page, "Core Group Commitment Card");
		await page.locator(PAPER).waitFor();
		await select(page, "Through Launch Sunday", -1, -1);
		await page.keyboard.type(" X");
		await button(page, "Preview").click();
		await page.getByRole("img", { name: /, page 1/ }).waitFor({ timeout: 60_000 });
		const card = await context.request.get(`${BASE}${cardPath}/file?format=pdf&revision=2`);
		const sheets = await pdfPages(Buffer.from(await card.body()));
		assert.equal(sheets.length, 1, "one sheet");
		assert.equal(
			sheets[0].split("Through Launch Sunday, I will: X").length - 1,
			4,
			"the edit shows on 4 cards of the sheet",
		);
	});
});

// ------------------------------------------------------------------------------------------------ criterion 12 (files)

test("AC:DOC-EDIT-LEGAL: after Delete all content and Save the PDF and the Word file hold only the notice", async () => {
	await onPage(async (page, context) => {
		const path = await fork(page, "Conflict of Interest Policy");
		await button(page, "Delete all content").click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Delete all content" }).click();
		await button(page, "Save").click();
		await page.getByRole("status").filter({ hasText: "Revision 2" }).waitFor();
		const { pdf, docx } = await files(context, path, 2);
		const pages = await pdfPages(pdf);
		assert.deepEqual(pages, ["Template, not legal advice"]);
		const parts = docxParts(docx);
		const body = wordText(parts["word/document.xml"]);
		assert.equal(body, "", "the Word body holds no text");
		const notices = Object.entries(parts)
			.filter(([name]) => /word\/(footer|header)\d*\.xml$/.test(name))
			.map(([, xml]) => wordText(xml));
		assert.deepEqual(notices.filter(Boolean), ["Template, not legal advice"]);
	});
});

// ------------------------------------------------------------------------------------------------ criterion 14

test("AC:DOC-EDIT-MEMBER: a Member sees the preview and the downloads, and no editing controls", async () => {
	let path = "";
	await onPage(async (page) => {
		path = await fork(page, "Conflict of Interest Policy");
	});
	await withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people").member.cookie);
		await page.goto(`${BASE}${path}`);
		await hydrated(page);
		await page.getByRole("img", { name: /, page 1/ }).waitFor({ timeout: 60_000 });
		assert.equal(await page.locator("[contenteditable]").count(), 0, "no contenteditable");
		for (const name of ["Save", "Preview", "Delete all content", "Undo", "Bold"])
			assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `no ${name} control`);
		assert.equal(await page.getByRole("toolbar").count(), 0, "no toolbar");
		assert.ok(await page.getByRole("link", { name: "Download PDF" }).isVisible(), "the downloads stay");
	});
});

// ------------------------------------------------------------------------------------------------ criterion 15 (chunks)

const EDITOR = /prosemirror-state|ProseMirror-selectednode|@tiptap|tiptap-pro/;

/** Every script the browser loads for a page, as text: the page's own chunks and the ones it loads after hydration. */
async function loadedCode(cookie, route, ready) {
	let code = "";
	await withPage(chromium, async (page, context) => {
		await signIn(context, cookie);
		const bodies = [];
		page.on("response", (response) => {
			if (response.request().resourceType() === "script") bodies.push(response.text().catch(() => ""));
		});
		await page.goto(`${BASE}${route}`);
		await hydrated(page);
		await ready(page);
		await page.waitForLoadState("networkidle");
		code = (await Promise.all(bodies)).join("\n");
	});
	return code;
}
const hit = (text) => text.match(EDITOR)?.[0] ?? null;

test("AC:DOC-EDIT-CHUNKS: the library and a Member's page load no editor code; the Owner's page does", async () => {
	let path = "";
	await onPage(async (page) => {
		path = await fork(page, "Conflict of Interest Policy");
	});
	const { owner, member } = fixture("people");
	const library = await loadedCode(owner.cookie, "/documents/church", (page) =>
		page.getByRole("button", { name: "New from template" }).first().waitFor(),
	);
	assert.equal(hit(library), null, "the library loads no editor code");
	const memberPage = await loadedCode(member.cookie, path, (page) =>
		page.getByRole("img", { name: /, page 1/ }).waitFor({ timeout: 60_000 }),
	);
	assert.equal(hit(memberPage), null, "the Member page loads no editor code");
	const ownerPage = await loadedCode(owner.cookie, path, (page) => page.locator(PAPER).waitFor({ timeout: 60_000 }));
	assert.ok(hit(ownerPage), "the Owner's document page loads the editor");
});
