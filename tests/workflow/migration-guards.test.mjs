import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const ts = createRequire(join(root, "packages/domain/package.json"))("typescript");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

const MIGRATES = /(?<![\w-])(?:migrate|migration-apply)(?![\w-])/;
const LIFECYCLE = /^(?:pre|post)?(?:build|start|dev|install|prepare|vercel-build)$/;

function migratingScripts(scripts) {
	const runs = (name, seen = new Set()) => {
		if (seen.has(name)) return false;
		seen.add(name);
		const command = scripts[name];
		return (
			MIGRATES.test(command) ||
			(command.match(/[\w:-]+/g) ?? []).some((word) => Object.hasOwn(scripts, word) && runs(word, seen))
		);
	};
	return Object.keys(scripts).filter((name) => LIFECYCLE.test(name) && runs(name));
}

const migratingCommands = (config) =>
	Object.entries(config).flatMap(([key, value]) =>
		typeof value === "string"
			? /Command$/.test(key) && MIGRATES.test(value)
				? [key]
				: []
			: value && typeof value === "object"
				? migratingCommands(value).map((inner) => `${key}.${inner}`)
				: [],
	);

const migratingLines = (workflow) =>
	workflow.split("\n").flatMap((line, i) => (!/^\s*#/.test(line) && MIGRATES.test(line) ? [`line ${i + 1}`] : []));

test("INV-deploy: no build, start, dev or install script, Vercel command or deploy workflow runs a migration", () => {
	for (const path of ["package.json", "apps/web/package.json"])
		assert.deepEqual(migratingScripts(json(path).scripts), [], path);
	assert.deepEqual(migratingCommands(json("apps/web/vercel.json")), []);
	for (const path of [".github/workflows/deploy-production.yml", ".github/workflows/promote.yml"]) {
		const workflow = read(path);
		assert.match(workflow, /^jobs:/m, path);
		assert.deepEqual(migratingLines(workflow), [], path);
	}
});

test("INV-deploy: the guard names each planted migration and allows the explicit migrate script", () => {
	assert.deepEqual(
		migratingScripts({
			build: "pnpm db:migrate && next build",
			postbuild: "node ops/cli.mts migration-apply",
			prestart: "tsx scripts/migrate.ts",
			prepare: "pnpm run ready",
			ready: "pnpm --filter @everyfield/domain migrate",
			postinstall: "node tools/migrations-safety.ts",
			"db:migrate": "pnpm --filter @everyfield/domain migrate",
		}),
		["build", "postbuild", "prestart", "prepare"],
	);
	assert.deepEqual(
		migratingCommands({
			buildCommand: "pnpm db:migrate && next build",
			installCommand: "pnpm install",
			services: { web: { installCommand: "pnpm migrate" } },
		}),
		["buildCommand", "services.web.installCommand"],
	);
	assert.deepEqual(
		migratingLines(
			[
				"# run: pnpm db:migrate",
				"- run: pnpm db:migrate",
				"- run: |",
				"    npx vercel deploy",
				"    node cli.mts migration-apply",
			].join("\n"),
		),
		["line 2", "line 5"],
	);
});

const MIGRATE_MODULE = "packages/db/src/schema/migrate";
const MIGRATE_OWNERS = "packages/db/src/schema/";

function migrateImports(path, source) {
	const reaches = (name) =>
		name === "@everyfield/db/migrate" ||
		posix.join(name.startsWith(".") ? dirname(path) : "", name).replace(/\.[cm]?[jt]s$/, "") === MIGRATE_MODULE ||
		/(?:^|\/)schema\/migrate(?:\.[cm]?[jt]s)?$/.test(name);
	const found = [];
	const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const walk = (node) => {
		const typeOnly =
			(ts.isImportDeclaration(node) && node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) ||
			((ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) && node.isTypeOnly);
		const called =
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === "require");
		const specifier =
			ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
				? node.moduleSpecifier
				: ts.isExternalModuleReference(node)
					? node.expression
					: called
						? node.arguments[0]
						: undefined;
		if (!typeOnly && specifier && ts.isStringLiteralLike(specifier) && reaches(specifier.text))
			found.push(`${path}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
		if (!typeOnly) ts.forEachChild(node, walk);
	};
	walk(ast);
	return found;
}

test("INV-deploy: no app or runtime package code imports the migration runner, except as a type", () => {
	const files = globSync(
		["apps/web/src/**/*.{ts,tsx,mts,js,mjs}", "apps/web/next.config.*", "packages/*/src/**/*.{ts,tsx,mts,js,mjs}"],
		{ cwd: root },
	).filter((path) => !path.startsWith(MIGRATE_OWNERS));
	for (const path of [
		"apps/web/next.config.ts",
		"apps/web/src/instrumentation.ts",
		"packages/domain/src/onboarding/backfill.ts",
	])
		assert.ok(files.includes(path), path);
	const found = files.flatMap((path) => {
		const source = read(path);
		return source.includes("migrate") ? migrateImports(path, source) : [];
	});
	assert.deepEqual(found, [], "migrations are an explicit operator command: pnpm db:migrate");
});

test("INV-deploy: the import guard sees every value form and passes type-only imports", () => {
	const at = (line, path = "apps/web/src/instrumentation.ts") => migrateImports(path, line).length;
	for (const line of [
		'import { migrate } from "@everyfield/db/migrate";',
		'import "@everyfield/db/migrate";',
		'import { migrate, type Backfill } from "@everyfield/db/migrate";',
		'export { migrate } from "@everyfield/db/migrate";',
		'const { migrate } = await import("@everyfield/db/migrate");',
		'const { migrate } = require("@everyfield/db/migrate");',
		'import { migrate } from "../../../packages/db/src/schema/migrate.ts";',
	])
		assert.equal(at(line), 1, line);
	assert.equal(at('export * from "./schema/migrate.ts";', "packages/db/src/index.ts"), 1);
	for (const line of [
		'import type { Backfill } from "@everyfield/db/migrate";',
		'export type { Backfill } from "@everyfield/db/migrate";',
		'type Backfill = import("@everyfield/db/migrate").Backfill;',
		'import { sql } from "@everyfield/db/query";',
		'const name = "@everyfield/db/migrate";',
	])
		assert.equal(at(line), 0, line);
});

function processClockReads(source) {
	const ast = ts.createSourceFile("fixture.mts", source, ts.ScriptTarget.Latest, true);
	const found = [];
	const isDate = (node) => (ts.isPropertyAccessExpression(node) ? node.name : node).getText(ast) === "Date";
	const walk = (node) => {
		const reads =
			(ts.isPropertyAccessExpression(node) && isDate(node.expression) && node.name.text === "now") ||
			(ts.isNewExpression(node) && isDate(node.expression) && !node.arguments?.length) ||
			(ts.isCallExpression(node) && isDate(node.expression));
		if (reads) found.push(node.getText(ast));
		ts.forEachChild(node, walk);
	};
	walk(ast);
	return found;
}

test("INV-fixture-clock: the shared seed fixture stamps times with the database clock, never the process clock", () => {
	const source = read("tests/support/fixture.mts");
	assert.match(source, /clock_timestamp\(\)/);
	assert.deepEqual(processClockReads(source), []);
	assert.deepEqual(
		processClockReads(
			"const a = Date.now(); const b = new Date(); const c = Date(); const d = new Date; const e = new Date(Date.now() + 1); const f = new globalThis.Date();",
		),
		["Date.now", "new Date()", "Date()", "new Date", "Date.now", "new globalThis.Date()"],
	);
	assert.deepEqual(
		processClockReads(
			"const now = sql`clock_timestamp()`; function f({ clock }: { clock?: Date }) { return new Date(clock); }",
		),
		[],
	);
});
