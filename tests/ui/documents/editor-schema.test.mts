// WP-036 slice 2: the editor's free parts and its schema. No browser, no database.
//   AC:DOC-EDIT-FREE: every Tiptap package the workspace installs is MIT; no @tiptap-pro package; no private registry.
//   AC:DOC-EDIT-SCHEMA: the editor's extensions hold the body of a fork of each built-in template unchanged.
//   BUG-T50: a color swatch is named by its readable name, never by its raw token (Nora QA Nov 4, #420 criterion 13).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { docDocument, FORMAT_SCHEMA, forkTemplate } from "../../../packages/contracts/src/documents/index.ts";
import { DOC_TEMPLATES } from "../../../packages/domain/src/documents/doc-templates.ts";
import {
	clean,
	documentFrom,
	editorContent,
} from "../../../apps/web/src/features/documents/church/editor/document-json.ts";
import { TOKEN_NAMES, TOKENS } from "../../../apps/web/src/features/documents/church/editor/layout.ts";
import { editorSchema } from "../../../apps/web/src/features/documents/church/editor/schema.ts";
import { fieldValues } from "../../../apps/web/src/features/documents/church/editor/field-values.ts";
import { frozenData } from "../../../packages/domain/src/documents/doc-values.ts";

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

test("BUG-T50: each color token of the format has a swatch with its own readable name, never the raw token", () => {
	const tokens = FORMAT_SCHEMA.tokens.color;
	assert.deepEqual([...TOKENS], [...tokens], "one swatch for each color token, in the format's order");
	assert.deepEqual(
		tokens.map((token) => TOKEN_NAMES[token as keyof typeof TOKEN_NAMES]),
		["None", "Text", "Muted text", "Primary", "Accent", "Light shade", "Border"],
	);
});

test("BUG-T49: a commitment card with a stored empty contact_line shows nothing in the editor, not [Contact line]", async () => {
	const card = DOC_TEMPLATES.find((t) => t.id === "commitment-card")!;
	const sources = {
		churchName: "Harbor City Church",
		pastorName: null,
		tagline: null,
		legalName: null,
		contactLine: null,
		meetingDate: null,
	};
	const empty = await forkTemplate(card, { data: frozenData(card.fields, sources).data });
	assert.equal(empty.data?.contact_line, "");
	const values = fieldValues(empty);
	assert.equal(values.contact_line, "");
	assert.ok(!Object.values(values).some((v) => /\[contact line\]/i.test(v)));
	// A brand kit with a contact line prints it; a field with no value and no fallback still shows its label in brackets.
	const filled = await forkTemplate(card, {
		data: frozenData(card.fields, { ...sources, contactLine: "harborcity.church  ·  (555) 010-0199" }).data,
	});
	assert.equal(fieldValues(filled).contact_line, "harborcity.church  ·  (555) 010-0199");
	assert.equal(fieldValues(filled).church_name, "Harbor City Church");
	const bare = await forkTemplate(card, { data: {} });
	assert.equal(fieldValues(bare).church_name, "[church name]");
});
