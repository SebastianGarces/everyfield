import { spawn } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `pnpm typecheck`: each package's `typecheck` script, which runs the pinned `bun check` (T-110, D-961, on the T-109
 * shadow data). It prints every package's diagnostics and exits 1 when any package has type errors, or its bun check
 * is missing, crashes or times out. `pnpm typecheck:tsc` runs each package's `typecheck:tsc` (TypeScript 7), which
 * GitHub CI's `Types` step keeps as the backstop. After the packages, `pnpm typecheck` runs the root `typecheck:tools`
 * script over the tool folders (tsconfig.tools.json, T-176), and the run fails if either fails. The helpers below also
 * serve typecheck-compare.ts and typecheck-corpus.ts.
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
		if (located) found.push({ file: located[1]!, line: Number(located[2]), code: located[3]! });
		else {
			const global = line.match(GLOBAL);
			if (global) found.push({ file: "", line: 0, code: global[1]! });
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

/** The root `typecheck:tools` script, streamed to this process. Resolves to its exit code, or 0 when there is none. */
function typecheckTools(root: string): Promise<number> {
	const script: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.["typecheck:tools"];
	if (typeof script !== "string") return Promise.resolve(0);
	return new Promise<number>((done) => {
		const child = spawn("sh", ["-c", script], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
		child.on("error", (error) => {
			console.error(`typecheck: could not start typecheck:tools: ${String(error)}`);
			done(1);
		});
		child.on("close", (code) => {
			if (code !== 0) console.error(`typecheck:tools failed (exit ${code ?? "signal"}).`);
			done(code ?? 1);
		});
	});
}

/** Run every package's `typecheck` script in turn and resolve to the exit code: 0 only when every package passed. */
export async function typecheck(root: string): Promise<number> {
	const packages = typecheckPackages(root);
	if (!packages.length) {
		console.error("typecheck: no package has a typecheck script.");
		return 1;
	}
	const timeoutMs = Number(process.env.TYPECHECK_TIMEOUT_MS) || 120_000;
	const failed: string[] = [];
	for (const pkg of packages) {
		const run = await runScript(pkg.scripts.typecheck!, join(root, pkg.dir), timeoutMs);
		for (const line of run.output.trimEnd().split(/\r?\n/)) if (line) console.log(`${pkg.dir} typecheck: ${line}`);
		if (run.outcome === "pass") continue;
		const why = {
			errors: "type errors",
			crash: `crashed (exit ${run.code})`,
			timeout: `timed out after ${timeoutMs} ms`,
			missing: "bun check is missing; run pnpm install",
		}[run.outcome];
		failed.push(`${pkg.dir}: ${why}`);
	}
	if (failed.length)
		console.error(`typecheck failed in ${failed.length} of ${packages.length} packages:\n  ${failed.join("\n  ")}`);
	else console.error(`typecheck: bun check found no type errors in ${packages.length} packages.`);
	const toolsExit = await typecheckTools(root);
	return failed.length ? 1 : toolsExit;
}

if (import.meta.main) process.exitCode = await typecheck(process.cwd());
