import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "../../../packages/contracts/node_modules/typescript/lib/typescript.js";

const COPY = fileURLToPath(new URL("../../../ops/maintenance/copy.mts", import.meta.url));
const STORAGE = fileURLToPath(new URL("../../../packages/db/src/schema/storage.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "copy-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the backup copy store takes only the backup directory, never the app's private storage or its object store client", () => {
	const fixture = join(dir, "stores.mts");
	const lines = [
		`import { BackupDirectory, type CopyDeps } from ${JSON.stringify(COPY)};`,
		`import type { PrivateStorage } from ${JSON.stringify(STORAGE)};`,
		"declare const storage: PrivateStorage;",
		"const clock = () => new Date();",
		'export const backup: CopyDeps = { store: new BackupDirectory("/private/backup"), clock };',
		"export const appStorage: CopyDeps = { store: storage, clock };",
		"export const appClient: CopyDeps = { store: storage.client, clock };",
	];
	writeFileSync(fixture, lines.join("\n"));
	const program = ts.createProgram([fixture], {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		allowImportingTsExtensions: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		target: ts.ScriptTarget.ES2022,
		types: ["node"],
		typeRoots: [fileURLToPath(new URL("../../../packages/db/node_modules/@types", import.meta.url))],
	});
	const refused = program
		.getSemanticDiagnostics(program.getSourceFile(fixture))
		.map((d) => lines[d.file!.getLineAndCharacterOfPosition(d.start!).line]!.split(":")[0]);
	assert.deepEqual(refused, ["export const appStorage", "export const appClient"]);
});

test("the backup copy module imports nothing from the object store SDK or the app's storage module", () => {
	const imported = ts
		.preProcessFile(readFileSync(COPY, "utf8"), true, true)
		.importedFiles.map((file: { fileName: string }) => file.fileName);
	assert.ok(imported.includes("./control.mts"), "the scan sees the module's own imports");
	assert.deepEqual(
		imported.filter((name: string) => /^@aws-sdk(?:\/|$)|^@everyfield\/db(?:\/|$)|packages\/db\//.test(name)),
		[],
	);
});
