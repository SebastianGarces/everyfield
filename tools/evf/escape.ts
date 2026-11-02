import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { newTaskRow, openWorkDb, record } from "./db.ts";
import { nextId } from "./ids.ts";
import {
	evfDataDir,
	fail,
	git,
	loadConfig,
	oneLine,
	parseTask,
	requireWorktree,
	run,
	type CheckDef,
	type RunResult,
	type TaskRef,
} from "./lib.ts";
import { stackInfo } from "./task.ts";

/**
 * OPS-114: a bug Sebastian catches becomes a permanent check. `evf escape <PR> --what` files the OPS task that writes
 * the regression test into tests/ui/escaped/; `evf escape soak` proves a test is stable before it joins the folder; and
 * the `ui-escaped` check runs the folder on every UI task's stack. All of it runs on this machine only, never in CI.
 */

export const ESCAPED_DIR = "tests/ui/escaped/";
export const SOAK_RUNS = 20;
const ESCAPED_TEST = /^tests\/ui\/escaped\/[^/]+\.test\.mjs$/;
const SHA = /^[a-f0-9]{40}$/;

/** What evf reads of a PR. `null` from a reader means GitHub has no PR with that number. */
export type PrRead = { state: string; headRefOid: string; mergeCommit: { oid: string } | null };
export type PrReader = (pr: number) => PrRead | null;

export function ghPrReader(root: string): PrReader {
	return (pr) => {
		const r = run("gh", ["pr", "view", String(pr), "--json", "state,headRefOid,mergeCommit"], { cwd: root });
		if (r.code !== 0) {
			if (/Could not resolve to a PullRequest|no pull requests found/i.test(r.stderr)) return null;
			fail(`Cannot read PR #${pr} from GitHub: ${oneLine(r.stderr || r.stdout)}`);
		}
		return JSON.parse(r.stdout) as PrRead;
	};
}

export type EscapedHead = { sha: string; source: "override" | "merge commit" | "PR head" };

/** The head the bug escaped on: `--head` wins; else the merge commit of a merged PR; else the PR's current head. */
export function escapedHead(pr: PrRead, override?: string): EscapedHead {
	if (override !== undefined) {
		if (!SHA.test(override)) fail("--head takes a full 40-character commit SHA.");
		return { sha: override, source: "override" };
	}
	if (pr.state === "MERGED" && pr.mergeCommit?.oid) return { sha: pr.mergeCommit.oid, source: "merge commit" };
	return { sha: pr.headRefOid, source: "PR head" };
}

/** The Done template every escape task carries (spec criterion 3). */
export function doneTemplate(head: string): string {
	return [
		`1. A test in \`${ESCAPED_DIR}\` fails on the escaped head ${head} and passes on the fix, or on main when main never had the bug.`,
		`2. The test passes the ${SOAK_RUNS}-run soak: \`bin/evf escape soak ${ESCAPED_DIR}<name>.test.mjs\` records ${SOAK_RUNS} green runs for the file's current bytes.`,
		"3. One `bin/evf proof add` records each of the two runs (the failure on the escaped head and the pass on the fix or main), with the head SHA, the command and the result.",
	].join("\n");
}

/** The ask an escape task stores. `what` stays byte for byte. */
export function escapeAsk(pr: number, head: EscapedHead, what: string): string {
	return [
		`# Ask: escaped bug from PR #${pr} becomes a permanent check`,
		"",
		"## Sebastian's words (verbatim)",
		"",
		what,
		"",
		"## Escape",
		"",
		`- PR: #${pr}`,
		`- Escaped head: ${head.sha} (${head.source})`,
		"",
		"## Done template",
		"",
		doneTemplate(head.sha),
	].join("\n");
}

/** The maintenanceTasks entry the coordinator commits on the new task's branch. evf never writes it. */
export function escapeEntry(checks: CheckDef[], pr: number): Record<string, unknown> {
	const named = (name: string) => {
		const check = checks.find((c) => c.name === name);
		if (!check) fail(`evf.config.json checks must define "${name}".`);
		return check;
	};
	return {
		title: `Escaped bug from PR #${pr} becomes a permanent check`,
		owningPaths: [ESCAPED_DIR],
		checks: [named("documentation"), named("workflow-regressions")],
		risk: "ordinary",
	};
}

