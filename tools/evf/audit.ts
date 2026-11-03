import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { caseGrep } from "./coverage.ts";
import { ensureTask, openWorkDb, record } from "./db.ts";
import { nextId } from "./ids.ts";
import {
	baseRef,
	command,
	EvfError,
	evfDataDir,
	fail,
	git,
	gitOk,
	hasRemote,
	loadContexts,
	loadConfig,
	parseTask,
	run,
	type Config,
	type TaskRef,
} from "./lib.ts";
import { awaitLoad } from "./load.ts";
import { doneCriteria } from "./spec.ts";

/**
 * `evf audit` (OPS-116): a check of the answer key itself. It plants one realistic bug from the lines a merged task
 * changed, in a detached throwaway worktree of current main, and runs the tests that carry the task's `AC:` markers
 * plus tests/ui/escaped/. The four outcomes: killed (a test failed on the mutant), survived (none did; files one OPS
 * task), invalid (the mutant did not build or start) and baseline-red (a test failed before the mutation). The run
 * costs no model tokens, pushes nothing and leaves no branch, worktree or preview behind.
 */

export type Operator = "off-by-one" | "dropped-call" | "removed-route";
export type Candidate = {
	id: string;
	operator: Operator;
	file: string;
	line: number;
	/** The line on main; for removed-route the whole file text. */
	before: string;
	/** The mutated line; null when the line or file is removed. */
	after: string | null;
};
export type Outcome = "killed" | "survived" | "invalid" | "baseline-red";
export type FileResult = "passed" | "failed" | "invalid";
export type TestRow = { file: string; main: FileResult; mutant: FileResult | null };
export type AuditTarget = {
	ref: string;
	mergeCommits: string[];
	mergedAt: string;
	markers: string[];
	marked: string[];
	escaped: string[];
	candidates: Candidate[];
};

const SOURCE = /^(?:apps|packages)\/.+\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures?|node_modules)\/|\.(?:test|spec)\.[^/]+$|\.d\.ts$/;
const ROUTE = /^apps\/web\/(?:src\/)?app\/(?:.+\/)?(?:page\.tsx|route\.ts)$/;
const TEST_FILE = /\.test\.(?:[cm]?[jt]s|tsx)$/;
const ESCAPED = "tests/ui/escaped/";
const KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"return",
	"throw",
	"super",
	"import",
	"export",
	"typeof",
	"new",
	"delete",
	"yield",
	"case",
	"catch",
	"function",
]);
const DAY = 86_400_000;
export const AUDIT_WINDOW_DAYS = 30;
export const AUDIT_REMINDER_DAYS = 31;
const TREE_PREFIX = "evf-audit-";

/** True for each character of `line` that is code: not inside a string literal or a comment. */
function codeMask(line: string): boolean[] {
	const mask: boolean[] = [];
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote) {
			mask.push(false);
			if (ch === "\\") {
				mask.push(false);
				i++;
			} else if (ch === quote) quote = null;
		} else if (ch === "/" && line[i + 1] === "/") {
			while (mask.length < line.length) mask.push(false);
			break;
		} else if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			mask.push(false);
		} else mask.push(true);
	}
	return mask;
}

const isCode = (mask: boolean[], from: number, to: number) => mask.slice(from, to).every(Boolean);
const replaceAt = (s: string, at: number, len: number, by: string) => s.slice(0, at) + by + s.slice(at + len);
const SWAP: Record<string, string> = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" };

/** The off-by-one mutants of one line: swap < and <=, > and >=, or move an integer literal of a comparison or slice bound by 1. */
export function offByOne(line: string): string[] {
	const mask = codeMask(line),
		out = new Set<string>();
	const bump = (at: number, digits: string) => {
		if (!isCode(mask, at, at + digits.length)) return;
		for (const d of [1, -1]) out.add(replaceAt(line, at, digits.length, String(Number(digits) + d)));
	};
	for (const m of line.matchAll(/ (<=|>=|===|!==|==|!=|<|>) /g)) {
		const op = m[1]!,
			at = m.index! + 1;
		if (!isCode(mask, at, at + op.length)) continue;
		if (SWAP[op]) out.add(replaceAt(line, at, op.length, SWAP[op]));
		const right = /^-?\d+(?![\w.])/.exec(line.slice(at + op.length + 1));
		if (right) bump(at + op.length + 1, right[0]);
		const left = /(?<![\w.$])-?\d+$/.exec(line.slice(0, m.index!));
		if (left) bump(left.index, left[0]);
	}
	for (const m of line.matchAll(/\.(?:slice|substring)\(([^()]*)\)/g)) {
		let at = m.index! + m[0].indexOf("(") + 1;
		for (const arg of m[1]!.split(",")) {
			const lit = /^(\s*)(-?\d+)\s*$/.exec(arg);
			if (lit) bump(at + lit[1]!.length, lit[2]!);
			at += arg.length + 1;
		}
	}
	out.delete(line);
	return [...out];
}

