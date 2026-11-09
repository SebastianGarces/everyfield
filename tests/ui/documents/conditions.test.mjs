// T-20 (WP-036 slice): conditional text in the Church Document editor, in a real browser against a preview. Each action
// runs on a forked document; after each action, after Undo and after Redo the whole document JSON is checked: Undo
// gives the earlier JSON exactly, Redo the later, and each one parses with docDocument.
//   UI_BASE_URL=https://....localhost:1355 node --env-file=<home apps/web/.env.local> --test tests/ui/documents/conditions.test.mjs
// Seed People, then Settings, as for the table tests (tables.test.mjs). A document with number and list fields, and one
// with no fields, is written as the fork's revision through the seed's admin connection: no template has them.
//   T-20 criteria 2, 3, 4, 5, 6, 9 and 10.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../packages/domain/src/documents/doc-templates.ts";
import { documentFrom } from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { pdfPages } from "../../integration/documents/fixtures/readers.mts";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";
import { clickDownload } from "./tables-support.mjs";

const PAPER = ".ef-paper .ProseMirror";
const MOD = "ControlOrMeta";
const TITLES = {
	"commitment-card": "Core Group Commitment Card",
	"conflict-of-interest-policy": "Conflict of Interest Policy",
};

let db = null;
/**
 * The seeded database, opened on first use. It saves the next revision of a document, as the Owner, with fields no
 * template has: the same rows `documents.saveNative` writes (revisions are immutable, so a new one).
 */
async function database() {
	if (db) return db;
	const { openSeedEnvironment } = await import("../seed-env.mts");
	const { sql } = await import("../../../packages/db/node_modules/drizzle-orm/index.js");
	const env = await openSeedEnvironment(fixture("people").origin);
	const write = async (id, doc) => {
		const body = JSON.stringify(doc);
		const hash = createHash("sha256").update(body, "utf8").digest("hex");
		const author = fixture("people").owner.accountId;
		await env.admin.execute(
			sql`WITH existing AS (SELECT id, tenant_id, revision FROM document WHERE id = ${id}::uuid),
			added AS (
				INSERT INTO document_revision (
					id, tenant_id, document_id, version_number, body, content_hash, published_at, recorded_at, author_account_id
				)
				SELECT ${randomUUID()}::uuid, existing.tenant_id, existing.id, (existing.revision + 1)::int, ${body}, ${hash},
					clock_timestamp(), clock_timestamp(), ${author}::uuid
				FROM existing
				RETURNING id, document_id
			)
			UPDATE document SET current_revision_id = added.id, revision = document.revision + 1
			FROM added WHERE document.id = added.document_id`,
		);
	};
	db = { write, close: () => env.close() };
	return db;
}
test.after(async () => {
	if (db) await db.close();
});

const settle = (page) =>
	page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

/**
 * Forks `templateId` as the seeded Owner (or `who`) and gives `run` the page and helpers. `rewrite` turns the fork into
 * another document before the editor opens it: its revision is replaced and the page reloads.
 */
function onFork(engine, templateId, run, { size, who = "owner", rewrite } = {}) {
	return withPage(
		engine,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			page.on("pageerror", (error) => assert.fail(`page error: ${error.message}`));
			await page.goto(`${BASE}/documents/church`);
			await hydrated(page);
			await page.getByRole("button", { name: "New from template" }).first().click();
			await page.getByRole("button", { name: new RegExp(`^${TITLES[templateId]}`) }).click();
			await page.waitForURL(/\/documents\/church\/[0-9a-f-]{36}$/, { timeout: 120_000 });
			await page.locator(PAPER).waitFor({ timeout: 120_000 });
			const id = page.url().split("/").pop();
			let base = await forkTemplate(docTemplateById(templateId), { data: {} });
			if (rewrite) {
				// The stored envelope keeps the data the fork froze; the rewrite sets the rest.
				const stored = await page.locator(PAPER).evaluate((el) => el.editor.getJSON());
				base = rewrite(documentFrom(base, stored));
				assert.ok(docDocument.safeParse(base).success, "the rewritten document is valid");
				await (await database()).write(id, base);
				await page.reload();
				await page.locator(PAPER).waitFor({ timeout: 120_000 });
			}
			if (who !== "owner") {
				await context.clearCookies();
				await signIn(context, fixture("people")[who].cookie);
				await page.reload();
				await hydrated(page);
			} else await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
			await run(
				page,
				helpers(page, () => base, id),
			);
		},
		size ? { width: size[0], height: size[1] } : undefined,
	);
}

