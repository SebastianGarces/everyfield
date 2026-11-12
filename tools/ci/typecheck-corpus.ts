import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
	diagnosticKey,
	diffDiagnostics,
	parseDiagnostics,
	runScript,
	typecheckPackages,
	type Diagnostic,
	type Outcome,
} from "./typecheck.ts";

/**
 * Seeded type errors for comparing tsc with bun check (T-53).
 * `node tools/ci/typecheck-corpus.ts`
 * Every case runs in a temporary copy of the workspace, never in tracked source. Each case is applied alone and
 * bun check must exit non-zero in every package it names. Then all cases are applied together and tsc and bun check
 * must report the same file, line and code in each package.
 */

type Expect = { pkg: string; file: string; line: number; code: string };
export type Case = {
	id: string;
	/** What the case seeds, for the report. */
	kind: string;
	/** Files to write, by path from the workspace root. */
	files: Record<string, string>;
	expect: Expect[];
};

const C = "src/__corpus__";
const one = (pkg: string, id: string, kind: string, ext: string, source: string, line: number, code: string): Case => ({
	id,
	kind,
	files: { [`${pkg}/${C}/${id}.${ext}`]: source },
	expect: [{ pkg, file: `${C}/${id}.${ext}`, line, code }],
});

/** Valid at baseline: two exports of @everyfield/contracts/common and one consumer in each package that imports it. */
const CONSUMERS = ["apps/web", "packages/domain", "packages/evry", "packages/reference"];
export const BASE_FILES: Record<string, string> = {
	"packages/contracts/src/common/corpus-a.ts": "export const corpusId = (id: string): string => id;\n",
	"packages/contracts/src/common/corpus-b.ts": "export const corpusCount = (): number => 1;\n",
	...Object.fromEntries(
		CONSUMERS.map((pkg) => [
			`${pkg}/${C}/uses-contracts.ts`,
			[
				'import { corpusId } from "@everyfield/contracts/common";',
				'import { corpusCount } from "@everyfield/contracts/common";',
				'export const id: string = corpusId("a");',
				"export const count: number = corpusCount();",
				"",
			].join("\n"),
		]),
	),
};
const BASE_APPEND = {
	"packages/contracts/src/common/index.ts": 'export * from "./corpus-a.ts";\nexport * from "./corpus-b.ts";\n',
};

const CONTRACTS = "packages/contracts",
	DB = "packages/db",
	DOMAIN = "packages/domain",
	EVRY = "packages/evry",
	REFERENCE = "packages/reference",
	UI = "packages/ui",
	WEB = "apps/web";

