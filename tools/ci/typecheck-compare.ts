import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { availableParallelism, cpus, loadavg, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { outcomeOf, parseDiagnostics, typecheckPackages, type Outcome } from "./typecheck.ts";

/**
 * Time TypeScript 7 (the `typecheck` scripts' tsc), TypeScript 6 (each package's own `typescript`, which lint, Next and
 * the reference build still need) and bun check on each typecheck package (T-53, T-252).
 * `node tools/ci/typecheck-compare.ts [--runs 3] [--package packages/ui]...`
 * Each run records the 1-minute load average before it starts, wall time, CPU time (user + system, children
 * included) and peak resident memory, from /usr/bin/time. ts6 and ts7 run with --incremental false, so every run
 * is a full check, as on a fresh checkout or in GitHub CI.
 */

type Tool = "ts6" | "ts7" | "bun";
const TOOLS: Tool[] = ["ts6", "ts7", "bun"];

export type Measurement = {
	package: string;
	tool: Tool;
	run: number;
	load: number;
	wall_s: number;
	cpu_s: number;
	peak_mb: number;
	exit: number | null;
	outcome: Outcome;
	errors: number;
};

function commands(root: string, dir: string): Record<Tool, string[]> {
	const ts6 = join(root, dir, "node_modules/typescript/bin/tsc");
	const ts7 = join(root, "node_modules/typescript-7/bin/tsc");
	const bun = join(realpathSync(join(root, "node_modules/bun")), "bin/bun.exe");
	for (const bin of [ts6, ts7, bun]) if (!existsSync(bin)) throw new Error(`missing ${bin}; run pnpm install`);
	return {
		ts6: [ts6, "--noEmit", "--pretty", "false", "--incremental", "false"],
		ts7: [ts7, "--noEmit", "--pretty", "false", "--incremental", "false"],
		bun: [bun, "check", "--no-script", "--no-pretty", "--all"],
	};
}

/** Parse /usr/bin/time's report: BSD `-l` gives bytes, GNU `-v` gives kilobytes. */
export function parseTime(stderr: string): { cpu_s: number; peak_mb: number } {
	const bsd = stderr.match(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/);
	const bsdRss = stderr.match(/(\d+)\s+maximum resident set size/);
	if (bsd && bsdRss) return { cpu_s: Number(bsd[2]) + Number(bsd[3]), peak_mb: Number(bsdRss[1]) / 2 ** 20 };
	const user = stderr.match(/User time \(seconds\): ([\d.]+)/);
	const sys = stderr.match(/System time \(seconds\): ([\d.]+)/);
	const rss = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
	if (user && sys && rss) return { cpu_s: Number(user[1]) + Number(sys[1]), peak_mb: Number(rss[1]) / 1024 };
	throw new Error(`could not read /usr/bin/time output:\n${stderr.slice(-2000)}`);
}

function measure(
	command: string[],
	cwd: string,
): Promise<{ wall_s: number; cpu_s: number; peak_mb: number; exit: number | null; output: string }> {
	const flag = platform() === "darwin" ? "-l" : "-v";
	const started = performance.now();
	return new Promise((done, fail) => {
		let stdout = "",
			stderr = "";
		const child = spawn("/usr/bin/time", [flag, ...command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (c: Buffer) => (stdout += c));
		child.stderr.on("data", (c: Buffer) => (stderr += c));
		child.on("error", fail);
		child.on("close", (exit) => {
			const wall_s = (performance.now() - started) / 1000;
			try {
				done({ wall_s, ...parseTime(stderr), exit, output: stdout + stderr });
			} catch (error) {
				fail(error);
			}
		});
	});
}

function version(command: string[]): string {
	const run = spawnSync(command[0], ["--version"], { encoding: "utf8" });
	return (run.stdout || run.stderr).trim().split("\n")[0] ?? "?";
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const f1 = (n: number) => n.toFixed(1);

export function table(rows: Measurement[], header: string[]): string {
	const out = [...header, ""];
	out.push("### Medians per package", "");
	out.push(
		"| Package | Tool | Wall s | CPU s | Peak MB | Load at runs | Errors |",
		"|---|---|---:|---:|---:|---|---:|",
	);
	const packages = [...new Set(rows.map((r) => r.package))];
	for (const pkg of packages)
		for (const tool of TOOLS) {
			const runs = rows.filter((r) => r.package === pkg && r.tool === tool);
			if (!runs.length) continue;
			out.push(
				`| ${pkg} | ${tool} | ${f1(median(runs.map((r) => r.wall_s)))} | ${f1(median(runs.map((r) => r.cpu_s)))} | ${Math.round(median(runs.map((r) => r.peak_mb)))} | ${runs.map((r) => f1(r.load)).join(", ")} | ${runs.map((r) => r.errors).join(", ")} |`,
			);
		}
	out.push(
		"",
		"### Totals (sum of package medians)",
		"",
		"| Tool | Wall s | CPU s | Max peak MB |",
		"|---|---:|---:|---:|",
	);
	for (const tool of TOOLS) {
		const per = packages.map((pkg) => rows.filter((r) => r.package === pkg && r.tool === tool));
		out.push(
			`| ${tool} | ${f1(per.reduce((n, runs) => n + median(runs.map((r) => r.wall_s)), 0))} | ${f1(per.reduce((n, runs) => n + median(runs.map((r) => r.cpu_s)), 0))} | ${Math.round(Math.max(...per.map((runs) => median(runs.map((r) => r.peak_mb)))))} |`,
		);
	}
	out.push("", "### Every run", "", "| Package | Tool | Run | Load | Wall s | CPU s | Peak MB | Exit | Errors |");
	out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
	for (const r of rows)
		out.push(
			`| ${r.package} | ${r.tool} | ${r.run} | ${f1(r.load)} | ${f1(r.wall_s)} | ${f1(r.cpu_s)} | ${Math.round(r.peak_mb)} | ${r.exit} | ${r.errors} |`,
		);
	return out.join("\n") + "\n";
}

export async function compare(
	root: string,
	packages: string[],
	runs: number,
): Promise<{ rows: Measurement[]; markdown: string }> {
	const rows: Measurement[] = [];
	for (let run = 1; run <= runs; run++)
		for (const dir of packages) {
			const cmd = commands(root, dir);
			for (const tool of TOOLS) {
				const load = loadavg()[0];
				const m = await measure(cmd[tool], join(root, dir));
				const row: Measurement = {
					package: dir,
					tool,
					run,
					load,
					wall_s: m.wall_s,
					cpu_s: m.cpu_s,
					peak_mb: m.peak_mb,
					exit: m.exit,
					// tsc's 1 and 2 and bun's 1 are all "errors".
					outcome: outcomeOf(m.exit, false),
					errors: parseDiagnostics(m.output).length,
				};
				rows.push(row);
				console.error(
					`${dir} ${tool} run ${run}: load ${f1(load)}, ${f1(row.wall_s)} s wall, ${f1(row.cpu_s)} s CPU, ${Math.round(row.peak_mb)} MB, ${row.outcome}`,
				);
			}
		}
	const cmd = commands(root, packages[0]);
	const header = [
		`## Typecheck comparison, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
		"",
		`${platform()} ${release()}, ${cpus()[0]?.model ?? "?"}, ${availableParallelism()} cores, ${Math.round(totalmem() / 2 ** 30)} GB. ` +
			`ts6 ${version(cmd.ts6)}, ts7 ${version(cmd.ts7)}, bun ${version(cmd.bun)}. ${runs} runs per package, tools interleaved. ` +
			"Load is the 1-minute load average when each run started. CPU is user plus system time. ts6 and ts7 ran with --incremental false.",
	];
	return { rows, markdown: table(rows, header) };
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			runs: { type: "string", default: "3" },
			package: { type: "string", multiple: true },
		},
	});
	const root = resolve(import.meta.dirname, "../..");
	const packages = values.package?.length
		? values.package
		: typecheckPackages(root)
				.filter((p) => p.scripts["typecheck:bun"])
				.map((p) => p.dir);
	const { rows, markdown } = await compare(root, packages, Number(values.runs));
	process.stdout.write(markdown);
	if (rows.some((r) => r.outcome !== "pass" && r.outcome !== "errors")) process.exitCode = 1;
}
