import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./lib.ts";

/**
 * OPS-136: a test that reads the branch diff of the current checkout passes on one branch and fails on the next. AC:OPS-125-8
 * failed every app branch for four hours that way. `evf test` runs this lint before `node --test`.
 *
 * A read is `git diff`, `log`, `merge-base`, `rev-list`, `cherry`, or `show` with a revision. The current checkout is
 * `source`, `process.cwd()`, a path from `import.meta`, or a git call with no `cwd`, `-C` or `--git-dir`. The lint scans
 * tokens, so git text in a string that a test only writes as content is never a call. It follows `-C`, `--git-dir`, `cwd`,
 * shell strings, local aliases and file-local helpers to the call that passes the checkout in, so each call decides for
 * its own test block.
 *
 * Limit: it sees direct git calls and helpers in the same file. It does not follow a git read across files, into an evf
 * command, or through a helper passed as a value. It accepts a call whose arguments it cannot read: a subcommand or
 * options in a variable, a shell string that is not one literal or template, or `shell: true`.
 */

type Token = {
	kind: "id" | "str" | "tpl" | "punct" | "other";
	text: string;
	line: number;
	/** A template literal's text between its expressions, and those expressions. */
	parts?: string[];
	exprs?: Token[][];
};
type Param = { name: string | null; rest: boolean };
type Fn = { name: string; params: Param[]; from: number; to: number; scope: Scope };
type Variable = { name: string; init: Token[]; scope: Scope };
type Scope = { from: number; to: number };
type Call = { args: Token[][]; at: number };
type Env = Map<Fn, Call>;
type Word = { lit: string | null; tokens: Token[]; at: number };
type Site = { at: number; options: Token[] | null } & (
	{ kind: "git"; args: Token[] } | { kind: "shell"; command: Token[] }
);

type Refusal = { file: string; line: number; test: string | null; read: string; readLine: number };

/** `==` joins so that a comparison never reads as an assignment; `...` and `=>` are what the parser looks for. */
const JOINED = ["...", "===", "==", "=>"];

function tokenize(src: string): Token[] {
	let at = 0,
		line = 1;
	const advance = (to: number) => {
		for (; at < to; at++) if (src[at] === "\n") line++;
	};
	const quoted = (quote: string): string => {
		let end = at + 1;
		while (end < src.length && src[end] !== quote) end += src[end] === "\\" ? 2 : 1;
		const raw = src.slice(at + 1, end);
		advance(end + 1);
		return raw;
	};
	function scan(inExpr: boolean): Token[] {
		const tokens: Token[] = [];
		let depth = 0;
		while (at < src.length) {
			const c = src[at]!;
			if (/\s/.test(c)) advance(at + 1);
			else if (src.startsWith("//", at)) advance(src.indexOf("\n", at) < 0 ? src.length : src.indexOf("\n", at));
			else if (src.startsWith("/*", at)) advance(src.indexOf("*/", at) < 0 ? src.length : src.indexOf("*/", at) + 2);
			else if (c === '"' || c === "'") {
				const l = line;
				tokens.push({ kind: "str", text: quoted(c), line: l });
			} else if (c === "`") {
				const l = line,
					parts: string[] = [],
					exprs: Token[][] = [];
				let text = "";
				advance(at + 1);
				while (at < src.length && src[at] !== "`") {
					if (src[at] === "\\") {
						text += src.slice(at, at + 2);
						advance(at + 2);
					} else if (src.startsWith("${", at)) {
						advance(at + 2);
						parts.push(text);
						text = "";
						exprs.push(scan(true));
					} else {
						text += src[at];
						advance(at + 1);
					}
				}
				advance(at + 1);
				parts.push(text);
				tokens.push({ kind: "tpl", text: parts.join(""), line: l, parts, exprs });
			} else if (/[\w$]/.test(c)) {
				const m = /^[\w$]+/.exec(src.slice(at, at + 200))![0];
				tokens.push({ kind: "id", text: m, line });
				advance(at + m.length);
			} else if (c === "/" && regexAllowed(tokens.at(-1))) {
				let end = at + 1,
					inClass = false;
				for (; end < src.length && (src[end] !== "/" || inClass) && src[end] !== "\n"; end++) {
					if (src[end] === "\\") end++;
					else if (src[end] === "[") inClass = true;
					else if (src[end] === "]") inClass = false;
				}
				tokens.push({ kind: "other", text: "/re/", line });
				advance(end + 1);
			} else {
				if (inExpr && c === "}" && depth === 0) {
					advance(at + 1);
					return tokens;
				}
				if (c === "{") depth++;
				if (c === "}") depth--;
				const text = JOINED.find((p) => src.startsWith(p, at)) ?? c;
				tokens.push({ kind: "punct", text, line });
				advance(at + text.length);
			}
		}
		return tokens;
	}
	return scan(false);
}

