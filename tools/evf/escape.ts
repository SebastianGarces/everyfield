import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findTask, openWorkDb, record } from "./db.ts";
import {
	command,
	evfDataDir,
	fail,
	git,
	loadConfig,
	oneLine,
	parseTask,
	requireWorktree,
	run,
	type RunResult,
	type TaskRef,
} from "./lib.ts";
import { stackEnv, stackInfo } from "./task.ts";

/**
 * OPS-114: a bug Sebastian catches becomes a permanent check. `evf escape <PR> --what --task <WP-NNN/ui>` stores the
 * escape on the WP /ui task that writes the regression test into tests/ui/escaped/; `evf escape soak` proves a test is stable before it joins the folder; and
 * the `ui-escaped` check runs the folder on every UI task's stack. All of it runs on this machine only, never in CI.
 */

const ESCAPED_DIR = "tests/ui/escaped/";
const SOAK_RUNS = 20;
const ESCAPED_TEST = /^tests\/ui\/escaped\/[^/]+\.test\.mjs$/;
const SHA = /^[a-f0-9]{40}$/;

/** What evf reads of a PR. `null` from a reader means GitHub has no PR with that number. */
export type PrRead = { state: string; headRefOid: string; mergeCommit: { oid: string } | null };
type PrReader = (pr: number) => PrRead | null;

function ghPrReader(root: string): PrReader {
	return (pr) => {
		const r = run("gh", ["pr", "view", String(pr), "--json", "state,headRefOid,mergeCommit"], { cwd: root });
		if (r.code !== 0) {
			if (/Could not resolve to a PullRequest|no pull requests found/i.test(r.stderr)) return null;
			fail(`Cannot read PR #${pr} from GitHub: ${oneLine(r.stderr || r.stdout)}`);
		}
		return JSON.parse(r.stdout) as PrRead;
	};
}

type EscapedHead = { sha: string; source: "override" | "merge commit" | "PR head" };

/** The head the bug escaped on: `--head` wins; else the merge commit of a merged PR; else the PR's current head. */
function escapedHead(pr: PrRead, override?: string): EscapedHead {
	if (override !== undefined) {
		if (!SHA.test(override)) fail("--head takes a full 40-character commit SHA.");
		return { sha: override, source: "override" };
	}
	if (pr.state === "MERGED" && pr.mergeCommit?.oid) return { sha: pr.mergeCommit.oid, source: "merge commit" };
	return { sha: pr.headRefOid, source: "PR head" };
}

/** The escape block an escape stores on the task's ask: `what` byte for byte, the PR, the escaped head and the Done template. */
function escapeAsk(pr: number, head: EscapedHead, what: string): string {
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
		`1. A test in \`${ESCAPED_DIR}\` fails on the escaped head ${head.sha} and passes on the fix, or on main when main never had the bug.`,
		`2. The test passes the ${SOAK_RUNS}-run soak: \`bin/evf escape soak ${ESCAPED_DIR}<name>.test.mjs\` records ${SOAK_RUNS} green runs for the file's current bytes.`,
		"3. One `bin/evf proof add` records each of the two runs (the failure on the escaped head and the pass on the fix or main), with the head SHA, the command and the result.",
	].join("\n");
}

/** The task that already carries this PR and head's escape, if any. */
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
 * Store an escaped bug on the WP /ui task the coordinator names. OPS tasks do not own tests/ui/escaped/, so the
 * escape reserves no OPS id and prints no maintenanceTasks entry: it appends the escape block to the task's ask and
 * records an escape_filed event. Every refusal comes before the write. A second call for the same PR and head stores
 * nothing and prints the task that already carries it.
 */
