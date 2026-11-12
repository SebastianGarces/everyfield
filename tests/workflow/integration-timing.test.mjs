// T-261: no real sleep, clock poll or wall-clock assertion under tests/integration (test-standard, "Pick the layer").
// T-249 removed them; this guard keeps them out. It matches shapes in the source, not data flow: a clock read that
// places seeded data passes, and so does any word in a comment or string, except pg_sleep, which lives in SQL strings.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const ROOT = "tests/integration";
const SOURCE = /\.(mts|mjs|ts|js)$/;

/**
 * The only real-time uses the test standard allows. Each is bound to its file and to the source lines it hits today,
 * so another sleep or clock read in the same file still fails. A new entry needs the owner's agreement.
 */
export const EXEMPT = {
	"tests/integration/identity/timing.production.mts": {
		why: "the production latency proof: its pg_sleep stall, performance.now timings and polling deadline are the measurement",
		hits: [
			[
				"pg_sleep",
				"querySql`CREATE FUNCTION slow_identity_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5);RETURN NEW;END $$`,",
			],
			["clock loop", 'for (const path of ["request-password-reset", "send-verification-email"]) {'],
			["clock loop", "for (let i = 0; i < 22; i++) {"],
			["performance.now", "const start = performance.now();"],
			["performance.now", "row[kind] = performance.now() - start;"],
			["performance.now", "const deadline = performance.now() + 15000;"],
			["clock loop", "while ((await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0].n === before) {"],
			[
				"performance.now",
				'assert.ok(performance.now() < deadline, "post-response proof mail must reach the real outbox");',
			],
			[
				"clock assertion",
				'assert.ok(performance.now() < deadline, "post-response proof mail must reach the real outbox");',
			],
			[
				"clock comparison",
				'assert.ok(performance.now() < deadline, "post-response proof mail must reach the real outbox");',
			],
			["timer", "await new Promise((r) => setTimeout(r, 50));"],
		],
	},
	"tests/integration/writes/counter.mjs": {
		why: "the census sample's ms field reports real time, which is its job; nothing asserts on it",
		hits: [
			["performance.now", "const started = performance.now();"],
			[
				"performance.now",
				'emit({ kind: "sample", ...counts, name: label, status, ms: Math.round(performance.now() - started) });',
			],
		],
	},
	"tests/integration/identity/invitations.test.mts": {
		why: "INV-expiry: only elapsed time shows the expiry check reads the clock after the root lock wait (D-704)",
		hits: [["timer", "await new Promise((resolve) => setTimeout(resolve, 3000));"]],
	},
};

const RULE_TEXT = {
	timer: "a setTimeout or setInterval call is a real delay or watchdog",
	sleep: "a sleep call waits on real time",
	pg_sleep: "pg_sleep stalls Postgres on real time",
	"performance.now": "performance.now reads the wall clock",
	"clock loop": "a loop that reads the clock polls real time",
	"clock assertion": "an assert reads the wall clock",
	"clock comparison": "a comparison against the wall clock is a deadline",
	"clock subtraction": "subtracting the wall clock measures elapsed real time",
};

/**
 * Two views of `source`, the same length with the same newlines: `code` blanks comments, strings, template text and
 * regex literals; `sql` blanks only comments.
 */
