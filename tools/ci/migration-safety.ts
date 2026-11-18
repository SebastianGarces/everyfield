import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, mergeBase } from "./feature-maps.ts";

export type AddedMigration = { path: string; sql: string };

export const MIGRATION = /^packages\/db\/migrations\/[^/]+\.sql$/;
export const CONTRACT_PATHS = ["packages/db/", "docs/", "tests/integration/db/"] as const;

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?`;
const MARKER = /^[ \t]*--[ \t]*contract:(.*)$/gim;
const LATER = "drop or change it in a later migration marked -- contract: <reason>, after no code reads the old shape";
const INDEX =
	"migrate.ts applies every migration in one transaction, so CREATE INDEX CONCURRENTLY cannot run there and a plain index locks the table's writes while it builds; build it in a separate migration marked -- contract: <reason>";

function name(ident: string): string {
	const [, quoted, bare] = /(?:"([^"]+)"|([A-Za-z_][\w$]*))$/.exec(ident)!;
	return quoted ?? bare!.toLowerCase();
}

export function statements(source: string): string[] {
	const out: string[] = [];
	let current = "";
	let i = 0;
	const push = () => {
		const text = current.replace(/\s+/g, " ").trim();
		if (text) out.push(text);
		current = "";
	};
	while (i < source.length) {
		const c = source[i]!;
		const next = source[i + 1];
		if (c === "-" && next === "-") {
			const end = source.indexOf("\n", i);
			i = end < 0 ? source.length : end;
			current += " ";
		} else if (c === "/" && next === "*") {
			let depth = 1;
			i += 2;
			while (i < source.length && depth) {
				const step = source.startsWith("/*", i) ? 1 : source.startsWith("*/", i) ? -1 : 0;
				depth += step;
				i += step ? 2 : 1;
			}
			current += " ";
		} else if (c === "'") {
			const escapes = /[eE]/.test(source[i - 1] ?? "") && !/[\w$]/.test(source[i - 2] ?? "");
			i++;
			while (i < source.length) {
				if (escapes && source[i] === "\\") i += 2;
				else if (source[i] === "'" && source[i + 1] === "'") i += 2;
				else if (source[i] === "'") break;
				else i++;
			}
			i++;
			current += "''";
		} else if (c === '"') {
			const end = source.indexOf('"', i + 1);
			const stop = end < 0 ? source.length : end + 1;
			current += source.slice(i, stop);
			i = stop;
		} else if (c === "$" && !/[\w$]/.test(source[i - 1] ?? "")) {
			const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(source.slice(i))?.[0];
			if (!tag) {
				current += c;
				i++;
			} else {
				const end = source.indexOf(tag, i + tag.length);
				const stop = end < 0 ? source.length : end + tag.length;
				current += source.slice(i, stop);
				i = stop;
			}
		} else if (c === ";") {
			push();
			i++;
		} else {
			current += c;
			i++;
		}
	}
	push();
	return out;
}

function actions(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '"') i = body.indexOf('"', i + 1) < 0 ? body.length : body.indexOf('"', i + 1);
		else if (c === "(") depth++;
		else if (c === ")") depth--;
		else if (c === "," && depth === 0) {
			parts.push(body.slice(start, i).trim());
			start = i + 1;
		}
	}
	parts.push(body.slice(start).trim());
	return parts.filter(Boolean);
}

const ALTER_TABLE = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${IDENT})\s*\*?\s*(.*)$`, "is");
const CREATE_TABLE = new RegExp(
	String.raw`^CREATE (?:(?:GLOBAL|LOCAL) )?(?:(?:TEMP|TEMPORARY|UNLOGGED) )?TABLE (?:IF NOT EXISTS )?(${IDENT})`,
	"i",
);
const CREATE_INDEX = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX\b.*?\bON (?:ONLY )?(${IDENT})`, "is");
const ADD_COLUMN = new RegExp(String.raw`^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(${IDENT})\s+(.*)$`, "is");
const ALTER_COLUMN = new RegExp(String.raw`^ALTER (?:COLUMN )?(${IDENT})\s+(.*)$`, "is");
const NOT_COLUMN = /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i;

type Finding = { statement: string; rule: string };

export function findings(source: string): Finding[] {
	const all = statements(source);
	const created = new Set<string>();
	const defaults = new Set<string>();
	for (const statement of all) {
		const table = CREATE_TABLE.exec(statement);
		if (table) created.add(name(table[1]!));
		const alter = ALTER_TABLE.exec(statement);
		if (!alter) continue;
		for (const action of actions(alter[2]!)) {
			const add = ADD_COLUMN.exec(action);
			if (add && !NOT_COLUMN.test(action.slice(4)) && /\bDEFAULT\b/i.test(add[2]!))
				defaults.add(`${name(alter[1]!)}.${name(add[1]!)}`);
			const column = ALTER_COLUMN.exec(action);
			if (column && /^SET DEFAULT\b/i.test(column[2]!)) defaults.add(`${name(alter[1]!)}.${name(column[1]!)}`);
		}
	}
	const out: Finding[] = [];
	for (const statement of all) {
		const hit = (rule: string) => out.push({ statement, rule });
		if (/\bDROP TABLE\b/i.test(statement)) hit(`DROP TABLE removes a table the running code may still read; ${LATER}`);
		if (/\bRENAME\b/i.test(statement)) hit(`RENAME breaks the code that still uses the old name; ${LATER}`);
		const index = CREATE_INDEX.exec(statement);
		if (index && !created.has(name(index[1]!))) hit(`CREATE INDEX on the existing table ${name(index[1]!)}: ${INDEX}`);
		const alter = ALTER_TABLE.exec(statement);
		if (!alter) {
			if (/\bDROP COLUMN\b/i.test(statement))
				hit(`DROP COLUMN removes a column the running code may still read; ${LATER}`);
			if (new RegExp(String.raw`\bALTER (?:COLUMN )?${IDENT} (?:SET DATA )?TYPE\b`, "i").test(statement))
				hit(`ALTER ... TYPE rewrites a column the running code reads and writes; ${LATER}`);
			if (/\bSET NOT NULL\b/i.test(statement))
				hit(
					`SET NOT NULL refuses the running code's NULL writes; set a default for the column in this migration, or ${LATER}`,
				);
			continue;
		}
		const table = name(alter[1]!);
		if (created.has(table)) continue;
		for (const action of actions(alter[2]!)) {
			const column = ALTER_COLUMN.exec(action);
			const add = ADD_COLUMN.exec(action);
			if (/^DROP\b/i.test(action) && !/^DROP CONSTRAINT\b/i.test(action))
				hit(`DROP COLUMN removes a column the running code may still read; ${LATER}`);
			else if (column && /^(?:SET DATA )?TYPE\b/i.test(column[2]!))
				hit(`ALTER ... TYPE rewrites a column the running code reads and writes; ${LATER}`);
			else if (column && /^SET NOT NULL\b/i.test(column[2]!) && !defaults.has(`${table}.${name(column[1]!)}`))
				hit(
					`SET NOT NULL without a default for ${table}.${name(column[1]!)} refuses the running code's NULL writes; set a default for the column in this migration, or ${LATER}`,
				);
			else if (
				add &&
				!NOT_COLUMN.test(action.slice(4)) &&
				/\bNOT NULL\b/i.test(add[2]!) &&
				!/\b(?:DEFAULT|GENERATED)\b/i.test(add[2]!)
			)
				hit(
					`ADD COLUMN ... NOT NULL without DEFAULT on the existing table ${table} fails on its rows and refuses the running code's inserts; add a DEFAULT, or add it nullable and ${LATER}`,
				);
		}
	}
	return out;
}