const CALL = /^(?:await |void )?([A-Za-z_$][\w$]*)(?:\??\.#?[A-Za-z_$][\w$]*)*(?:\?\.)?\(.*\);$/;

/** True when `line` is one whole call statement, such as `setOpen(false);`, that follows a finished statement. */
export function isCallStatement(line: string, previous: string | undefined): boolean {
	const text = line.trim(),
		m = CALL.exec(text);
	if (!m || KEYWORDS.has(m[1]!)) return false;
	const mask = codeMask(text);
	// The parentheses opened by the call close only at the end: `a(b) || c(d);` is not one call.
	let depth = 0,
		opened = false;
	for (let i = 0; i < text.length - 1; i++) {
		if (!mask[i]) continue;
		if (text[i] === "(") (depth++, (opened = true));
		else if (text[i] === ")") {
			depth--;
			if (depth === 0 && i !== text.length - 2 && text[i + 1] !== "(") return false;
		}
	}
	if (!opened || depth !== 0) return false;
	const prev = previous?.trim();
	return !prev || /[;{}:]$/.test(prev) || prev.startsWith("//") || prev.endsWith("*/");
}

const isComment = (text: string) => /^(?:\/\/|\/\*|\*)/.test(text);

/** A stable id: it names the operator, the file, the main line text and the mutant, never a line number. */
function candidateId(operator: Operator, file: string, occurrence: number, before: string, after: string | null) {
	const prefix = operator === "off-by-one" ? "obo" : operator === "dropped-call" ? "drop" : "route";
	const hash = createHash("sha256")
		.update([operator, file, occurrence, before, after ?? "\0"].join("\n"))
		.digest("hex");
	return `${prefix}-${hash.slice(0, 8)}`;
}

/**
 * The candidates of one file on main. `owned` holds the 1-based main line numbers that the audited merge added or
 * changed (git blame); `route` is true when the merge added or changed this file and it is a page or route.
 */
export function fileCandidates(file: string, text: string, owned: Set<number>, route: boolean): Candidate[] {
	const out: Candidate[] = [];
	if (route)
		out.push({
			id: candidateId("removed-route", file, 0, file, null),
			operator: "removed-route",
			file,
			line: 1,
			before: text,
			after: null,
		});
	const lines = text.split("\n"),
		seen = new Map<string, number>();
	lines.forEach((line, i) => {
		const occurrence = seen.get(line) ?? 0;
		seen.set(line, occurrence + 1);
		const trimmed = line.trim();
		if (!owned.has(i + 1) || !trimmed || isComment(trimmed)) return;
		const add = (operator: Operator, after: string | null) =>
			out.push({
				id: candidateId(operator, file, occurrence, line, after),
				operator,
				file,
				line: i + 1,
				before: line,
				after,
			});
		for (const after of offByOne(line)) add("off-by-one", after);
		const previous = lines
			.slice(0, i)
			.reverse()
			.find((l) => l.trim());
		if (isCallStatement(line, previous)) add("dropped-call", null);
	});
	return out;
}

/** One line for `--list`: what the mutant changes. */
export function oneLineDiff(c: Candidate): string {
	if (c.operator === "removed-route") return "(file removed)";
	return `${c.before.trim()} → ${c.after === null ? "(line removed)" : c.after.trim()}`;
}

/** The mutation as a unified diff, word for word. */
export function mutationDiff(c: Candidate): string {
	if (c.operator === "removed-route") {
		const lines = c.before.endsWith("\n") ? c.before.slice(0, -1).split("\n") : c.before.split("\n");
		const range = lines.length === 1 ? "1" : `1,${lines.length}`;
		return [`--- a/${c.file}`, "+++ /dev/null", `@@ -${range} +0,0 @@`, ...lines.map((l) => `-${l}`)].join("\n");
	}
	return c.after === null
		? [`--- a/${c.file}`, `+++ b/${c.file}`, `@@ -${c.line} +${c.line - 1},0 @@`, `-${c.before}`].join("\n")
		: [`--- a/${c.file}`, `+++ b/${c.file}`, `@@ -${c.line} +${c.line} @@`, `-${c.before}`, `+${c.after}`].join("\n");
}

/** A small seeded generator (mulberry32): the same seed picks the same candidate. */
export function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function pickCandidate(candidates: Candidate[], seed: number): Candidate {
	return candidates[Math.floor(seeded(seed)() * candidates.length)]!;
}

// ---- Git reads on main ---------------------------------------------------------------------------------------------

const show = (root: string, rev: string, path: string) => {
	const r = run("git", ["show", `${rev}:${path}`], { cwd: root });
	return r.code === 0 ? r.stdout : null;
};

/** The commits a merge brought to main: the commit itself for a squash, or every commit of a merged branch. */
function commitsOf(root: string, merge: string): string[] {
	const parents = git(root, "rev-list", "--parents", "-n", "1", merge).split(" ").slice(1);
	if (!parents.length) fail(`${merge} has no parent; the audit needs a merge on main.`);
	return parents.length > 1 ? git(root, "rev-list", `${merge}^1..${merge}`).split("\n").filter(Boolean) : [merge];
}

/** The 1-based line numbers of `file` on main that one of `commits` last changed. */
function blamedLines(root: string, main: string, file: string, commits: Set<string>): Set<number> {
	const out = new Set<number>();
	const r = run("git", ["blame", "--porcelain", main, "--", file], { cwd: root });
	if (r.code !== 0) return out;
	for (const line of r.stdout.split("\n")) {
		const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
		if (head && commits.has(head[1]!)) out.add(Number(head[2]));
	}
	return out;
}

/** The candidates of the merges on current main: only lines they changed that main still holds. */
export function candidatesOf(root: string, main: string, merges: string[]): Candidate[] {
	const commits = new Set(merges.flatMap((m) => commitsOf(root, m)));
	const files = new Set<string>();
	for (const merge of merges)
		for (const f of git(root, "diff", "--no-renames", "--name-only", `${merge}^1`, merge, "--", "apps", "packages")
			.split("\n")
			.filter(Boolean))
			if (SOURCE.test(f) && !TEST_PATH.test(f)) files.add(f);
	const out: Candidate[] = [];
	for (const file of [...files].sort()) {
		const text = show(root, main, file);
		if (text === null) continue;
		const owned = blamedLines(root, main, file, commits);
		if (!owned.size) continue;
		out.push(...fileCandidates(file, text, owned, ROUTE.test(file)));
	}
	return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
}

/** Test files on main that carry one of the markers as `AC:<marker>`. */
export function markedTests(root: string, main: string, markers: string[]): string[] {
	if (!markers.length) return [];
	const args = [
		"grep",
		"-l",
		"-F",
		...markers.flatMap((m) => ["-e", `AC:${m}`]),
		main,
		"--",
		"tests",
		"apps",
		"packages",
	];
	const r = run("git", args, { cwd: root });
	if (r.code > 1) fail(`git grep failed: ${r.stderr.trim()}`);
	const grep = new RegExp(caseGrep(markers));
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((l) => l.slice(main.length + 1))
		.filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/") && !/\.production\./.test(f))
		.filter((f) => grep.test(show(root, main, f) ?? ""))
		.sort();
}

export function escapedTests(root: string, main: string): string[] {
	return git(root, "ls-tree", "-r", "--name-only", main, "--", ESCAPED)
		.split("\n")
		.filter((f) => f.startsWith(ESCAPED) && f.endsWith(".test.mjs"))
		.sort();
}

// ---- Merged tasks and their markers --------------------------------------------------------------------------------

type MergedRow = { ref: string; merge_commit: string; spec: string | null };

/** The markers of a task: its package case IDs for a WP task and AC:<task>-<n> for each Done criterion of a spec. */
export function markersOf(
	root: string,
	task: TaskRef,
	specs: Array<string | null>,
	cases?: () => Map<string, string[]>,
) {
	const out = new Set<string>();
	if (task.kind === "wp") for (const id of (cases ?? (() => packageCases(root)))().get(task.wp) ?? []) out.add(id);
	const prefix = task.id.replace("/", "-");
	for (const spec of specs) for (const n of doneCriteria(spec)) out.add(`${prefix}-${n}`);
	return [...out].sort();
}

function packageCases(root: string): Map<string, string[]> {
	return new Map(loadContexts(root).map((c) => [c.id, c.case_ids]));
}

function mergedRows(db: DatabaseSync): MergedRow[] {
	return db
		.prepare(
			"SELECT ref, merge_commit, spec FROM tasks WHERE status = 'merged' AND merge_commit IS NOT NULL AND ref IS NOT NULL ORDER BY id",
		)
		.all() as MergedRow[];
}

/** The audit target for one ref, or the reason it cannot be audited. */
export function targetOf(
	root: string,
	db: DatabaseSync,
	main: string,
	ref: string,
	cases?: () => Map<string, string[]>,
): AuditTarget | string {
	const task = parseTask(ref);
	const rows = mergedRows(db).filter(
		(r) =>
			r.ref === task.id &&
			gitOk(root, "cat-file", "-e", `${r.merge_commit}^{commit}`) &&
			gitOk(root, "merge-base", "--is-ancestor", r.merge_commit, main),
	);
	if (!rows.length) return `${task.id} is not merged: the work store has no merged row whose merge commit is on main.`;
	const markers = markersOf(
		root,
		task,
		rows.map((r) => r.spec),
		cases,
	);
	const marked = markedTests(root, main, markers);
	if (!marked.length)
		return `${task.id} has no marked test: no test on main carries AC:<marker> for any of its ${markers.length} markers.`;
	const mergeCommits = rows.map((r) => r.merge_commit);
	const mergedAt = mergeCommits
		.map((c) => new Date(git(root, "show", "-s", "--format=%cI", c)).toISOString())
		.sort()
		.at(-1)!;
	return {
		ref: task.id,
		mergeCommits,
		mergedAt,
		markers,
		marked,
		escaped: escapedTests(root, main),
		candidates: candidatesOf(root, main, mergeCommits),
	};
}

/** The time of a ref's last finished audit, or null when it was never audited. */
function lastAudit(db: DatabaseSync, ref: string): string | null {
	return (
		(
			db.prepare("SELECT MAX(ended_at) AS at FROM audit_runs WHERE task_ref = ? AND ended_at IS NOT NULL").get(ref) as {
				at: string | null;
			}
		).at ?? null
	);
}

/**
 * The task for an audit with no --task: merged in the last 30 days, with a marked test and a candidate. Never-audited
 * tasks come first, then the oldest last audit; ties go to the oldest merge, which leaves the window first.
 */
export function pickTarget(root: string, db: DatabaseSync, main: string, now: Date): AuditTarget {
	const since = now.getTime() - AUDIT_WINDOW_DAYS * DAY;
	let contexts: Map<string, string[]> | undefined;
	const cases = () => (contexts ??= packageCases(root));
	// Only refs with a merge on main inside the window are read further: blame and grep cost time per task.
	const recent = (r: MergedRow) =>
		gitOk(root, "cat-file", "-e", `${r.merge_commit}^{commit}`) &&
		Date.parse(git(root, "show", "-s", "--format=%cI", r.merge_commit)) >= since;
	const refs = [
		...new Set(
			mergedRows(db)
				.filter(recent)
				.map((r) => r.ref),
		),
	];
	const eligible: Array<{ target: AuditTarget; last: string | null }> = [];
	for (const ref of refs) {
		let target: AuditTarget | string;
		try {
			target = targetOf(root, db, main, ref, cases);
		} catch (e) {
			if (e instanceof EvfError) continue; // A ref evf cannot parse or read is not auditable.
			throw e;
		}
		if (typeof target === "string" || !target.candidates.length || Date.parse(target.mergedAt) < since) continue;
		eligible.push({ target, last: lastAudit(db, target.ref) });
	}
	eligible.sort(
		(a, b) =>
			(a.last === null ? 0 : 1) - (b.last === null ? 0 : 1) ||
			(a.last ?? "").localeCompare(b.last ?? "") ||
			a.target.mergedAt.localeCompare(b.target.mergedAt) ||
			a.target.ref.localeCompare(b.target.ref),
	);
	if (!eligible.length)
		fail(`No task merged in the last ${AUDIT_WINDOW_DAYS} days has a marked test and a mutation candidate.`);
	return eligible[0]!.target;
}

// ---- The ask a survived mutant files -------------------------------------------------------------------------------

export function surviveTitle(ref: string, c: Candidate): string {
	return `Answer key for ${ref} missed ${c.operator} in ${c.file}:${c.line}`;
}

export function renderAsk(
	target: Pick<AuditTarget, "ref" | "mergeCommits">,
	main: string,
	c: Candidate,
	seed: number,
	tests: TestRow[],
): string {
	return [
		`# Ask: ${surviveTitle(target.ref, c)}`,
		"",
		`Filed by \`evf audit\` (OPS-116). One planted bug survived every marked test of ${target.ref}.`,
		"",
		`- Audited task: ${target.ref} (merge commit ${target.mergeCommits.join(", ")})`,
		`- Main SHA: ${main}`,
		`- Candidate: ${c.id} (${c.operator}, seed ${seed})`,
		`- Repeat: \`bin/evf audit --task ${target.ref} --mutation ${c.id} --seed ${seed} --dry-run\``,
		"",
		"## Mutation diff",
		"",
		"```diff",
		mutationDiff(c),
		"```",
		"",
		"## Tests that ran",
		"",
		...tests.map((t) => `- ${t.file}: main ${t.main}, mutant ${t.mutant ?? "not run"}`),
		"",
		"## Done template",
		"",
		`1. A test that carries one of ${target.ref}'s markers (\`AC:<marker>\`) fails on this mutant and passes on main.`,
		`   Check: \`bin/evf audit --task ${target.ref} --mutation ${c.id}\` reports \`killed\`.`,
		"",
	].join("\n");
}

/** The evf.config.json maintenanceTasks entry the coordinator commits on the new task's branch. */
export function maintenanceEntry(id: string, title: string): string {
	const entry = {
		[id]: {
			title,
			owningPaths: ["tests/"],
			checks: [
				{ name: "documentation", run: ["python3", "docs/check-all.py"] },
				{ name: "package-unit-tests", run: ["corepack", "pnpm", "-r", "--if-present", "test:unit"] },
			],
			risk: "ordinary",
		},
	};
	return JSON.stringify(entry, null, 2).slice(2, -2);
}

// ---- Processes, the throwaway tree and its preview -----------------------------------------------------------------

type Exec = { code: number; out: string };
const live = new Set<ChildProcess>();
let stopping = false;
class Stopped extends Error {}

/** One child in its own process group, so a stop reaches everything it started. */
function exec(argv: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<Exec> {
	if (stopping) throw new Stopped();
	return new Promise((resolve) => {
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		live.add(child);
		let out = "";
		child.stdout!.on("data", (d) => (out += d));
		child.stderr!.on("data", (d) => (out += d));
		const timer = opts.timeoutMs ? setTimeout(() => killGroup(child, "SIGKILL"), opts.timeoutMs) : undefined;
		child.on("error", (e) => (out += String(e)));
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			live.delete(child);
			resolve({ code: code ?? (signal ? 128 : 1), out });
		});
	});
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
	try {
		if (child.pid) process.kill(-child.pid, sig);
	} catch {
		// already gone
	}
}