export const CASES: Case[] = [
	// packages/contracts
	one(
		CONTRACTS,
		"c-index",
		"noUncheckedIndexedAccess array",
		"ts",
		"const xs: number[] = [1];\nexport const first: number = xs[0];\n",
		2,
		"TS2322",
	),
	one(
		CONTRACTS,
		"c-expect",
		"unused @ts-expect-error",
		"ts",
		"// @ts-expect-error\nexport const ok = 1;\n",
		1,
		"TS2578",
	),
	one(
		CONTRACTS,
		"c-missing",
		"missing relative module",
		"ts",
		'import { nope } from "./does-not-exist.ts";\nexport { nope };\n',
		1,
		"TS2307",
	),
	one(
		CONTRACTS,
		"c-args",
		"wrong argument count",
		"ts",
		"function f(a: string) {\n\treturn a;\n}\nexport const r = f();\n",
		4,
		"TS2554",
	),
	one(
		CONTRACTS,
		"c-never",
		"non-exhaustive switch",
		"ts",
		'type K = "a" | "b" | "c";\nexport function g(k: K): number {\n\tswitch (k) {\n\t\tcase "a":\n\t\t\treturn 1;\n\t\tcase "b":\n\t\t\treturn 2;\n\t\tdefault: {\n\t\t\tconst never: never = k;\n\t\t\treturn never;\n\t\t}\n\t}\n}\n',
		9,
		"TS2322",
	),
	// packages/db
	one(DB, "d-prop", "unknown property", "ts", "const o = { a: 1 };\nexport const b = o.b;\n", 2, "TS2339"),
	one(
		DB,
		"d-type-import",
		"type import without `type` (verbatimModuleSyntax)",
		"ts",
		'import { PathLike } from "node:fs";\nexport const p: PathLike = "x";\n',
		1,
		"TS1484",
	),
	one(DB, "d-implicit-any", "implicit any parameter", "ts", "export function h(x) {\n\treturn x;\n}\n", 1, "TS7006"),
	one(
		DB,
		"d-record",
		"noUncheckedIndexedAccess record",
		"ts",
		'const m: Record<string, { v: number }> = {};\nexport const v = m["k"].v;\n',
		2,
		"TS2532",
	),
	one(
		DB,
		"d-readonly",
		"assign to readonly",
		"ts",
		"const t = { a: 1 } as const;\nt.a = 2;\nexport { t };\n",
		2,
		"TS2540",
	),
	// packages/domain
	one(
		DOMAIN,
		"m-jsx",
		"JSX unknown prop",
		"tsx",
		'function Card(props: { title: string }) {\n\treturn <div>{props.title}</div>;\n}\nexport const el = <Card titel="x" />;\n',
		4,
		"TS2322",
	),
	one(DOMAIN, "m-const", "assign to const", "ts", "const k = 1;\nk = 2;\nexport { k };\n", 2, "TS2588"),
	one(
		DOMAIN,
		"m-override",
		"missing override (noImplicitOverride)",
		"ts",
		"class A {\n\tm() {}\n}\nexport class B extends A {\n\tm() {}\n}\n",
		5,
		"TS4114",
	),
	one(DOMAIN, "m-init", "uninitialised property", "ts", "export class C {\n\tname: string;\n}\n", 2, "TS2564"),
	one(
		DOMAIN,
		"m-expect",
		"unused @ts-expect-error in TSX",
		"tsx",
		"// @ts-expect-error\nexport const el = <div />;\n",
		1,
		"TS2578",
	),
	// packages/evry
	one(
		EVRY,
		"e-destructure",
		"noUncheckedIndexedAccess destructure",
		"ts",
		"const arr: string[] = [];\nconst [x] = arr;\nexport const s: string = x;\n",
		3,
		"TS2322",
	),
	one(
		EVRY,
		"e-missing-pkg",
		"missing workspace package",
		"ts",
		'import { a } from "@everyfield/not-a-package";\nexport { a };\n',
		1,
		"TS2307",
	),
	one(
		EVRY,
		"e-excess",
		"excess object literal property",
		"ts",
		"type P = { a: number };\nexport const p: P = { a: 1, b: 2 };\n",
		2,
		"TS2353",
	),
	one(
		EVRY,
		"e-overlap",
		"comparison with no overlap",
		"ts",
		'export const z = (s: "a" | "b") => s === "c";\n',
		1,
		"TS2367",
	),
	one(
		EVRY,
		"e-await",
		"await outside async",
		"ts",
		"export function w() {\n\tawait Promise.resolve();\n}\n",
		2,
		"TS1308",
	),
	// packages/reference
	one(
		REFERENCE,
		"r-expect",
		"unused @ts-expect-error",
		"ts",
		"// @ts-expect-error\nexport const ok = 1;\n",
		1,
		"TS2578",
	),
	one(
		REFERENCE,
		"r-string-index",
		"noUncheckedIndexedAccess string",
		"ts",
		'const s: string = "abc";\nexport const ch: string = s[5];\n',
		2,
		"TS2322",
	),
	one(
		REFERENCE,
		"r-constraint",
		"generic constraint",
		"ts",
		"function len<T extends { length: number }>(t: T) {\n\treturn t.length;\n}\nexport const n = len(5);\n",
		4,
		"TS2345",
	),
	one(
		REFERENCE,
		"r-missing-prop",
		"missing required property",
		"ts",
		"type Q = { a: number; b: number };\nexport const q: Q = { a: 1 };\n",
		2,
		"TS2741",
	),
	one(
		REFERENCE,
		"r-tdz",
		"used before declaration",
		"ts",
		"export const early = later;\nconst later = 1;\n",
		1,
		"TS2448",
	),
	// packages/ui
	one(
		UI,
		"u-jsx-type",
		"JSX prop of the wrong type",
		"tsx",
		'function Tag(props: { count: number }) {\n\treturn <span>{props.count}</span>;\n}\nexport const t = <Tag count="1" />;\n',
		4,
		"TS2322",
	),
	one(
		UI,
		"u-jsx-required",
		"JSX missing required prop",
		"tsx",
		"function Tag(props: { count: number }) {\n\treturn <span>{props.count}</span>;\n}\nexport const t = <Tag />;\n",
		4,
		"TS2741",
	),
	one(
		UI,
		"u-jsx-intrinsic",
		"JSX unknown attribute on a DOM element",
		"tsx",
		'export const d = <div hreff="x" />;\n',
		1,
		"TS2322",
	),
	one(
		UI,
		"u-expect",
		"unused @ts-expect-error in TSX",
		"tsx",
		"// @ts-expect-error\nexport const s = <span />;\n",
		1,
		"TS2578",
	),
	one(
		UI,
		"u-index",
		"noUncheckedIndexedAccess element",
		"ts",
		"const a: Array<{ n: number }> = [];\nexport const n: number = a[0].n;\n",
		2,
		"TS2532",
	),
	// apps/web
	one(
		WEB,
		"w-jsx-ui",
		"JSX prop of a workspace component",
		"tsx",
		'import { Button } from "@everyfield/ui/controls";\nexport const b = <Button variant="nope">x</Button>;\n',
		2,
		"TS2322",
	),
	one(
		WEB,
		"w-alias",
		"missing module through a path alias",
		"ts",
		'import { x } from "@/does/not/exist";\nexport { x };\n',
		1,
		"TS2307",
	),
	one(
		WEB,
		"w-record",
		"noUncheckedIndexedAccess property",
		"ts",
		"const r: Record<string, string> = {};\nexport const up = r.key.toUpperCase();\n",
		2,
		"TS18048",
	),
	one(
		WEB,
		"w-expect",
		"unused @ts-expect-error in TSX",
		"tsx",
		"// @ts-expect-error\nexport const p = <p />;\n",
		1,
		"TS2578",
	),
	one(
		WEB,
		"w-async",
		"async return type",
		"ts",
		'export async function f(): Promise<number> {\n\treturn "x";\n}\n',
		2,
		"TS2322",
	),
	// A workspace package export that changes: errors land in every consumer, not in contracts.
	{
		id: "x-renamed-export",
		kind: "workspace export renamed",
		files: {
			"packages/contracts/src/common/corpus-a.ts": "export const renamedExport = (id: string): string => id;\n",
		},
		expect: CONSUMERS.map((pkg) => ({ pkg, file: `${C}/uses-contracts.ts`, line: 1, code: "TS2305" })),
	},
	{
		id: "x-changed-type",
		kind: "workspace export changes type",
		files: { "packages/contracts/src/common/corpus-b.ts": 'export const corpusCount = (): string => "1";\n' },
		expect: CONSUMERS.map((pkg) => ({ pkg, file: `${C}/uses-contracts.ts`, line: 4, code: "TS2322" })),
	},
];