function excerpt(statement: string): string {
	return statement.length > 100 ? `${statement.slice(0, 97)}...` : statement;
}

export function checkMigrations(added: readonly AddedMigration[], changed: readonly string[]): string[] {
	const problems: string[] = [];
	const appCode = changed.filter((path) => !CONTRACT_PATHS.some((prefix) => path.startsWith(prefix)));
	for (const { path, sql } of added) {
		const reasons = [...sql.matchAll(MARKER)].map((m) => m[1]!.trim());
		if (reasons.some((reason) => !reason))
			problems.push(`${path}: the -- contract: marker has no reason; write why this contract step is safe now`);
		const marked = reasons.some(Boolean);
		if (marked && appCode.length)
			problems.push(
				`${path}: a contract migration lands alone, but this change also touches app code: ${appCode.join(", ")}; move that code to an earlier change`,
			);
		if (marked) continue;
		for (const { statement, rule } of findings(sql)) problems.push(`${path}: ${excerpt(statement)}: ${rule}`);
	}
	return problems;
}

export type Change = { base: string; head?: string; against: string };

export function changeUnderCheck(root: string, ref = "origin/main"): Change | { error: string } {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	const base = mergeBase(root, ref);
	if (!base) return { error: `git merge-base HEAD ${ref} failed (is ${ref} fetched?)` };
	if (base !== git("rev-parse", "HEAD")) return { base, against: `the merge base ${base.slice(0, 12)} with ${ref}` };
	try {
		return { base: git("rev-parse", "HEAD^1"), head: "HEAD", against: "the head commit's first parent" };
	} catch {
		return { error: "HEAD is on the base and has no parent to compare with" };
	}
}

export function addedMigrations(root: string, change: Change): { added: AddedMigration[]; changed: string[] } {
	const changed = changedFiles(root, change.base, change.head);
	const atBase = new Set(
		execFileSync("git", ["ls-tree", "-r", "--name-only", change.base, "--", "packages/db/migrations/"], {
			cwd: root,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean),
	);
	const added = changed
		.filter((path) => MIGRATION.test(path) && !atBase.has(path))
		.flatMap((path): AddedMigration[] => {
			if (change.head)
				return [
					{ path, sql: execFileSync("git", ["show", `${change.head}:${path}`], { cwd: root, encoding: "utf8" }) },
				];
			return existsSync(join(root, path)) ? [{ path, sql: readFileSync(join(root, path), "utf8") }] : [];
		});
	return { added, changed };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--base");
	const ref = at >= 0 ? args[at + 1] : undefined;
	if (at >= 0 && !ref) {
		console.error("usage: node tools/ci/migration-safety.ts [--base <ref>]");
		process.exit(2);
	}
	const root = process.cwd();
	const change = changeUnderCheck(root, ref);
	if ("error" in change) {
		console.error(`migration-safety: ${change.error}`);
		process.exit(2);
	}
	const { added, changed } = addedMigrations(root, change);
	const problems = checkMigrations(added, changed);
	for (const problem of problems) console.error(problem);
	console.log(
		`migration-safety: ${added.length} added migration(s) against ${change.against}${added.length ? `: ${added.map((m) => m.path).join(", ")}` : ""}; ${problems.length} problem(s)`,
	);
	if (problems.length) process.exitCode = 1;
}
