import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "../../packages/contracts/node_modules/typescript/lib/typescript.js";
import {
	coverage,
	machines,
	mermaid,
	refusals,
	skips,
	unreachableStates,
	type MachineShape,
	type Observation,
} from "../../packages/contracts/src/machines/index.ts";
import * as registry from "../../packages/contracts/src/machines/index.ts";

export type Writer = {
	readonly file: string;
	readonly line: number;
	readonly statement: "insert" | "update" | "set fragment" | "drizzle";
	readonly guard: string | null;
};

type Guard = { readonly fn: "fromStates" | "entryStates"; readonly event: string | null; readonly to: string | null };
type Literal = { readonly text: string; readonly guarded: readonly (Guard | null)[]; readonly line: number };

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

const stringOf = (expr: ts.Expression | undefined): string | null =>
	expr !== undefined && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) ? expr.text : null;

function guardCall(expr: ts.Expression, binding: string): Guard | null {
	if (!ts.isCallExpression(expr)) return null;
	const callee = expr.expression.getText();
	if (callee === "sql.param" && expr.arguments.length === 1) return guardCall(expr.arguments[0]!, binding);
	if ((callee !== "fromStates" && callee !== "entryStates") || expr.arguments[0]?.getText() !== binding) return null;
	return {
		fn: callee,
		event: stringOf(expr.arguments[1]),
		to: callee === "fromStates" ? stringOf(expr.arguments[2]) : null,
	};
}

function fits(m: MachineShape, guard: Guard | null | undefined, fn: Guard["fn"], written: string | null): boolean {
	if (!guard || guard.fn !== fn) return false;
	const moves = fn === "fromStates" ? m.transitions : m.entries;
	if (guard.event !== null && !moves.some((t) => t.event === guard.event)) return false;
	if (fn === "entryStates") return true;
	if (guard.to !== null && written !== null && guard.to !== written) return false;
	const to = guard.to ?? written;
	return to === null || m.transitions.some((t) => (guard.event === null || t.event === guard.event) && t.to === to);
}

