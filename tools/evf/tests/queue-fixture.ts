import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixture, source } from "./fixtures.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { evfDataDir, parseTask, type Config } from "../lib.ts";

/** The disposable repository, seat commands and slot holders of the full check queue tests (OPS-138, OPS-151). */

export const MAIN = join(source, "tools/evf/main.ts"),
	task = parseTask("OPS-1");
export const node = (js: string) => [process.execPath, "-e", js];
export const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
export async function until(what: string, ready: () => boolean, ms = 20_000) {
	const start = Date.now();
	while (!ready()) {
		if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
		await delay(20);
	}
}

export type Running = { child: ChildProcess; out: () => string; err: () => string; done: Promise<number | null> };
export function watch(child: ChildProcess): Running {
	let out = "",
		err = "";
	child.stdout?.on("data", (d) => (out += d));
	child.stderr?.on("data", (d) => (err += d));
	return {
		child,
		out: () => out,
		err: () => err,
		done: new Promise((done) => child.on("close", (code) => done(code))),
	};
}

/** Three preloads for `NODE_OPTIONS`: always over the limit, over it at the first read, and over it only inside a gate. */
const LOADS = {
	high: "const read = () => 50;",
	falling: "let reads = 0; const read = () => (reads++ ? 0 : 50);",
	inside: "const read = () => (process.env.EVF_LOAD_GATE_ROOT ? 50 : 0);",
};

export function queueFixture(checks?: Array<{ name: string; run: string[]; modes?: string[] }>) {
	const f = fixture();
	const own = checks ?? [{ name: "own", run: node('require("node:fs").writeFileSync(process.env.EVF_RAN_FILE,"")') }];
	f.cfg.maintenanceTasks = { "OPS-1": { title: "Queue", owningPaths: ["tools/evf/"], checks: own } };
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	// `evf test` reads the package scripts and the CI workflow before it runs.
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
	mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
	writeFileSync(join(f.root, ".github/workflows/ci.yml"), "jobs: {}\n");
	f.git("add", "package.json", ".github");
	f.commit();
	const wt = f.task("ops-1");
	const db = openWorkDb(f.root);
	ensureTask(db, task, "implement");
	db.prepare("UPDATE tasks SET worktree = ?, status = 'active' WHERE ref = ?").run(wt, task.id);
	db.close();
	const dir = join(evfDataDir(f.root), "check-queue"),
		ran = join(f.root, "fake-bin/ran"),
		children: ChildProcess[] = [];
	mkdirSync(dir, { recursive: true });
	const preloads = Object.fromEntries(
		Object.entries(LOADS).map(([name, source]) => {
			const path = join(f.root, `fake-bin/load-${name}.mjs`);
			writeFileSync(
				path,
				`import os from "node:os";\nimport { syncBuiltinESMExports } from "node:module";\n${source}\nos.loadavg = () => [read(), read(), read()];\nsyncBuiltinESMExports();\n`,
			);
			return [name, path];
		}),
	) as Record<keyof typeof LOADS, string>;
	const setLoad = (machineLoad: NonNullable<Config["machineLoad"]>) =>
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify({ ...f.cfg, machineLoad }));
	/** An evf command as a seat starts it, with the state of any outer test run taken out. */
	const cli = (cwd: string, args: string[], load?: keyof typeof LOADS, env: NodeJS.ProcessEnv = {}) => {
		const child = spawn(process.execPath, [MAIN, ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				EVF_RUN: "",
				EVF_FOREGROUND: "1",
				EVF_RAN_FILE: ran,
				CI: "",
				EVF_LOAD_GATE_ROOT: "",
				GITHUB_ACTIONS: "",
				EVF_CHECK_SLOT: "",
				EVF_FAILED_TESTS: undefined,
				EVF_TEST_REPORT: undefined,
				NODE_TEST_CONTEXT: undefined,
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${load ? ` --import=${preloads[load]}` : ""}`,
				...env,
			},
		});
		children.push(child);
		return watch(child);
	};
	/** A live process with a ticket ahead of every new arrival: a running full check for the queue. */
	const holder = (n: number) => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
		children.push(child);
		writeFileSync(
			join(dir, ticketName(n)),
			JSON.stringify({ pid: child.pid, task: `OPS-H${n}`, at: new Date().toISOString() }),
		);
		return child;
	};
	const stop = async (child: ChildProcess) => {
		const gone = new Promise((done) => child.once("exit", done));
		child.kill("SIGKILL");
		await gone;
	};
	return {
		...f,
		wt,
		dir,
		ran,
		cli,
		holder,
		stop,
		setLoad,
		preloads,
		tickets: () => readdirSync(dir).sort(),
		events: (type: string) => {
			const store = openWorkDb(f.root);
			try {
				return (
					store.prepare("SELECT payload FROM events WHERE type = ? ORDER BY id").all(type) as Array<{ payload: string }>
				).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
			} finally {
				store.close();
			}
		},
		commitFiles: (files: Record<string, string>, into = wt) => {
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(into, path)), { recursive: true });
				writeFileSync(join(into, path), text);
			}
			const git = (...args: string[]) => f.git("-C", into, ...args);
			git("add", "--", ...Object.keys(files));
			git("commit", "-qm", "stub");
		},
		setSpec: (spec: string) => {
			const store = openWorkDb(f.root);
			store.prepare("UPDATE tasks SET spec = ? WHERE ref = ?").run(spec, task.id);
			store.close();
		},
		overrides: () => {
			const path = join(evfDataDir(f.root), "load-overrides.jsonl");
			return existsSync(path)
				? readFileSync(path, "utf8")
						.trim()
						.split("\n")
						.map((l) => JSON.parse(l) as { command: string; reason: string })
				: [];
		},
		finish: async () => {
			for (const child of children) child.kill("SIGKILL");
			f.close();
		},
	};
}

export const ticketName = (n: number) => `${String(n).padStart(15, "0")}.json`;
export const STUB_TESTS = `import test from "node:test";\ntest("alpha", () => {});\ntest("beta", () => {});\n`;
export const specOf = (marker: string) =>
	`Goal: g.\nDone criteria:\n1. One.\n   Check: AC:${marker}\nNon-goals: none.\n`;
export const TOOL_STUB = `import test from "node:test";\ntest("tool (AC:OPS-1-1)", () => {});\n`;
export const UI_STUB = `import test from "node:test";\ntest("browser (AC:OPS-1-1)", () => {});\n`;

export function preview(f: ReturnType<typeof queueFixture>) {
	const list = join(f.root, "fake-bin/previews.json");
	writeFileSync(
		list,
		JSON.stringify([{ project: f.wt, state: "ready", head: f.git("-C", f.wt, "rev-parse", "HEAD"), url: "https://x" }]),
	);
	writeFileSync(
		join(f.root, "fake-bin/portless"),
		`#!${process.execPath}\nprocess.stdout.write(require("node:fs").readFileSync(${JSON.stringify(list)},"utf8"));\n`,
		{ mode: 0o755 },
	);
}