const activePath = (root: string) => join(evfDataDir(root), "audit", "active.json");
type Active = { pid: number; tree: string; runtime: string; startedAt: string };

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readActive(root: string): Active | null {
	try {
		return JSON.parse(readFileSync(activePath(root), "utf8")) as Active;
	} catch {
		return null;
	}
}

/** The audit worktrees `git worktree list` holds: their folder names start with evf-audit-. */
export function auditWorktrees(root: string): string[] {
	return git(root, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length))
		.filter((p) => basename(p).startsWith(TREE_PREFIX));
}

function stackEnvOf(tree: string, runtime: string): NodeJS.ProcessEnv {
	return { ...process.env, EVF_WORKTREE: tree, EVF_RUNTIME_DIR: runtime };
}

function previewDownSync(cfg: Config, tree: string, runtime: string): void {
	if (!cfg.stack?.down || !existsSync(join(runtime, "stack.json"))) return;
	const argv = command(cfg.stack.down);
	run(argv[0]!, argv.slice(1), { cwd: existsSync(tree) ? tree : runtime, env: stackEnvOf(tree, runtime) });
	rmSync(join(runtime, "stack.json"), { force: true });
}

function removeTree(root: string, cfg: Config, tree: string, runtime: string): void {
	previewDownSync(cfg, tree, runtime);
	run("git", ["worktree", "remove", "--force", "--force", tree], { cwd: root });
	rmSync(tree, { recursive: true, force: true });
	rmSync(runtime, { recursive: true, force: true });
	run("git", ["worktree", "prune"], { cwd: root });
}

