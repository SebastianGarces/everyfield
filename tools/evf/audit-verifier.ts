import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { git, run } from "./lib.ts";
import { readSessionUsage } from "./usage.ts";

/**
 * The optional verifier seat of `evf audit --with-verifier` (OPS-124). After a run ends killed or survived, one fresh
 * Opus 5.5 medium session reviews the audited task's change with the planted bug in it, and evf grades its findings by
 * file and line. The seat is not told a bug was planted. It reads a plain folder of two files, never a checkout, so
 * nothing it can open names the operator, the candidate or the outcome. It runs on the subscription only: the env it
 * gets holds no API key and no cloud switch. One found or missed result a month is the limit Sebastian approved (D.2).
 */

export type VerifierResult = "found" | "missed" | "no-verdict";
export type Finding = { file: string; line: number; summary: string };
/** What grading needs of the planted bug. */
export type Planted = { operator: "off-by-one" | "dropped-call" | "removed-route"; file: string; line: number };
/** How a seat process ended. `code` is null when it never started or a signal ended it. */
export type SeatRun = { code: number | null; out: string; err: string; timedOut: boolean; spawnError?: string };

export const SEAT_MODEL = "claude-opus-5-5";
export const SEAT_EFFORT = "medium";
export const SEAT_TOOLS = "Read,Grep,Glob";
export const SEAT_TIMEOUT_MS = 30 * 60_000;
export const LINE_WINDOW = 3;
export const LIMIT_DAYS = 30;
const DAY = 86_400_000;
const REVIEW_PREFIX = "review-";

/** The prompt names neither the run nor its purpose: a reviewer of any change would read the same words. */
export const SEAT_PROMPT = [
	"You are reviewing a change before it merges.",
	"The folder holds two files: task.md says what the change should do, and change.diff is the change.",
	"Find defects: code that is wrong, or that does not do what task.md requires.",
	"Use Read, Grep and Glob. Report only defects you can point to.",
	'Reply with JSON only, in this shape: {"findings":[{"file":"path as in change.diff","line":123,"summary":"what is wrong"}]}.',
	"line is the line number in the new version of the file; for a file the change deletes, use 1.",
	'Reply {"findings":[]} when you find no defect.',
].join("\n");

export const seatArgs = (session: string): string[] => [
	"-p",
	"--session-id",
	session,
	"--model",
	SEAT_MODEL,
	"--effort",
	SEAT_EFFORT,
	"--tools",
	SEAT_TOOLS,
	"--allowedTools",
	SEAT_TOOLS,
	"--output-format",
	"json",
];

// ---- The monthly limit ---------------------------------------------------------------------------------------------

/** The refusal for a run that would start a second seat inside the limit, or null. A no-verdict run does not count. */
export function verifierRefusal(db: DatabaseSync, now: Date): string | null {
	const since = new Date(now.getTime() - LIMIT_DAYS * DAY).toISOString();
	const last = (
		db
			.prepare(
				"SELECT MAX(verifier_ended_at) AS at FROM audit_runs WHERE verifier_result IN ('found', 'missed') AND verifier_ended_at > ?",
			)
			.get(since) as { at: string | null }
	).at;
	if (!last) return null;
	const next = new Date(Date.parse(last) + LIMIT_DAYS * DAY).toISOString();
	return `evf audit --with-verifier is limited to one found or missed result in ${LIMIT_DAYS} days (the approved Opus verify, report decision D.2). The last one ended ${last}. The first date it will run is ${next}. More than one a month needs a new approval from Sebastian.`;
}

// ---- The seat's environment ----------------------------------------------------------------------------------------

/** Only these reach the seat. Nothing from EVF_*, no API key, no cloud switch, no shell location of the run. */
const KEEP = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"TERM",
	"TZ",
	"CLAUDE_CONFIG_DIR",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"no_proxy",
]);

export function seatEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (v !== undefined && (KEEP.has(k) || k.startsWith("LC_"))) out[k] = v;
	return out;
}

// ---- What the seat receives ----------------------------------------------------------------------------------------

type Merged = { ref: string; mergeCommits: string[] };

