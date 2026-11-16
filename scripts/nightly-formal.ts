import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { appendFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { engineVerdict } from "./nightly-ui.ts";

const REPLAY_TEST = "../../tests/integration/access/formal-replay.test.mts";
const DISAGREES = /Behavior \d+ of \d+ \(seed \d+, [^)]*\) disagrees at step \d+ of \d+/;

export const reproduce = (seed: number, commit: string) => {
	const dir = `/tmp/formal-seed-${seed}`;
	return `git checkout ${commit}, then bin/dev formal --traces ${dir} --seed ${seed}, then cd packages/domain && FORMAL_TRACES=${dir} npx tsx --conditions=react-server --test ${REPLAY_TEST}`;
};

export type Run = { status: number | null; output: string };

export type FormalDeps = {
	seed: number;
	commit: string;
	dir: string;
	generate: (traces: string, seed: number) => Promise<Run>;
	readTraces: (traces: string) => { behaviors: unknown[][] } | null;
	database: () => Promise<string | null>;
	replay: (traces: string, log: string) => Promise<Run>;
	log: (line: string) => void;
	summary: (lines: string[]) => void;
};

export function replayVerdict(run: Run): "green" | "disagreement" | string {
	const { run: counts, reason } = engineVerdict(run.output);
	if (!counts) return "the replay crashed before node:test printed a summary";
	if (counts.tests === 0) return "no replay test ran";
	if (counts.failed > 0 && DISAGREES.test(run.output)) return "disagreement";
	if (reason) return `the replay crashed (${reason}, with no disagreement)`;
	return run.status === 0 ? "green" : `the replay exited ${run.status ?? "on a signal"} after every test passed`;
}

export async function nightlyFormal(deps: FormalDeps): Promise<number> {
	const { seed, commit, dir, log } = deps;
	const traces = join(dir, "traces");
	const fail = (what: string) => {
		const line = `::error title=Nightly formal replay::${what}. Seed ${seed}, commit ${commit}. Reproduce: ${reproduce(seed, commit)}`;
		log(line);
		deps.summary([
			`**Failed:** ${what}.`,
			`Seed ${seed}, commit ${commit}.`,
			`Reproduce: \`${reproduce(seed, commit)}\``,
		]);
		return 1;
	};
	log(`Nightly formal replay: seed ${seed}, commit ${commit}`);
	try {
		return await generateAndReplay(deps, traces, fail);
	} catch {
		return fail("the driver crashed");
	}
}

async function generateAndReplay(deps: FormalDeps, traces: string, fail: (what: string) => number) {
	const { seed, commit, dir, log } = deps;
	log(`Generating: bin/dev formal --traces ${traces} --seed ${seed}`);
	const generated = await deps.generate(traces, seed);
	const file = deps.readTraces(traces);
	const gap = /the traces leave out: (.+?)\. Try another seed\./.exec(generated.output)?.[1];
	if (!file || (generated.status !== 0 && !gap)) return fail("TLC generation failed");
	const steps = file.behaviors.reduce((n, b) => n + b.length, 0);
	const facts = [
		`Seed ${seed} at commit ${commit}: ${file.behaviors.length} traces, ${steps} steps.`,
		gap ? `The traces leave out: ${gap}. They still replay.` : "The traces cover every model action.",
	];
	facts.forEach((line) => log(line));
	deps.summary(["### Nightly formal replay", ...facts]);
	const database = await deps.database();
	if (database) return fail(`the database was not reachable (${database})`);
	const replayLog = join(dir, "replay.log");
	log(`Replaying with FORMAL_TRACES=${traces}; its output goes to ${replayLog} only.`);
	const verdict = replayVerdict(await deps.replay(traces, replayLog));
	if (verdict === "disagreement")
		return fail("a replayed behavior disagrees with the code; its detail stays off the public log");
	if (verdict !== "green") return fail(verdict);
	const passed = `Passed: every behavior from seed ${seed} replays without disagreement.`;
	log(passed);
	deps.summary([passed]);
	return 0;
}

const root = fileURLToPath(new URL("..", import.meta.url));

function collect(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, file?: string) {
	const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
	const out = file ? createWriteStream(file) : undefined;
	let output = "";
	child.once("error", (error) => (output += `\n${command} did not start: ${error.message}\n`));
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk: Buffer) => {
			output += chunk;
			if (out) out.write(chunk);
			else process.stdout.write(chunk);
		});
	return new Promise<Run>((resolve) =>
		child.once("close", (status) => (out ? out.end(() => resolve({ status, output })) : resolve({ status, output }))),
	);
}

function database(): Promise<string | null> {
	let url: URL;
	try {
		url = new URL(process.env.DATABASE_URL ?? "");
	} catch {
		return Promise.resolve("DATABASE_URL is not set to a URL");
	}
	return new Promise((resolve) => {
		const socket = connect({ host: url.hostname, port: Number(url.port || 5432) });
		const done = (why: string | null) => (socket.destroy(), resolve(why));
		socket.setTimeout(5_000, () => done("no answer within 5 s"));
		socket.once("connect", () => done(null));
		socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "connection error"));
	});
}

function commit(): string {
	if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
	const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : "unknown";
}

const USAGE = "usage: node scripts/nightly-formal.ts [--seed <n>]";

export async function nightlyFormalCommand(args: string[]): Promise<number> {
	if (args.length && (args.length !== 2 || args[0] !== "--seed" || !/^\d{1,15}$/.test(args[1]!)))
		return (console.error(USAGE), 2);
	const seed = args.length ? Number(args[1]) : randomInt(1, 2 ** 47);
	const dir = process.env.RUNNER_TEMP
		? join(process.env.RUNNER_TEMP, "nightly-formal")
		: mkdtempSync(join(tmpdir(), "nightly-formal-"));
	mkdirSync(dir, { recursive: true });
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	return nightlyFormal({
		seed,
		commit: commit(),
		dir,
		generate: (traces, s) =>
			collect(process.execPath, [join(root, "scripts/dev.ts"), "formal", "--traces", traces, "--seed", `${s}`], {
				cwd: root,
				env,
			}),
		readTraces: (traces) => {
			try {
				return JSON.parse(readFileSync(join(traces, "permissions", "traces.json"), "utf8"));
			} catch {
				return null;
			}
		},
		database,
		replay: (traces, log) =>
			collect(
				join(root, "packages/domain/node_modules/.bin/tsx"),
				["--conditions=react-server", "--test", REPLAY_TEST],
				{ cwd: join(root, "packages/domain"), env: { ...env, FORMAL_TRACES: traces } },
				log,
			),
		log: console.log,
		summary: (lines) => {
			if (summaryFile) appendFileSync(summaryFile, `${lines.join("\n\n")}\n\n`);
		},
	});
}

if (import.meta.main) process.exitCode = await nightlyFormalCommand(process.argv.slice(2));