const regexAllowed = (prev: Token | undefined) =>
	!prev || (prev.kind === "punct" && ![")", "]"].includes(prev.text)) || (prev.kind === "id" && prev.text === "return");

const OPEN = new Set(["(", "[", "{"]),
	CLOSE = new Set([")", "]", "}"]);
const isP = (t: Token | undefined, text: string) => t?.kind === "punct" && t.text === text;

/** The index of the bracket that closes the one at `open`. */
function closer(tokens: Token[], open: number): number {
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		if (tokens[i]!.kind !== "punct") continue;
		if (OPEN.has(tokens[i]!.text)) depth++;
		else if (CLOSE.has(tokens[i]!.text) && --depth === 0) return i;
	}
	return tokens.length - 1;
}

/** Split on the commas outside any bracket. */
function splitCommas(tokens: Token[]): Token[][] {
	const out: Token[][] = [];
	let depth = 0,
		current: Token[] = [];
	for (const t of tokens) {
		if (t.kind === "punct" && OPEN.has(t.text)) depth++;
		if (t.kind === "punct" && CLOSE.has(t.text)) depth--;
		if (depth === 0 && isP(t, ",")) {
			out.push(current);
			current = [];
		} else current.push(t);
	}
	if (current.length) out.push(current);
	return out;
}

/** The end (exclusive) of an expression that starts at `from`: the first comma, semicolon or unmatched closer. */
function expressionEnd(tokens: Token[], from: number): number {
	let depth = 0;
	for (let i = from; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.kind !== "punct") continue;
		if (OPEN.has(t.text)) depth++;
		else if (CLOSE.has(t.text)) {
			if (depth === 0) return i;
			depth--;
		} else if (depth === 0 && (t.text === "," || t.text === ";")) return i;
	}
	return tokens.length;
}

function parseParams(tokens: Token[]): Param[] {
	return splitCommas(tokens).map((p) => {
		const rest = isP(p[0], "...");
		const first = p[rest ? 1 : 0];
		return { name: first?.kind === "id" ? first.text : null, rest };
	});
}