/**
 * Remove what a crashed audit left: its worktree, its preview and its lock. A live audit holds the lock, and a
 * second audit refuses to start beside it.
 */
export function recoverAudits(root: string, cfg: Config): string[] {
	const active = readActive(root);
	if (active && active.pid !== process.pid && alive(active.pid))
		fail(`Another evf audit (PID ${active.pid}) is running on ${active.tree}. Wait for it to end.`);
	const removed: string[] = [];
	const trees = new Set(auditWorktrees(root));
	if (active) trees.add(active.tree);
	for (const tree of trees) {
		const runtime = active && active.tree === tree ? active.runtime : join(evfDataDir(root), "audit", basename(tree));
		removeTree(root, cfg, tree, runtime);
		removed.push(tree);
	}
	rmSync(activePath(root), { force: true });
	return removed;
}

/** Doctor lines about audits: a leftover audit worktree, and the monthly reminder. Nothing when all is well. */
export function auditDoctorLines(root: string, db: DatabaseSync | null, now = new Date()): string[] {
	const lines: string[] = [];
	const active = readActive(root);
	for (const tree of auditWorktrees(root))
		lines.push(
			active?.tree === tree && alive(active.pid)
				? `audit worktree ${tree} belongs to the running evf audit (PID ${active.pid})`
				: `audit worktree ${tree} is left from a stopped evf audit; the next evf audit removes it`,
		);
	const hasTable =
		db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_runs'").get() !== undefined;
	const last = hasTable
		? (
				db!.prepare("SELECT MAX(ended_at) AS at FROM audit_runs WHERE outcome IN ('killed', 'survived')").get() as {
					at: string | null;
				}
			).at
		: null;
	if (!last || Date.parse(last) < now.getTime() - AUDIT_REMINDER_DAYS * DAY)
		lines.push(`no evf audit killed or survived a mutant in the last ${AUDIT_REMINDER_DAYS} days; run: bin/evf audit`);
	return lines;
}