/**
 * A new folder with change.diff and task.md. change.diff is the audited merges' whole change as it stands on the
 * mutant: `git diff <first merge>^1 <mutant>` over the files the merges changed. A route file the task added and the
 * mutant removed has no diff, so the seat can notice it only by comparing the diff with task.md.
 */
export function buildReview(root: string, db: DatabaseSync, target: Merged, mutant: string, tmpBase?: string): string {
	const files = new Set<string>();
	for (const m of target.mergeCommits)
		for (const f of git(root, "diff", "--no-renames", "--name-only", `${m}^1`, m).split("\n").filter(Boolean))
			files.add(f);
	const first = [...target.mergeCommits].sort(
		(a, b) => Number(git(root, "show", "-s", "--format=%ct", a)) - Number(git(root, "show", "-s", "--format=%ct", b)),
	)[0]!;
	const diff = run(
		"git",
		["diff", "--no-renames", "--no-color", "--no-ext-diff", `${first}^1`, mutant, "--", ...[...files].sort()],
		{ cwd: root },
	);
	if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
	const rows = db
		.prepare("SELECT ask, spec FROM tasks WHERE ref = ? AND status = 'merged' ORDER BY id")
		.all(target.ref) as Array<{ ask: string | null; spec: string | null }>;
	const sections = rows.flatMap((r) => [
		...(r.ask ? [`## Ask\n\n${r.ask.trim()}`] : []),
		...(r.spec ? [`## Spec\n\n${r.spec.trim()}`] : []),
	]);
	const folder = mkdtempSync(join(tmpBase ?? tmpdir(), REVIEW_PREFIX));
	writeFileSync(join(folder, "change.diff"), diff.stdout);
	writeFileSync(join(folder, "task.md"), `# Task\n\n${sections.join("\n\n") || "(no stored text)"}\n`);
	return folder;
}

// ---- The seat process ----------------------------------------------------------------------------------------------

let current: ChildProcess | null = null;

/** Signal the running seat's process group: what a stop of the audit sends. */
export function stopSeat(sig: NodeJS.Signals): void {
	try {
		if (current?.pid) process.kill(-current.pid, sig);
	} catch {
		// already gone
	}
}

/** Run `claude -p` in `folder`, the prompt on stdin. Never throws: a missing binary or a timeout is in the result. */
export function runSeatProcess(
	folder: string,
	session: string,
	env: NodeJS.ProcessEnv,
	timeoutMs = SEAT_TIMEOUT_MS,
): Promise<SeatRun> {
	return new Promise((resolve) => {
		let out = "",
			err = "",
			timedOut = false,
			done = false;
		const finish = (r: Omit<SeatRun, "out" | "err" | "timedOut">) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			current = null;
			resolve({ ...r, out, err, timedOut });
		};
		const child = spawn("claude", seatArgs(session), {
			cwd: folder,
			env,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		current = child;
		const timer = setTimeout(() => {
			timedOut = true;
			stopSeat("SIGKILL");
		}, timeoutMs);
		child.stdout!.on("data", (d) => (out += d));
		child.stderr!.on("data", (d) => (err += d));
		child.stdin!.on("error", () => {});
		child.stdin!.end(SEAT_PROMPT);
		child.on("error", (e) => finish({ code: null, spawnError: String(e.message) }));
		child.on("close", (code) => finish({ code }));
	});
}

// ---- Grading -------------------------------------------------------------------------------------------------------

function jsonIn(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)?.[1];
	const braced = trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
	for (const candidate of [trimmed, fenced, braced])
		if (candidate)
			try {
				return JSON.parse(candidate);
			} catch {
				// try the next shape
			}
	return undefined;
}

/** The findings in the seat's stdout (the `claude -p --output-format json` envelope), or null when they do not parse. */
export function parseFindings(stdout: string): Finding[] | null {
	let payload = jsonIn(stdout) as any;
	if (payload && typeof payload === "object" && !Array.isArray(payload) && "result" in payload) {
		if (payload.is_error === true || typeof payload.result !== "string") return null;
		payload = jsonIn(payload.result);
	}
	const list = Array.isArray(payload) ? payload : payload?.findings;
	if (!Array.isArray(list)) return null;
	const out: Finding[] = [];
	for (const f of list) {
		if (!f || typeof f.file !== "string" || !f.file || !Number.isInteger(f.line) || typeof f.summary !== "string")
			return null;
		out.push({ file: f.file, line: f.line, summary: f.summary });
	}
	return out;
}

