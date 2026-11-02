// WP-036 criterion 13: every built-in everyfield.doc/1 template file is in the document-template merge class, so a
// change to one routes to `evf approve` (Sebastian's approval) and never merges through `evf ship`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_DOCUMENT_TEMPLATES } from "../../../tools/evf/policy.ts";

const root = new URL("../../../", import.meta.url);

test("WP-036 each templates/*.json file matches mergePolicy.documentTemplates or its OPS-80 default", () => {
	const config = JSON.parse(readFileSync(new URL("evf.config.json", root), "utf8"));
	const entries: string[] = (config.mergePolicy.documentTemplates ?? DEFAULT_DOCUMENT_TEMPLATES).paths;
	const files = readdirSync(new URL("packages/domain/src/documents/templates/", root))
		.filter((name) => name.endsWith(".json"))
		.map((name) => `packages/domain/src/documents/templates/${name}`);
	assert.equal(files.length, 4);
	const matches = (path: string) =>
		entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
	for (const file of files) assert.ok(matches(file), `${file} is in the document-template class`);
	// A file outside the class does not match, so the check can see a miss.
	assert.equal(matches("apps/web/src/features/documents/routes.tsx"), false);
});