/** Plant one mutation in the tree and commit it on the detached HEAD, so a preview builds that exact tree. */
function plant(tree: string, c: Candidate): void {
	const path = join(tree, c.file);
	if (c.operator === "removed-route") rmSync(path);
	else {
		const lines = readFileSync(path, "utf8").split("\n");
		if (lines[c.line - 1] !== c.before) fail(`${c.file}:${c.line} on main is not the candidate line.`);
		if (c.after === null) lines.splice(c.line - 1, 1);
		else lines[c.line - 1] = c.after;
		writeFileSync(path, lines.join("\n"));
	}
	git(
		tree,
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"user.name=evf audit",
		"-c",
		"user.email=evf-audit@localhost",
		"commit",
		"-q",
		"--no-verify",
		"-am",
		`evf audit mutant ${c.id}`,
	);
}

/** A file that fails to load, not an assertion, marks a mutant that does not build. */
const LOAD_ERROR =
	/^# (?:SyntaxError|.*\[ERR_MODULE_NOT_FOUND\]|.*does not provide an export named|.*ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|.*ERR_INVALID_TYPESCRIPT_SYNTAX)/m;
export function fileResult(code: number, tap: string): FileResult {
	if (code === 0) return "passed";
	return LOAD_ERROR.test(tap) && /^# pass 0$/m.test(tap) ? "invalid" : "failed";
}

