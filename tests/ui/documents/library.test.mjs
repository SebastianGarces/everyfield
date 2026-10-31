// WP-036/ui: the documents library and preview against the real Forme renderer on a production preview.
//   UI_BASE_URL=https://wp-....localhost:1355 PEOPLE_UI_FIXTURE=... node --test tests/ui/documents/library.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts). The Owner's session opens /documents.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { BASE, ENGINES, fixture, hydrated, signIn, withPage as onPreview } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Page sizes in points: Letter 612 x 792, card 306 x 396 (4.25 x 5.5 in).
const TEMPLATES = {
	"commitment-card": { name: "Core Group Commitment Card", size: [306, 396], pages: 1, fillable: true },
	"response-card": { name: "Response Card", size: [306, 396], pages: 1, fillable: true },
	"guest-sign-in-sheet": { name: "Guest Sign-in Sheet", size: [612, 792], pages: 1, fillable: true },
	"vision-meeting-agenda": { name: "Vision Meeting Agenda", size: [612, 792], pages: 1, fillable: true },
	"launch-sunday-checklists": { name: "Launch Sunday Checklists", size: [612, 792], pages: 2, fillable: true },
};

const withPage = (engine, run, size = {}) =>
	onPreview(
		engine,
		async (page, context) => {
			await signIn(context, fixture("people").owner.cookie);
			await run(page, context);
		},
		size,
	);

async function openTemplate(page, id) {
	await page.goto(`${BASE}/documents?template=${id}`);
	await hydrated(page);
	await page.getByRole("img", { name: /, page 1/ }).waitFor({ timeout: 60_000 });
}

/** The preview route's bytes for one template, as the browser asks for them. */
async function previewBytes(context, templateId) {
	const response = await context.request.post(`${BASE}/documents/preview`, {
		data: { templateId, format: "pdf", overrides: {} },
		headers: { origin: BASE },
	});
	const json = await response.json();
	assert.equal(json.status, "ok", JSON.stringify(json));
	return Buffer.from(json.value.artifact, "base64");
}

