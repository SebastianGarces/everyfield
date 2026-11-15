import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "../../packages/contracts/node_modules/typescript/lib/typescript.js";
import {
	coverage,
	machines,
	mermaid,
	refusals,
	unreachableStates,
	type MachineShape,
	type Observation,
	type Refusal,
} from "../../packages/contracts/src/machines/index.ts";

export type Writer = {
	readonly file: string;
	readonly line: number;
	readonly statement: "insert" | "update" | "set fragment" | "drizzle";
	readonly guard: string | null;
};

type Literal = { readonly text: string; readonly exprs: readonly string[]; readonly line: number };

const SOURCE_ROOTS = ["apps", "packages", "ops", "scripts", "tools"];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const NOT_PRODUCT = /(?:^|\/)(?:tests?|node_modules|\.next|dist)\/|\.test\.[^/]+$/;
const KEYWORDS = /\b(?:SELECT|UPDATE|INSERT|DELETE|WHERE|FROM|JOIN|ON|AND|OR|WHEN|THEN|CASE)\b/i;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sourceFiles(root: string): string[] {
	return execFileSync("git", ["ls-files", "-z", "--", ...SOURCE_ROOTS], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((file) => file && SOURCE_FILE.test(file) && !NOT_PRODUCT.test(file) && existsSync(join(root, file)));
}

function literals(source: ts.SourceFile): Literal[] {
	const found: Literal[] = [];
	const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const visit = (node: ts.Node) => {
		if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node))
			found.push({ text: node.text, exprs: [], line: line(node) });
		else if (ts.isTemplateExpression(node))
			found.push({
				text: node.head.text + node.templateSpans.map((span, i) => `$${i}${span.literal.text}`).join(""),
				exprs: node.templateSpans.map((span) => span.expression.getText(source)),
				line: line(node),
			});
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function splitTop(list: string): string[] {
	const items: string[] = [];
	let depth = 0,
		quoted = false,
		current = "";
	for (const ch of list) {
		if (ch === "'") quoted = !quoted;
		if (!quoted && ch === "(") depth++;
		if (!quoted && ch === ")") depth--;
		if (!quoted && depth === 0 && ch === ",") {
			items.push(current.trim());
			current = "";
		} else current += ch;
	}
	items.push(current.trim());
	return items;
}

function drizzleWriters(source: ts.SourceFile, m: MachineShape, file: string): Writer[] {
	const found: Writer[] = [];
	const target = new RegExp(`(?:^|\\.)${escape(m.table)}$`);
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			["set", "values"].includes(node.expression.name.text) &&
			ts.isCallExpression(node.expression.expression) &&
			ts.isPropertyAccessExpression(node.expression.expression.expression) &&
			["update", "insert"].includes(node.expression.expression.expression.name.text) &&
			target.test(node.expression.expression.arguments[0]?.getText(source) ?? "") &&
			node.arguments.some(
				(arg) =>
					ts.isObjectLiteralExpression(arg) &&
					arg.properties.some((p) => p.name !== undefined && p.name.getText(source) === m.column),
			)
		)
			found.push({
				file,
				line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
				statement: "drizzle",
				guard: null,
			});
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

export function census(root: string, m: MachineShape): Writer[] {
	const table = escape(m.table),
		column = `"?${escape(m.column)}"?`;
	const update = new RegExp(
		`\\bUPDATE\\s+(?:ONLY\\s+)?"?${table}"?(?![\\w"])(?:\\s+(?:AS\\s+)?(?!SET\\b)\\w+)?\\s+SET\\b([\\s\\S]*?)(?:\\bWHERE\\b|\\bRETURNING\\b|\\bFROM\\b|$)`,
		"i",
	);
	const insert = new RegExp(
		`\\bINSERT\\s+INTO\\s+"?${table}"?\\s*\\(([^)]*)\\)\\s*(VALUES\\s*\\(([\\s\\S]*)\\))?`,
		"i",
	);
	const assigns = new RegExp(`(?<![.\\w])${column}\\s*=`, "i");
	const filter = new RegExp(`(?<![\\w])(?:\\w+\\.)?${column}\\s*=\\s*ANY\\s*\\(\\s*\\$(\\d+)`, "i");
	const prefilter = new RegExp(`\\b(?:UPDATE|INSERT\\s+INTO)\\s+"?${table}\\b|\\.(?:update|insert)\\(`, "i");
	const writers: Writer[] = [];
	for (const file of sourceFiles(root)) {
		const text = readFileSync(join(root, file), "utf8");
		if (!prefilter.test(text)) continue;
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const found = literals(source);
		let dynamicSet = false;
		for (const lit of found) {
			const u = update.exec(lit.text);
			if (u) {
				const set = u[1] ?? "";
				if (splitTop(set).some((item) => /^\$\d+$/.test(item))) dynamicSet = true;
				if (!assigns.test(set)) continue;
				const f = filter.exec(lit.text);
				const guarded = f !== null && (lit.exprs[Number(f[1])] ?? "").includes("fromStates(");
				writers.push({ file, line: lit.line, statement: "update", guard: guarded ? "from-state filter" : null });
				continue;
			}
			const i = insert.exec(lit.text);
			if (i) {
				const columns = splitTop(i[1] ?? "").map((c) => c.replace(/"/g, "").toLowerCase());
				const at = columns.indexOf(m.column.toLowerCase());
				if (at < 0) continue;
				const value = i[3] === undefined ? undefined : splitTop(i[3])[at];
				const initial = value !== undefined && new RegExp(`^'${escape(m.initial.to)}'(?:::text)?$`).test(value);
				writers.push({ file, line: lit.line, statement: "insert", guard: initial ? "initial state" : null });
			}
		}
		if (dynamicSet)
			for (const lit of found)
				if (!KEYWORDS.test(lit.text) && assigns.test(lit.text))
					writers.push({ file, line: lit.line, statement: "set fragment", guard: null });
		writers.push(...drizzleWriters(source, m, file));
	}
	return writers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
const refusalRow = (r: Refusal) => `| ${r.subject} | \`${r.event}\` | ${r.from} | ${r.to} |`;

export function render(m: MachineShape, declaredRefusals: readonly Refusal[], writers: readonly Writer[]): string {
	const statements = [...new Map(writers.map((w) => [`${w.file} ${w.statement}`, w])).values()];
	return [
		`# ${title(m.id)} machine`,
		"",
		`Generated from \`packages/contracts/src/machines/${m.id}.ts\` by \`node tools/ci/machines.ts --write\`.`,
		"`node tools/ci/machines.ts --check` fails when this page differs from the table or when code writes the column",
		"without the machine's guard.",
		"",
		`- Column: \`${m.table}.${m.column}\``,
		`- States: ${m.states.map((s) => `\`${s}\``).join(", ")}`,
		`- Subjects the guards tell apart: ${Object.keys(m.subjects)
			.map((s) => `\`${s}\``)
			.join(", ")}`,
		`- Refusal for every move the chart does not show: \`${m.refusal}\``,
		...(m.unchangedIsNoop.length
			? [`- A request for the current state writes nothing: ${m.unchangedIsNoop.map((e) => `\`${e}\``).join(", ")}`]
			: []),
		"",
		"```mermaid",
		mermaid(m),
		"```",
		"",
		"## Refused moves",
		"",
		"| Subject | Event | From | To |",
		"|---|---|---|---|",
		...declaredRefusals.map(refusalRow),
		"",
		"## Writers of the column",
		"",
		"| File | Statement | Guard |",
		"|---|---|---|",
		...statements.map((w) => `| \`${w.file}\` | ${w.statement} | ${w.guard ?? "none"} |`),
		"",
		"## Proof",
		"",
		`\`${m.proof}\` walks every edge and every refused move against Postgres through the public operations and`,
		"reads each state back from the row. Run it with `EVF_MACHINE_COVERAGE=<file>` set, then attach this chart and",
		"the report below to a change that touches this machine:",
		"",
		"```sh",
		"node tools/ci/machines.ts coverage <file>",
		"```",
		"",
	].join("\n");
}

const page = (m: MachineShape) => `docs/machines/${m.id}.md`;

export function checkMachines(root: string, write = false): string[] {
	const problems: string[] = [];
	for (const m of machines) {
		const writers = census(root, m);
		for (const w of writers)
			if (!w.guard)
				problems.push(
					`${w.file}:${w.line}: ${w.statement} writes ${m.table}.${m.column} outside the ${m.id} machine's guard.`,
				);
		for (const s of unreachableStates(m)) problems.push(`${m.id}: state ${s} has no incoming edge.`);
		if (!existsSync(join(root, m.proof))) problems.push(`${m.id}: proof test ${m.proof} does not exist.`);
		const expected = render(m, refusals(m), writers),
			path = join(root, page(m));
		if (write) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, expected);
		} else if (!existsSync(path) || readFileSync(path, "utf8") !== expected)
			problems.push(`${page(m)} differs from its table: run node tools/ci/machines.ts --write.`);
	}
	return problems;
}