function helpers(page, base, id) {
	const json = () => page.locator(PAPER).evaluate((el) => el.editor.getJSON());
	const snap = async () => documentFrom(base(), await json());
	const body = async () => (await snap()).body.content ?? [];
	const valid = (doc, label) => {
		const parsed = docDocument.safeParse(doc);
		assert.ok(parsed.success, `${label}: the document parses with docDocument: ${parsed.error?.issues[0]?.message}`);
	};
	const button = (name) => page.getByRole("button", { name, exact: true });
	const undo = () => button("Undo").click();
	const redo = () => button("Redo").click();

	/** One action with Undo and Redo: the whole document JSON after each step, valid every time. */
	async function checked(label, act, { same = false } = {}) {
		const before = await snap();
		valid(before, `${label} (before)`);
		await act();
		await settle(page);
		const done = await snap();
		valid(done, `${label} (after)`);
		if (same) {
			// Nothing changed, so there is nothing for Undo to reverse.
			assert.deepStrictEqual(done, before, `${label} left the document as it was`);
			return done;
		}
		assert.notDeepStrictEqual(done, before, `${label} changed the document`);
		await undo();
		await settle(page);
		const undone = await snap();
		valid(undone, `${label} (after Undo)`);
		assert.deepStrictEqual(undone, before, `${label}: Undo gives the earlier JSON exactly`);
		await redo();
		await settle(page);
		const redone = await snap();
		valid(redone, `${label} (after Redo)`);
		assert.deepStrictEqual(redone, done, `${label}: Redo gives the later JSON exactly`);
		return done;
	}
	async function insert(name) {
		await button("Insert block").click();
		await page.getByRole("menuitem", { name, exact: true }).click();
		await settle(page);
	}
	/** The cursor at the end (or `offset` chars in) of the first text that contains `text`. */
	async function cursorIn(text, offset = -1) {
		await page.locator(PAPER).evaluate(
			(el, [needle, at]) => {
				const ed = el.editor;
				let pos = null;
				ed.state.doc.descendants((node, p) => {
					if (pos !== null || !node.isText) return pos === null;
					const i = node.text.indexOf(needle);
					if (i >= 0) pos = p + i + (at < 0 ? needle.length : at);
					return false;
				});
				if (pos === null) throw new Error(`no text "${needle}"`);
				ed.chain().focus().setTextSelection(pos).run();
			},
			[text, offset],
		);
		await settle(page);
	}
	/** Selects the n-th conditional text block as a whole. */
	async function selectCondition(n = 0) {
		await page.locator(PAPER).evaluate((el, index) => {
			const ed = el.editor;
			let seen = -1;
			let at = null;
			ed.state.doc.descendants((node, p) => {
				if (at !== null) return false;
				if (node.type.name === "if" && ++seen === index) at = p;
				return true;
			});
			ed.chain().focus().setNodeSelection(at).run();
		}, n);
		await settle(page);
	}
	async function save() {
		await button("Save").click();
		await page.getByRole("status").filter({ hasText: /^Saved/ }).waitFor({ timeout: 60_000 });
	}
	/** The bytes for the saved revision. `download` is what Download gives: it saves one export of the revision, then
	 * fetches that export's stored bytes (D-78). Else the file route the preview reads. */
	async function file(format, { download = true } = {}) {
		const revision = (await page.getByRole("status").filter({ hasText: /^Saved/ }).innerText()).match(/Revision (\d+)/)?.[1];
		const { request } = page.context();
		if (!download) {
			const response = await request.get(`${BASE}/documents/church/${id}/file?format=${format}&revision=${revision}`);
			return { status: response.status(), bytes: new Uint8Array(await response.body()) };
		}
		const saved = await request.post(`${BASE}/documents/church/${id}/exports`, {
			data: { revision: String(revision), format, requestKey: randomUUID() },
		});
		const reply = await saved.json();
		if (reply.status !== "saved") return { status: saved.status(), bytes: new Uint8Array() };
		const response = await request.get(`${BASE}/documents/church/${id}/exports/${reply.saved.id}`);
		return { status: response.status(), bytes: new Uint8Array(await response.body()) };
	}
	const conditions = async () => (await body()).filter((n) => n.type === "if");
	const field = () => page.getByRole("combobox", { name: "Condition field" });
	const testSelect = () => page.getByRole("combobox", { name: "Condition test" });
	const label = (n = 0) => page.locator(`${PAPER} .ef-if-label`).nth(n);
	const state = (n = 0) => page.locator(`${PAPER} .ef-if-state`).nth(n);
	return {
		json,
		snap,
		body,
		valid,
		button,
		undo,
		redo,
		checked,
		insert,
		cursorIn,
		selectCondition,
		save,
		file,
		conditions,
		field,
		testSelect,
		label,
		state,
		settle: () => settle(page),
		id,
	};
}

