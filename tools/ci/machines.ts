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
import * as registry from "../../packages/contracts/src/machines/index.ts";
import { mergeBase } from "./feature-maps.ts";

export type Writer = {
	readonly file: string;
	readonly line: number;
	readonly statement: "insert" | "update" | "set fragment" | "drizzle";
	readonly guard: string | null;
};

type Literal = { readonly text: string; readonly guarded: readonly boolean[]; readonly line: number };

const SOURCE_ROOTS = ["apps", "packages", "ops", "scripts", "tools"];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SQL_FILE = /\.sql$/;
const NOT_PRODUCT = /(?:^|\/)(?:tests?|node_modules|\.next|dist)\/|\.test\.[^/]+$/;
const STATEMENT = /\b(?:SELECT|UPDATE|INSERT|DELETE|WHERE|FROM)\b/i;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function trackedFiles(root: string): string[] {
	return execFileSync("git", ["ls-files", "-z", "--", ...SOURCE_ROOTS], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter(
			(file) =>
				file &&
				(SOURCE_FILE.test(file) || SQL_FILE.test(file)) &&
				!NOT_PRODUCT.test(file) &&
				existsSync(join(root, file)),
		);
}

function guardCall(expr: ts.Expression, binding: string): boolean {
	if (!ts.isCallExpression(expr)) return false;
	const callee = expr.expression.getText();
	if (callee === "sql.param" && expr.arguments.length === 1) return guardCall(expr.arguments[0]!, binding);
	return callee === "fromStates" && expr.arguments[0]?.getText() === binding;
}

function literals(source: ts.SourceFile, binding: string): Literal[] {
	const found: Literal[] = [];
	const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const visit = (node: ts.Node) => {
		if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node))
			found.push({ text: node.text, guarded: [], line: line(node) });
		else if (ts.isTemplateExpression(node))
			found.push({
				text: node.head.text + node.templateSpans.map((span, i) => `$${i}${span.literal.text}`).join(""),
				guarded: node.templateSpans.map((span) => guardCall(span.expression, binding)),
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
	const names = (arg: ts.Expression) =>
		!ts.isObjectLiteralExpression(arg) ||
		arg.properties.some(
			(p) =>
				ts.isSpreadAssignment(p) ||
				p.name === undefined ||
				ts.isComputedPropertyName(p.name) ||
				p.name.getText(source).replace(/["']/g, "") === m.column,
		);
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			["set", "values"].includes(node.expression.name.text) &&
			ts.isCallExpression(node.expression.expression) &&
			ts.isPropertyAccessExpression(node.expression.expression.expression) &&
			["update", "insert"].includes(node.expression.expression.expression.name.text) &&
			target.test(node.expression.expression.arguments[0]?.getText(source) ?? "") &&
			node.arguments.some(names)
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

export function bindingOf(m: MachineShape): string {
	const name = Object.entries(registry).find(([, value]) => value === m)?.[0];
	if (!name) throw new Error(`${m.id}: the machines index must export the machine by name.`);
	return name;
}

export function census(root: string, m: MachineShape, binding = bindingOf(m)): Writer[] {
	const table = `(?:"?\\w+"?\\.)?"?${escape(m.table)}"?(?![\\w"])`,
		column = `"?${escape(m.column)}"?`;
	const update = new RegExp(
		`\\bUPDATE\\s+(?:ONLY\\s+)?${table}(?:\\s+(?:AS\\s+)?(?!SET\\b)\\w+)?\\s+SET\\b([\\s\\S]*?)(?=\\bWHERE\\b|\\bRETURNING\\b|\\bFROM\\b|;|$)`,
		"gi",
	);
	const insert = new RegExp(
		`\\bINSERT\\s+INTO\\s+${table}\\s*(?:\\(([^)]*)\\)\\s*(VALUES\\s*\\(([\\s\\S]*)\\))?)?`,
		"gi",
	);
	const assigns = new RegExp(`^(?:\\w+\\.)?${column}\\s*=`, "i");
	const dynamicColumn = /^\$\d+\s*=/;
	const filter = new RegExp(`(?<![\\w])(?:\\w+\\.)?${column}\\s*=\\s*ANY\\s*\\(\\s*\\$(\\d+)`, "i");
	const prefilter = new RegExp(`\\b(?:UPDATE|INSERT\\s+INTO)\\s+${table}|\\.(?:update|insert)\\(`, "i");
	const writers: Writer[] = [];
	for (const file of trackedFiles(root)) {
		const text = readFileSync(join(root, file), "utf8");
		if (!prefilter.test(text)) continue;
		const sqlFile = SQL_FILE.test(file);
		const source = sqlFile ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
		const found: Literal[] = source ? literals(source, binding) : [{ text, guarded: [], line: 1 }];
		const lineOf = (lit: Literal, index: number) => (sqlFile ? text.slice(0, index).split("\n").length : lit.line);
		let dynamicSet = false;
		for (const lit of found) {
			for (const u of lit.text.matchAll(update)) {
				const items = splitTop(u[1] ?? "").filter(Boolean);
				if (items.some((item) => /^\$\d+$/.test(item))) dynamicSet = true;
				const line = lineOf(lit, u.index);
				if (!items.length || items.some((item) => dynamicColumn.test(item))) {
					writers.push({ file, line, statement: "update", guard: null });
					continue;
				}
				if (!items.some((item) => assigns.test(item))) continue;
				const f = filter.exec(lit.text);
				const guarded = !sqlFile && f !== null && lit.guarded[Number(f[1])] === true;
				writers.push({ file, line, statement: "update", guard: guarded ? "from-state filter" : null });
			}
			for (const i of lit.text.matchAll(insert)) {
				const line = lineOf(lit, i.index);
				if (i[1] === undefined) {
					writers.push({ file, line, statement: "insert", guard: null });
					continue;
				}
				const columns = splitTop(i[1]).map((c) => c.replace(/"/g, "").toLowerCase());
				const at = columns.indexOf(m.column.toLowerCase());
				if (at < 0) continue;
				const value = i[3] === undefined ? undefined : splitTop(i[3])[at];
				const initial =
					!sqlFile && value !== undefined && new RegExp(`^'${escape(m.initial.to)}'(?:::text)?$`).test(value);
				writers.push({ file, line, statement: "insert", guard: initial ? "initial state" : null });
			}
		}
		if (dynamicSet)
			for (const lit of found)
				if (!STATEMENT.test(lit.text) && splitTop(lit.text).some((item) => assigns.test(item)))
					writers.push({ file, line: lit.line, statement: "set fragment", guard: null });
		if (source) writers.push(...drizzleWriters(source, m, file));
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
		"`node tools/ci/machines.ts --check` fails when this page differs from the table, and when the writer census below",
		"finds a write of the column that does not carry the machine's guard.",
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
		"The census is a static scan of git-tracked product code and SQL files under apps, packages, ops, scripts and",
		"tools. It reads SQL literals (with an optional schema prefix), SET fragments in a file that also holds a dynamic",
		"`SET ${…}` on the table, Drizzle `update`/`insert` calls, and `.sql` files. A guarded UPDATE filters on",
		`\`${m.column} = ANY(\${fromStates(${bindingOf(m)}, …)})\` in the same statement; a guarded INSERT writes the`,
		"initial state. A column name or statement start built at runtime, or a Drizzle object that is not a literal, counts",
		"as an unguarded writer.",
		"",
		"It cannot see: a SET fragment passed in from another file, SQL text assembled from variables that hold no",
		"literal naming the table, statements sent outside this repository, or writes made by hand in a database",
		"session. Only a database trigger generated from this table would refuse those.",
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

export const page = (m: MachineShape) => `docs/machines/${m.id}.md`;
export const tableFile = (m: MachineShape) => `packages/contracts/src/machines/${m.id}.ts`;
export const SCHEMA_TABLES = "packages/db/src/schema/tables.ts";
const STATE_NAME = /^(?:status|state|stage|phase)$|_(?:status|state|stage|phase)$/;
const STATE_MINIMUM = 4;

export function enumColumns(text: string): Map<string, string[]> {
	const columns = new Map<string, string[]>();
	const source = ts.createSourceFile(SCHEMA_TABLES, text, ts.ScriptTarget.Latest, true);
	const stringArg = (call: ts.CallExpression, i: number) => {
		const arg = call.arguments[i];
		return arg && ts.isStringLiteralLike(arg) ? arg.text : undefined;
	};
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && node.expression.getText(source) === "pgTable") {
			const table = stringArg(node, 0),
				body = node.arguments[1];
			if (table !== undefined && body) collect(table, body);
		}
		ts.forEachChild(node, visit);
	};
	const collect = (table: string, node: ts.Node) => {
		if (ts.isCallExpression(node) && node.expression.getText(source) === "text") {
			const column = stringArg(node, 0),
				options = node.arguments[1];
			const list =
				options &&
				ts.isObjectLiteralExpression(options) &&
				options.properties.find(
					(p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === "enum",
				)?.initializer;
			if (column !== undefined && list && ts.isArrayLiteralExpression(list))
				columns.set(
					`${table}.${column}`,
					list.elements.filter(ts.isStringLiteralLike).map((e) => e.text),
				);
		}
		ts.forEachChild(node, (child) => collect(table, child));
	};
	visit(source);
	return columns;
}

export const sameValues = (a: readonly string[] = [], b: readonly string[] = []) =>
	a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

export function showAt(root: string, base: string, file: string): string {
	try {
		return execFileSync("git", ["show", `${base}:${file}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return "";
	}
}

export function checkStateColumns(root: string, base: string): string[] {
	const headFile = join(root, SCHEMA_TABLES);
	const head = enumColumns(existsSync(headFile) ? readFileSync(headFile, "utf8") : "");
	const before = enumColumns(showAt(root, base, SCHEMA_TABLES));
	const covered = new Set(machines.map((m) => `${m.table}.${m.column}`));
	const problems: string[] = [];
	for (const [key, values] of head) {
		const [table, column] = key.split(".") as [string, string];
		if (!STATE_NAME.test(column) || values.length < STATE_MINIMUM) continue;
		if (covered.has(key) || sameValues(values, before.get(key))) continue;
		const id = `${table}-${column}`.replace(/_/g, "-");
		problems.push(
			`${SCHEMA_TABLES}: ${key} has ${values.length} states (${values.join(", ")}) and no machine table. Add packages/contracts/src/machines/${id}.ts with table "${table}" and column "${column}", export it from packages/contracts/src/machines/index.ts, then run node tools/ci/machines.ts --write.`,
		);
	}
	return problems;
}

export const chartCurrent = (root: string, m: MachineShape, expected: string) => {
	const path = join(root, page(m));
	return existsSync(path) && readFileSync(path, "utf8") === expected;
};

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
		} else if (!chartCurrent(root, m, expected))
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
	const root = process.cwd();
	const problems = checkMachines(root, mode === "--write");
	if (mode === "--check") {
		const base = mergeBase(root);
		problems.push(
			...(base
				? checkStateColumns(root, base)
				: [
						"machines: no merge base with origin/main (run git fetch origin main), so the rule that a changed 4+ state column needs a machine table was not checked.",
					]),
		);
	}
	for (const p of problems) console.error(p);
	if (problems.length) process.exit(1);
	console.log(
		`machines: ${machines.length} machine(s), charts current, every writer the census sees is guarded, every changed 4+ state column has a machine.`,
	);
}