const usesBrowser = (root: string, main: string, file: string) =>
	file.startsWith("tests/ui/") && /setup\.mjs|UI_BASE_URL/.test(show(root, main, file) ?? "");

type Tree = { path: string; runtime: string };

/**
 * The tsx CLI a workspace package installed, as the package test scripts run TypeScript tests: Node's own type
 * stripping refuses syntax such as parameter properties. A tree without tsx runs TypeScript on plain Node.
 */
function tsxCli(tree: string): string | undefined {
	const packages = join(tree, "packages");
	return ["", ...(existsSync(packages) ? readdirSync(packages).map((p) => join("packages", p)) : [])]
		.map((dir) => join(tree, dir, "node_modules/tsx/dist/cli.mjs"))
		.find(existsSync);
}

/** Run each test file once on the tree; a preview of that exact tree serves the browser tests. */
async function runTests(
	root: string,
	cfg: Config,
	tree: Tree,
	files: string[],
	browser: boolean,
	log: (s: string) => void,
): Promise<{ results: FileResult[]; startFailed: boolean }> {
	const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", EVF_AUDIT: "1" };
	// Both engines run: tests/ui/setup.mjs limits itself to one only when UI_ENGINE is set. The development env file
	// supplies the database, so a shell value never points a test elsewhere.
	// NODE_TEST_CONTEXT would turn the nested runner into a child of an outer one, which always exits 0.
	for (const k of Object.keys(env))
		if (k === "UI_ENGINE" || k === "NODE_TEST_CONTEXT" || k.startsWith("DATABASE_URL")) delete env[k];
	if (browser) {
		if (!cfg.stack?.up || !cfg.stack.down) fail("Browser tests need a preview, and evf.config.json has no stack.");
		mkdirSync(tree.runtime, { recursive: true });
		const up = await exec([...command(cfg.stack.up), "--mode", "production"], {
			cwd: tree.path,
			env: stackEnvOf(tree.path, tree.runtime),
			timeoutMs: 20 * 60_000,
		});
		const info = existsSync(join(tree.runtime, "stack.json"))
			? (JSON.parse(readFileSync(join(tree.runtime, "stack.json"), "utf8")) as { url?: string })
			: {};
		if (up.code !== 0 || !info.url) {
			log(`preview did not start:\n${up.out.trim().split("\n").slice(-20).join("\n")}`);
			return { results: files.map(() => "invalid"), startFailed: true };
		}
		env.UI_BASE_URL = info.url;
	}
	const results: FileResult[] = [],
		tsx = tsxCli(tree.path);
	try {
		for (const file of files) {
			const r = await exec(
				[
					process.execPath,
					...(/\.[cm]?tsx?$/.test(file) && tsx ? [tsx] : []),
					"--conditions=react-server",
					`--env-file-if-exists=${join(root, "apps/web/.env.local")}`,
					"--test",
					"--test-concurrency=1",
					"--test-reporter=tap",
					file,
				],
				{ cwd: tree.path, env, timeoutMs: 15 * 60_000 },
			);
			if (stopping) throw new Stopped();
			const result = fileResult(r.code, r.out);
			results.push(result);
			log(`${file}: ${result}`);
			if (result !== "passed") {
				const failed = [...r.out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]).slice(0, 10);
				if (failed.length) log(`  not ok: ${failed.join("; ")}`);
			}
		}
	} finally {
		if (browser) previewDownSync(cfg, tree.path, tree.runtime);
	}
	return { results, startFailed: false };
}

