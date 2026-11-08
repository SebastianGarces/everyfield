// The watcher's only side effects: two allowlisted read-only commands, its own state, lock and log
// files, and the wake transport. Nothing here writes to evf, GitHub or any routine.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseState, type State } from "./observe.mts";

export const COMMAND_TIMEOUT_MS = 20_000;
export const MAIN_CHECKOUT = join(homedir(), "dev/everyfield_v3");
export const STATE_DIR = join(homedir(), "Library/Application Support/everyfield-actionable-watch");
export const LOG_DIR = join(homedir(), "Library/Logs/everyfield-actionable-watch");

/** The complete list of commands the watcher may run. Both only read. */
export const COMMANDS = {
	"evf-status": { bin: join(homedir(), ".cargo/bin/evf"), args: ["status", "--json"] },
	"gh-main-ci": {
		bin: "/opt/homebrew/bin/gh",
		args: [
			"run", "list", "--repo", "SebastianGarces/everyfield", "--branch", "main", "--workflow", "CI",
			"--event", "push", "--limit", "10", "--json", "headSha,status,conclusion,createdAt",
		],
	},
} as const;
export type CommandName = keyof typeof COMMANDS;
export type ExecResult = { ok: true; stdout: string } | { ok: false; code: string };

/** Runs one allowlisted command. `bin` and `cwd` are overridable only so tests can use fakes. */
export async function runAllowed(
	name: CommandName,
	opts: { bin?: string; cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
	const command = COMMANDS[name];
	if (!command) return { ok: false, code: "command_not_allowed" };
	const bin = opts.bin ?? command.bin;
	const prefix = name === "evf-status" ? "evf" : "gh";
	try {
		await access(bin, constants.X_OK);
	} catch (e) {
		return { ok: false, code: `${prefix}_${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "not_executable"}` };
	}
	return new Promise((resolve) => {
		execFile(
			bin,
			[...command.args],
			{
				cwd: opts.cwd ?? MAIN_CHECKOUT,
				timeout: Math.min(opts.timeoutMs ?? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS),
				killSignal: "SIGKILL",
				maxBuffer: 16 * 1024 * 1024,
				env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
			},
			(err, stdout) => {
				if (!err) return resolve({ ok: true, stdout });
				const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
				if (e.killed) return resolve({ ok: false, code: `${prefix}_timeout` });
				if (typeof e.code === "number") return resolve({ ok: false, code: `${prefix}_exit_${e.code}` });
				resolve({ ok: false, code: `${prefix}_failed` });
			},
		);
	});
}

// ---- state ------------------------------------------------------------------------------------

export async function loadState(path: string): Promise<{ state: State | null; code: "ok" | "state_missing" | "state_corrupt" }> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { state: null, code: "state_missing" };
	}
	try {
		const state = parseState(JSON.parse(text));
		return state ? { state, code: "ok" } : { state: null, code: "state_corrupt" };
	} catch {
		return { state: null, code: "state_corrupt" };
	}
}

/** Atomic: write a private temp file beside the target, then rename over it. */
export async function saveState(path: string, state: State): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	const fh = await open(tmp, "w", 0o600);
	try {
		await fh.writeFile(JSON.stringify(state));
		await fh.sync();
	} finally {
		await fh.close();
	}
	await rename(tmp, path);
}

// ---- single instance --------------------------------------------------------------------------

export const LOCK_STALE_MS = 10 * 60_000; // one poll is bounded far below this

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Exclusive lock file holding `pid at`. Returns null when a live, fresh holder exists. */
export async function acquireLock(path: string, nowMs: number): Promise<{ release(): Promise<void> } | null> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fh = await open(path, "wx", 0o600);
			await fh.writeFile(`${process.pid} ${nowMs}\n`);
			await fh.close();
			return { release: () => unlink(path).catch(() => undefined) };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const [pid, at] = (await readFile(path, "utf8").catch(() => "")).trim().split(" ").map(Number);
		const fresh = Number.isSafeInteger(pid) && pid > 0 && alive(pid) && nowMs - at < LOCK_STALE_MS;
		if (fresh) return null;
		await unlink(path).catch(() => undefined);
	}
	return null;
}

// ---- log --------------------------------------------------------------------------------------

export const LOG_MAX_BYTES = 1024 * 1024;
export type Log = (line: string) => Promise<void>;

/** Appends one line per call; past LOG_MAX_BYTES the file rolls to `.1` (one generation kept). */
export function createLog(path: string, now: () => number = Date.now, maxBytes = LOG_MAX_BYTES): Log {
	return async (line) => {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const size = await stat(path).then((s) => s.size, () => 0);
		if (size > maxBytes) await rename(path, `${path}.1`);
		await appendFile(path, `${new Date(now()).toISOString()} ${line}\n`, { mode: 0o600 });
	};
}

// ---- transport --------------------------------------------------------------------------------

export type Payload = { source: string; version: number; at: string; events: Record<string, unknown>[] };
export type Transport = { mode: "dry-run" | "webhook"; send(payload: Payload, signal: AbortSignal): Promise<void> };

/** The routine's documented public sender contract is unknown to agents, so webhook stays off. */
export const WEBHOOK_CONTRACT_NEEDED =
	"webhook_refused: the routine's documented public sender contract is missing. Needed: the endpoint URL shape, " +
	"the auth header name and value format, and the payload schema (content type and required fields).";

export function createTransport(mode: string, log: Log): { ok: true; transport: Transport } | { ok: false; code: string } {
	if (mode === "dry-run") {
		return { ok: true, transport: { mode: "dry-run", send: (payload) => log(`dry-run wake payload=${JSON.stringify(payload)}`) } };
	}
	if (mode === "webhook") return { ok: false, code: WEBHOOK_CONTRACT_NEEDED };
	return { ok: false, code: "transport_unknown" };
}

export const SEND_TRIES = 3;
export const SEND_TIMEOUT_MS = 10_000;
export const SEND_BACKOFF_MS = 1_000;

/** At most SEND_TRIES tries with exponential backoff and a per-try timeout, all inside one poll. */
export async function deliver(
	transport: Transport,
	payload: Payload,
	opts: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number; backoffMs?: number } = {},
): Promise<{ ok: boolean; tries: number }> {
	const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	for (let i = 0; i < SEND_TRIES; i++) {
		const ac = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				transport.send(payload, ac.signal),
				new Promise((_, reject) => {
					timer = setTimeout(() => {
						ac.abort();
						reject(new Error("send_timeout"));
					}, opts.timeoutMs ?? SEND_TIMEOUT_MS);
				}),
			]);
			return { ok: true, tries: i + 1 };
		} catch {
			if (i < SEND_TRIES - 1) await sleep((opts.backoffMs ?? SEND_BACKOFF_MS) * 2 ** i);
		} finally {
			clearTimeout(timer);
		}
	}
	return { ok: false, tries: SEND_TRIES };
}
