import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKUP_KEY_VARIABLE } from "../../../ops/maintenance/key.mts";
import ts from "../../../packages/contracts/node_modules/typescript/lib/typescript.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHIPPED = ["apps", "packages"];
const VARIABLE = "EVERYFIELD_BACKUP_KEY";
const BUILD = ["tools", "bin", "scripts", "patches", ".github", ".agents"];
const TEXT = /^[^.]+$|\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|sh|py|patch|plist)$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|json)$/;
const SKIPPED = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "migrations"]);
const KEY_NAMES = /everyfield-backup|tigris\.env|backup\.key|app-key-probe|BACKUP_(?:KEY|BUCKET|AWS)/;
const dir = mkdtempSync(join(tmpdir(), "backup-isolation-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function files(at: string, wanted = SOURCE): string[] {
	return readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
		const path = join(at, entry.name);
		if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : files(path, wanted);
		return entry.isFile() && wanted.test(entry.name) ? [path] : [];
	});
}

function names(root: string): string[] {
	const top = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile() && TEXT.test(entry.name));
	return [
		...top.map((entry) => join(root, entry.name)),
		...[...SHIPPED, ...BUILD].filter((at) => existsSync(join(root, at))).flatMap((at) => files(join(root, at), TEXT)),
	]
		.filter((path) => readFileSync(path, "utf8").includes(VARIABLE))
		.map((path) => relative(root, path).split(sep).join("/"));
}

function reaches(root: string): string[] {
	return SHIPPED.flatMap((top) => files(join(root, top))).flatMap((path) => {
		const at = relative(root, path).split(sep).join("/");
		const text = readFileSync(path, "utf8");
		const imported = path.endsWith(".json")
			? []
			: ts.preProcessFile(text, true, true).importedFiles.map((file: { fileName: string }) => file.fileName);
		const modules = imported.filter((name: string) => {
			const target = name.startsWith(".")
				? relative(root, resolve(path, "..", name))
						.split(sep)
						.join("/")
				: name;
			return /(?:^|\/)ops\/maintenance(?:\/|$)/.test(target);
		});
		const named = /ops\/maintenance\/[a-z]+\.mts/.test(text) && !path.endsWith(".json");
		const keys = KEY_NAMES.test(text);
		return modules.length || named || keys ? [at] : [];
	});
}

test("INV-backup: no app, package or build code imports the backup modules or names their keys", () => {
	assert.deepEqual(reaches(ROOT), []);
	for (const config of ["package.json", "turbo.json", "vercel.json"]) {
		const text = readdirSync(ROOT).includes(config) ? readFileSync(join(ROOT, config), "utf8") : "";
		assert.doesNotMatch(text, KEY_NAMES, config);
	}
});

test("INV-backup: the app, packages, build configuration and preview tooling never name the backup key variable", () => {
	assert.equal(BACKUP_KEY_VARIABLE, VARIABLE);
	assert.deepEqual(names(ROOT), []);
	for (const path of [
		"apps/web/src/server/a.ts",
		"apps/web/vercel.json",
		"packages/domain/src/b.ts",
		"package.json",
		"turbo.json",
		"pnpm-workspace.yaml",
		"evf.toml",
		".github/workflows/ci.yml",
		"scripts/build.mjs",
		"bin/app",
		"tools/qa/preview.ts",
		".agents/skills/portless-preview/scripts/preview.mjs",
	]) {
		const root = join(dir, `name_${path.replaceAll("/", "_")}`);
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), `${VARIABLE}`);
		assert.deepEqual(names(root), [path]);
	}
});

test("INV-backup: the guard fails on a planted import, a planted key file and a planted variable", () => {
	const plants: [string, string][] = [
		["apps/web/src/server/a.ts", 'import { runBackup } from "../../../../ops/maintenance/backup.mts";\nrunBackup;'],
		["apps/web/src/server/b.ts", 'export const load = () => import("../../../../ops/maintenance/copy.mts");'],
		["apps/web/next.config.ts", 'const key = readFileSync(home + "/.config/everyfield-backup/tigris.env");'],
		["packages/domain/src/c.ts", "export const key = process.env.BACKUP_KEY;"],
		["apps/web/src/server/e.ts", "export const key = process.env.EVERYFIELD_BACKUP_KEY;"],
		["packages/db/scripts/d.mjs", 'spawn("node", ["ops/maintenance/cli.mts", "backup-daily"]);'],
	];
	for (const [path, text] of plants) {
		const root = join(dir, path.replaceAll("/", "_"));
		for (const top of SHIPPED) mkdirSync(join(root, top), { recursive: true });
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
		assert.deepEqual(reaches(root), [path]);
	}
});
