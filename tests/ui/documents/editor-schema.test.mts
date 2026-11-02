// WP-036 slice 2: the editor's free parts and its schema. No browser, no database.
//   AC:DOC-EDIT-FREE: every Tiptap package the workspace installs is MIT; no @tiptap-pro package; no private registry.
//   AC:DOC-EDIT-SCHEMA: the editor's extensions hold the body of a fork of each built-in template unchanged.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { docDocument, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { DOC_TEMPLATES } from "../../../packages/domain/src/documents/doc-templates.ts";
import {
	clean,
	documentFrom,
	editorContent,
} from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { editorSchema } from "../../../apps/web/src/features/documents/church/editor/schema.ts";

const ROOT = join(import.meta.dirname, "../../..");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

/** Every workspace package.json: the root, apps/* and packages/*. */
function workspacePackages() {
	const dirs = [ROOT, ...["apps", "packages"].flatMap((d) => readdirSync(join(ROOT, d)).map((n) => join(ROOT, d, n)))];
	return dirs.filter((d) => existsSync(join(d, "package.json")));
}

test("AC:DOC-EDIT-FREE: each Tiptap package the workspace depends on is installed under the MIT license", () => {
	const found: string[] = [];
	for (const dir of workspacePackages()) {
		const manifest = readJson(join(dir, "package.json"));
		const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
		for (const name of Object.keys(deps)) {
			assert.ok(!name.startsWith("@tiptap-pro/"), `${dir}: ${name} is a paid Tiptap package`);
			if (!name.startsWith("@tiptap/")) continue;
			const installed = join(dir, "node_modules", name, "package.json");
			assert.ok(existsSync(installed), `${name} is not installed in ${dir}`);
			assert.equal(readJson(installed).license, "MIT", `${name} is not MIT`);
			found.push(name);
		}
	}
	assert.ok(found.includes("@tiptap/react"), "the web app depends on @tiptap/react");
});

test("AC:DOC-EDIT-FREE: no committed .npmrc names a Tiptap private registry or token", () => {
	for (const dir of workspacePackages()) {
		const file = join(dir, ".npmrc");
		if (!existsSync(file)) continue;
		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /tiptap/i, `${file} mentions Tiptap`);
		assert.doesNotMatch(text, /_authToken|registry\.tiptap\.dev/i, `${file} holds a registry token`);
	}
});

const schema = editorSchema();

for (const template of DOC_TEMPLATES) {
	test(`AC:DOC-EDIT-SCHEMA: a fork of ${template.id} loads into the editor schema and reads back unchanged`, async () => {
		const doc = await forkTemplate(template);
		const node = schema.nodeFromJSON(editorContent(doc));
		node.check();
		const back = documentFrom(doc, node.toJSON());
		assert.deepStrictEqual(back, clean(doc));
		assert.equal(docDocument.safeParse(back).success, true, "the document parses with docDocument");
	});
}

test("AC:DOC-EDIT-SCHEMA: nodes of later slices keep every attribute and child", async () => {
	const seen = new Set<string>();
	const walk = (n: any) => {
		seen.add(n.type);
		for (const c of n.content ?? []) walk(c);
	};
	for (const template of DOC_TEMPLATES) walk(template.body);
	for (const type of ["columns", "column", "box", "image", "writeIn", "table", "row", "cell", "field"])
		assert.ok(seen.has(type), `the templates hold a ${type} node`);
	// The templates hold no slot (a doctrinal section); check one built by hand.
	const slot = {
		type: "doc",
		content: [
			{
				type: "slot",
				attrs: { label: "Statement of faith" },
				content: [{ type: "paragraph", content: [{ type: "text", text: "We believe." }] }],
			},
		],
	};
	assert.deepStrictEqual(clean(schema.nodeFromJSON(slot).toJSON()), slot);
});
