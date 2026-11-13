// T-81 criterion 1: the store of published built-in template versions (D-421) agrees with the template files. Each
// template's current version is stored with its hash, so a file whose content changes without a new version fails
// here; versions run with no gap; every superseded version keeps its body, which documents made from it compare with.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { templateHash } from "../../../packages/contracts/src/documents/index.ts";
import {
	DOC_TEMPLATES,
	docTemplateById,
	publishedProblems,
	publishedTemplate,
} from "../../../packages/domain/src/documents/doc-templates.ts";
import { PUBLISHED, SUPERSEDED } from "../../../packages/domain/src/documents/templates/published/index.ts";

const folder = new URL("../../../packages/domain/src/documents/templates/published/", import.meta.url);
const POLICY = "conflict-of-interest-policy";

test("INV-template-changes: the store holds the current version of every built-in template, with its hash", async () => {
	assert.deepEqual(await publishedProblems(DOC_TEMPLATES, PUBLISHED, SUPERSEDED), []);
	assert.deepEqual(Object.keys(PUBLISHED).sort(), DOC_TEMPLATES.map((t) => t.id).sort());
	// Today: version 1 of ten, and version 2 of commitment-card (T-205: the card's return line), whose version 1
	// body is kept.
	assert.equal(DOC_TEMPLATES.length, 11);
	for (const template of DOC_TEMPLATES) {
		const current = { version: template.version, hash: await templateHash(template) };
		if (template.id !== "commitment-card") assert.deepEqual(PUBLISHED[template.id], [current], template.id);
		else {
			assert.equal(template.version, 2);
			assert.deepEqual(PUBLISHED[template.id], [
				{ version: 1, hash: await templateHash(SUPERSEDED["commitment-card.v1"] as typeof template) },
				current,
			]);
		}
	}
	// The folder holds the store and one `<id>.v<n>.json` per entry of SUPERSEDED, nothing else.
	const bodies = readdirSync(folder)
		.filter((name) => name !== "index.ts" && name !== "versions.json")
		.map((name) => name.replace(/\.json$/, ""))
		.sort();
	assert.deepEqual(bodies, Object.keys(SUPERSEDED).sort());
});

test("INV-template-changes: a published version is found by its id and hash; an unknown hash has no base", async () => {
	const v1 = docTemplateById(POLICY)!;
	assert.equal(publishedTemplate(POLICY, await templateHash(v1)), v1);
	assert.equal(publishedTemplate(POLICY, `sha256:${"0".repeat(64)}`), undefined);
	assert.equal(publishedTemplate("bylaws", await templateHash(v1)), undefined, "the hash of another template");
});

test("INV-template-changes: an edit without a new version, a gap and a missing superseded body each fail", async () => {
	const v1 = docTemplateById(POLICY)!;
	const h1 = await templateHash(v1);
	const others = DOC_TEMPLATES.filter((t) => t.id !== POLICY);
	const store = { ...PUBLISHED };

	// The file's content changes, its version stays 1.
	const edited = structuredClone(v1);
	edited.title = "Conflict of Interest Policy (revised)";
	assert.deepEqual(await publishedProblems([...others, edited], store, SUPERSEDED), [
		`${POLICY}: the file changed but its version did not go up from 1`,
	]);

	// Version 2 is published, but version 1's body was not kept.
	const v2 = { ...edited, version: 2 };
	const h2 = await templateHash(v2);
	const two = {
		...store,
		[POLICY]: [
			{ version: 1, hash: h1 },
			{ version: 2, hash: h2 },
		],
	};
	assert.deepEqual(await publishedProblems([...others, v2], two, SUPERSEDED), [
		`${POLICY}.v1: the superseded body is missing or does not validate`,
	]);
	// With it kept, the store agrees.
	assert.deepEqual(await publishedProblems([...others, v2], two, { ...SUPERSEDED, [`${POLICY}.v1`]: v1 }), []);
	// A kept body that is not the published version 1 fails.
	assert.deepEqual(await publishedProblems([...others, v2], two, { ...SUPERSEDED, [`${POLICY}.v1`]: { ...edited } }), [
		`${POLICY}.v1: the body's hash is not the one published`,
	]);

	// The file jumps to version 3: the store skips version 2.
	const v3 = { ...edited, version: 3 };
	const gap = {
		...store,
		[POLICY]: [
			{ version: 1, hash: h1 },
			{ version: 3, hash: await templateHash(v3) },
		],
	};
	assert.deepEqual(await publishedProblems([...others, v3], gap, { ...SUPERSEDED, [`${POLICY}.v1`]: v1 }), [
		`${POLICY}: versions must run 1, 2, 3 with no gap`,
	]);
	// A new version the store does not list yet.
	assert.deepEqual(await publishedProblems([...others, v2], store, SUPERSEDED), [
		`${POLICY}: the file is version 2, the store ends at 1`,
	]);
});
