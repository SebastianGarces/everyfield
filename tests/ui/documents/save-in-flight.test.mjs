// T-120: saves in the Church Document and written-document editors, in Chromium against a real preview.
//  - "Save and leave" while a save is in flight: the test holds the first save's request, types more text, picks
//    "Save and leave" and only then lets the request go. The editor waits for that save, sees the later text unsaved,
//    saves it too and leaves; a fresh load of the document shows the later text.
//  - A save whose body JSON is near BODY_JSON_MAX (over 1 MB, and over 3 MB of UTF-8 on the wire) succeeds: the host's
//    server-action limit (apps/web/next.config.ts) covers the largest valid save.
//   UI_BASE_URL=https://....localhost:1355 UI_ENGINE=chromium node --test tests/ui/documents/save-in-flight.test.mjs
// Seed People first: tests/ui/people/seed.mts up <preview-url>.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BODY_JSON_MAX } from "../../../packages/contracts/src/documents/body.ts";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const PAPER = ".ef-paper .ProseMirror";
const CHURCH_PATH = /\/documents\/church\/[0-9a-f-]{36}$/;
const WRITTEN_PATH = /\/documents\/written\/[0-9a-f-]{36}$/;

const onPage = (run) =>
	withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people").owner.cookie);
		const native = [];
		page.on("dialog", async (dialog) => {
			native.push(dialog.type());
			await dialog.dismiss();
		});
		await run(page);
		assert.deepEqual(native, [], "no browser dialog opened");
	});

const status = (page, text) =>
	page
		.getByRole("status")
		.filter({ hasText: /Saved|Unsaved|Saving|Not saved/ })
		.filter({ hasText: text });
const saveButton = (page) => page.getByRole("button", { name: "Save", exact: true });
const text = (page) => page.locator(PAPER).evaluate((el) => el.editor.getText());

/** Puts the cursor at the end of the last top-level paragraph of the body (not a header, footer or box). */
const cursorAtBodyEnd = (page) =>
	page.locator(PAPER).evaluate((el) => {
		const ed = el.editor;
		let end = null;
		ed.state.doc.forEach((child, offset) => {
			if (child.type.name === "paragraph") end = offset + 1 + child.content.size;
		});
		if (end === null) throw new Error("no body paragraph");
		ed.chain().focus().setTextSelection(end).run();
		return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
	});

/**
 * Holds the next server action POST (a save) until `release()`; `held` resolves once the browser has sent it. Later
 * actions pass straight through.
 */