/** The current escape task for this PR and head, if one was filed. */
function filedEscape(root: string, pr: number, head: string): string | undefined {
	const db = openWorkDb(root);
	try {
		const row = db
			.prepare(
				"SELECT t.ref FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.type = 'escape_filed' AND json_extract(e.payload, '$.pr') = ? AND json_extract(e.payload, '$.head') = ? AND t.status != 'abandoned' ORDER BY t.id DESC LIMIT 1",
			)
			.get(pr, head) as { ref: string } | undefined;
		return row?.ref;
	} finally {
		db.close();
	}
}

/**
 * File one OPS task for an escaped bug. Every refusal comes before the id reservation, so a refused call reserves no
 * id. A second call for the same PR and head files nothing and prints the existing id.
 */
export function escape(
	root: string,
	opts: { pr: number; what?: string; head?: string },
	deps: { readPr?: PrReader; reserveId?: () => string } = {},
): number {
	if (opts.what === undefined) fail('Give --what "<his words>": Sebastian\'s words for the bug, verbatim.');
	if (!opts.what.trim()) fail("--what is empty. Give Sebastian's words for the bug, verbatim.");
	const cfg = loadConfig(root);
	const pr = (deps.readPr ?? ghPrReader(root))(opts.pr);
	if (!pr) fail(`PR #${opts.pr} does not exist.`);
	const head = escapedHead(pr, opts.head);
	const existing = filedEscape(root, opts.pr, head.sha);
	if (existing) {
		console.log(`escape: ${existing} already covers PR #${opts.pr} at ${head.sha}. Nothing filed.`);
		console.log(existing);
		return 0;
	}
	const id = (deps.reserveId ?? (() => nextId(root, cfg, "ops")))();
	const task = parseTask(id);
	const ask = escapeAsk(opts.pr, head, opts.what);
	const title = `Escaped bug from PR #${opts.pr} becomes a permanent check`;
	const db = openWorkDb(root);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = newTaskRow(db, task, "implement");
			db.prepare("UPDATE tasks SET ask = ?, title = ? WHERE id = ?").run(ask, title, row.id);
			record(db, row.id, null, "escape_filed", {
				pr: opts.pr,
				head: head.sha,
				source: head.source,
				summary: `${id}: escaped bug from PR #${opts.pr} at ${head.sha.slice(0, 10)}`,
			});
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	} finally {
		db.close();
	}
	console.log(`escape: filed ${id} (status new) for PR #${opts.pr} at ${head.sha} (${head.source}).`);
	console.log(
		`Commit this maintenanceTasks entry on the ${task.branch} branch before implement starts (evf does not edit evf.config.json):`,
	);
	console.log(JSON.stringify({ [id]: escapeEntry(cfg.checks, opts.pr) }, null, "\t"));
	console.log(id);
	return 0;
}

export type SoakRecord = {
	file: string;
	sha256: string;
	required: number;
	runs: number;
	passed: boolean;
	failedRun: number | null;
	baseUrl: string;
	head: string;
	log: string;
	finishedAt: string;
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The soak record of a task for one file content hash. */
export function soakPath(root: string, task: TaskRef, hash: string): string {
	return join(evfDataDir(root), "evidence", task.slug, "soak", `${hash}.json`);
}

function readSoak(root: string, task: TaskRef, hash: string): SoakRecord | undefined {
	const path = soakPath(root, task, hash);
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SoakRecord) : undefined;
}

const noStack = (task: TaskRef) =>
	`No running stack for ${task.id}. Start it with bin/evf stack up ${task.id}, then rerun.`;