/** A paragraph of text, as the format stores it. */
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });

/** The commitment card turned into a document with number and list fields, as the agenda would have. */
const FIELDS = [
	{ key: "church_name", label: "Church name", type: "text" },
	{ key: "pastor", label: "Pastor", type: "text" },
	{ key: "shown", label: "Attendees shown", type: "number" },
	{ key: "not_shown", label: "Attendees not shown", type: "number" },
	{ key: "attendees", label: "Attendees", type: "list" },
];
const PAGE = { size: "letter", orientation: "portrait", margin: { top: 54, right: 54, bottom: 54, left: 54 } };
const withNumbers = (doc) => ({
	...doc,
	fields: FIELDS,
	data: { church_name: "Harbor City Church", shown: 150, not_shown: 1, attendees: [{ name: "A" }, { name: "B" }] },
	page: PAGE,
	body: {
		type: "doc",
		content: [
			para("Attendees"),
			{
				type: "if",
				attrs: { field: "not_shown", test: "more-than", value: 0 },
				content: [
					{
						type: "paragraph",
						attrs: { style: "small" },
						content: [
							{ type: "text", text: "This list shows the first " },
							{ type: "field", attrs: { key: "shown" } },
							{ type: "text", text: " people. " },
							{ type: "field", attrs: { key: "not_shown" } },
							{ type: "text", text: " more are not shown." },
						],
					},
				],
			},
			para("Follow-up actions"),
		],
	},
});
/** A document with no fields at all, as a blank document is. */
const noFields = (doc) => ({
	...doc,
	fields: [],
	data: {},
	page: PAGE,
	body: { type: "doc", content: [para("A blank page"), para("Second line")] },
});

const pdfText = async (bytes) => (await pdfPages(bytes)).join(" ");

