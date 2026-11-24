import "../runs-in/render-module-mocks.mjs";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as TypeScript from "../../../apps/web/node_modules/typescript/lib/typescript.js";
import { resolveImport } from "../../../scripts/lint/boundaries.mjs";
import { mount } from "../evry/fake-dom.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const { createElement } = web("react");
const ts: typeof TypeScript = web("typescript");

const DOCUMENTS = "apps/web/src/features/documents/";
const EDITORS = [DOCUMENTS + "church/editor/ChurchEditor.tsx", DOCUMENTS + "written/NativeEditor.tsx"];

const valueOnly = (clause: TypeScript.ImportClause | undefined) =>
	!clause?.isTypeOnly &&
	!(
		clause &&
		!clause.name &&
		clause.namedBindings &&
		ts.isNamedImports(clause.namedBindings) &&
		clause.namedBindings.elements.length > 0 &&
		clause.namedBindings.elements.every((e) => e.isTypeOnly)
	);

function staticImports(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest);
	return source.statements.flatMap((s) => {
		const from =
			(ts.isImportDeclaration(s) && valueOnly(s.importClause)) || (ts.isExportDeclaration(s) && !s.isTypeOnly)
				? s.moduleSpecifier
				: undefined;
		return from && ts.isStringLiteral(from) ? [from.text] : [];
	});
}

function reached(entries: readonly string[]) {
	const from = new Map<string, string>(entries.map((file) => [file, "page"]));
	const packages = new Map<string, string>();
	for (const file of from.keys()) {
		if (!/\.[cm]?tsx?$/.test(file)) continue;
		for (const spec of staticImports(file)) {
			if (/^@tiptap\//.test(spec)) packages.set(spec, file);
			const { to } = resolveImport(file, spec) as { to?: string | null };
			if (to && !from.has(to)) from.set(to, file);
		}
	}
	return { files: from, packages };
}

test("INV-editor-chunk: no document page reaches an editor or a Tiptap package through a static import", () => {
	const pages = globSync("apps/web/src/app/**/documents/**/{page,layout,loading}.tsx", { cwd: root });
	assert.ok(pages.length >= 5, `${pages.length} document pages`);
	const { files, packages } = reached(pages);
	for (const screen of ["church/ChurchDocumentScreen.tsx", "written/WrittenScreen.tsx"])
		assert.ok(files.has(DOCUMENTS + screen), `the walk reaches ${screen}`);
	for (const editor of EDITORS)
		assert.equal(files.get(editor), undefined, `${editor} is imported by ${files.get(editor)}`);
	assert.deepEqual([...packages], []);
	assert.ok(reached(EDITORS).packages.has("@tiptap/react"), "the walk sees the packages an editor imports");
});

const at = (path: string) => pathToFileURL(root + DOCUMENTS + path).href;
const noAction = async () => assert.fail("no action runs while rendering");
const asked: string[] = [];
mock.module(pathToFileURL(web.resolve("next/dynamic")).href, {
	defaultExport: (load: () => Promise<unknown>) =>
		function Lazy() {
			asked.push(String(load));
			return null;
		},
});
mock.module(at("church/actions.ts"), {
	namedExports: {
		archiveChurchDocument: noAction,
		deleteChurchDocument: noAction,
		deleteSavedExport: noAction,
		setChurchBranding: noAction,
	},
});
mock.module(at("written/NativeProse.tsx"), { namedExports: { NativeProse: () => createElement("article") } });
globalThis.fetch = (async () => Response.json({}, { status: 503 })) as typeof fetch;
const { ChurchDocumentScreen } =
	await import("../../../apps/web/src/features/documents/church/ChurchDocumentScreen.tsx");
const { WrittenScreen } = await import("../../../apps/web/src/features/documents/written/WrittenScreen.tsx");

async function asks(type: unknown, props: Record<string, unknown>) {
	asked.length = 0;
	const page = await mount(type, props);
	const text = page.text();
	await page.unmount();
	return { text, editors: asked.filter((load) => /\/(?:Church|Native)Editor\b/.test(load)).length };
}
const ARCHIVED = { at: "2026-10-21T12:00:00Z", by: "Ana Lee" };
const brand = { palette: {}, assets: { logo: null, mark: null, photo: null } };
const EDITABLE = { document: { exports: [] }, brands: { church: null, plain: brand }, template: null, mergeValues: {} };
const church = (archived: typeof ARCHIVED | null, editable: typeof EDITABLE | null) => ({
	doc: {
		id: "d",
		title: "Bylaws",
		templateId: "bylaws",
		templateVersion: 1,
		templateName: "Bylaws",
		documentClass: "general",
		revision: "1",
		formats: ["pdf"],
		useChurchBranding: false,
		page: { width: 612, height: 792, perSheet: 1 },
		archived,
	},
	editable,
	canManage: editable !== null || archived !== null,
	exports: [],
	revisions: [],
	revisionsTruncated: false,
	viewerName: null,
});
const written = (archived: typeof ARCHIVED | null, canEdit: boolean) => ({
	doc: { id: "d", title: "Plan", kind: "native", revision: "1", archived, body: { type: "doc", content: [] } },
	scope: "church",
	canEdit,
	canStore: true,
});

test("INV-editor-chunk: a Member, and anyone on an archived document, never asks for the church editor; an Owner of an open one does", async () => {
	for (const props of [church(null, null), church(ARCHIVED, null)]) {
		const seen = await asks(ChurchDocumentScreen, props);
		assert.ok(seen.text.includes("Bylaws"));
		assert.equal(seen.editors, 0);
	}
	assert.equal((await asks(ChurchDocumentScreen, church(null, EDITABLE))).editors, 1);
});

test("INV-editor-chunk: a Member, and anyone on an archived document, never asks for the written editor; an Owner of an open or new one does", async () => {
	for (const props of [written(null, false), written(ARCHIVED, false), written(ARCHIVED, true)]) {
		const seen = await asks(WrittenScreen, props);
		assert.ok(seen.text.includes("Plan"));
		assert.equal(seen.editors, 0);
	}
	assert.equal((await asks(WrittenScreen, written(null, true))).editors, 1);
	assert.equal((await asks(WrittenScreen, { ...written(null, true), doc: null })).editors, 1);
});
