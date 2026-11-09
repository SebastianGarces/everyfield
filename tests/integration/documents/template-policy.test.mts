// WP-036 criterion 13: every built-in everyfield.doc/1 template file is in the document-templates owner class of
// evf.toml, so a change to one waits for Sebastian's approval and never lands on its own.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);

/** The paths of one [[policy.class]] in evf.toml. */
function ownerClassPaths(name: string): string[] {
	const block = readFileSync(new URL("evf.toml", root), "utf8")
		.split("[[policy.class]]")
		.find((text) => text.includes(`name = "${name}"`));
	assert.ok(block, `evf.toml has the ${name} class`);
	assert.match(block, /^outcome = "owner"$/m);
	const paths = /^paths = \[(.*?)\]/ms.exec(block);
	assert.ok(paths, `the ${name} class lists paths`);
	return [...paths[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

test("WP-036 each templates/*.json file matches the document-templates owner class in evf.toml", () => {
	const entries = ownerClassPaths("document-templates");
	const files = readdirSync(new URL("packages/domain/src/documents/templates/", root))
		.filter((name) => name.endsWith(".json"))
		.map((name) => `packages/domain/src/documents/templates/${name}`);
	assert.equal(files.length, 9);
	const matches = (path: string) =>
		entries.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
	for (const file of files) assert.ok(matches(file), `${file} is in the document-template class`);
	// A file outside the class does not match, so the check can see a miss.
	assert.equal(matches("apps/web/src/features/documents/routes.tsx"), false);
});