const pathOf = (p: string) => p.replace(/^(?:\.\/|[ab]\/)/, "");

/** found when a finding names the planted file and a line within 3 of it (the file alone for a removed route). */
export function grade(planted: Planted, findings: Finding[]): "found" | "missed" {
	const hit = findings.some((f) => {
		const file = pathOf(f.file);
		if (file !== planted.file && !file.endsWith(`/${planted.file}`)) return false;
		return planted.operator === "removed-route" || Math.abs(f.line - planted.line) <= LINE_WINDOW;
	});
	return hit ? "found" : "missed";
}

/** The verdict of one seat run. A failed run, a timeout or output that does not parse is never `missed`. */
export function verdictOf(
	planted: Planted,
	seat: SeatRun,
): { result: VerifierResult; findings: Finding[] | null; note: string } {
	if (seat.spawnError)
		return { result: "no-verdict", findings: null, note: `the seat did not start: ${seat.spawnError}` };
	if (seat.timedOut) return { result: "no-verdict", findings: null, note: "the seat timed out" };
	if (seat.code !== 0)
		return { result: "no-verdict", findings: null, note: `the seat exited ${seat.code ?? "on a signal"}` };
	const findings = parseFindings(seat.out);
	if (!findings) return { result: "no-verdict", findings: null, note: "the seat's output did not parse as findings" };
	return { result: grade(planted, findings), findings, note: `${findings.length} findings` };
}

// ---- The run -------------------------------------------------------------------------------------------------------

export type VerifierRun = {
	root: string;
	db: DatabaseSync;
	rowId: number;
	target: Merged;
	planted: Planted;
	mutant: string;
	dryRun: boolean;
	tmpBase?: string;
	/** Told the review folder when it exists and null when it is gone, so a crash can find it. */
	onFolder: (path: string | null) => void;
	stopped: () => boolean;
};

/** Build the review folder, run the seat and record its row. Returns the result, or "dry-run" when no seat started. */
export async function runVerifier(a: VerifierRun): Promise<VerifierResult | "dry-run"> {
	const folder = buildReview(a.root, a.db, a.target, a.mutant, a.tmpBase);
	a.onFolder(folder);
	try {
		if (a.dryRun) {
			const files = ["task.md", "change.diff"];
			console.log(`evf audit: dry run. No verifier seat started. The seat would run in a new folder with:`);
			console.log(
				`  claude ${seatArgs("<new session id>").join(" ")}  (environment: PATH, HOME, locale and proxy only)`,
			);
			console.log(`  prompt:\n${SEAT_PROMPT.replace(/^/gm, "    ")}`);
			for (const f of files) console.log(`  ${f}:\n${readFileSync(join(folder, f), "utf8").replace(/^/gm, "    ")}`);
			return "dry-run";
		}
		const session = randomUUID();
		a.db.prepare("UPDATE audit_runs SET verifier_session = ? WHERE id = ?").run(session, a.rowId);
		console.log(`evf audit: starting one verifier seat (${SEAT_MODEL}, effort ${SEAT_EFFORT}), session ${session}.`);
		const seat = a.stopped()
			? ({ code: null, out: "", err: "", timedOut: false, spawnError: "stopped" } satisfies SeatRun)
			: await runSeatProcess(folder, session, seatEnv(process.env));
		const { result, findings, note } = verdictOf(a.planted, seat);
		const usage = readSessionUsage(session);
		a.db
			.prepare(
				"UPDATE audit_runs SET verifier_result = ?, verifier_findings = ?, verifier_usage = ?, verifier_ended_at = ? WHERE id = ?",
			)
			.run(
				result,
				findings ? JSON.stringify(findings) : null,
				usage ? JSON.stringify(Object.fromEntries(usage)) : null,
				new Date().toISOString(),
				a.rowId,
			);
		console.log(`evf audit: verifier ${result} (${note}).`);
		return result;
	} finally {
		rmSync(folder, { recursive: true, force: true });
		a.onFolder(null);
	}
}
