// WP-036/api: a real HTTP preview request on the production build. Without serverExternalPackages the Forme WASM
// engine bundles into a renderer that returns a PDF with 0 pages, so each template's page count is checked here.
//   UI_BASE_URL=https://wp-....localhost:1355 node --test tests/ui/documents/preview-route.test.mjs
// Seed the People fixture first (tests/ui/people/seed.mts); the Owner's session cookie signs the request in.
import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "../../../packages/domain/node_modules/pdf-lib/cjs/index.js";
import { BASE, fixture } from "../setup.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const PAGES = {
	"commitment-card": 1,
	"response-card": 1,
	"guest-sign-in-sheet": 1,
	"vision-meeting-agenda": 1,
	"member-expectations": 1,
	"launch-team-commitment": 1,
	"follow-up-letter": 1,
	"board-meeting-agenda": 1,
	"launch-sunday-checklists": 2,
};
const preview = async (cookie, body) => {
	const started = performance.now();
	const response = await fetch(`${BASE}/documents/preview`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie, origin: BASE },
		body: JSON.stringify(body),
	});
	return { json: await response.json(), ms: performance.now() - started };
};

for (const [templateId, pages] of Object.entries(PAGES)) {
	test(`production preview of ${templateId} is a PDF with ${pages} page(s)`, async () => {
		const cookie = fixture("people").owner.cookie;
		const first = await preview(cookie, { templateId, format: "pdf" });
		assert.equal(first.json.status, "ok", JSON.stringify(first.json));
		const bytes = Buffer.from(first.json.value.artifact, "base64");
		assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
		const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
		assert.equal(pdf.getPageCount(), pages);
		const warm = await preview(cookie, { templateId, format: "pdf" });
		assert.equal(warm.json.value.digest, first.json.value.digest);
		assert.ok(warm.ms < 1000, `warm preview took ${Math.round(warm.ms)} ms`);
	});
}

test("production preview of a former DOCX template refuses Word", async () => {
	const cookie = fixture("people").owner.cookie;
	const result = await preview(cookie, { templateId: "vision-meeting-agenda", format: "docx" });
	assert.equal(result.json.status, "refused");
	assert.equal(result.json.problem, "Format is not on this template.");
});