/** `file` as a path inside the worktree, refused unless it is one test in tests/ui/escaped/. */
function escapedFile(wt: string, file: string): string {
	const rel = relative(wt, isAbsolute(file) ? file : resolve(process.cwd(), file))
		.split("\\")
		.join("/");
	if (!ESCAPED_TEST.test(rel)) fail(`${file} is not a test file in ${ESCAPED_DIR} (${ESCAPED_DIR}<name>.test.mjs).`);
	if (!existsSync(join(wt, rel))) fail(`${rel} does not exist in ${wt}.`);
	return rel;
}

/**
 * Run one escaped test SOAK_RUNS times in a row against the task's stack. The first failed run ends the soak. The
 * record is keyed by the file's content hash, so any later edit needs a new soak.
 */
export function soak(
	root: string,
	task: TaskRef,
	file: string,
	runOnce?: (rel: string, baseUrl: string, wt: string) => RunResult,
): SoakRecord {
	const wt = requireWorktree(root, loadConfig(root), task);
	const rel = escapedFile(wt, file);
	const baseUrl = stackInfo(root, task).url;
	if (!baseUrl) fail(noStack(task));
	const hash = sha256(readFileSync(join(wt, rel)));
	const path = soakPath(root, task, hash),
		log = path.replace(/\.json$/, ".log");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(log, `soak ${rel} sha256 ${hash} against ${baseUrl}\n`);
	const once =
		runOnce ??
		((r: string, url: string, cwd: string) =>
			run(process.execPath, ["--test", r], { cwd, env: { ...process.env, UI_BASE_URL: url }, timeoutMs: 600_000 }));
	let runs = 0,
		failedRun: number | null = null;
	while (runs < SOAK_RUNS) {
		runs++;
		const r = once(rel, baseUrl, wt);
		appendFileSync(log, `\n--- run ${runs}: exit ${r.code}\n${r.stdout}\n${r.stderr}\n`);
		console.error(`evf escape soak: run ${runs}/${SOAK_RUNS} ${r.code === 0 ? "passed" : "failed"}.`);
		if (r.code !== 0) {
			failedRun = runs;
			break;
		}
	}
	const result: SoakRecord = {
		file: rel,
		sha256: hash,
		required: SOAK_RUNS,
		runs,
		passed: failedRun === null,
		failedRun,
		baseUrl,
		head: git(wt, "rev-parse", "HEAD"),
		log,
		finishedAt: new Date().toISOString(),
	};
	writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
	console.log(`${result.passed ? "PASSED" : `FAILED on run ${failedRun} of`} ${SOAK_RUNS}-run soak of ${rel}: ${path}`);
	return result;
}

/** What `evf verify` does with the ui-escaped check for a task. */
export type EscapedGate = { skip: string } | { fail: string } | { baseUrl: string };

/**
 * ui-escaped runs for WP /ui parts and for any task that changes tests/ui/escaped/. It fails closed without a running
 * stack, and for a changed escaped test without a passing soak record for its current bytes.
 */
export function uiEscapedGate(root: string, wt: string, task: TaskRef, baseSha: string): EscapedGate {
	const changed = git(wt, "diff", "--name-only", "--no-renames", baseSha, "HEAD", "--", ESCAPED_DIR)
		.split("\n")
		.filter(Boolean);
	const ui = task.kind === "wp" && task.part === "ui";
	if (!ui && !changed.length)
		return { skip: `${task.id} is not a WP /ui part and changes no file under ${ESCAPED_DIR}.` };
	const baseUrl = stackInfo(root, task).url;
	if (!baseUrl) return { fail: noStack(task) };
	const unsoaked = changed
		.filter((path) => ESCAPED_TEST.test(path) && existsSync(join(wt, path)))
		.filter((path) => {
			const soaked = readSoak(root, task, sha256(readFileSync(join(wt, path))));
			return !(soaked?.passed && soaked.runs >= SOAK_RUNS);
		});
	if (unsoaked.length)
		return {
			fail: unsoaked
				.map(
					(path) =>
						`${path} has no ${SOAK_RUNS}-green soak record for its current bytes. Run bin/evf escape soak ${path} in the ${task.id} worktree.`,
				)
				.join("\n"),
		};
	return { baseUrl };
}
