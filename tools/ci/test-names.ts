import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * `node tools/ci/test-names.ts`: test, subtest and describe names say which behavior they prove, not which plan
 * item asked for them (T-215). A name outside `tests/workflow/` that cites `WP-<n>`, `T-<n>`, `RT-<n>`, `D-<n>` or
 * the hyphenless `T<n>-<n>` fails. `tests/workflow/` tests the tooling, so its names may cite tooling ids.
 * Comments and other strings are left alone: a small lexer finds only the first string argument of a test call.
 */

export type Finding = { file: string; line: number; id: string; name: string };

/** Plan ids: not part of a longer word or dashed id, so catalog ids such as `AC:TARGET-PPL-016` pass. */
const PLAN_ID = /(?<![\w-])(?:(?:WP|RT|T|D)-\d+|T\d+-\d+)(?![\w])/g;
/** Calls that name a test: `test(`, `it(`, `describe(`, `suite(`, `t.test(`, `test.skip(`, `describe.only(` ... */
const TEST_CALL = new Set(["test", "it", "describe", "suite"]);
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec|db)\.[cm]?[jt]sx?$/;

/** Whether a tracked file holds tests this lint reads. */
export function isLinted(file: string): boolean {
	if (file.startsWith("tests/workflow/") || !SOURCE.test(file)) return false;
	return TEST_FILE.test(file) || file.startsWith("tests/");
}

/** The plan ids in one file's test names. */
export function findPlanIds(file: string, source: string): Finding[] {
	const findings: Finding[] = [];
	for (const { line, name } of testNames(source)) {
		for (const match of name.matchAll(PLAN_ID)) findings.push({ file, line, id: match[0], name });
	}
	return findings;
}

/** The first string argument of each test call, with its line. */
export function testNames(source: string): Array<{ line: number; name: string }> {
	const names: Array<{ line: number; name: string }> = [];
	const n = source.length;
	let i = 0;
	// What the last significant token was, to tell a regex literal from division.
	let prev: "value" | "operator" = "operator";
	// The dotted identifier chain just read, such as ["t", "test"], waiting for its `(`.
	let chain: string[] = [];
	let afterDot = false;
	// Set after `<test call>(`: the next token, if a string, is the name.
	let expectName = false;
	const lineAt = (at: number) => source.slice(0, at).split("\n").length;

	const skipString = (from: number, quote: string): number => {
		let j = from + 1;
		while (j < n && source[j] !== quote) {
			if (source[j] === "\\") j++;
			else if (source[j] === "\n") break;
			j++;
		}
		return j + 1;
	};
	// A template literal, with nested `${ ... }` holding code that may itself hold strings and templates.
	const skipTemplate = (from: number): number => {
		let j = from + 1;
		while (j < n && source[j] !== "`") {
			if (source[j] === "\\") j += 2;
			else if (source[j] === "$" && source[j + 1] === "{") j = skipCode(j + 2, "}");
			else j++;
		}
		return j + 1;
	};
	const skipCode = (from: number, close: string): number => {
		let depth = 0,
			j = from;
		while (j < n) {
			const c = source[j];
			if (c === "'" || c === '"') {
				j = skipString(j, c);
			} else if (c === "`") j = skipTemplate(j);
			else if (c === "/" && source[j + 1] === "/") j = source.indexOf("\n", j) < 0 ? n : source.indexOf("\n", j);
			else if (c === "/" && source[j + 1] === "*") j = source.indexOf("*/", j) < 0 ? n : source.indexOf("*/", j) + 2;
			else {
				if (c === "{") depth++;
				else if (c === close && depth-- === 0) return j + 1;
				j++;
			}
		}
		return j;
	};

	while (i < n) {
		const c = source[i] ?? "";
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "/" && source[i + 1] === "/") {
			const end = source.indexOf("\n", i);
			i = end < 0 ? n : end;
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end < 0 ? n : end + 2;
			continue;
		}
		const nameExpected = expectName;
		expectName = false;
		if (c === "'" || c === '"' || c === "`") {
			const end = c === "`" ? skipTemplate(i) : skipString(i, c);
			if (nameExpected) names.push({ line: lineAt(i), name: source.slice(i + 1, end - 1) });
			i = end;
			prev = "value";
			chain = [];
			continue;
		}
		if (c === "/" && prev === "operator") {
			// A regex literal: skip to its closing slash outside a character class, then its flags.
			let j = i + 1,
				inClass = false;
			while (j < n && source[j] !== "\n") {
				const r = source[j];
				if (r === "\\") j++;
				else if (r === "[") inClass = true;
				else if (r === "]") inClass = false;
				else if (r === "/" && !inClass) break;
				j++;
			}
			i = j + 1;
			while (i < n && /\w/.test(source[i] ?? "")) i++;
			prev = "value";
			chain = [];
			continue;
		}
		if (/[A-Za-z_$]/.test(c)) {
			let j = i + 1;
			while (j < n && /[\w$]/.test(source[j] ?? "")) j++;
			const word = source.slice(i, j);
			chain = afterDot ? [...chain, word] : [word];
			afterDot = false;
			i = j;
			// After keywords such as `return` or `typeof`, a slash starts a regex.
			prev = /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(word)
				? "operator"
				: "value";
			continue;
		}
		if (/\d/.test(c)) {
			let j = i + 1;
			while (j < n && /[\w.]/.test(source[j] ?? "")) j++;
			i = j;
			prev = "value";
			chain = [];
			continue;
		}
		if (c === "." && chain.length && !afterDot) {
			afterDot = true;
			i++;
			continue;
		}
		if (c === "(") {
			const first = chain[0],
				last = chain[chain.length - 1];
			expectName = chain.length > 0 && (TEST_CALL.has(first ?? "") || TEST_CALL.has(last ?? ""));
		}
		chain = [];
		afterDot = false;
		prev = c === ")" || c === "]" || c === "}" ? "value" : "operator";
		i++;
	}
	return names;
}

/** Scan the git-tracked test files under `root`. */
export function lintTestNames(root: string): Finding[] {
	const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
		.split("\0")
		.filter((file) => file && isLinted(file));
	return files.flatMap((file) => findPlanIds(file, readFileSync(`${root}/${file}`, "utf8")));
}

if (import.meta.main) {
	const findings = lintTestNames(process.cwd());
	for (const f of findings)
		console.error(`${f.file}:${f.line}: test name cites ${f.id}: name the behavior, not the plan item.`);
	if (findings.length) {
		console.error(`test-names: ${findings.length} plan id(s) in test names outside tests/workflow/.`);
		process.exit(1);
	}
	console.log("test-names: no plan ids in test names outside tests/workflow/.");
}