function statementEnd(text: string, start: number): number {
	let depth = 0,
		quoted = false;
	for (let at = start; at < text.length; at++) {
		const ch = text[at];
		if (ch === "'") quoted = !quoted;
		if (quoted) continue;
		if (ch === "(") depth++;
		if (ch === ")" && --depth < 0) return at;
		if (ch === ";" && depth === 0) return at;
	}
	return text.length;
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

const initialStates = (m: MachineShape) => [...new Set(m.entries.map((e) => e.to))];

function drizzleWriters(source: ts.SourceFile, m: MachineShape, file: string, binding: string): Writer[] {
	const found: Writer[] = [];
	const target = new RegExp(`(?:^|\\.)${escape(m.table)}$`);
	const targetColumn = new RegExp(`(?:^|\\.)${escape(m.table)}\\.${escape(m.column)}$`);
	const constants = new Map<string, ts.Expression>();
	const collect = (node: ts.Node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isVariableDeclarationList(node.parent) &&
			node.parent.flags & ts.NodeFlags.Const
		)
			constants.set(node.name.text, node.initializer);
		ts.forEachChild(node, collect);
	};
	collect(source);
	const resolve = (expr: ts.Expression, depth = 0): ts.Expression =>
		ts.isIdentifier(expr) && constants.has(expr.text) && depth < 8
			? resolve(constants.get(expr.text)!, depth + 1)
			: expr;
	const textOf = (expr: ts.Expression): string => {
		const e = resolve(expr);
		return ts.isPropertyAccessExpression(e) ? `${textOf(e.expression)}.${e.name.text}` : e.getText(source);
	};
	const writes = (call: ts.Expression): "update" | "insert" | null => {
		const c = resolve(call);
		return ts.isCallExpression(c) &&
			ts.isPropertyAccessExpression(c.expression) &&
			(c.expression.name.text === "update" || c.expression.name.text === "insert") &&
			c.arguments[0] !== undefined &&
			target.test(textOf(c.arguments[0]))
			? c.expression.name.text
			: null;
	};
	const inserts = (expr: ts.Expression): boolean => {
		const e = resolve(expr);
		if (writes(e) === "insert") return true;
		if (ts.isCallExpression(e)) return inserts(e.expression);
		if (ts.isPropertyAccessExpression(e)) return inserts(e.expression);
		return false;
	};
	const column = (p: ts.ObjectLiteralElementLike) =>
		p.name !== undefined &&
		!ts.isComputedPropertyName(p.name) &&
		p.name.getText(source).replace(/["']/g, "") === m.column;
	const names = (arg: ts.Expression) =>
		!ts.isObjectLiteralExpression(arg) ||
		arg.properties.some(
			(p) => ts.isSpreadAssignment(p) || p.name === undefined || ts.isComputedPropertyName(p.name) || column(p),
		);
	const initial = (arg: ts.Expression) => {
		if (!ts.isObjectLiteralExpression(arg)) return false;
		const last = arg.properties.findLast(
			(p) => ts.isSpreadAssignment(p) || p.name === undefined || ts.isComputedPropertyName(p.name) || column(p),
		);
		return (
			last !== undefined &&
			ts.isPropertyAssignment(last) &&
			column(last) &&
			ts.isStringLiteral(last.initializer) &&
			initialStates(m).includes(last.initializer.text)
		);
	};
	const written = (arg: ts.Expression | undefined): string | null => {
		if (arg === undefined || !ts.isObjectLiteralExpression(arg)) return null;
		const last = arg.properties.findLast(
			(p) => ts.isSpreadAssignment(p) || p.name === undefined || ts.isComputedPropertyName(p.name) || column(p),
		);
		return last !== undefined && ts.isPropertyAssignment(last) && column(last) ? stringOf(last.initializer) : null;
	};
	const filtered = (where: ts.Expression, value: string | null): boolean => {
		if (!ts.isCallExpression(where)) return false;
		const callee = where.expression.getText(source);
		if (callee === "and") return where.arguments.some((w) => filtered(w, value));
		return (
			callee === "inArray" &&
			where.arguments.length === 2 &&
			targetColumn.test(textOf(where.arguments[0]!)) &&
			fits(m, guardCall(where.arguments[1]!, binding), "fromStates", value)
		);
	};
	const guardOf = (node: ts.CallExpression, kind: string): string | null => {
		if (kind === "values") return node.arguments.length === 1 && initial(node.arguments[0]!) ? "initial state" : null;
		const parent = node.parent;
		const where =
			ts.isPropertyAccessExpression(parent) && parent.name.text === "where" && ts.isCallExpression(parent.parent)
				? parent.parent
				: null;
		return where && where.arguments.length === 1 && filtered(where.arguments[0]!, written(node.arguments[0]))
			? "from-state filter"
			: null;
	};
	const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
			const method = node.expression.name.text;
			const kind = writes(node.expression.expression);
			if (
				((method === "set" && kind === "update") || (method === "values" && kind === "insert")) &&
				node.arguments.some(names)
			)
				found.push({ file, line: line(node), statement: "drizzle", guard: guardOf(node, method) });
			if (
				(method === "onConflictDoUpdate" || method === "onDuplicateKeyUpdate") &&
				inserts(node.expression.expression)
			) {
				const config = node.arguments[0];
				const set =
					config && ts.isObjectLiteralExpression(config)
						? config.properties.find(
								(p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === "set",
							)
						: undefined;
				if (!config || !ts.isObjectLiteralExpression(config) || (set && names(set.initializer)))
					found.push({ file, line: line(node), statement: "drizzle", guard: null });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function functionGuard(m: MachineShape, text: string, index: number, to: string | undefined): string | null {
	const head = [
		...text.slice(0, index).matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?\w+"?\.)?"?(\w+)"?\s*\(/gi),
	].at(-1);
	if (!head || to === undefined || text.slice(head.index, index).includes("$$;")) return null;
	const from = [...new Set(m.transitions.filter((t) => t.sql === head[1] && t.to === to).map((t) => t.from))];
	const lock = new RegExp(
		`SELECT\\s+\\*\\s+INTO\\s+\\w+\\s+FROM\\s+"?${escape(m.table)}"?\\s+WHERE\\s+([^;]*?)\\s+FOR\\s+UPDATE\\s*;\\s*IF\\s+NOT\\s+FOUND\\s+THEN\\s+RAISE\\b`,
		"i",
	).exec(text.slice(head.index, index));
	const column = escape(m.column);
	const single = lock && new RegExp(`(?<![\\w.])${column}\\s*=\\s*'([^']*)'`, "i").exec(lock[1]!);
	const listed = lock && new RegExp(`(?<![\\w.])${column}\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(lock[1]!);
	const required = single ? [single[1]!] : listed ? splitTop(listed[1]!).map((v) => v.replace(/'/g, "")) : [];
	const same = from.length > 0 && required.length === from.length && from.every((s) => required.includes(s));
	const where = /\bWHERE\s+(?:\w+\.)?id\s*=\s*(\w+)\s*$/i.exec(text.slice(index, statementEnd(text, index)));
	const locked =
		lock !== null &&
		where !== null &&
		new RegExp(`(?:^|\\sAND\\s)(?:\\w+\\.)?id\\s*=\\s*${escape(where[1]!)}(?:\\s|$)`, "i").test(lock[1]!);
	return same && locked ? `locked ${from.join(", ")} in ${head[1]}` : null;
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
				const assignment = items.find((item) => assigns.test(item));
				if (assignment === undefined) continue;
				if (sqlFile) {
					const to = /=\s*'([^']*)'\s*$/.exec(assignment)?.[1];
					writers.push({ file, line, statement: "update", guard: functionGuard(m, text, u.index, to) });
					continue;
				}
				const f = filter.exec(lit.text.slice(u.index, statementEnd(lit.text, u.index)));
				const value = /=\s*'([^']*)'\s*$/.exec(assignment)?.[1] ?? null;
				const guarded = f !== null && fits(m, lit.guarded[Number(f[1])], "fromStates", value);
				writers.push({ file, line, statement: "update", guard: guarded ? "from-state filter" : null });
			}
			for (const i of lit.text.matchAll(insert)) {
				const line = lineOf(lit, i.index);
				if (i[1] === undefined) {
					const f = filter.exec(lit.text.slice(i.index, statementEnd(lit.text, i.index)));
					const copied = !sqlFile && f !== null && fits(m, lit.guarded[Number(f[1])], "entryStates", null);
					writers.push({ file, line, statement: "insert", guard: copied ? "entry-state filter" : null });
					continue;
				}
				const columns = splitTop(i[1]).map((c) => c.replace(/"/g, "").toLowerCase());
				const at = columns.indexOf(m.column.toLowerCase());
				if (at < 0) continue;
				const value = i[3] === undefined ? undefined : splitTop(i[3])[at];
				const initial =
					!sqlFile &&
					value !== undefined &&
					initialStates(m).some((to) => new RegExp(`^'${escape(to)}'(?:::text)?$`).test(value));
				writers.push({ file, line, statement: "insert", guard: initial ? "initial state" : null });
			}
		}
		if (dynamicSet)
			for (const lit of found)
				if (!STATEMENT.test(lit.text) && splitTop(lit.text).some((item) => assigns.test(item)))
					writers.push({ file, line: lit.line, statement: "set fragment", guard: null });
		if (source) writers.push(...drizzleWriters(source, m, file, binding));
	}
	return writers.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
const code = (text: string) => `\`${text}\``;
const list = (items: readonly string[]) => items.map(code).join(", ");

export function render(m: MachineShape, writers: readonly Writer[]): string {
	const statements = [...new Map(writers.map((w) => [`${w.file} ${w.statement} ${w.guard}`, w])).values()];
	const declaredRefusals = refusals(m),
		declaredSkips = skips(m);
	return [
		`# ${title(m.id)} machine`,
		"",
		`Generated from \`packages/contracts/src/machines/${m.id}.ts\` by \`node tools/ci/machines.ts --write\`.`,
		"`node tools/ci/machines.ts --check` fails when this page differs from the table, and when the writer census below",
		"finds a write of the column that does not carry the machine's guard.",
		"",
		`- Column: ${code(`${m.table}.${m.column}`)}`,
		`- States: ${list(m.states)}`,
		`- Subjects the guards tell apart: ${list(Object.keys(m.subjects))}`,
		...(m.facts?.length ? [`- Guards that describe the moment, not the subject: ${list(m.facts)}`] : []),
		`- Refusal for every move the chart does not show: ${code(m.refusal)}`,
		...(m.refusalCodes ?? []).map(
			(r) =>
				`- ${code(r.code)} instead for ${code(r.event)}${r.from === undefined ? "" : ` from ${list(typeof r.from === "string" ? [r.from] : r.from)}`}`,
		),
		...(m.unchangedIsNoop.length
			? [`- A request for the current state writes nothing: ${list(m.unchangedIsNoop)}`]
			: []),
		...(declaredSkips.length
			? ["- A sweep changes only the rows in its from-states and leaves every other row as it is"]
			: []),
		...(m.notes?.length ? ["", ...m.notes.map((n) => `- ${n}`)] : []),
		"",
		"```mermaid",
		mermaid(m),
		"```",
		"",
		"## Refused moves",
		"",
		"| Subject | Event | From | To | Refusal |",
		"|---|---|---|---|---|",
		...declaredRefusals.map((r) => `| ${code(r.subject)} | ${code(r.event)} | ${r.from} | ${r.to} | ${code(r.code)} |`),
		...(declaredSkips.length
			? [
					"",
					"## Rows a sweep leaves unchanged",
					"",
					"| Subject | Event | From | Not moved to |",
					"|---|---|---|---|",
					...declaredSkips.map((r) => `| ${code(r.subject)} | ${code(r.event)} | ${r.from} | ${r.to} |`),
				]
			: []),
		"",
		"## Writers of the column",
		"",
		"| File | Statement | Guard |",
		"|---|---|---|",
		...statements.map((w) => `| ${code(w.file)} | ${w.statement} | ${w.guard ?? "none"} |`),
		"",
		"The census is a static scan of git-tracked product code and SQL files under apps, packages, ops, scripts and",
		"tools. It reads SQL literals (with an optional schema prefix), SET fragments in a file that also holds a dynamic",
		"`SET ${…}` on the table, Drizzle `update`/`insert`/`onConflictDoUpdate` calls (a table or query held in a",
		"`const` of the same file is followed), and `.sql` files. A statement ends at its `;` or at the parenthesis",
		"that closes its CTE, so a guard elsewhere in the same SQL text does not count. A guarded UPDATE filters on",
		`\`${m.column} = ANY(\${fromStates(${bindingOf(m)}, …)})\` inside its own statement, or a Drizzle update on`,
		`\`inArray(<table>.${m.column}, fromStates(${bindingOf(m)}, …))\` in its \`where\` (alone or inside \`and\`). When`,
		"the guard names its event or target as a string literal, or the write sets the state as a literal, the event",
		"must have a move to that state and the two targets must agree. A guarded INSERT writes an initial state as a",
		"literal; in a Drizzle object literal that is the last property that names the column, after any spread. An",
		"insert that updates the column on conflict is unguarded. An INSERT that copies rows without a column list is",
		`guarded when its own statement filters on \`${m.column} = ANY(\${entryStates(${bindingOf(m)}, …)})\`. An UPDATE in`,
		"a `.sql` file is guarded only inside a function that an edge names with `sql`, after a",
		"`SELECT * INTO … FROM <table> WHERE … FOR UPDATE; IF NOT FOUND THEN RAISE` whose required states are exactly",
		"that edge's from-states, only when it writes that edge's target as a literal, and only when its `WHERE` is",
		"`id = <the id the lock read>`. A column name or statement start built at runtime, or a Drizzle object that is",
		"not a literal, counts as an unguarded writer.",
		"",
		"It cannot see: a SET fragment passed in from another file; SQL text assembled from variables that hold no",
		"literal naming the table; a table or query handed through a parameter, a `let` or another file; whether an",
		"event or target passed as a variable fits the write (only literal ones are checked); statements sent outside",
		"this repository; or writes made by hand in a database session. Only a database trigger generated from this",
		"table would refuse those.",
		"",
		"It is strict where it cannot tell: any other write in a `.sql` file counts as unguarded (a data backfill",
		"needs its own edge and function), and so does a bare",
		`\`${m.column} = …\` fragment of any table in a file that also holds a dynamic \`UPDATE ${m.table} SET \${…}\`.`,
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
		const expected = render(m, writers),
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
	const results = machines.map((m) => coverage(m, observations));
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
	console.log(`machines: ${machines.length} machine(s), charts current, every writer the census sees is guarded.`);
}
