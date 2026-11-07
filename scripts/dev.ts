import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { browserRun } from "./browser.ts";

const HELP = `Browser runs, the local preview stack and its logs, for the worktree you run them from. Node 24.
  dev browser run [--timeout <seconds>] [--session <name>] -- <command> [args...]
        runs a browser check in its own process group (default timeout 900 s), then closes its agent-browser
        session and stops every process it started, also on failure or timeout
  dev stack up [--mode development|production] [--project <path>]    waits for a free preview slot, then starts it
  dev stack status|check|down [--project <path>]
  dev logs [--project <path>] [args...]    portless preview logs of this worktree's preview
  dev traces                               says what to read instead: no trace reader exists yet`;

const root = resolve(import.meta.dirname, "..");
const SLOTS = join(root, ".agents/skills/verify-preview/scripts/preview-slots.mjs");
const STACK = join(root, "scripts/stack.mjs");

class DevError extends Error {}

/** A node script on this Node, not whichever node is first on PATH. */
const node = (script: string, args: string[], capture = false) =>
	spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});

/** Takes one `--name value` option out of `args`. */
function take(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const [, value] = args.splice(at, 2);
	if (!value) throw new DevError(`${name} needs a value.`);
	return value;
}

async function browser(args: string[]): Promise<number> {
	const sep = args.indexOf("--");
	if (args[0] !== "run" || sep < 0 || sep === args.length - 1) return usage();
	const options = args.slice(1, sep),
		timeout = Number(take(options, "--timeout") ?? 900),
		session = take(options, "--session");
	if (options.length) return usage();
	if (!Number.isFinite(timeout) || timeout <= 0) throw new DevError("--timeout takes a number of seconds.");
	return browserRun(args.slice(sep + 1), { timeoutSeconds: timeout, session });
}

function stack(args: string[]): number {
	const [action, ...rest] = args;
	if (!action || !["up", "status", "check", "down"].includes(action)) return usage();
	if (action === "up") {
		const options = [...rest],
			project = take(options, "--project") ?? process.env.EVF_WORKTREE ?? root;
		// A full preview pool makes the stack wait for a free slot (and free orphans first) instead of failing.
		const slot = node(SLOTS, ["--project", project]);
		if (slot.status !== 0) return slot.status ?? 1;
	}
	return node(STACK, [action, ...rest]).status ?? 1;
}

function logs(args: string[]): number {
	const extra = [...args],
		project = take(extra, "--project");
	const status = node(STACK, ["status", ...(project ? ["--project", project] : [])], true);
	if (status.status !== 0) return status.status ?? 1;
	const { id } = JSON.parse(status.stdout) as { id?: string };
	if (!id) throw new DevError("This worktree has no running preview. Start it with bin/dev stack up.");
	const shown = spawnSync("portless", ["preview", "logs", id, ...extra], { stdio: "inherit" });
	if (shown.error)
		throw new DevError("Cannot run managed Portless. Run portless preview --help to check installation.");
	return shown.status ?? 1;
}

function usage(): number {
	console.error(HELP);
	return 2;
}

async function main([command, ...args]: string[]): Promise<number> {
	switch (command) {
		case "browser":
			return browser(args);
		case "stack":
			return stack(args);
		case "logs":
			return logs(args);
		case "traces":
			throw new DevError(
				"No trace reader exists yet: the observability package has not landed. Read bin/dev logs instead, and say so in your report.",
			);
		case "help":
		case "--help":
		case undefined:
			console.log(HELP);
			return 0;
		default:
			return usage();
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof DevError)) throw error;
	console.error(`dev: ${error.message}`);
	process.exitCode = 1;
}