// ---- The command ---------------------------------------------------------------------------------------------------

export type AuditOptions = {
	list?: boolean;
	task?: string;
	mutation?: string;
	seed?: number;
	dryRun?: boolean;
	ignoreLoad?: string;
	now?: Date;
	tmpBase?: string;
};

function printCandidates(target: AuditTarget): void {
	console.log(
		`${target.ref}: ${target.candidates.length} candidates from ${target.mergeCommits.map((c) => c.slice(0, 10)).join(", ")}`,
	);
	for (const c of target.candidates) console.log(`${c.id}  ${c.operator}  ${c.file}:${c.line}  ${oneLineDiff(c)}`);
	console.log(`marked tests (${target.marked.length}): ${target.marked.join(", ") || "none"}`);
	if (target.escaped.length) console.log(`escaped tests (${target.escaped.length}): ${target.escaped.join(", ")}`);
}

export async function audit(root: string, opts: AuditOptions = {}): Promise<number> {
	const cfg = loadConfig(root);
	if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const main = git(root, "rev-parse", baseRef(root, cfg));
	for (const tree of recoverAudits(root, cfg)) console.error(`evf audit: removed ${tree}, left by a stopped audit.`);
	const db = openWorkDb(root);
	try {
		let target: AuditTarget;
		if (opts.task) {
			const t = targetOf(root, db, main, opts.task);
			if (typeof t === "string") fail(t);
			target = t;
		} else target = pickTarget(root, db, main, opts.now ?? new Date());
		if (opts.list) {
			printCandidates(target);
			return 0;
		}
		if (!target.candidates.length) fail(`${target.ref} has no mutation candidate on main.`);
		const seed = opts.seed ?? randomInt(1, 2 ** 31);
		const c = opts.mutation
			? (target.candidates.find((x) => x.id === opts.mutation) ??
				fail(
					`${opts.mutation} is not a candidate of ${target.ref}. List them with evf audit --list --task ${target.ref}.`,
				))
			: pickCandidate(target.candidates, seed);
		const tests = [...target.marked, ...target.escaped.filter((f) => !target.marked.includes(f))];
		console.log(`evf audit: task ${target.ref}, candidate ${c.id}, seed ${seed}, main ${main}`);
		console.log(
			`  repeat: bin/evf audit --task ${target.ref} --mutation ${c.id} --seed ${seed}${opts.dryRun ? " --dry-run" : ""}`,
		);
		console.log(`  ${c.operator} ${c.file}:${c.line}  ${oneLineDiff(c)}`);
		console.log(`  tests (${tests.length}): ${tests.join(", ")}`);
		awaitLoad(root, "audit", opts.ignoreLoad);
		return await runAudit(root, cfg, db, main, target, c, seed, tests, opts);
	} finally {
		db.close();
	}
}

