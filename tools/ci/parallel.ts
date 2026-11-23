import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

type Command = { label: string; command: string };
type Result = Command & { code: number | null; signal: NodeJS.Signals | null; seconds: number };

const USAGE = 'usage: node tools/ci/parallel.ts "<label>=<command>" ...';

function parseCommands(args: string[]): Command[] | string {
	if (!args.length) return USAGE;
	const commands: Command[] = [];
	for (const arg of args) {
		const match = arg.match(/^([\w-]+)=(.*\S.*)$/s);
		if (!match) return `${USAGE}\nnot <label>=<command>: ${arg}`;
		commands.push({ label: match[1]!, command: match[2]!.trim() });
	}
	return commands;
}

const seconds = (since: number) => Math.round((performance.now() - since) / 100) / 10;

function prefix(stream: Readable, label: string): Promise<void> {
	return new Promise((done) => {
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		lines.on("line", (line) => process.stdout.write(`[${label}] ${line}\n`));
		lines.on("close", done);
	});
}

function run(command: Command, started: number): Promise<Result> {
	process.stdout.write(`[${command.label}] $ ${command.command}\n`);
	const child = spawn(command.command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
	const output = Promise.all([prefix(child.stdout, command.label), prefix(child.stderr, command.label)]);
	return new Promise((done) => {
		child.on("close", async (code, signal) => {
			await output;
			const result = { ...command, code, signal, seconds: seconds(started) };
			process.stdout.write(`[${command.label}] ${outcome(result)} after ${result.seconds} s\n`);
			done(result);
		});
	});
}

const outcome = (r: Result) => (r.signal ? `killed by ${r.signal}` : `exit ${r.code}`);

async function runParallel(commands: Command[]): Promise<number> {
	const started = performance.now();
	const results = await Promise.all(commands.map((c) => run(c, started)));
	const failed = results.filter((r) => r.code !== 0);
	const total = `${commands.length} commands in ${seconds(started)} s`;
	process.stdout.write(
		failed.length
			? `parallel: ${failed.length} of ${total} failed: ${failed.map((r) => `${r.label} (${outcome(r)})`).join(", ")}\n`
			: `parallel: all ${total} passed\n`,
	);
	return failed.length ? 1 : 0;
}

if (import.meta.main) {
	const commands = parseCommands(process.argv.slice(2));
	if (typeof commands === "string") {
		console.error(commands);
		process.exitCode = 2;
	} else process.exitCode = await runParallel(commands);
}