export function escape(
	root: string,
	opts: { pr: number; what?: string; head?: string; task?: string },
	deps: { readPr?: PrReader } = {},
): number {
	if (opts.what === undefined) fail('Give --what "<his words>": Sebastian\'s words for the bug, verbatim.');
	if (!opts.what.trim()) fail("--what is empty. Give Sebastian's words for the bug, verbatim.");
	if (!opts.task) fail("Give --task <WP-NNN/ui>: the WP /ui task that writes the escaped test.");
	const task = parseTask(opts.task);
	if (task.kind !== "wp" || task.part !== "ui")
		fail(`${task.id} is not a WP /ui part. An escaped test lives in ${ESCAPED_DIR}, which only a WP /ui task owns.`);
	const pr = (deps.readPr ?? ghPrReader(root))(opts.pr);
	if (!pr) fail(`PR #${opts.pr} does not exist.`);
	const head = escapedHead(pr, opts.head);
	const existing = filedEscape(root, opts.pr, head.sha);
	if (existing) {
		console.log(`escape: ${existing} already carries PR #${opts.pr} at ${head.sha}. Nothing stored.`);
		console.log(existing);
		return 0;
	}
	const block = escapeAsk(opts.pr, head, opts.what);
	const db = openWorkDb(root);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = findTask(db, task);
			if (!row) fail(`${task.id} has no task row. File it first (bin/evf task new ${task.id} --ask-file <file>).`);
			if (row.status === "merged") fail(`${task.id} has merged. Name an open WP /ui task.`);
			const prior = (db.prepare("SELECT ask FROM tasks WHERE id = ?").get(row.id) as { ask: string | null }).ask;
			const ask = prior?.trim() ? `${prior}\n\n${block}` : block;
			db.prepare("UPDATE tasks SET ask = ?, updated_at = ? WHERE id = ?").run(ask, new Date().toISOString(), row.id);
			record(db, row.id, null, "escape_filed", {
				pr: opts.pr,
				head: head.sha,
				source: head.source,
				summary: `${task.id}: escaped bug from PR #${opts.pr} at ${head.sha.slice(0, 10)}`,
			});
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	} finally {
		db.close();
	}
	console.log(`escape: stored PR #${opts.pr} at ${head.sha} (${head.source}) on ${task.id}.`);
	console.log(task.id);
	return 0;
}

type SoakRecord = {
	file: string;
	sha256: string;
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

const noStack = (task: TaskRef) =>
	`No running stack for ${task.id}. Start it with bin/evf stack up ${task.id}, then rerun.`;

/**
 * The URL of the task's stack when it is running. stack.json can outlive its preview (a lease ends, or another seat
 * frees the slot), so when evf.config.json has a stack status command, the stack must also report `ready` there.
 */
function liveStackUrl(root: string, wt: string, task: TaskRef): string | undefined {
	const url = stackInfo(root, task).url;
	const status = loadConfig(root).stack?.status;
	if (!url || !status) return url;
	const argv = command(status);
	const r = run(argv[0], argv.slice(1), { cwd: wt, env: stackEnv(root, task, wt) });
	const last = r.stdout.trim().split("\n").pop() ?? "";
	try {
		return r.code === 0 && (JSON.parse(last) as { state?: string }).state === "ready" ? url : undefined;
	} catch {
		return undefined;
	}
}

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
	const baseUrl = liveStackUrl(root, wt, task);
	if (!baseUrl) fail(noStack(task));
	const hash = sha256(readFileSync(join(wt, rel)));
	const path = soakPath(root, task, hash),
		log = path.replace(/\.json$/, ".log");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(log, `soak ${rel} sha256 ${hash} against ${baseUrl}\n`);
	const once =
		runOnce ??
		((r, url, cwd) =>
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
type EscapedGate = { skip: string } | { fail: string } | { baseUrl: string };

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
	const dir = join(wt, ESCAPED_DIR);
	if (!existsSync(dir) || !readdirSync(dir).some((name) => ESCAPED_TEST.test(ESCAPED_DIR + name)))
		return { skip: `${ESCAPED_DIR} holds no escaped test yet.` };
	const baseUrl = liveStackUrl(root, wt, task);
	if (!baseUrl) return { fail: noStack(task) };
	const unsoaked = changed
		.filter((path) => ESCAPED_TEST.test(path) && existsSync(join(wt, path)))
		.filter((path) => {
			const record = soakPath(root, task, sha256(readFileSync(join(wt, path))));
			if (!existsSync(record)) return true;
			const soaked = JSON.parse(readFileSync(record, "utf8")) as SoakRecord;
			return !(soaked.passed && soaked.runs >= SOAK_RUNS);
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
