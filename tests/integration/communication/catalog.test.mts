import test from "node:test";
import assert from "node:assert/strict";
import { systemTemplates } from "../../../packages/contracts/src/communication/catalog.ts";
import { sanitizeHtml } from "../../../packages/contracts/src/communication/html.ts";

test("there are seven system templates with unique source keys", () => {
	assert.equal(systemTemplates.length, 7);
	assert.equal(new Set(systemTemplates.map((t) => t.sourceKey)).size, 7);
});

for (const template of systemTemplates) {
	test(`system template ${template.sourceKey} is a complete, sendable email`, () => {
		assert.equal(sanitizeHtml(template.bodyHtml), template.bodyHtml, "body survives the sanitizer unchanged");
		assert.ok(template.bodyHtml.startsWith("<p>Hello {{name}},</p>"));
		assert.ok(template.bodyHtml.endsWith("[Your name]</p>"));
		assert.ok(template.bodyHtml.length <= 100_000);
		assert.ok(template.subject.length >= 1 && template.subject.length <= 500);
		assert.ok(!template.subject.includes("{{"), "subjects are never merged");
		assert.ok(template.description && template.description.length <= 1000);
		const fields = [...template.bodyHtml.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((m) => m[1]);
		assert.deepEqual([...new Set(fields)], ["name"], "only the merge field that works today");
	});
}
