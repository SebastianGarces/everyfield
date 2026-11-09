import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, globSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

/**
 * `pnpm typecheck`: tsc in every package, as before, and `bun check` beside it as a shadow (T-53).
 * tsc alone decides the exit code. The shadow prints one `typecheck-shadow {json}` line per run and,
 * outside CI, appends it to a log outside the repository, so that the data can later decide whether
 * `bun check` may replace tsc.
 */

export type Diagnostic = { file: string; line: number; code: string };

/** How one checker run ended. tsc exits 1 or 2 on type errors and bun check exits 1: all of them are "errors". */
export type Outcome = "pass" | "errors" | "crash" | "timeout" | "missing";

export function outcomeOf(code: number | null, timedOut: boolean): Outcome {
	if (timedOut) return "timeout";
	if (code === 0) return "pass";
	if (code === 1 || code === 2) return "errors";
	// The shell's "not found" and "not executable".
	if (code === 126 || code === 127) return "missing";
	return "crash";
}

const ANSI = /\x1b\[[0-9;]*m/g;
const LOCATED = /^(.+?)\((\d+),\d+\): error (TS\d+):/;
const GLOBAL = /^error (TS\d+):/;

/** The error lines of `tsc --pretty false` or `bun check --no-pretty`. Continuation lines carry no location. */
export function parseDiagnostics(text: string): Diagnostic[] {
	const found: Diagnostic[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(ANSI, "");
		const located = line.match(LOCATED);
		if (located) found.push({ file: located[1], line: Number(located[2]), code: located[3] });
		else {
			const global = line.match(GLOBAL);
			if (global) found.push({ file: "", line: 0, code: global[1] });
		}
	}
	return found;
}

export const diagnosticKey = (d: Diagnostic): string => `${d.file}:${d.line}:${d.code}`;

/** Diagnostics one side reports more often than the other, compared by file, line and code. */
export function diffDiagnostics(tsc: Diagnostic[], bun: Diagnostic[]): Array<Diagnostic & { only: "tsc" | "bun" }> {
	const counts = new Map<string, { d: Diagnostic; n: number }>();
	for (const d of tsc) {
		const entry = counts.get(diagnosticKey(d)) ?? { d, n: 0 };
		entry.n++;
		counts.set(diagnosticKey(d), entry);
	}
	for (const d of bun) {
		const entry = counts.get(diagnosticKey(d)) ?? { d, n: 0 };
		entry.n--;
		counts.set(diagnosticKey(d), entry);
	}
	const out: Array<Diagnostic & { only: "tsc" | "bun" }> = [];
	for (const { d, n } of [...counts.values()].sort((a, b) => diagnosticKey(a.d).localeCompare(diagnosticKey(b.d))))
		for (let i = 0; i < Math.abs(n); i++) out.push({ ...d, only: n > 0 ? "tsc" : "bun" });
	return out;
}

export type WorkspacePackage = { dir: string; scripts: Record<string, string> };

/** The workspace packages with a `typecheck` script, which is the set `pnpm -r --if-present typecheck` runs. */
export function typecheckPackages(root: string): WorkspacePackage[] {
	return globSync(["apps/*/package.json", "packages/*/package.json"], { cwd: root })
		.sort()
		.map((file) => {
			const pkg: { scripts?: Record<string, string> } = JSON.parse(readFileSync(join(root, file), "utf8"));
			return { dir: dirname(file), scripts: pkg.scripts ?? {} };
		})
		.filter((p) => typeof p.scripts.typecheck === "string");
}

export type ScriptRun = {
	code: number | null;
	timedOut: boolean;
	output: string;
	wallMs: number;
	outcome: Outcome;
};

/** Run a package script as pnpm would, in its own process group so that a timeout stops every child. */
export function runScript(script: string, cwd: string, timeoutMs: number): Promise<ScriptRun> {
	const started = performance.now();
	return new Promise((done) => {
		let output = "",
			timedOut = false;
		const child = spawn("sh", ["-c", script], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk: Buffer) => (output += chunk));
		child.stderr.on("data", (chunk: Buffer) => (output += chunk));
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group has already gone.
			}
		}, timeoutMs);
		const finish = (code: number | null) => {
			clearTimeout(timer);
			const wallMs = Math.round(performance.now() - started);
			done({ code, timedOut, output, wallMs, outcome: outcomeOf(code, timedOut) });
		};
		child.on("error", (error) => {
			output += String(error);
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

const WORST: Outcome[] = ["pass", "errors", "crash", "timeout", "missing"];

type PackageResult = {
	dir: string;
	tsc: { outcome: "pass" | "errors" | "unknown"; errors: number };
	bun: { outcome: Outcome; exit: number | null; errors: number; wall_ms: number };
	mismatch: "yes" | "no";
	differences_total: number;
	differences: Array<Diagnostic & { only: "tsc" | "bun" }>;
};

export type ShadowResult = {
	v: 1;
	at: string;
	commit: string | null;
	dirty: boolean | null;
	ci: boolean;
	tsc: { exit: number; errors: number; wall_ms: number };
	bun: { exit: number | null; outcome: Outcome; errors: number; wall_ms: number };
	mismatch: "yes" | "no";
	packages: PackageResult[];
	shadow_error?: string;
};

/** Split pnpm's prefixed `pnpm -r` output into each package's tsc output and status. */
function tscByPackage(
	output: string,
	dirs: string[],
): Map<string, { text: string; status: "pass" | "errors" | "unknown" }> {
	const result = new Map(dirs.map((dir) => [dir, { text: "", status: "unknown" as "pass" | "errors" | "unknown" }]));
	for (const line of output.replace(ANSI, "").split(/\r?\n/)) {
		for (const dir of dirs) {
			const prefix = `${dir} typecheck: `;
			if (!line.startsWith(prefix)) continue;
			const rest = line.slice(prefix.length);
			const entry = result.get(dir)!;
			if (rest === "Done") entry.status = "pass";
			else if (rest === "Failed") entry.status = "errors";
			else entry.text += rest + "\n";
		}
	}
	return result;
}

/** Compare one package's tsc and bun results. A bun run that gave no verdict counts as a mismatch. */
export function comparePackage(
	dir: string,
	tsc: { text: string; status: "pass" | "errors" | "unknown" },
	bun: ScriptRun | undefined,
): PackageResult {
	const tscDiagnostics = parseDiagnostics(tsc.text);
	const bunDiagnostics = bun ? parseDiagnostics(bun.output) : [];
	const differences = diffDiagnostics(tscDiagnostics, bunDiagnostics);
	const bunOutcome: Outcome = bun?.outcome ?? "missing";
	const mismatch =
		tsc.status === "unknown" ||
		!(bunOutcome === "pass" || bunOutcome === "errors") ||
		tsc.status !== bunOutcome ||
		differences.length > 0 ||
		(tsc.status === "errors" && tscDiagnostics.length === 0);
	return {
		dir,
		tsc: { outcome: tsc.status, errors: tscDiagnostics.length },
		bun: { outcome: bunOutcome, exit: bun?.code ?? null, errors: bunDiagnostics.length, wall_ms: bun?.wallMs ?? 0 },
		mismatch: mismatch ? "yes" : "no",
		differences_total: differences.length,
		differences: differences.slice(0, 20),
	};
}

function git(root: string, args: string[]): string | null {
	const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
	return run.status === 0 ? run.stdout.trim() : null;
}

/** The shadow log, outside the repository. `EVERYFIELD_TYPECHECK_LOG` overrides it. */
export function shadowLogPath(): string {
	if (process.env.EVERYFIELD_TYPECHECK_LOG) return resolve(process.env.EVERYFIELD_TYPECHECK_LOG);
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "everyfield", "typecheck-shadow.jsonl");
}

async function shadow(root: string, tscOutput: string, tscExit: number, tscWallMs: number): Promise<ShadowResult> {
	const packages = typecheckPackages(root);
	const timeoutMs = Number(process.env.TYPECHECK_BUN_TIMEOUT_MS) || 120_000;
	const tsc = tscByPackage(
		tscOutput,
		packages.map((p) => p.dir),
	);
	const results: PackageResult[] = [];
	for (const pkg of packages) {
		const script = pkg.scripts["typecheck:bun"];
		const bun = script === undefined ? undefined : await runScript(script, join(root, pkg.dir), timeoutMs);
		results.push(comparePackage(pkg.dir, tsc.get(pkg.dir)!, bun));
	}
	const worst = results.reduce<Outcome>(
		(acc, r) => (WORST.indexOf(r.bun.outcome) > WORST.indexOf(acc) ? r.bun.outcome : acc),
		"pass",
	);
	const head = git(root, ["rev-parse", "HEAD"]);
	const status = head === null ? null : git(root, ["status", "--porcelain", "--untracked-files=no"]);
	return {
		v: 1,
		at: new Date().toISOString(),
		commit: head,
		dirty: status === null ? null : status.length > 0,
		ci: Boolean(process.env.CI),
		tsc: { exit: tscExit, errors: results.reduce((n, r) => n + r.tsc.errors, 0), wall_ms: tscWallMs },
		bun: {
			exit: results.find((r) => r.bun.outcome === worst)?.bun.exit ?? 0,
			outcome: worst,
			errors: results.reduce((n, r) => n + r.bun.errors, 0),
			wall_ms: results.reduce((n, r) => n + r.bun.wall_ms, 0),
		},
		mismatch: results.some((r) => r.mismatch === "yes") ? "yes" : "no",
		packages: results,
	};
}

function record(root: string, result: ShadowResult): void {
	const line = `typecheck-shadow ${JSON.stringify(result)}`;
	console.log(line);
	const verdict =
		result.mismatch === "no"
			? `bun check matched tsc in ${result.packages.length} packages`
			: `bun check differed from tsc in ${result.packages
					.filter((p) => p.mismatch === "yes")
					.map((p) => `${p.dir} (bun ${p.bun.outcome}, ${p.differences_total} differences)`)
					.join(", ")}${result.shadow_error ? ` (${result.shadow_error})` : ""}`;
	console.error(
		`typecheck-shadow: ${verdict}. tsc ${(result.tsc.wall_ms / 1000).toFixed(1)} s, bun check ${(result.bun.wall_ms / 1000).toFixed(1)} s. tsc alone sets the exit code.`,
	);
	if (result.ci) return;
	const log = shadowLogPath();
	if (!relative(root, log).startsWith("..")) {
		console.error(`typecheck-shadow: not logging to ${log}, which is inside the repository.`);
		return;
	}
	try {
		mkdirSync(dirname(log), { recursive: true });
		appendFileSync(log, `${JSON.stringify(result)}\n`);
	} catch (error) {
		console.error(`typecheck-shadow: could not append to ${log}: ${String(error)}`);
	}
}

/** Run tsc through pnpm as before, then the shadow. Resolves to tsc's exit code, whatever the shadow does. */
export async function typecheck(root: string): Promise<number> {
	const started = performance.now();
	let output = "";
	const tscExit = await new Promise<number>((done) => {
		const child = spawn("pnpm", ["-r", "--if-present", "--no-bail", "typecheck"], {
			cwd: root,
			stdio: ["inherit", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
		child.on("error", (error) => {
			console.error(`typecheck: could not start pnpm: ${String(error)}`);
			done(1);
		});
		child.on("close", (code) => done(code ?? 1));
	});
	const tscWallMs = Math.round(performance.now() - started);
	let result: ShadowResult;
	try {
		result = await shadow(root, output, tscExit, tscWallMs);
	} catch (error) {
		result = {
			v: 1,
			at: new Date().toISOString(),
			commit: null,
			dirty: null,
			ci: Boolean(process.env.CI),
			tsc: { exit: tscExit, errors: parseDiagnostics(output).length, wall_ms: tscWallMs },
			bun: { exit: null, outcome: "crash", errors: 0, wall_ms: 0 },
			mismatch: "yes",
			packages: [],
			shadow_error: String(error),
		};
	}
	try {
		record(root, result);
	} catch (error) {
		console.error(`typecheck-shadow: could not record the result: ${String(error)}`);
	}
	return tscExit;
}

if (import.meta.main) process.exitCode = await typecheck(process.cwd());
