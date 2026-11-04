import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { git } from "./lib.ts";
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
export type SeatRun = { code: number | null; out: string };

const LIMIT_DAYS = 30;
const DAY = 86_400_000;
const TOOLS = "Read,Grep,Glob";

/** The prompt names neither the run nor its purpose: a reviewer of any change would read the same words. */
const PROMPT = [
	"You are reviewing a change before it merges.",
	"The folder holds two files: task.md says what the change should do, and change.diff is the change.",
	"Find defects: code that is wrong, or that does not do what task.md requires.",
	"Use Read, Grep and Glob. Report only defects you can point to.",
	'Reply with JSON only, in this shape: {"findings":[{"file":"path as in change.diff","line":123,"summary":"what is wrong"}]}.',
	"line is the line number in the new version of the file; for a file the change deletes, use 1.",
	'Reply {"findings":[]} when you find no defect.',
].join("\n");

const seatArgs = (session: string): string[] => [
	"-p",
	"--session-id",
	session,
	"--model",
	"claude-opus-5-5",
	"--effort",
	"medium",
	"--tools",
	TOOLS,
	"--allowedTools",
	TOOLS,
	"--output-format",
	"json",
];

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

/** Only these reach the seat. Nothing from EVF_*, no API key, no cloud switch, no shell location of the run. */
const KEEP = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ", "CLAUDE_CONFIG_DIR"]);

export function seatEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([k]) => KEEP.has(k) || k.startsWith("LC_")));
}

type Merged = { ref: string; mergeCommits: string[] };

/**
 * A new folder with change.diff and task.md. change.diff is the audited merges' whole change as it stands on the
 * mutant: `git diff <first merge>^1 <mutant>` over the files the merges changed. A route file the task added and the
 * mutant removed has no diff, so the seat can notice it only by comparing the diff with task.md.
 */
function buildReview(root: string, db: DatabaseSync, target: Merged, mutant: string, tmpBase?: string): string {
	const files = new Set<string>();
	for (const m of target.mergeCommits)
		for (const f of git(root, "diff", "--no-renames", "--name-only", `${m}^1`, m).split("\n").filter(Boolean))
			files.add(f);
	const diff = git(
		root,
		"diff",
		"--no-renames",
		"--no-color",
		"--no-ext-diff",
		`${target.mergeCommits[0]}^1`,
		mutant,
		"--",
		...[...files].sort(),
	);
	const rows = db
		.prepare("SELECT ask, spec FROM tasks WHERE ref = ? AND status = 'merged' ORDER BY id")
		.all(target.ref) as Array<{ ask: string | null; spec: string | null }>;
	const sections = rows.flatMap((r) => [
		...(r.ask ? [`## Ask\n\n${r.ask.trim()}`] : []),
		...(r.spec ? [`## Spec\n\n${r.spec.trim()}`] : []),
	]);
	const folder = mkdtempSync(join(tmpBase ?? tmpdir(), "review-"));
	writeFileSync(join(folder, "change.diff"), `${diff}\n`);
	writeFileSync(join(folder, "task.md"), `# Task\n\n${sections.join("\n\n") || "(no stored text)"}\n`);
	return folder;
}

/** Run `claude -p` in `folder`, the prompt on stdin. Never throws. `live` is the set a stop of the audit signals. */
export function runSeatProcess(
	folder: string,
	session: string,
	env: NodeJS.ProcessEnv,
	live: Set<ChildProcess>,
	timeoutMs = 30 * 60_000,
): Promise<SeatRun> {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn("claude", seatArgs(session), {
			cwd: folder,
			env,
			detached: true,
			stdio: ["pipe", "pipe", "inherit"],
		});
		live.add(child);
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				// already gone
			}
		}, timeoutMs);
		const finish = (code: number | null) => {
			clearTimeout(timer);
			live.delete(child);
			resolve({ code, out });
		};
		child.stdout!.on("data", (d) => (out += d));
		child.stdin!.on("error", () => {});
		child.stdin!.end(PROMPT);
		child.on("error", (e) => {
			console.error(`evf audit: the seat did not start: ${e.message}`);
			finish(null);
		});
		child.on("close", finish);
	});
}

/** The JSON object in `text`, which may sit inside a code fence or prose, or undefined. */
function objectIn(text: string): any {
	try {
		return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
	} catch {
		return undefined;
	}
}

/** The findings in the `claude -p --output-format json` envelope on stdout, or null when they do not parse. */
function parseFindings(stdout: string): Finding[] | null {
	const envelope = objectIn(stdout);
	if (envelope?.is_error === true || typeof envelope?.result !== "string") return null;
	const list = objectIn(envelope.result)?.findings;
	if (!Array.isArray(list)) return null;
	const valid = list.every(
		(f) => f && typeof f.file === "string" && f.file && Number.isInteger(f.line) && typeof f.summary === "string",
	);
	return valid ? list : null;
}

/**
 * found when a finding names the planted file and a line within 3 of it (the file alone for a removed route). A failed
 * run, a timeout or output that does not parse is no-verdict, never missed.
 */
export function verdictOf(planted: Planted, seat: SeatRun): { result: VerifierResult; findings: Finding[] | null } {
	const findings = seat.code === 0 ? parseFindings(seat.out) : null;
	if (!findings) return { result: "no-verdict", findings: null };
	const hit = findings.some(
		(f) =>
			(f.file === planted.file || f.file.endsWith(`/${planted.file}`)) &&
			(planted.operator === "removed-route" || Math.abs(f.line - planted.line) <= 3),
	);
	return { result: hit ? "found" : "missed", findings };
}

/** Build the review folder, run the seat and record its row. Returns the result, or "dry-run" when no seat started. */
export async function runVerifier(a: {
	root: string;
	db: DatabaseSync;
	rowId: number;
	target: Merged;
	planted: Planted;
	mutant: string;
	dryRun: boolean;
	tmpBase?: string;
	live: Set<ChildProcess>;
}): Promise<VerifierResult | "dry-run"> {
	const folder = buildReview(a.root, a.db, a.target, a.mutant, a.tmpBase);
	try {
		if (a.dryRun) {
			console.log(`evf audit: dry run. No verifier seat started. The seat would run in a new folder with:`);
			console.log(`  claude ${seatArgs("<new session id>").join(" ")}  (environment: PATH, HOME and locale only)`);
			console.log(`  prompt:\n${PROMPT.replace(/^/gm, "    ")}`);
			for (const f of ["task.md", "change.diff"])
				console.log(`  ${f}:\n${readFileSync(join(folder, f), "utf8").replace(/^/gm, "    ")}`);
			return "dry-run";
		}
		const session = randomUUID();
		console.log(`evf audit: starting one verifier seat, session ${session}.`);
		const seat = await runSeatProcess(folder, session, seatEnv(process.env), a.live);
		const { result, findings } = verdictOf(a.planted, seat);
		const usage = readSessionUsage(session);
		a.db
			.prepare(
				"UPDATE audit_runs SET verifier_result = ?, verifier_session = ?, verifier_findings = ?, verifier_usage = ?, verifier_ended_at = ? WHERE id = ?",
			)
			.run(
				result,
				session,
				findings ? JSON.stringify(findings) : null,
				usage ? JSON.stringify(Object.fromEntries(usage)) : null,
				new Date().toISOString(),
				a.rowId,
			);
		return result;
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
