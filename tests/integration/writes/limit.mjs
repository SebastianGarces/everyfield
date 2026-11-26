import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { limitFailure } from "./failures.mjs";

const reporter = fileURLToPath(new URL("./progress.mjs", import.meta.url));

export function censusPhases({ directory, cwd, env, files }) {
	const phases = [];
	const progress = join(directory, "progress.jsonl");
	let active;
	let stopped = false;
	return {
		async run(label, args, nodeOptions) {
			if (stopped) throw Error(`The census stopped before its ${label} phase`);
			phases.push({ label, at: Date.now() });
			const child = spawn(process.execPath, args, {
				cwd,
				env: { ...env, NODE_OPTIONS: nodeOptions.join(" ") },
				stdio: ["ignore", "pipe", "pipe"],
			});
			const evidence = join(directory, label + ".log");
			let log = "";
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (chunk) => {
					log += chunk;
					appendFileSync(evidence, chunk);
				});
			const exited = new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("exit", resolve);
			});
			active = { child, exited };
			const exit = await exited;
			active = undefined;
			return { exit, log, evidence };
		},
		reporters: [
			"--test-reporter=spec",
			"--test-reporter-destination=stdout",
			"--test-reporter=" + reporter,
			"--test-reporter-destination=" + progress,
		],
		failure(limit) {
			const log = existsSync(progress) ? readFileSync(progress, "utf8") : "";
			const rows = log
				.split("\n")
				.slice(0, -1)
				.map((line) => JSON.parse(line));
			return limitFailure({ limit, directory, phases, files, rows, now: Date.now(), load: loadavg() });
		},
		async stop() {
			stopped = true;
			if (!active?.child.pid) return;
			killTree(active.child.pid);
			await active.exited;
		},
	};
}

export async function withinLimit(t, limit, phases, body) {
	let outcome;
	let failure;
	await t.test("the census run, stopped at its time limit", { timeout: limit }, async (run) => {
		run.signal.addEventListener("abort", () => {
			if (!outcome) failure = phases.failure(limit);
		});
		run.after(() => phases.stop());
		outcome = await body().then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
	});
	if (failure) throw Error(failure);
	if (outcome.error) throw outcome.error;
	return outcome.value;
}

function killTree(root) {
	const frozen = new Set();
	for (let found = [root]; found.length; found = childrenOf(frozen).filter((pid) => !frozen.has(pid)))
		for (const pid of found) {
			frozen.add(pid);
			signal(pid, "SIGSTOP");
		}
	for (const pid of frozen) signal(pid, "SIGKILL");
}

function childrenOf(parents) {
	return execFileSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([, parent]) => parents.has(parent))
		.map(([pid]) => pid);
}

function signal(pid, name) {
	try {
		process.kill(pid, name);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}