function lex(source) {
	const code = [...source];
	const sql = [...source];
	const n = source.length;
	const blankCode = (i) => source[i] !== "\n" && (code[i] = " ");
	const blankBoth = (i) => source[i] !== "\n" && (code[i] = sql[i] = " ");
	const templates = []; // brace depth inside each open `${`
	let prev = ""; // the last code token, to tell a regex literal from division
	let i = 0;
	// Template text from i up to its closing backtick or the next `${`.
	const templateText = () => {
		while (i < n) {
			if (source[i] === "\\") {
				blankCode(i++);
				blankCode(i++);
			} else if (source[i] === "`") {
				blankCode(i++);
				prev = "`";
				return;
			} else if (source[i] === "$" && source[i + 1] === "{") {
				blankCode(i++);
				blankCode(i++);
				templates.push(0);
				prev = "{";
				return;
			} else blankCode(i++);
		}
	};
	while (i < n) {
		const c = source[i];
		if (c === "/" && source[i + 1] === "/") {
			while (i < n && source[i] !== "\n") blankBoth(i++);
		} else if (c === "/" && source[i + 1] === "*") {
			const end = source.indexOf("*/", i + 2);
			for (const stop = end < 0 ? n : end + 2; i < stop;) blankBoth(i++);
		} else if (c === '"' || c === "'") {
			blankCode(i++);
			while (i < n && source[i] !== c && source[i] !== "\n") {
				if (source[i] === "\\") blankCode(i++);
				blankCode(i++);
			}
			blankCode(i++);
			prev = '"';
		} else if (c === "`") {
			blankCode(i++);
			templateText();
		} else if (c === "}" && templates.length && templates.at(-1) === 0) {
			templates.pop();
			blankCode(i++);
			templateText();
		} else if (
			c === "/" &&
			/^$|[(,=:[!&|?{};+\-*%<>~^]$|^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(prev)
		) {
			blankCode(i++);
			let inClass = false;
			while (i < n && source[i] !== "\n" && (inClass || source[i] !== "/")) {
				if (source[i] === "\\") blankCode(i++);
				else if (source[i] === "[") inClass = true;
				else if (source[i] === "]") inClass = false;
				blankCode(i++);
			}
			blankCode(i++);
			prev = "/re/";
		} else if (/[\w$]/.test(c)) {
			const word = /^[\w$]+/.exec(source.slice(i, i + 64))[0];
			prev = word;
			i += word.length;
		} else {
			if (templates.length && c === "{") templates[templates.length - 1]++;
			if (templates.length && c === "}") templates[templates.length - 1]--;
			if (!/\s/.test(c)) prev = c;
			i++;
		}
	}
	return { code: code.join(""), sql: sql.join("") };
}

/** The index just past the bracket that closes the one at `open` in `code`. */
function closing(code, open) {
	const pair = { "(": ")", "{": "}", "[": "]" };
	const stack = [];
	for (let i = open; i < code.length; i++) {
		if (pair[code[i]]) stack.push(pair[code[i]]);
		else if (code[i] === stack.at(-1) && (stack.pop(), stack.length === 0)) return i + 1;
	}
	return code.length;
}

const CLOCK = String.raw`(?:Date|performance)\.now\s*\(\s*\)`;
const CLOCK_READ = String.raw`(?:${CLOCK}|\bnew\s+Date\s*\(\s*\))(?:\.\w+\s*\(\s*\))?`;
const READS_CLOCK = new RegExp(CLOCK_READ);
const COMPARES_CLOCK = new RegExp(String.raw`(?<![=<>])[<>]=?\s*${CLOCK_READ}|${CLOCK_READ}\s*[<>](?![<>])`);
/** Whether a loop body checks the clock: compares a clock read, or reads it in an `if` test. */
function checksClock(body) {
	if (COMPARES_CLOCK.test(body)) return true;
	for (const match of body.matchAll(/\bif\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		if (READS_CLOCK.test(body.slice(open, closing(body, open)))) return true;
	}
	return false;
}
/** Whether a `for` head has a test (`init; test; update`) rather than iterating (`of`, `in`). */
function counting(head) {
	let depth = 0;
	for (const c of head) {
		if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === ";" && depth === 1) return true;
	}
	return false;
}
const PATTERNS = [
	["timer", /\b(?:setTimeout|setInterval)\s*\(/g, "code"],
	["sleep", /\bsleep\s*\(/g, "code"],
	["pg_sleep", /\bpg_sleep(?:_for|_until)?\s*\(/g, "sql"],
	["performance.now", /\bperformance\.now\s*\(/g, "code"],
	// `<`, `<=`, `>`, `>=` on either side of a clock read; `=>`, `<<` and `>>` are not comparisons.
	[
		"clock comparison",
		new RegExp(String.raw`(?<=(?<![=<>])[<>]=?\s*)${CLOCK}|${CLOCK}(?=\s*[<>](?![<>]))`, "g"),
		"code",
	],
	["clock subtraction", new RegExp(String.raw`(?<=[\w$)\]]\s*-\s*)${CLOCK}`, "g"), "code"],
];

/** Every real-time shape in one file's source, as `{ line, rule }` in source order. */
export function scan(source) {
	const views = lex(source);
	const { code } = views;
	const lineOf = (index) => source.slice(0, index).split("\n").length;
	const found = [];
	for (const [rule, pattern, view] of PATTERNS)
		for (const match of views[view].matchAll(pattern)) found.push({ at: match.index, rule });
	for (const match of code.matchAll(/\bassert(?:\.\w+)?\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		const args = code.slice(open, closing(code, open));
		for (const clock of args.matchAll(new RegExp(CLOCK, "g")))
			found.push({ at: open + clock.index, rule: "clock assertion" });
	}
	// A loop polls when its condition reads the clock or its body checks it. A body that only stamps rows with the
	// time it runs, such as `created_at: new Date()`, seeds data and passes.
	for (const match of code.matchAll(/\b(while|for)\s*\(|\bdo\s*\{/g)) {
		const open = match.index + match[0].length - 1;
		let head = "";
		let end = closing(code, open);
		if (code[open] === "(") {
			head = code.slice(open, end);
			if (match[1] === "for" && !counting(head)) head = "";
			const body = end + /^\s*/.exec(code.slice(end))[0].length;
			end = code[body] === "{" ? closing(code, body) : code.indexOf(";", body) + 1 || code.length;
		}
		const body = code.slice(open + head.length, end);
		if (READS_CLOCK.test(head) || checksClock(body)) found.push({ at: match.index, rule: "clock loop" });
	}
	return found
		.sort((a, b) => a.at - b.at || a.rule.localeCompare(b.rule))
		.map(({ at, rule }) => ({ line: lineOf(at), rule }));
}

/** The findings no exemption covers, and the exemptions no finding uses, across `files` (`{ path, source }`). */
export function check(files, exempt = EXEMPT) {
	const violations = [];
	const stale = [];
	for (const { path, source } of files) {
		const lines = source.split("\n");
		const unused = [...(exempt[path]?.hits ?? [])];
		for (const { line, rule } of scan(source)) {
			const text = lines[line - 1].trim();
			const k = unused.findIndex(([r, t]) => r === rule && t === text);
			if (k >= 0) unused.splice(k, 1);
			else violations.push(`${path}:${line} ${rule}: ${RULE_TEXT[rule]}`);
		}
		for (const [rule, text] of unused) stale.push(`${path}: no ${rule} hit at "${text}"`);
	}
	for (const path of Object.keys(exempt))
		if (!files.some((file) => file.path === path)) stale.push(`${path} is exempt but missing`);
	return { violations, stale };
}

function integrationFiles() {
	return readdirSync(join(repo, ROOT), { recursive: true })
		.filter((name) => SOURCE.test(name))
		.sort()
		.map((name) => {
			const path = relative(repo, join(repo, ROOT, name))
				.split("\\")
				.join("/");
			return { path, source: readFileSync(join(repo, path), "utf8") };
		});
}

test("T-261: no file under tests/integration sleeps, polls the clock or asserts on wall-clock time", () => {
	const files = integrationFiles();
	assert.ok(
		files.some((file) => file.path === "tests/integration/writes/counter.mjs"),
		"the scan reaches writes/*.mjs",
	);
	assert.ok(
		files.some((file) => file.path.endsWith("/support.mts")),
		"the scan reaches support modules",
	);
	const { violations, stale } = check(files);
	assert.deepEqual(violations, [], "replace each with a data control: set the row's time or wait with waitingOnLock");
	assert.deepEqual(stale, [], "an exemption whose hit is gone comes out of EXEMPT");
});

test("T-261: the scanner names each real wait and wall-clock assertion by line and rule", () => {
	const source = [
		/* 1 */ "await new Promise((r) => setTimeout(r, 100));",
		/* 2 */ "const watchdog = setInterval(() => controller.abort(), 5000);",
		/* 3 */ "await sleep(250);",
		/* 4 */ "await db.execute(sql`SELECT pg_sleep(0.2)`);",
		/* 5 */ "const started = performance.now();",
		/* 6 */ "while (Date.now() < deadline) await tick();",
		/* 7 */ "for (;;) {",
		/* 8 */ "  if (new Date() > until) break;",
		/* 9 */ "}",
		/* 10 */ "do { await tick(); } while (!done && clock());",
		/* 11 */ "assert.ok(expiresAt - Date.now() <= 300000);",
		/* 12 */ "const wait = retryAt - Date.now();",
		/* 13 */ "assert.equal(Math.round(Date.now() / 1000), stamp);",
		/* 14 */ "if (Date.now() >= cutoff) fail();",
		/* 15 */ "const late = 0 > performance.now();",
		/* 16 */ "do {",
		/* 17 */ "  attempts++;",
		/* 18 */ "} while (Date.now() - start < 1000);",
	].join("\n");
	assert.deepEqual(scan(source), [
		{ line: 1, rule: "timer" },
		{ line: 2, rule: "timer" },
		{ line: 3, rule: "sleep" },
		{ line: 4, rule: "pg_sleep" },
		{ line: 5, rule: "performance.now" },
		{ line: 6, rule: "clock loop" },
		{ line: 6, rule: "clock comparison" },
		{ line: 7, rule: "clock loop" },
		{ line: 11, rule: "clock assertion" },
		{ line: 11, rule: "clock comparison" },
		{ line: 11, rule: "clock subtraction" },
		{ line: 12, rule: "clock subtraction" },
		{ line: 13, rule: "clock assertion" },
		{ line: 14, rule: "clock comparison" },
		{ line: 15, rule: "clock comparison" },
		{ line: 15, rule: "performance.now" },
		{ line: 18, rule: "clock loop" },
	]);
	assert.deepEqual(check([{ path: "tests/integration/x.test.mts", source: "await sleep(1);" }]).violations, [
		"tests/integration/x.test.mts:1 sleep: a sleep call waits on real time",
	]);
});

test("T-261: seeded times, mock timers, waitingOnLock and words in comments or strings pass", () => {
	const source = [
		"const ahead = new Date(Date.now() + 3 * day).toISOString();",
		"const old = new Date(Date.now() - 31 * 86_400_000);",
		"const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);",
		"const now = () => new Date();",
		"for (const p of people) await insert({ ...p, created_at: at });",
		"for (const n of [101, 250]) await insert({ n, created_at: new Date() });",
		'for (const [type, day] of [["a", 2]]) await meeting(type, new Date(Date.now() + day * 86_400_000));',
		"for (const [table, patch] of [[t.team, { archived_at: new Date() }]]) await update(table, patch);",
		'mock.timers.enable({ apis: ["setTimeout"] });',
		'mock.timers.enable({ apis: ["Date"], now: Date.now() + 86_400_000 });',
		"mock.timers.tick(3500);",
		"assert.equal(await waitingOnLock(f.admin, { blockedBy: pid }), true);",
		"// no setTimeout(r, 50), sleep(1), pg_sleep(1) or while (Date.now() < deadline) here",
		"/* assert.ok(expiresAt - Date.now() <= 300000) */",
		'assert.ok(ok, "never setTimeout( or sleep( or performance.now() < x");',
		"const note = `retryAt - Date.now() and sleep(1) are words here`;",
		"const re = /sleep\\(|setTimeout\\(/g;",
		"const half = total / 2, slept = `${(Date.now() - 0) && name}`;",
	].join("\n");
	assert.deepEqual(scan(source), []);
	// A template expression is code, not string text.
	assert.deepEqual(scan("const t = `${retryAt - Date.now()}`;"), [{ line: 1, rule: "clock subtraction" }]);
});

test("T-261: an exempt file holds only the hits it has today", () => {
	const real = (path) => ({ path, source: readFileSync(join(repo, path), "utf8") });
	const invitations = real("tests/integration/identity/invitations.test.mts");
	const counter = real("tests/integration/writes/counter.mjs");
	const before = invitations.source.split("\n").length;
	const { violations, stale } = check([
		{ ...invitations, source: invitations.source + "\nawait new Promise((resolve) => setTimeout(resolve, 3000));\n" },
		{ ...counter, source: counter.source + "\nassert.ok(performance.now() - started < 50);\n" },
		real("tests/integration/identity/timing.production.mts"),
	]);
	const counterLine = counter.source.split("\n").length + 1;
	assert.deepEqual(violations, [
		`tests/integration/identity/invitations.test.mts:${before + 1} timer: ${RULE_TEXT.timer}`,
		`tests/integration/writes/counter.mjs:${counterLine} clock assertion: ${RULE_TEXT["clock assertion"]}`,
		`tests/integration/writes/counter.mjs:${counterLine} performance.now: ${RULE_TEXT["performance.now"]}`,
	]);
	assert.deepEqual(stale, []);
});
