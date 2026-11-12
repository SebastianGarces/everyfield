// The watcher's only side effects: two allowlisted read-only commands, its own state, lock and log
// files, and the wake transport (one HTTPS POST to the routine's own webhook). Nothing here writes to
// evf or GitHub.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
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
			"run",
			"list",
			"--repo",
			"SebastianGarces/everyfield",
			"--branch",
			"main",
			"--workflow",
			"CI",
			"--limit",
			"10",
			"--json",
			"headSha,status,conclusion,createdAt",
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
		return {
			ok: false,
			code: `${prefix}_${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "not_executable"}`,
		};
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
				env: {
					HOME: homedir(),
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
					GH_PROMPT_DISABLED: "1",
					NO_COLOR: "1",
				},
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

export async function loadState(
	path: string,
): Promise<{ state: State | null; code: "ok" | "state_missing" | "state_corrupt" }> {
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
		const [pid = NaN, at = NaN] = (await readFile(path, "utf8").catch(() => "")).trim().split(" ").map(Number);
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
		const size = await stat(path).then(
			(s) => s.size,
			() => 0,
		);
		if (size > maxBytes) await rename(path, `${path}.1`);
		await appendFile(path, `${new Date(now()).toISOString()} ${line}\n`, { mode: 0o600 });
	};
}

// ---- transport --------------------------------------------------------------------------------

export type Payload = { source: string; version: number; kind?: string; at: string; events: Record<string, unknown>[] };
/**
 * `result` is the only thing a log line may say about a send: `http_<status>`, an error class or a
 * config refusal code. It never carries the URL, the key, a header or an error message.
 * `retry` is true only when no request can have reached the routine (DNS, connect) or the routine
 * answered 5xx. A routine run is not idempotent as far as its docs say, so anything else waits.
 */
export type SendResult = { ok: true; result: string } | { ok: false; result: string; retry: boolean };
export type Transport = {
	mode: "dry-run" | "webhook";
	/** capped transports count every POST against WEBHOOK_SENDS_PER_HOUR */
	capped: boolean;
	send(payload: Payload, signal: AbortSignal): Promise<SendResult>;
};

/** Written by `provision.mts` from Sebastian's paste (or by hand). Agents never read or print it. */
export const WEBHOOK_CONFIG = join(STATE_DIR, "webhook.json");
export type WebhookConfig = { url: URL; key: string };

/** Read at send time only. Every refusal is a named code and happens before any request. */
export async function readWebhookConfig(
	path: string,
): Promise<{ ok: true; config: WebhookConfig } | { ok: false; code: string }> {
	let fh;
	try {
		fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (e) {
		return {
			ok: false,
			code: (e as NodeJS.ErrnoException).code === "ENOENT" ? "webhook_config_missing" : "webhook_config_unreadable",
		};
	}
	let text: string;
	try {
		const st = await fh.stat();
		if (!st.isFile()) return { ok: false, code: "webhook_config_unreadable" };
		if (st.uid !== process.getuid?.()) return { ok: false, code: "webhook_config_not_owner" };
		if ((st.mode & 0o077) !== 0) return { ok: false, code: "webhook_config_mode" };
		text = await fh.readFile("utf8");
	} catch {
		return { ok: false, code: "webhook_config_unreadable" };
	} finally {
		await fh.close();
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, code: "webhook_config_invalid_json" };
	}
	const obj = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
	return obj ? parseWebhookFields(obj.url, obj.key) : { ok: false, code: "webhook_config_invalid" };
}

/**
 * The one validator for a URL and key, shared by the send-time loader and the provisioning helper.
 * It returns only a named code: a URL parse error can carry the input, so it is never surfaced.
 */
export function parseWebhookFields(
	url: unknown,
	key: unknown,
): { ok: true; config: WebhookConfig } | { ok: false; code: string } {
	// A bearer key is visible ASCII with no spaces; anything else could split the header.
	if (typeof url !== "string" || typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key)) {
		return { ok: false, code: "webhook_config_invalid" };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, code: "webhook_config_invalid_url" };
	}
	if (parsed.protocol !== "https:") return { ok: false, code: "webhook_url_not_https" };
	return { ok: true, config: { url: parsed, key } };
}

const DNS_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL"]);
const CONNECT_ERRORS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "ENETDOWN"]);

/** An error's class from its code alone; the message (which can name the host) is never read. */
export function classifySendError(e: unknown): SendResult & { ok: false } {
	const code = String((e as NodeJS.ErrnoException)?.code ?? "");
	if (DNS_ERRORS.has(code)) return { ok: false, result: "dns_error", retry: true };
	if (CONNECT_ERRORS.has(code)) return { ok: false, result: "connect_error", retry: true };
	if (code === "ABORT_ERR" || (e as Error)?.name === "AbortError")
		return { ok: false, result: "timeout", retry: false };
	if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_TLS_CERT)/.test(code)) {
		return { ok: false, result: "tls_error", retry: false };
	}
	// ECONNRESET, EPIPE and the rest: the request may have reached the routine, so do not resend.
	return { ok: false, result: "network_error", retry: false };
}