/** The refusals of one test file's text. Functions, aliases and git calls are found by index into its token list. */
export function lintBranchDiffSource(file: string, text: string): Refusal[] {
	const tokens = tokenize(text);
	const enclosing: Scope[] = [];
	const scopes: Scope[] = [];
	for (let i = 0; i < tokens.length; i++) {
		if (isP(tokens[i], "{")) {
			enclosing.push({ from: i, to: closer(tokens, i) });
		}
		scopes[i] = enclosing.at(-1) ?? { from: 0, to: tokens.length };
		if (isP(tokens[i], "}")) enclosing.pop();
	}
	const fns: Fn[] = [],
		variables: Variable[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.kind === "id" && t.text === "function" && tokens[i + 1]?.kind === "id" && isP(tokens[i + 2], "(")) {
			const close = closer(tokens, i + 2);
			let body = close + 1;
			// A return type can hold an object type: the body is the first brace that does not start a type.
			while (
				body < tokens.length &&
				!(isP(tokens[body], "{") && !isP(tokens[body - 1], ":") && !isP(tokens[body - 1], "|"))
			)
				body = isP(tokens[body], "{") ? closer(tokens, body) + 1 : body + 1;
			fns.push({
				name: tokens[i + 1]!.text,
				params: parseParams(tokens.slice(i + 3, close)),
				from: i + 2,
				to: closer(tokens, body),
				scope: scopes[i]!,
			});
		}
		if (t.kind === "id" && isP(tokens[i + 1], "=") && !isP(tokens[i - 1], ".")) {
			let start = i + 2;
			if (tokens[start]?.text === "async") start++;
			let params: Param[] | null = null,
				arrow = -1;
			if (isP(tokens[start], "(")) {
				const close = closer(tokens, start);
				params = parseParams(tokens.slice(start + 1, close));
				arrow = close + 1;
				if (isP(tokens[arrow], ":")) {
					const limit = expressionEnd(tokens, arrow);
					while (arrow < limit && !isP(tokens[arrow], "=>")) arrow++;
				}
				if (!isP(tokens[arrow], "=>")) params = null;
			} else if (tokens[start]?.kind === "id" && isP(tokens[start + 1], "=>")) {
				params = [{ name: tokens[start]!.text, rest: false }];
				arrow = start + 1;
			}
			if (params) {
				const to = isP(tokens[arrow + 1], "{") ? closer(tokens, arrow + 1) : expressionEnd(tokens, arrow + 1);
				fns.push({ name: t.text, params, from: start, to, scope: scopes[i]! });
			} else
				variables.push({ name: t.text, init: tokens.slice(i + 2, expressionEnd(tokens, i + 2)), scope: scopes[i]! });
		}
	}

	const width = (s: Scope) => s.to - s.from;
	const within = (s: Scope, at: number) => s.from <= at && at <= s.to;
	type Found = { kind: "param"; fn: Fn; index: number } | { kind: "var"; variable: Variable } | { kind: "fn"; fn: Fn };
	function lookup(name: string, at: number): Found | null {
		let best: Found | null = null,
			bestWidth = Infinity;
		const offer = (found: Found, scope: Scope) => {
			if (within(scope, at) && width(scope) <= bestWidth) {
				best = found;
				bestWidth = width(scope);
			}
		};
		for (const fn of fns) {
			const index = fn.params.findIndex((p) => p.name === name);
			if (index >= 0) offer({ kind: "param", fn, index }, fn);
			if (fn.name === name) offer({ kind: "fn", fn }, fn.scope);
		}
		for (const variable of variables) if (variable.name === name) offer({ kind: "var", variable }, variable.scope);
		return best;
	}

	class NeedsCall extends Error {
		fn: Fn;
		constructor(fn: Fn) {
			super();
			this.fn = fn;
		}
	}
	const boundArgs = (fn: Fn, env: Env): Call => {
		const call = env.get(fn);
		if (!call) throw new NeedsCall(fn);
		return call;
	};

	/** Does this expression name the current checkout? */
	function isCurrent(expr: Token[], at: number, env: Env, seen: Set<Variable> = new Set()): boolean {
		for (let i = 0; i < expr.length; i++) {
			const t = expr[i]!;
			if (t.kind === "tpl") {
				if (t.exprs!.some((e) => isCurrent(e, at, env, seen))) return true;
				continue;
			}
			if (t.kind !== "id" || isP(expr[i - 1], ".")) continue;
			if (t.text === "process" && expr[i + 2]?.text === "cwd") return true;
			if (t.text === "import" && expr[i + 2]?.text === "meta") return true;
			// A temporary directory is a fixture, wherever its name comes from.
			if (/^(mkdtemp|mkdtempSync|tmpdir|fixture)$/.test(t.text)) return false;
			if (isP(expr[i + 1], "(")) continue;
			const found = lookup(t.text, at);
			if (!found) {
				if (t.text === "source") return true;
				continue;
			}
			if (found.kind === "var") {
				if (seen.has(found.variable)) continue;
				seen.add(found.variable);
				if (isCurrent(found.variable.init, at, env, seen)) return true;
			} else if (found.kind === "param") {
				const call = boundArgs(found.fn, env);
				const arg = call.args[found.index];
				// A helper called without the path runs the child in the current directory.
				if (!arg || isCurrent(arg, call.at, env, seen)) return true;
			}
		}
		return false;
	}

	const literal = (t: Token[]) =>
		t.length === 1 && (t[0]!.kind === "str" || (t[0]!.kind === "tpl" && !t[0]!.exprs!.length)) ? t[0]!.text : null;

	const wordOf = (expr: Token[], at: number): Word => ({ lit: literal(expr), tokens: expr, at });

	/** The words of an argv expression: an array literal, an alias of one, or an array or rest parameter. */
	function wordsOf(expr: Token[], at: number, env: Env): Word[] {
		const element = (e: Token[], from: number) =>
			isP(e[0], "...") ? wordsOf(e.slice(1), from, env) : [wordOf(e, from)];
		if (isP(expr[0], "[")) return splitCommas(expr.slice(1, closer(expr, 0))).flatMap((e) => element(e, at));
		if (expr.length === 1 && expr[0]!.kind === "id") {
			const found = lookup(expr[0]!.text, at);
			if (found?.kind === "var") return wordsOf(found.variable.init, at, env);
			if (found?.kind === "param") {
				const call = boundArgs(found.fn, env);
				if (found.fn.params[found.index]!.rest)
					return call.args.slice(found.index).flatMap((arg) => element(arg, call.at));
				const arg = call.args[found.index];
				if (arg) return wordsOf(arg, call.at, env);
			}
		}
		return [wordOf(expr, at)];
	}

	/** Do these options leave the child in the current checkout? Options this lint cannot read count as no. */
	function optionsAreCurrent(options: Token[] | null, at: number, env: Env): boolean {
		if (!options) return true;
		if (!isP(options[0], "{")) return false;
		for (const field of splitCommas(options.slice(1, closer(options, 0)))) {
			if (field[0]?.text === "cwd") return isCurrent(isP(field[1], ":") ? field.slice(2) : field, at, env);
			if (isP(field[0], "...")) return false;
		}
		return true;
	}

	const READS = new Set(["diff", "log", "merge-base", "rev-list", "cherry"]);

	/** Walks git's own flags to the subcommand. Returns the read and where it runs, or null when it is not a read. */
	function readOf(words: Word[]): { read: string; target: Word | null } | null {
		let target: Word | null = null;
		for (let i = 0; i < words.length; i++) {
			const w = words[i]!;
			if (w.lit === "-C" || w.lit === "--git-dir") target = words[++i] ?? null;
			else if (w.lit === "-c") i++;
			else if (w.lit?.startsWith("--git-dir=")) target = w;
			else if (w.lit === null) return null;
			else if (!w.lit.startsWith("-")) {
				const rest = words.slice(i + 1);
				if (READS.has(w.lit)) return { read: `git ${w.lit}`, target };
				if (w.lit === "show" && rest.some((r) => !r.lit?.startsWith("-"))) return { read: "git show", target };
				return null;
			}
		}
		return null;
	}

	/** The git reads of one shell string, a `cd` before a read counting as its target. Only a literal or a template is read. */
	function shellReads(site: Extract<Site, { kind: "shell" }>) {
		const only = site.command.length === 1 ? site.command[0]! : null;
		if (only?.kind !== "str" && only?.kind !== "tpl") return [];
		const exprs = only.exprs ?? [];
		// A placeholder stands for each expression, so `git -C ${source} log` keeps its target.
		const text = (only.parts ?? [only.text])
			.map((part, i) => (i < exprs.length ? `${part}\u0001${i}\u0001` : part))
			.join("");
		const toWord = (raw: string): Word => {
			const clean = raw.replace(/^['"]|['"]$/g, "");
			const hole = /\u0001(\d+)\u0001/.exec(clean);
			return hole
				? { lit: null, tokens: exprs[Number(hole[1])]!, at: site.at }
				: { lit: clean, tokens: [], at: site.at };
		};
		const reads: Array<{ read: string; target: Word | null }> = [];
		let cd: Word | null = null;
		for (const command of text.split(/&&|\|\||[;|\n()]|\$\(/)) {
			const words = command.trim().split(/\s+/).filter(Boolean).map(toWord);
			if (words[0]?.lit === "cd" && words[1]) cd = words[1];
			if (words[0]?.lit !== "git") continue;
			const read = readOf(words.slice(1));
			if (read) reads.push({ read: read.read, target: read.target ?? cd });
		}
		return reads;
	}

	const sites: Site[] = [];
	const SPAWN = new Set(["spawnSync", "execFileSync", "spawn", "execFile", "run"]);
	const EXEC = new Set(["execSync", "exec"]);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t.kind !== "id" || !isP(tokens[i + 1], "(")) continue;
		const member = isP(tokens[i - 1], ".");
		const args = () => splitCommas(tokens.slice(i + 2, closer(tokens, i + 1)));
		if (SPAWN.has(t.text)) {
			const a = args(),
				program = a[0] ? literal(a[0]) : null;
			if (program === "git" && a[1]) sites.push({ kind: "git", at: i, args: a[1], options: a[2] ?? null });
			else if (program && /(^|\/)(sh|bash|zsh)$/.test(program) && a[1] && isP(a[1][0], "[")) {
				const [flag, command] = splitCommas(a[1].slice(1, -1));
				if (flag && command && literal(flag) === "-c")
					sites.push({ kind: "shell", at: i, command, options: a[2] ?? null });
			}
		} else if (EXEC.has(t.text) && !member) {
			const a = args();
			if (a[0]) sites.push({ kind: "shell", at: i, command: a[0], options: a[1] ?? null });
		} else if ((t.text === "git" || t.text === "gitOk") && !member && !lookup(t.text, i)) {
			// lib.ts's git(cwd, ...args) is `git -C cwd ...args`.
			const argv = [[synthetic("str", "-C")], ...args()].flatMap((w) => [...w, synthetic("punct", ",")]);
			sites.push({
				kind: "git",
				at: i,
				args: [synthetic("punct", "["), ...argv, synthetic("punct", "]")],
				options: null,
			});
		}
	}

	function testOf(at: number): string | null {
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i]!.text !== "test" || !isP(tokens[i + 1], "(") || isP(tokens[i - 1], ".")) continue;
			if (i + 1 < at && at < closer(tokens, i + 1)) return tokens[i + 2]?.text ?? "";
		}
		return null;
	}

	const refusals = new Map<string, Refusal>();
	function refuse(site: Site, env: Env, read: string) {
		// The refusal names the outermost call: a helper's caller, where the checkout goes in.
		let at = site.at;
		for (const call of env.values()) if (![...env.keys()].some((fn) => within(fn, call.at))) at = call.at;
		const r: Refusal = { file, line: tokens[at]!.line, test: testOf(at), read, readLine: tokens[site.at]!.line };
		refusals.set(`${r.line} ${r.read}`, r);
	}

	/** Decide one site under one set of helper calls. An unbound helper parameter raises NeedsCall. */
	function decide(site: Site, env: Env) {
		const reads = site.kind === "git" ? [readOf(wordsOf(site.args, site.at, env))] : shellReads(site);
		for (const r of reads) {
			if (!r) continue;
			const current = r.target
				? isCurrent(r.target.tokens, r.target.at, env)
				: optionsAreCurrent(site.options, site.at, env);
			if (current) refuse(site, env, r.read);
		}
	}

	function callsOf(fn: Fn): Call[] {
		const calls: Call[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i]!;
			if (t.kind !== "id" || t.text !== fn.name || !isP(tokens[i + 1], "(") || isP(tokens[i - 1], ".")) continue;
			if (tokens[i - 1]?.text === "function" || within(fn, i)) continue;
			const found = lookup(t.text, i);
			if (found?.kind === "fn" && found.fn === fn)
				calls.push({ args: splitCommas(tokens.slice(i + 2, closer(tokens, i + 1))), at: i });
		}
		return calls;
	}

	function expand(site: Site, env: Env) {
		try {
			decide(site, env);
		} catch (e) {
			if (!(e instanceof NeedsCall)) throw e;
			for (const call of callsOf(e.fn)) expand(site, new Map(env).set(e.fn, call));
		}
	}
	for (const site of sites) expand(site, new Map());
	return [...refusals.values()].sort((a, b) => a.line - b.line);
}

const synthetic = (kind: Token["kind"], text: string): Token => ({ kind, text, line: 0 });

export const describeRefusal = (r: Refusal) =>
	`${r.file}:${r.line}: ${r.test === null ? "code outside a test" : `test "${r.test}"`} reads the branch diff of the current checkout: ${r.read}${r.readLine === r.line ? "" : ` at line ${r.readLine}`}. Fix: read the diff in a repository the test builds itself (fixture(), a temporary git init, or --git-dir on a fixture remote). This checkout's diff changes with each branch, so the test would fail on branches that did not touch it.`;

/** Refuses a test under tools/evf/tests/ that reads the branch diff of the current checkout. */
export function checkBranchDiffTests(root: string): void {
	const files = globSync("tools/evf/tests/*.test.ts", { cwd: root }).sort();
	const refusals = files.flatMap((file) => lintBranchDiffSource(file, readFileSync(join(root, file), "utf8")));
	if (refusals.length)
		fail(`Tests that read this checkout's branch diff:\n${refusals.map(describeRefusal).join("\n")}`);
}