async function runAudit(
	root: string,
	cfg: Config,
	db: DatabaseSync,
	main: string,
	target: AuditTarget,
	c: Candidate,
	seed: number,
	tests: string[],
	opts: AuditOptions,
): Promise<number> {
	const tree: Tree = {
		path: mkdtempSync(join(opts.tmpBase ?? tmpdir(), TREE_PREFIX)),
		runtime: "",
	};
	tree.runtime = join(evfDataDir(root), "audit", basename(tree.path));
	mkdirSync(join(evfDataDir(root), "audit"), { recursive: true });
	writeFileSync(
		activePath(root),
		JSON.stringify({ pid: process.pid, tree: tree.path, runtime: tree.runtime, startedAt: new Date().toISOString() }),
	);
	const rowId = Number(
		db
			.prepare(
				`INSERT INTO audit_runs (task_ref, merge_commit, main_sha, candidate_id, operator, file, line, seed, dry_run, started_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				target.ref,
				target.mergeCommits.at(-1)!,
				main,
				c.id,
				c.operator,
				c.file,
				c.line,
				seed,
				opts.dryRun ? 1 : 0,
				new Date().toISOString(),
			).lastInsertRowid,
	);
	const rows: TestRow[] = tests.map((file) => ({ file, main: "failed", mutant: null }));
	let outcome: Outcome | "stopped" | "error" = "error",
		filed: string | null = null;
	const onSignal = () => {
		if (stopping) return;
		stopping = true;
		console.error("evf audit: stopping; removing the audit worktree and preview.");
		for (const child of live) killGroup(child, "SIGTERM");
		setTimeout(() => {
			for (const child of live) killGroup(child, "SIGKILL");
		}, 5000).unref();
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);
	const log = (s: string) => console.log(`  ${s}`);
	try {
		git(root, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--quiet", "--detach", tree.path, main);
		if (existsSync(join(tree.path, "pnpm-lock.yaml"))) {
			console.log("evf audit: installing dependencies in the audit worktree.");
			const install = await exec(["corepack", "pnpm", "install", "--frozen-lockfile", "--prefer-offline"], {
				cwd: tree.path,
				env: { ...process.env, CI: "1" },
				timeoutMs: 20 * 60_000,
			});
			if (install.code !== 0) fail(`pnpm install failed in the audit worktree:\n${install.out.trim().slice(-2000)}`);
		}
		const browser = tests.some((f) => usesBrowser(root, main, f));
		console.log(`evf audit: baseline on main${browser ? " with a preview" : ""}.`);
		const base = await runTests(root, cfg, tree, tests, browser, log);
		base.results.forEach((r, i) => (rows[i]!.main = r));
		if (base.startFailed || base.results.some((r) => r !== "passed")) {
			outcome = "baseline-red";
			const red = rows.filter((r) => r.main !== "passed").map((r) => r.file);
			console.log(
				`evf audit: outcome baseline-red. ${base.startFailed ? "The preview of main did not start" : `Failing on main: ${red.join(", ")}`}. Nothing planted, nothing filed.`,
			);
			return 1;
		}
		plant(tree.path, c);
		console.log(`evf audit: mutant ${c.id} planted.`);
		const mutant = await runTests(root, cfg, tree, tests, browser, log);
		mutant.results.forEach((r, i) => (rows[i]!.mutant = r));
		outcome =
			mutant.startFailed || mutant.results.includes("invalid")
				? "invalid"
				: mutant.results.includes("failed")
					? "killed"
					: "survived";
		const killers = rows.filter((r) => r.mutant === "failed").map((r) => r.file);
		console.log(
			`evf audit: outcome ${outcome}.${outcome === "killed" ? ` Failed on the mutant: ${killers.join(", ")}.` : outcome === "invalid" ? " The mutant did not build or start; it proves nothing." : ""}`,
		);
		if (outcome === "survived") filed = fileSurvivor(root, cfg, db, main, target, c, seed, rows, opts.dryRun ?? false);
		return 0;
	} catch (e) {
		if (e instanceof Stopped || stopping) {
			outcome = "stopped";
			return 143;
		}
		throw e;
	} finally {
		if (stopping) outcome = "stopped";
		removeTree(root, cfg, tree.path, tree.runtime);
		rmSync(activePath(root), { force: true });
		db.prepare("UPDATE audit_runs SET outcome = ?, tests = ?, filed_task = ?, ended_at = ? WHERE id = ?").run(
			outcome,
			JSON.stringify(rows),
			filed,
			new Date().toISOString(),
			rowId,
		);
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
		stopping = false;
	}
}

/** A survived mutant files one OPS task, once per task, candidate and main SHA. A dry run only prints the ask. */
function fileSurvivor(
	root: string,
	cfg: Config,
	db: DatabaseSync,
	main: string,
	target: AuditTarget,
	c: Candidate,
	seed: number,
	rows: TestRow[],
	dryRun: boolean,
): string | null {
	const prior = db
		.prepare(
			"SELECT filed_task FROM audit_runs WHERE task_ref = ? AND candidate_id = ? AND main_sha = ? AND filed_task IS NOT NULL ORDER BY id LIMIT 1",
		)
		.get(target.ref, c.id, main) as { filed_task: string } | undefined;
	if (prior) {
		console.log(`evf audit: this survivor is filed already as ${prior.filed_task}. Nothing new filed.`);
		return null;
	}
	const title = surviveTitle(target.ref, c),
		ask = renderAsk(target, main, c, seed, rows);
	if (dryRun) {
		console.log(`evf audit: dry run. No id reserved, nothing filed. The ask it would file:\n\n${ask}`);
		return null;
	}
	const id = nextId(root, cfg, "ops");
	const task = ensureTask(db, parseTask(id), "implement");
	db.prepare("UPDATE tasks SET ask = ?, title = ?, updated_at = ? WHERE id = ?").run(
		ask,
		title,
		new Date().toISOString(),
		task.id,
	);
	record(db, task.id, null, "task_new", {
		summary: `${id}: ${title}`,
		audit: { task: target.ref, candidate: c.id, main },
	});
	console.log(`evf audit: filed ${id} (status new): ${title}`);
	console.log(
		`evf audit: commit this maintenanceTasks entry on ${id}'s branch (evf audit does not edit evf.config.json):\n${maintenanceEntry(id, title)}`,
	);
	return id;
}