/** The request builder: one POST, exactly these two headers, the payload as the body. */
export function webhookRequest(config: WebhookConfig, payload: Payload) {
	return {
		url: config.url,
		method: "POST" as const,
		headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	};
}

/** Only HTTP 200 means the routine accepted and started a run. Redirects are not followed. */
function post(config: WebhookConfig, payload: Payload, signal: AbortSignal, ca?: string): Promise<SendResult> {
	const req = webhookRequest(config, payload);
	return new Promise((resolve) => {
		try {
			const r = httpsRequest(
				req.url,
				{ method: req.method, headers: req.headers, signal, agent: false, ...(ca ? { ca } : {}) },
				(res) => {
					const status = res.statusCode ?? 0;
					res.resume();
					res.on("error", () => undefined);
					if (status === 200) resolve({ ok: true, result: "http_200" });
					else resolve({ ok: false, result: `http_${status}`, retry: status >= 500 && status <= 599 });
				},
			);
			r.on("error", (e) => resolve(classifySendError(e)));
			r.end(req.body);
		} catch (e) {
			resolve(classifySendError(e));
		}
	});
}

export function createTransport(
	mode: string,
	log: Log,
	opts: { configPath?: string; ca?: string } = {},
): { ok: true; transport: Transport } | { ok: false; code: string } {
	if (mode === "dry-run") {
		return {
			ok: true,
			transport: {
				mode: "dry-run",
				capped: false,
				send: async (payload) => (
					await log(`dry-run wake payload=${JSON.stringify(payload)}`),
					{ ok: true, result: "logged" }
				),
			},
		};
	}
	if (mode === "webhook") {
		const configPath = opts.configPath ?? WEBHOOK_CONFIG;
		return {
			ok: true,
			transport: {
				mode: "webhook",
				capped: true,
				send: async (payload, signal) => {
					const read = await readWebhookConfig(configPath);
					if (!read.ok) return { ok: false, result: read.code, retry: false };
					return post(read.config, payload, signal, opts.ca);
				},
			},
		};
	}
	return { ok: false, code: "transport_unknown" };
}

export const SEND_TRIES = 3;
export const SEND_TIMEOUT_MS = 10_000;
export const SEND_BACKOFF_MS = 1_000;
/** Far under the routine's documented 200 runs per routine per hour. */
export const WEBHOOK_SENDS_PER_HOUR = 20;
export const SEND_WINDOW_MS = 60 * 60_000;

export type Delivery = { ok: boolean; tries: number; result: string; capped: boolean; sends: number[] };

/**
 * Up to `tries` tries (default SEND_TRIES) inside one poll, with exponential backoff and a per-try
 * timeout. Only a retryable result tries again. With `cap`, every try is a POST counted in a
 * rolling hour; at WEBHOOK_SENDS_PER_HOUR it stops before sending and reports `capped`.
 */
export async function deliver(
	transport: Transport,
	payload: Payload,
	opts: {
		sleep?: (ms: number) => Promise<void>;
		timeoutMs?: number;
		backoffMs?: number;
		tries?: number;
		cap?: { sends: number[]; now: () => number };
	} = {},
): Promise<Delivery> {
	const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const maxTries = opts.tries ?? SEND_TRIES;
	const window = (sends: number[]) => (opts.cap ? sends.filter((t) => t > opts.cap!.now() - SEND_WINDOW_MS) : sends);
	let sends = window(opts.cap?.sends ?? []);
	let last: SendResult = { ok: false, result: "not_sent", retry: false };
	for (let i = 0; i < maxTries; i++) {
		if (opts.cap && transport.capped) {
			sends = window(sends);
			if (sends.length >= WEBHOOK_SENDS_PER_HOUR) return { ok: false, tries: i, result: "capped", capped: true, sends };
			sends = [...sends, opts.cap.now()];
		}
		const ac = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		try {
			last = await Promise.race([
				transport.send(payload, ac.signal),
				new Promise<SendResult>((resolve) => {
					timer = setTimeout(() => {
						ac.abort();
						resolve({ ok: false, result: "timeout", retry: false });
					}, opts.timeoutMs ?? SEND_TIMEOUT_MS);
				}),
			]);
		} catch {
			last = { ok: false, result: "send_error", retry: false };
		} finally {
			clearTimeout(timer);
		}
		if (last.ok) return { ok: true, tries: i + 1, result: last.result, capped: false, sends };
		if (!last.retry || i === maxTries - 1)
			return { ok: false, tries: i + 1, result: last.result, capped: false, sends };
		await sleep((opts.backoffMs ?? SEND_BACKOFF_MS) * 2 ** i);
	}
	return { ok: false, tries: maxTries, result: last.result, capped: false, sends };
}