export function coverageReport(file: string): { lines: string[]; complete: boolean } {
	const observations = readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Observation);
	const results = machines.map((m) => coverage(m, refusals(m), observations));
	return {
		lines: results.flatMap((r) => [r.line, ...r.missing.map((k) => `  missing: ${k}`)]),
		complete: results.every((r) => r.complete),
	};
}

if (import.meta.main) {
	const [mode, file] = process.argv.slice(2);
	if (mode === "coverage") {
		if (!file) {
			console.error("usage: node tools/ci/machines.ts coverage <observations.jsonl>");
			process.exit(2);
		}
		const report = coverageReport(file);
		for (const line of report.lines) console.log(line);
		process.exit(report.complete ? 0 : 1);
	}
	if (mode === "census") {
		for (const m of machines)
			for (const w of census(process.cwd(), m))
				console.log(`${m.id}: ${w.file}:${w.line} ${w.statement} guard=${w.guard ?? "none"}`);
		process.exit(0);
	}
	if (mode !== "--check" && mode !== "--write") {
		console.error("usage: node tools/ci/machines.ts --check | --write | census | coverage <file>");
		process.exit(2);
	}
	const problems = checkMachines(process.cwd(), mode === "--write");
	for (const p of problems) console.error(p);
	if (problems.length) process.exit(1);
	console.log(`machines: ${machines.length} machine(s), charts current, every writer guarded.`);
}