async function holdNextSave(page) {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let sent;
	const held = new Promise((resolve) => (sent = resolve));
	let once = false;
	await page.route(
		(url) => url.origin === new URL(BASE).origin,
		async (route) => {
			const request = route.request();
			if (once || request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
			once = true;
			sent();
			await gate;
			await route.fallback();
		},
	);
	return { held, release: () => release() };
}

/** Starts a save, types `later` while it is held, then leaves by `exit` and picks "Save and leave". */
async function saveTypeLeave(page, { first, later, exit, landed }) {
	await cursorAtBodyEnd(page);
	await page.keyboard.type(first);
	const save = await holdNextSave(page);
	await saveButton(page).click();
	await save.held;
	await status(page, "Saving").waitFor();
	// The save in flight carries `first` only; this text is typed while it runs.
	await cursorAtBodyEnd(page);
	await page.keyboard.type(later);
	await exit();
	const ask = page.getByRole("dialog", { name: "Leave without saving?" });
	await ask.waitFor();
	await ask.getByRole("button", { name: "Save and leave" }).click();
	save.release();
	await page.waitForURL(landed, { timeout: 60_000 });
}

test("written document: Save and leave during a save in flight stores the text typed after it started", async () => {
	await onPage(async (page) => {
		await page.goto(`${BASE}/documents/written/new`);
		await hydrated(page);
		await page.getByLabel("Title").fill(`In flight ${randomUUID().slice(0, 8)}`);
		await page.locator(PAPER).click();
		await page.keyboard.type("Opening line.");
		await saveButton(page).click();
		await page.waitForURL(WRITTEN_PATH);
		await status(page, /^Saved/).waitFor();
		const docUrl = page.url();
		const later = ` Typed later ${randomUUID().slice(0, 8)}.`;
		await saveTypeLeave(page, {
			first: " First edit.",
			later,
			exit: () => page.getByRole("link", { name: "Documents", exact: true }).first().click(),
			landed: /\/documents$/,
		});
		await page.goto(docUrl);
		await hydrated(page);
		await page.locator(PAPER).waitFor();
		assert.equal(await text(page), `Opening line. First edit.${later}`);
		await status(page, /^Saved/).waitFor();
	});
});

test("Church Document: Save and leave during a save in flight stores the text typed after it started", async () => {
	await onPage(async (page) => {
		await page.goto(`${BASE}/documents/church`);
		await hydrated(page);
		await page.getByRole("button", { name: "New from template" }).first().click();
		await page.getByRole("button", { name: /^Core Group Commitment Card/ }).click();
		await page.waitForURL(CHURCH_PATH, { timeout: 90_000 });
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		const docUrl = page.url();
		const later = ` Typed later ${randomUUID().slice(0, 8)}.`;
		await saveTypeLeave(page, {
			first: " First edit.",
			later,
			exit: () => page.getByRole("link", { name: "Documents", exact: true }).first().click(),
			landed: /\/documents(\/church)?$/,
		});
		await page.goto(docUrl);
		await hydrated(page);
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		const stored = await text(page);
		assert.ok(stored.includes(` First edit.${later}`), `the stored text holds the later edit: ${stored.slice(-200)}`);
		await status(page, /^Saved/).waitFor();
	});
});

/**
 * Fills the body with paragraphs of "€" (3 UTF-8 bytes each) until the editor's JSON is about `target` characters,
 * and returns that length. Each paragraph stays under the 20,000-character text limit.
 */
const fillTo = (page, target) =>
	page.locator(PAPER).evaluate((el, goal) => {
		const ed = el.editor;
		const size = () => JSON.stringify(ed.getJSON()).length;
		const chunk = "€".repeat(19_000);
		const paragraph = { type: "paragraph", content: [{ type: "text", text: chunk }] };
		const room = Math.floor((goal - size()) / JSON.stringify(paragraph).length);
		let end = null;
		ed.state.doc.forEach((child, offset) => {
			if (child.type.name === "paragraph") end = offset + child.nodeSize;
		});
		ed.chain()
			.insertContentAt(end, Array.from({ length: room }, () => paragraph))
			.run();
		return size();
	}, target);

test("a written document and a Church Document near BODY_JSON_MAX save through the host", async () => {
	await onPage(async (page) => {
		await page.goto(`${BASE}/documents/written/new`);
		await hydrated(page);
		await page.getByLabel("Title").fill("Near the body limit");
		await page.locator(PAPER).click();
		await page.keyboard.type("Start.");
		const written = await fillTo(page, BODY_JSON_MAX - 40_000);
		assert.ok(written > 1_900_000 && written < BODY_JSON_MAX, `written body JSON is ${written} characters`);
		await saveButton(page).click();
		await page.waitForURL(WRITTEN_PATH, { timeout: 60_000 });
		await status(page, /^Saved/).waitFor({ timeout: 60_000 });
		await page.reload();
		await hydrated(page);
		await page.locator(PAPER).waitFor();
		assert.equal(await page.locator(PAPER).evaluate((el) => JSON.stringify(el.editor.getJSON()).length), written);

		await page.goto(`${BASE}/documents/church`);
		await hydrated(page);
		await page.getByRole("button", { name: "New from template" }).first().click();
		await page.getByRole("button", { name: /^Core Group Commitment Card/ }).click();
		await page.waitForURL(CHURCH_PATH, { timeout: 90_000 });
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		// The saved document adds its page setup and exports to the editor's JSON, so the fill leaves room for them.
		const church = await fillTo(page, BODY_JSON_MAX - 60_000);
		assert.ok(church > 1_900_000, `Church body JSON is ${church} characters`);
		await saveButton(page).click();
		await status(page, /^Saved/).waitFor({ timeout: 60_000 });
		await page.reload();
		await hydrated(page);
		await page.locator(PAPER).waitFor({ timeout: 90_000 });
		assert.equal(await page.locator(PAPER).evaluate((el) => JSON.stringify(el.editor.getJSON()).length), church);
	});
});
