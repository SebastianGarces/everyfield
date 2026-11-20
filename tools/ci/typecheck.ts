import { spawn } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Diagnostic = { file: string; line: number; code: string };

export type Outcome = "pass" | "errors" | "crash" | "timeout" | "missing";

export function outcomeOf(code: number | null, timedOut: boolean): Outcome {
	if (timedOut) return "timeout";
	if (code === 0) return "pass";
	if (code === 1 || code === 2) return "errors";
	if (code === 126 || code === 127) return "missing";
	return "crash";
}

const ANSI = /\x1b\[[0-9;]*m/g;
const LOCATED = /^(.+?)\((\d+),\d+\): error (TS\d+):/;
const GLOBAL = /^error (TS\d+):/;

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

export function typecheckPackages(root: string, script = "typecheck"): WorkspacePackage[] {
	return globSync(["apps/*/package.json", "packages/*/package.json"], { cwd: root })
		.sort()
		.map((file) => {
			const pkg: { scripts?: Record<string, string> } = JSON.parse(readFileSync(join(root, file), "utf8"));
			return { dir: dirname(file), scripts: pkg.scripts ?? {} };
		})
		.filter((p) => typeof p.scripts[script] === "string");
}

export type ScriptRun = {
	code: number | null;
	timedOut: boolean;
	output: string;
	wallMs: number;
	outcome: Outcome;
};

export function runScript(
	script: string,
	cwd: string,
	timeoutMs: number,
	onLine: (line: string) => void = () => {},
): Promise<ScriptRun> {
	const started = performance.now();
	return new Promise((done) => {
		let output = "",
			pending = "",
			timedOut = false;
		const take = (chunk: Buffer | string) => {
			output += chunk;
			const lines = (pending + chunk).split(/\r?\n/);
			pending = lines.pop()!;
			for (const line of lines) if (line) onLine(line);
		};
		const child = spawn("sh", ["-c", script], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, timeoutMs);
		const finish = (code: number | null) => {
			clearTimeout(timer);
			if (pending) onLine(pending);
			pending = "";
			const wallMs = Math.round(performance.now() - started);
			done({ code, timedOut, output, wallMs, outcome: outcomeOf(code, timedOut) });
		};
		child.on("error", (error) => {
			take(`${String(error)}\n`);
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

export const TOOLS_SCRIPT = /^node tools\/ci\/typecheck\.ts typecheck:tools -p ((?:\S+\.json ?)+)$/;

export function toolsProjects(script: string): string[] | undefined {
	return TOOLS_SCRIPT.exec(script.trim())?.[1]!.trim().split(" ");
}

export async function runTools(root: string, projects: string[], prefix = ""): Promise<number> {
	const budgetMs = Number(process.env.TYPECHECK_TOOLS_TIMEOUT_MS) || 300_000;
	const deadline = performance.now() + budgetMs;
	let exit = 0;
	for (const project of projects) {
		console.log(`${prefix}tsc -p ${project}`);
		const run = await runScript(
			`node_modules/typescript-7/bin/tsc --noEmit -p '${project}' --checkers 2`,
			root,
			Math.max(1, Math.round(deadline - performance.now())),
			(line) => console.log(`${prefix}${line}`),
		);
		if (run.outcome === "pass") continue;
		if (run.outcome === "timeout") {
			console.error(`typecheck:tools timed out after ${budgetMs} ms in ${project}; its process group was killed.`);
			return 1;
		}
		console.error(`typecheck:tools failed in ${project} (exit ${run.code ?? "signal"}).`);
		exit ||= run.code || 1;
	}
	return exit;
}

async function typecheckTools(root: string): Promise<number> {
	const script: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts?.["typecheck:tools"];
	if (typeof script !== "string") return 0;
	const projects = toolsProjects(script);
	if (!projects) {
		console.error(
			"typecheck:tools must read `node tools/ci/typecheck.ts typecheck:tools -p <tsconfig.json>...`, so pnpm typecheck and fast-check share its project list.",
		);
		return 1;
	}
	return runTools(root, projects, "typecheck:tools: ");
}

export type TypecheckScript = "typecheck" | "typecheck:bun";

export async function typecheck(root: string, script: TypecheckScript = "typecheck"): Promise<number> {
	const packages = typecheckPackages(root, script);
	if (!packages.length) {
		console.error(`${script}: no package has a ${script} script.`);
		return 1;
	}
	const checker = script === "typecheck" ? "tsc" : "bun check";
	const timeoutMs = Number(process.env.TYPECHECK_TIMEOUT_MS) || 120_000;
	const failed: string[] = [];
	for (const pkg of packages) {
		console.log(`${pkg.dir} ${script}: started`);
		const run = await runScript(pkg.scripts[script]!, join(root, pkg.dir), timeoutMs, (line) =>
			console.log(`${pkg.dir} ${script}: ${line}`),
		);
		if (run.outcome === "pass") continue;
		const why = {
			errors: "type errors",
			crash: `crashed (exit ${run.code})`,
			timeout: `timed out after ${timeoutMs} ms`,
			missing: `${checker} is missing; run pnpm install`,
		}[run.outcome];
		failed.push(`${pkg.dir}: ${why}`);
	}
	if (failed.length)
		console.error(`${script} failed in ${failed.length} of ${packages.length} packages:\n  ${failed.join("\n  ")}`);
	else console.error(`${script}: ${checker} found no type errors in ${packages.length} packages.`);
	if (script === "typecheck:bun") return failed.length ? 1 : 0;
	const toolsExit = await typecheckTools(root);
	return failed.length ? 1 : toolsExit;
}

if (import.meta.main) {
	const [script = "typecheck", ...rest] = process.argv.slice(2);
	const projects = rest[0] === "-p" ? rest.slice(1).filter((p) => p.endsWith(".json")) : [];
	if (script === "typecheck:tools" && projects.length && projects.length === rest.length - 1)
		process.exitCode = await runTools(process.cwd(), projects);
	else if (rest.length || (script !== "typecheck" && script !== "typecheck:bun")) {
		console.error("usage: node tools/ci/typecheck.ts [typecheck|typecheck:bun|typecheck:tools -p <tsconfig.json>...]");
		process.exitCode = 2;
	} else process.exitCode = await typecheck(process.cwd(), script);
}