/** Copy the tracked workspace into `to` and give each package a node_modules that points at the copies. */
export function copyWorkspace(root: string, to: string, dirs: string[]): void {
	const listed = spawnSync(
		"git",
		["ls-files", "-z", "--", ...dirs, "tests/contracts", "tests/reference", "tests/support"],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	// Packages import tracked data and modules from these directories, such as docs/reference/*.json.
	const shared = spawnSync("git", ["ls-files", "-z", "--", "docs", "ops", "design"], { cwd: root, encoding: "utf8" });
	const files = [
		...listed.stdout.split("\0").filter(Boolean),
		...shared.stdout.split("\0").filter((f) => /\.(json|ts|mts|mjs)$/.test(f)),
		"package.json",
		"pnpm-workspace.yaml",
		"tsconfig.base.json",
	];
	for (const file of files) {
		if (/(^|\/)\.env/.test(file) || !existsSync(join(root, file))) continue;
		mkdirSync(dirname(join(to, file)), { recursive: true });
		copyFileSync(join(root, file), join(to, file));
	}
	symlinkSync(join(root, "node_modules"), join(to, "node_modules"));
	const link = (source: string, target: string) => {
		const real = realpathSync(source);
		const inside = relative(root, real);
		// Workspace packages resolve to their copies, so a changed export is seen by its consumers.
		const mapped = !inside.startsWith("..") && !inside.split("/").includes("node_modules") ? join(to, inside) : real;
		symlinkSync(mapped, target);
	};
	for (const dir of dirs) {
		const modules = join(root, dir, "node_modules");
		if (!existsSync(modules)) continue;
		mkdirSync(join(to, dir, "node_modules"), { recursive: true });
		for (const entry of readdirSync(modules)) {
			const source = join(modules, entry);
			if (entry.startsWith("@") && lstatSync(source).isDirectory() && !lstatSync(source).isSymbolicLink()) {
				mkdirSync(join(to, dir, "node_modules", entry));
				for (const scoped of readdirSync(source))
					link(join(source, scoped), join(to, dir, "node_modules", entry, scoped));
			} else link(source, join(to, dir, "node_modules", entry));
		}
	}
}

type Run = { outcome: Outcome; exit: number | null; diagnostics: Diagnostic[] };

async function check(copy: string, dir: string, tool: "tsc" | "bun", scripts: Record<string, string>): Promise<Run> {
	const script = tool === "tsc" ? `${scripts["typecheck:tsc"]} --pretty false` : scripts.typecheck!;
	const run = await runScript(script, join(copy, dir), 900_000);
	return { outcome: run.outcome, exit: run.code, diagnostics: parseDiagnostics(run.output) };
}

function apply(copy: string, files: Record<string, string>): () => void {
	const saved = new Map<string, string | null>();
	for (const [file, content] of Object.entries(files)) {
		const path = join(copy, file);
		saved.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return () => {
		for (const [path, content] of saved) content === null ? rmSync(path) : writeFileSync(path, content);
	};
}

export type CaseResult = {
	id: string;
	kind: string;
	packages: Array<{ pkg: string; exit: number | null; outcome: Outcome; nonZero: boolean; expectedFound: boolean }>;
};

export type CorpusReport = {
	cases: CaseResult[];
	baseline: Record<string, { tsc: number; bun: number; differences: number }>;
	combined: Record<
		string,
		{
			tsc: { exit: number | null; outcome: Outcome; errors: number };
			bun: { exit: number | null; outcome: Outcome; errors: number };
			differences: Array<Diagnostic & { only: "tsc" | "bun" }>;
			missingExpected: Array<Expect & { missingIn: Array<"tsc" | "bun"> }>;
		}
	>;
	ok: boolean;
};

export async function runCorpus(root: string): Promise<CorpusReport> {
	const packages = typecheckPackages(root).filter((p) => p.scripts["typecheck:tsc"]);
	const dirs = packages.map((p) => p.dir);
	const scriptsOf = (dir: string) => packages.find((p) => p.dir === dir)!.scripts;
	const copy = mkdtempSync(join(tmpdir(), "typecheck-corpus-"));
	try {
		copyWorkspace(root, copy, dirs);
		apply(copy, BASE_FILES);
		for (const [file, text] of Object.entries(BASE_APPEND)) appendFileSync(join(copy, file), text);

		const baseline: CorpusReport["baseline"] = {};
		for (const dir of dirs) {
			const [tsc, bun] = [await check(copy, dir, "tsc", scriptsOf(dir)), await check(copy, dir, "bun", scriptsOf(dir))];
			baseline[dir] = {
				tsc: tsc.diagnostics.length,
				bun: bun.diagnostics.length,
				differences: diffDiagnostics(tsc.diagnostics, bun.diagnostics).length,
			};
			console.error(`baseline ${dir}: tsc ${tsc.diagnostics.length}, bun ${bun.diagnostics.length} errors`);
		}

		const cases: CaseResult[] = [];
		for (const c of CASES) {
			const revert = apply(copy, c.files);
			const result: CaseResult = { id: c.id, kind: c.kind, packages: [] };
			for (const pkg of [...new Set(c.expect.map((e) => e.pkg))]) {
				const bun = await check(copy, pkg, "bun", scriptsOf(pkg));
				const keys = new Set(bun.diagnostics.map(diagnosticKey));
				result.packages.push({
					pkg,
					exit: bun.exit,
					outcome: bun.outcome,
					// Exit codes 1 and 2 both count as "errors found".
					nonZero: bun.outcome === "errors",
					expectedFound: c.expect.filter((e) => e.pkg === pkg).every((e) => keys.has(diagnosticKey(e))),
				});
			}
			revert();
			cases.push(result);
			console.error(
				`case ${c.id}: ${result.packages.map((p) => `${p.pkg} exit ${p.exit}${p.expectedFound ? "" : " (expected error missing)"}`).join(", ")}`,
			);
		}

		for (const c of CASES) apply(copy, c.files);
		const combined: CorpusReport["combined"] = {};
		for (const dir of dirs) {
			const tsc = await check(copy, dir, "tsc", scriptsOf(dir));
			const bun = await check(copy, dir, "bun", scriptsOf(dir));
			const has = (run: Run, e: Expect) => run.diagnostics.some((d) => diagnosticKey(d) === diagnosticKey(e));
			combined[dir] = {
				tsc: { exit: tsc.exit, outcome: tsc.outcome, errors: tsc.diagnostics.length },
				bun: { exit: bun.exit, outcome: bun.outcome, errors: bun.diagnostics.length },
				differences: diffDiagnostics(tsc.diagnostics, bun.diagnostics),
				missingExpected: CASES.flatMap((c) => c.expect)
					.filter((e) => e.pkg === dir)
					.map((e) => ({ ...e, missingIn: (["tsc", "bun"] as const).filter((t) => !has(t === "tsc" ? tsc : bun, e)) }))
					.filter((e) => e.missingIn.length > 0),
			};
			console.error(
				`combined ${dir}: tsc ${tsc.diagnostics.length}, bun ${bun.diagnostics.length}, ${combined[dir].differences.length} differences`,
			);
		}
		const ok =
			Object.values(baseline).every((b) => b.tsc === 0 && b.bun === 0) &&
			cases.every((c) => c.packages.every((p) => p.nonZero && p.expectedFound)) &&
			Object.values(combined).every((r) => r.differences.length === 0 && r.missingExpected.length === 0);
		return { cases, baseline, combined, ok };
	} finally {
		rmSync(copy, { recursive: true, force: true });
	}
}

export function markdown(report: CorpusReport): string {
	const seeded = CASES.reduce((n, c) => n + c.expect.length, 0);
	const out = [
		`## Error corpus: ${CASES.length} cases, ${seeded} seeded errors in ${Object.keys(report.combined).length} packages`,
		"",
		`Result: ${report.ok ? "tsc and bun check agree on every file, line and code" : "differences found, listed below"}.`,
		"",
		"### Baseline (corpus fixtures, no seeded errors; both must be 0)",
		"",
		"| Package | tsc errors | bun errors | Differences |",
		"|---|---:|---:|---:|",
		...Object.entries(report.baseline).map(([dir, b]) => `| ${dir} | ${b.tsc} | ${b.bun} | ${b.differences} |`),
		"",
		"### Each case alone: bun check exit code",
		"",
		"| Case | Seeds | Package | bun exit | Expected error found |",
		"|---|---|---|---:|---|",
		...report.cases.flatMap((c) =>
			c.packages.map((p) => `| ${c.id} | ${c.kind} | ${p.pkg} | ${p.exit} | ${p.expectedFound ? "yes" : "no"} |`),
		),
		"",
		"### All cases together: tsc against bun check",
		"",
		"| Package | tsc exit | tsc errors | bun exit | bun errors | Differences | Expected missing |",
		"|---|---:|---:|---:|---:|---:|---:|",
		...Object.entries(report.combined).map(
			([dir, r]) =>
				`| ${dir} | ${r.tsc.exit} | ${r.tsc.errors} | ${r.bun.exit} | ${r.bun.errors} | ${r.differences.length} | ${r.missingExpected.length} |`,
		),
	];
	const diffs = Object.entries(report.combined).flatMap(([dir, r]) => [
		...r.differences.map((d) => `- ${dir}: only ${d.only} reports ${d.file}:${d.line} ${d.code}`),
		...r.missingExpected.map(
			(e) => `- ${dir}: seeded ${e.file}:${e.line} ${e.code} missing in ${e.missingIn.join(" and ")}`,
		),
	]);
	if (diffs.length) out.push("", "### Differences", "", ...diffs);
	return out.join("\n") + "\n";
}

if (import.meta.main) {
	const report = await runCorpus(resolve(import.meta.dirname, "../.."));
	process.stdout.write(markdown(report));
	process.exitCode = report.ok ? 0 : 1;
}