for (const [name, engine] of ENGINES) {
	test(`T-20 (${name}) criteria 2, 3, 5 and 9: insert, change, wrap, remove, move, delete, copy and paste, with Undo and Redo`, async () => {
		await onFork(engine, "commitment-card", async (page, t) => {
			// 2: Insert offers Conditional text: one empty paragraph after the current block, with its control open.
			const first = (await t.body()).find((n) => n.type === "paragraph" && n.content?.some((c) => c.text));
			const firstText = first.content.find((c) => c.text).text;
			await t.cursorIn(firstText);
			const inserted = await t.checked("Insert Conditional text", () => t.insert("Conditional text"));
			const added = inserted.body.content.filter((n) => n.type === "if");
			assert.equal(added.length, 1);
			assert.deepEqual(added[0], {
				type: "if",
				attrs: { field: "church_name", test: "has-value" },
				content: [{ type: "paragraph" }],
			});
			const firstAt = inserted.body.content.findIndex((b) => JSON.stringify(b) === JSON.stringify(first));
			assert.equal(inserted.body.content.indexOf(added[0]), firstAt + 1, "it sits after the current block");
			await t.field().waitFor();
			assert.equal(await t.label().innerText(), "Prints only when Church name has a value");
			assert.equal(await t.state().innerText(), "Prints now");

			await t.checked("Type in conditional text", () => page.keyboard.type("Only when named"));

			// 3: each field by its label; a text field offers two tests; each change relabels the block at once.
			assert.deepEqual(await t.field().locator("option").allInnerTexts(), ["Church name", "Tagline", "Contact line"]);
			assert.deepEqual(await t.testSelect().locator("option").allInnerTexts(), ["Has a value", "Is empty"]);
			let doc = await t.checked("Change the field", () => t.field().selectOption("church_tagline"));
			assert.deepEqual(doc.body.content.find((n) => n.type === "if").attrs, {
				field: "church_tagline",
				test: "has-value",
			});
			assert.equal(await t.label().innerText(), "Prints only when Tagline has a value");
			doc = await t.checked("Change the test", () => t.testSelect().selectOption("is-empty"));
			assert.deepEqual(doc.body.content.find((n) => n.type === "if").attrs, {
				field: "church_tagline",
				test: "is-empty",
			});
			assert.equal(await t.label().innerText(), "Prints only when Tagline is empty");

			// 5: Remove condition keeps the text in place as a plain paragraph.
			const beforeRemove = await t.snap();
			const at = beforeRemove.body.content.findIndex((n) => n.type === "if");
			doc = await t.checked("Remove condition", () => t.button("Remove condition").click());
			assert.equal((await t.conditions()).length, 0);
			assert.deepEqual(doc.body.content[at], para("Only when named"));
			assert.equal(doc.body.content.length, beforeRemove.body.content.length);

			// 2: Make block conditional wraps the current block.
			await t.cursorIn("Only when named", 4);
			doc = await t.checked("Make block conditional", () => t.button("Make block conditional").click());
			assert.deepEqual(doc.body.content[at], {
				type: "if",
				attrs: { field: "church_name", test: "has-value" },
				content: [para("Only when named")],
			});

			// 5: Move up, Move down and Delete act on the whole conditional block.
			await t.cursorIn("Only when named");
			doc = await t.checked("Move up", () => t.button("Move block up").click());
			assert.equal(doc.body.content[at - 1].type, "if");
			doc = await t.checked("Move down", () => t.button("Move block down").click());
			assert.equal(doc.body.content[at].type, "if");

			// 9: a copied and pasted conditional block keeps its condition and stays valid.
			await t.selectCondition(0);
			await page.keyboard.press(`${MOD}+C`);
			await t.cursorIn(firstText);
			doc = await t.checked("Paste a conditional block", () => page.keyboard.press(`${MOD}+V`));
			const pasted = doc.body.content.filter((n) => n.type === "if");
			assert.equal(pasted.length, 2, "the paste added a second conditional block");
			for (const c of pasted)
				assert.deepEqual(c, {
					type: "if",
					attrs: { field: "church_name", test: "has-value" },
					content: [para("Only when named")],
				});

			await t.cursorIn("Only when named");
			const count = (await t.body()).length;
			doc = await t.checked("Delete block", () => t.button("Delete block").click());
			assert.equal(doc.body.content.length, count - 1);
			assert.equal(doc.body.content.filter((n) => n.type === "if").length, 1);

			// 9: Save and reload keep the condition.
			const kept = await t.snap();
			await t.save();
			await page.reload();
			await page.locator(PAPER).waitFor();
			assert.deepStrictEqual(await t.snap(), kept, "the condition is the same after a reload");
			assert.equal(await t.label().innerText(), "Prints only when Church name has a value");

			// 2: inside conditional text, Insert offers no second one; the page footer offers neither action.
			await t.cursorIn("Only when named");
			await t.button("Insert block").click();
			assert.equal(
				await page.getByRole("menuitem", { name: "Conditional text", exact: true }).count(),
				1,
				"offered: it goes after this one",
			);
			await page.keyboard.press("Escape");
		});
	});

	test(`T-20 (${name}) criteria 2 and 5: the footer offers no conditional text; Delete all content on a policy keeps only the notice`, async () => {
		await onFork(engine, "conflict-of-interest-policy", async (page, t) => {
			await t.cursorIn("|  Conflict of Interest Policy");
			assert.ok(
				await page
					.locator(`${PAPER} footer[data-ef-node="pageFooter"]`)
					.evaluate((el) => el.contains(getSelection()?.anchorNode ?? null)),
				"the cursor is in the footer",
			);
			await t.button("Insert block").click();
			assert.equal(
				await page.getByRole("menuitem", { name: "Conditional text", exact: true }).count(),
				0,
				"the footer's Insert menu has no Conditional text",
			);
			await page.keyboard.press("Escape");
			assert.equal(await t.button("Make block conditional").count(), 0, "the footer offers no Make block conditional");

			const body = await t.body();
			const text = body
				.find((n) => n.type === "paragraph" && n.content?.some((c) => c.text))
				.content.find((c) => c.text).text;
			await t.cursorIn(text);
			await t.checked("Make block conditional", () => t.button("Make block conditional").click());
			const doc = await t.checked("Delete all content", async () => {
				await page.getByRole("button", { name: "Delete all content" }).click();
				await page.getByRole("alertdialog").getByRole("button", { name: "Delete all content" }).click();
			});
			assert.equal(doc.body.content, undefined, "the body is empty: the conditional block went with the rest");
			await page.getByText("Template, not legal advice").waitFor();
			assert.equal(await page.locator(".ef-notice").getByText("Locked").count(), 1);
		});
	});

	test(`T-20 (${name}) criterion 2: in a document with no fields, both actions are disabled with a reason`, async () => {
		await onFork(
			engine,
			"commitment-card",
			async (page, t) => {
				await t.cursorIn("A blank page");
				const wrap = t.button("Make block conditional");
				assert.equal(await wrap.isDisabled(), true);
				assert.equal(await wrap.evaluate((el) => getComputedStyle(el).cursor), "not-allowed");
				await page
					.getByLabel("Make block conditional is unavailable. This document has no fields for a condition to read.")
					.hover();
				await page
					.getByRole("tooltip")
					.getByText("This document has no fields for a condition to read.", { exact: false })
					.waitFor();
				await t.button("Insert block").click();
				const item = page.getByRole("menuitem", { name: "Conditional text", exact: true });
				assert.equal(await item.getAttribute("data-disabled"), "");
				await page.getByRole("menu").getByText("This document has no fields for a condition to read.").waitFor();
				await page.keyboard.press("Escape");
			},
			{ rewrite: noFields },
		);
	});

	test(`T-20 (${name}) criteria 3, 4 and 6: number and list conditions, a bad value refused, the label matches the PDF`, async () => {
		await onFork(
			engine,
			"commitment-card",
			async (page, t) => {
				await t.cursorIn("more are not shown.");
				assert.equal(await t.label().innerText(), "Prints only when Attendees not shown is more than 0");
				assert.equal(await t.state().innerText(), "Prints now");
				assert.deepEqual(await t.testSelect().locator("option").allInnerTexts(), [
					"Has a value",
					"Is empty",
					"Is more than",
				]);
				const value = page.getByRole("textbox", { name: "Number" });

				// A value that is not a whole number from 0 shows why next to the field and is not applied.
				for (const bad of ["-1", "1.5", "abc"]) {
					await t.checked(`Bad value ${bad}`, () => value.fill(bad), { same: true });
					await page.getByRole("alert").filter({ hasText: "is not a whole number from 0" }).waitFor();
					await value.blur();
				}
				// Each case: the label and its state in the editor, then the PDF of the same saved revision.
				const cases = [
					// field, value, prints
					["not_shown", 0, true], // 1 above 0
					["not_shown", 1, false], // at
					["not_shown", 2, false], // below
					["attendees", 1, true], // 2 entries above 1
					["attendees", 2, false], // at
					["attendees", 3, false], // below
				];
				for (const [key, number, prints] of cases) {
					await t.cursorIn("more are not shown.");
					const now = (await t.conditions())[0].attrs;
					if (now.field !== key) await t.checked(`Field ${key}`, () => t.field().selectOption(key));
					if (now.test !== "more-than")
						await t.checked("Test is more than", () => t.testSelect().selectOption("more-than"));
					if ((await t.conditions())[0].attrs.value !== number)
						await t.checked(`Value ${number}`, () =>
							page.getByRole("textbox", { name: "Number" }).fill(String(number)),
						);
					const fieldLabel = key === "attendees" ? "Attendees" : "Attendees not shown";
					assert.equal(await t.label().innerText(), `Prints only when ${fieldLabel} is more than ${number}`);
					assert.equal(await t.state().innerText(), prints ? "Prints now" : "Does not print now");
					await t.save();
					const download = await t.file("pdf");
					assert.equal(download.status, 200);
					const text = await pdfText(download.bytes);
					assert.equal(
						text.includes("This list shows the first 150 people. 1 more are not shown."),
						prints,
						`${key} more than ${number}: the PDF agrees with the label`,
					);
					assert.match(
						text,
						/Attendees (This list shows .* not shown\. )?Follow-up actions/,
						"no blank: the next block follows",
					);
					// 6: the preview is the same PDF Download gives.
					const preview = await t.file("pdf", { download: false });
					assert.deepEqual(preview.bytes, download.bytes, "the preview bytes equal the Download bytes");
				}
				// has-value and is-empty on a number field.
				await t.checked("Test has a value", () => t.testSelect().selectOption("has-value"));
				assert.deepEqual(
					(await t.conditions())[0].attrs,
					{ field: "attendees", test: "has-value" },
					"the value goes with the test",
				);
				assert.equal(await page.getByRole("textbox", { name: "Number" }).count(), 0);
				// Changing to a text field drops a test it does not take.
				await t.checked("Test is more than", () => t.testSelect().selectOption("more-than"));
				await t.checked("Field to a text field", () => t.field().selectOption("pastor"));
				assert.deepEqual((await t.conditions())[0].attrs, { field: "pastor", test: "has-value" });
				assert.deepEqual(await t.testSelect().locator("option").allInnerTexts(), ["Has a value", "Is empty"]);
				assert.equal(await t.state().innerText(), "Does not print now");
				assert.equal(
					await page
						.locator(`${PAPER} .ef-if[data-prints="false"] .ef-if-body`)
						.evaluate((el) => getComputedStyle(el).opacity),
					"0.5",
				);
			},
			{ rewrite: withNumbers },
		);
	});

	test(`T-20 (${name}) criterion 10: the controls have names, tooltips, keyboard and cursors; 390 px fits; a Member sees what prints`, async () => {
		let docId = null;
		await onFork(
			engine,
			"commitment-card",
			async (page, t) => {
				docId = t.id;
				await t.cursorIn("more are not shown.");
				await t.checked("Field pastor", () => t.field().selectOption("pastor"));
				await t.save();
				for (const control of [t.field(), t.testSelect(), t.button("Remove condition")])
					assert.equal(await control.evaluate((el) => getComputedStyle(el).cursor), "pointer");
				// Inside conditional text, Make block conditional cannot apply: disabled, with its reason.
				assert.equal(
					await t.button("Make block conditional").evaluate((el) => getComputedStyle(el).cursor),
					"not-allowed",
				);
				await t.cursorIn("Attendees");
				assert.equal(await t.button("Make block conditional").evaluate((el) => getComputedStyle(el).cursor), "pointer");
				await t.cursorIn("more are not shown.");
				// Keyboard: Tab reaches the field, the test and Remove condition in order. WebKit's default skips buttons on
				// Tab (Safari's keyboard setting), so there Option+Tab reaches the button, as a Safari user presses it.
				await t.field().focus();
				await page.keyboard.press("Tab");
				assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Condition test");
				await page.keyboard.press(name === "webkit" ? "Alt+Tab" : "Tab");
				assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Remove condition");
				await page.keyboard.press("Enter");
				await t.settle();
				assert.equal((await t.conditions()).length, 0, "Enter on Remove condition removes it");
				await t.undo();
				await t.settle();
				// Tooltips.
				await t.field().hover();
				await page.getByRole("tooltip").getByText("The field this condition reads").waitFor();
				await t.button("Remove condition").hover();
				await page.getByRole("tooltip").getByText("Remove the condition and keep the text as plain blocks").waitFor();
				// 390 px: the control fits the screen with no sideways scroll.
				await page.setViewportSize({ width: 390, height: 844 });
				await t.cursorIn("more are not shown.");
				await t.field().waitFor();
				await t.settle();
				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				);
				assert.ok(overflow <= 0, `no sideways scroll at 390 px (${overflow} px)`);
				const box = await page.getByRole("group", { name: "Conditional text", exact: true }).boundingBox();
				assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "the condition control fits the screen");
			},
			{ rewrite: withNumbers },
		);
		// A Member reads the PDF: the false block is not there, and no control shows. Download works.
		await withPage(engine, async (page, context) => {
			await signIn(context, fixture("people").member.cookie);
			await page.goto(`${BASE}/documents/church/${docId}`);
			await hydrated(page);
			await page.getByRole("region", { name: "Preview" }).waitFor();
			assert.equal(await page.locator(PAPER).count(), 0, "no editor");
			assert.equal(await page.getByRole("combobox", { name: "Condition field" }).count(), 0, "no condition control");
			assert.equal(await page.getByText(/Prints only when/).count(), 0, "no condition label");
			const text = await pdfText(await clickDownload(page, "Download PDF"));
			assert.ok(!text.includes("This list shows"), "the Member's file leaves the false block out");
			assert.match(text, /Attendees Follow-up actions/);
			assert.ok((await clickDownload(page, "Download Word")).length > 0, "the Member downloads the Word file");
		});
	});
}