for (const [name, engine] of ENGINES) {
	test(`INV-doc-aspect (${name}): each page is drawn at the true aspect of its renderer page`, async () => {
		await withPage(engine, async (page, context) => {
			for (const [id, want] of Object.entries(TEMPLATES)) {
				await openTemplate(page, id);
				const pdf = await PDFDocument.load(await previewBytes(context, id), { updateMetadata: false });
				const { width, height } = pdf.getPage(0).getSize();
				assert.deepEqual([width, height], want.size, `${id} page size`);
				const frame = await page.getByRole("group", { name: `${want.name} preview` }).boundingBox();
				const canvas = await page.getByRole("img", { name: /, page 1/ }).boundingBox();
				assert.ok(Math.abs(frame.width / frame.height - width / height) < 0.01, `${id} frame aspect`);
				assert.ok(Math.abs(canvas.width / canvas.height - width / height) < 0.01, `${id} canvas aspect`);
				const drawn = await page.getByRole("img", { name: /, page 1/ }).evaluate((c) => [c.width, c.height]);
				assert.ok(Math.abs(drawn[0] / drawn[1] - width / height) < 0.01, `${id} drawn pixels`);
			}
		});
	});

	test(`INV-doc-pages (${name}): the checklists show Page n of m and move by buttons and by keyboard`, async () => {
		await withPage(engine, async (page) => {
			await openTemplate(page, "launch-sunday-checklists");
			await page.getByText("Page 1 of 2").waitFor();
			const previous = page.getByRole("button", { name: "Previous page" });
			const next = page.getByRole("button", { name: "Next page" });
			assert.equal(await previous.isDisabled(), true);
			await next.click();
			await page.getByText("Page 2 of 2").waitFor();
			assert.equal(await next.isDisabled(), true);
			await previous.click();
			await page.getByText("Page 1 of 2").waitFor();
			await page.getByRole("group", { name: "Launch Sunday Checklists preview" }).focus();
			await page.keyboard.press("ArrowRight");
			await page.getByText("Page 2 of 2").waitFor();
			await page.keyboard.press("ArrowLeft");
			await page.getByText("Page 1 of 2").waitFor();
			await openTemplate(page, "commitment-card");
			assert.equal(await page.getByText(/Page \d of \d/).count(), 0, "a one-page file shows no page controls");
		});
	});

	test(`INV-doc-format (${name}): PDF for nine templates, Excel for two, no Word and no format switch`, async () => {
		await withPage(engine, async (page) => {
			await page.goto(`${BASE}/documents`);
			await hydrated(page);
			const cards = page.getByRole("group", { name: "Templates" }).getByRole("button");
			await cards.first().waitFor();
			assert.equal(await cards.count(), 11);
			const labels = await cards.evaluateAll((nodes) =>
				nodes.map((n) => [...n.querySelectorAll("span")].map((s) => s.textContent)),
			);
			const formats = labels.map((l) => (l.includes("PDF") ? "PDF" : l.includes("Excel") ? "Excel" : "other"));
			assert.equal(formats.filter((f) => f === "PDF").length, 9);
			assert.equal(formats.filter((f) => f === "Excel").length, 2);
			assert.equal(await page.getByText("Word", { exact: true }).count(), 0);
			assert.equal(await page.getByRole("radiogroup", { name: "Format" }).count(), 0);
			for (const [index, card] of (await cards.all()).entries()) {
				await card.click();
				assert.equal(await page.getByRole("radio", { name: "Word" }).count(), 0, `card ${index}`);
			}
		});
	});

	test(`INV-doc-fillable (${name}): Fillable shows in the library and the preview, and a download keeps its fields`, async () => {
		await withPage(engine, async (page, context) => {
			await openTemplate(page, "commitment-card");
			const card = page.getByRole("button", { name: "Core Group Commitment Card" });
			await card.getByText("Fillable").waitFor();
			await page.getByRole("heading", { level: 2, name: "Core Group Commitment Card" }).waitFor();
			assert.ok((await page.getByText("Fillable", { exact: true }).count()) >= 2, "library and preview labels");
			const download = page.waitForEvent("download");
			await page.getByRole("button", { name: /Download PDF/ }).click();
			const path = await (await download).path();
			const pdf = await PDFDocument.load(await readFile(path), { updateMetadata: false });
			const fields = pdf.getForm().getFields();
			assert.ok(fields.length > 0, "the download keeps its form fields");
			console.log(`field dump (${name}): ${fields.map((f) => `${f.constructor.name}:${f.getName()}`).join(", ")}`);
			// A render of a template with no form fields has none: the Excel budgets are not fillable PDFs.
			await page.goto(`${BASE}/documents`);
			const budget = page
				.getByRole("group", { name: "Templates" })
				.getByRole("button", { name: /Budget/ })
				.first();
			assert.equal(await budget.getByText("Fillable").count(), 0);
		});
	});

	test(`INV-doc-bytes (${name}): the preview and the preview download are the same bytes (the saved file is AC:CASE-DOC-003)`, async () => {
		await withPage(engine, async (page, context) => {
			await openTemplate(page, "commitment-card");
			const preview = sha(await previewBytes(context, "commitment-card"));
			const download = page.waitForEvent("download");
			await page.getByRole("button", { name: /Download PDF/ }).click();
			const downloaded = sha(await readFile(await (await download).path()));
			console.log(`sha256 (${name}): preview ${preview} preview download ${downloaded}`);
			assert.equal(downloaded, preview, "preview download equals preview bytes");
		});
	});

	test(`INV-doc-neutral (${name}): no brand kit shows the neutral note; thumbnails are named and have alt text`, async () => {
		await withPage(engine, async (page) => {
			await openTemplate(page, "commitment-card");
			await page.getByText("No brand kit yet. Your church name stands in for a logo.").waitFor();
			await page.goto(`${BASE}/documents`);
			await hydrated(page);
			const card = page.getByRole("button", { name: "Core Group Commitment Card", exact: true });
			await card.focus();
			const image = card.getByRole("img", { name: "Page 1 of Core Group Commitment Card" });
			await image.waitFor({ timeout: 60_000 });
			assert.equal(await image.getAttribute("alt"), "Page 1 of Core Group Commitment Card");
			const box = await image.boundingBox();
			assert.ok(
				Math.abs(box.width / box.height - 4.25 / 5.5) < 0.02,
				`thumbnail keeps the card aspect, got ${box.width}x${box.height}`,
			);
		});
	});

	test(`INV-doc-error (${name}): a render the server refuses shows the state panel and keeps the list usable`, async () => {
		await withPage(engine, async (page, context) => {
			await context.route("**/documents/preview", (route) =>
				route.fulfill({ json: { status: "refused", code: "render_failed" } }),
			);
			await page.goto(`${BASE}/documents?template=commitment-card`);
			await hydrated(page);
			await page.getByRole("alert").getByText("This file did not render. Nothing was saved.").waitFor();
			await page.getByRole("button", { name: "Response Card" }).click();
			await page.getByRole("heading", { level: 2, name: "Response Card" }).waitFor();
		});
	});
}
