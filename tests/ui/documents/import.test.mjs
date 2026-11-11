// T-120: written-document import through its route (/documents/written/import), in Chromium against a real preview.
// The file goes as raw bytes through the proxy and the route handler, not a server action, whose 1 MB cap refused any
// file the 10 MB limit allows. Over the limit, the page states the limit; the route refuses a body over it the same way.
//   UI_BASE_URL=https://....localhost:1355 UI_ENGINE=chromium node --test tests/ui/documents/import.test.mjs
// Seed People first: tests/ui/people/seed.mts up <preview-url>.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { IMPORT_BYTES_MAX, IMPORT_TOO_LARGE } from "../../../packages/contracts/src/documents/values.ts";
import { p, storedZip } from "../../integration/documents/fixtures/word.mts";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const chromium = ENGINES.find(([name]) => name === "chromium")?.[1];
const PAPER = ".ef-paper .ProseMirror";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** A Word file of exactly `size` bytes: two paragraphs of text and a picture part that pads it to that size. */
function wordFile(size, lines) {
	const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((line) => p(line)).join("")}</w:body></w:document>`;
	const build = (padding) =>
		storedZip([
			{ name: "word/document.xml", data: xml },
			{ name: "word/media/image1.png", data: randomBytes(padding) },
		]);
	const bytes = build(size - build(0).length);
	assert.equal(bytes.length, size);
	return bytes;
}

const onWritten = (run) =>
	withPage(chromium, async (page, context) => {
		await signIn(context, fixture("people").owner.cookie);
		await page.goto(`${BASE}/documents/written/new`);
		await hydrated(page);
		await page.locator(PAPER).waitFor();
		await run(page);
	});

const note = (page, text) => page.getByRole("status").filter({ hasText: text });

test("a 2 MB Word file imports into a new written document as its saved revision", async () => {
	const marker = `Two megabytes ${randomUUID()}`;
	const file = wordFile(2 * 1024 * 1024, [marker, "Our second paragraph."]);
	assert.ok(file.length > 2_000_000, "the file is past the old 1 MB action cap");
	await onWritten(async (page) => {
		const posts = [];
		page.on("request", (request) => {
			if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
		});
		await page.locator('input[type="file"]').setInputFiles({ name: "Big plan.docx", mimeType: DOCX, buffer: file });
		await note(page, "The Word file is now this document's saved version").waitFor({ timeout: 60_000 });
		assert.deepEqual(posts, ["/documents/written/import"], "the file went to the import route, not an action");
		await assert.doesNotReject(page.waitForURL(/\/documents\/written\/[0-9a-f-]{36}$/));
		const text = () => page.locator(PAPER).innerText();
		assert.match(await text(), new RegExp(marker));
		// The import is the stored revision: a fresh load of the document shows it, with nothing unsaved.
		await page.reload();
		await hydrated(page);
		await page.locator(PAPER).getByText(marker).waitFor();
		assert.match(await text(), /Our second paragraph\./);
		await page
			.getByRole("status")
			.filter({ hasText: /^Saved/ })
			.waitFor();
	});
});

test("a .docx or .txt over the limit shows the stated limit, never a dropped connection", async () => {
	await onWritten(async (page) => {
		for (const [name, mimeType] of [
			["Too big.docx", DOCX],
			["Too big.txt", "text/plain"],
		]) {
			await page
				.locator('input[type="file"]')
				.setInputFiles({ name, mimeType, buffer: Buffer.alloc(IMPORT_BYTES_MAX + 1, 0x61) });
			await note(page, "The file must be 10 MB or smaller.").waitFor();
			assert.equal(IMPORT_TOO_LARGE, "The file must be 10 MB or smaller.");
			assert.equal(await page.getByText("The connection dropped").count(), 0, name);
		}
	});
});

/** Posts `bytes` to the import route as the browser does, signed in as the Owner. */
async function post(bytes, title) {
	const query = new URLSearchParams({ title, format: "docx", expectedRevision: "0", requestKey: randomUUID() });
	const response = await fetch(`${BASE}/documents/written/import?${query}`, {
		method: "POST",
		headers: {
			"content-type": "application/octet-stream",
			cookie: fixture("people").owner.cookie,
			origin: BASE,
			"sec-fetch-site": "same-origin",
		},
		body: bytes,
	});
	assert.equal(response.status, 200);
	return response.json();
}

test("the route refuses a file just over the limit with the stated limit, and imports one of exactly the limit", async () => {
	const over = await post(wordFile(IMPORT_BYTES_MAX + 1, ["Just over"]), "Just over");
	assert.deepEqual(over, { status: "refused", code: "invalid_input", problem: "The file must be 10 MB or smaller." });
	// Exactly 10 MiB passes the proxy's body buffer and the route whole, and lands as the document's first revision.
	const marker = `Exactly ten ${randomUUID()}`;
	const exact = await post(wordFile(IMPORT_BYTES_MAX, [marker]), "Exactly the limit");
	assert.equal(exact.status, "ok", JSON.stringify(exact));
	assert.equal(exact.value.revision, "1");
	assert.equal(exact.value.title, "Exactly the limit");
	assert.match(JSON.stringify(exact.value.body), new RegExp(marker));
});
