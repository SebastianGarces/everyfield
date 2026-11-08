// Provisions webhook.json from two native hidden-input prompts on this Mac.
// Usage: node provision.mts [--detach] [--state-dir <dir>]
// Sebastian pastes the routine panel's "POST to" URL, then its sender key. The values reach this process only
// over osascript's stdout pipe. They never go into argv, the environment, a log, the status file or any output:
// the helper reports a values-free code, nothing else. It reads no clipboard, keychain, app file or API.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseWebhookFields, readWebhookConfig, STATE_DIR } from "./io.mts";

export const OSASCRIPT = "/usr/bin/osascript";
/** Each prompt gives up after this long (at most 30 minutes, per the spec). */
export const PROMPT_GIVE_UP_S = 1800;
const VALUE_MAX = 8192;

export type Field = "url" | "key";
export type PromptResult = { ok: true; value: string } | { ok: false; reason: "cancelled" | "timed_out" | "prompt_failed" };
export type Prompt = (field: Field) => Promise<PromptResult>;
export type ProvisionState = "waiting" | "ok" | "cancelled" | "timed_out" | "invalid";
export type ProvisionResult = { state: ProvisionState; code: string };

const TEXT: Record<Field, string> = {
	url: "everyfield actionable watcher (1 of 2)\n\nPaste the \"POST to\" URL from the routine everyfield-actionable-change-webhook's panel.\n\nIt is saved only to webhook.json on this Mac.",
	key: "everyfield actionable watcher (2 of 2)\n\nPaste the sender key from the same routine panel.\n\nIt is saved only to webhook.json on this Mac.",
};

/**
 * The AppleScript for one prompt. It is built only from the fixed text above: no input, path or value is
 * ever interpolated. It answers on stdout with "C" (cancel), "T" (gave up) or "V" followed by the value.
 */
export function promptScript(field: Field): string {
	const text = TEXT[field].replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
	return [
		"try",
		`\tset r to display dialog "${text}" default answer "" with hidden answer with title "everyfield webhook setup" with icon note buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel" giving up after ${PROMPT_GIVE_UP_S}`,
		"on error number -128",
		'\treturn "C"',
		"end try",
		'if gave up of r then return "T"',
		'return "V" & (text returned of r)',
	].join("\n");
}

/** The real prompt: one `osascript` per field, the fixed script in argv, the answer back over a pipe. */
export function osascriptPrompt(bin = OSASCRIPT): Prompt {
	return (field) =>
		new Promise((resolve) => {
			execFile(
				bin,
				["-e", promptScript(field)],
				{ timeout: (PROMPT_GIVE_UP_S + 30) * 1000, killSignal: "SIGKILL", maxBuffer: VALUE_MAX, env: { PATH: "/usr/bin:/bin" } },
				(err, stdout) => {
					// Neither the error nor stderr is read: only the exit and the first byte decide.
					if (err) return resolve({ ok: false, reason: (err as { killed?: boolean }).killed ? "timed_out" : "prompt_failed" });
					const out = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
					if (out === "C") return resolve({ ok: false, reason: "cancelled" });
					if (out === "T") return resolve({ ok: false, reason: "timed_out" });
					if (out.startsWith("V")) return resolve({ ok: true, value: out.slice(1) });
					resolve({ ok: false, reason: "prompt_failed" });
				},
			);
		});
}

/** Writes `path` atomically: an exclusive 0600 temp file in the same directory, fsynced, renamed over it. */
async function writePrivate(path: string, text: string): Promise<void> {
	const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const fh = await open(tmp, "wx", 0o600);
	try {
		await fh.chmod(0o600);
		await fh.writeFile(text);
		await fh.sync();
		await fh.close();
		await rename(tmp, path);
	} catch (e) {
		await fh.close().catch(() => undefined);
		await unlink(tmp).catch(() => undefined);
		throw e;
	}
}

async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
}

export const statusPath = (stateDir: string) => join(stateDir, "provision.status");

export async function writeStatus(stateDir: string, r: ProvisionResult, now: () => number = Date.now): Promise<void> {
	await ensureDir(stateDir);
	await writePrivate(statusPath(stateDir), `state=${r.state} code=${r.code} at=${new Date(now()).toISOString()}\n`);
}

const STATE_FOR: Record<Exclude<PromptResult, { ok: true }>["reason"], ProvisionState> = {
	cancelled: "cancelled",
	timed_out: "timed_out",
	prompt_failed: "invalid",
};

/**
 * One provisioning run. It writes `waiting`, asks for the URL then the key, validates both with the
 * transport's own validator, writes webhook.json, re-reads it through the transport's loader and
 * writes the outcome. On cancel, timeout or invalid input it writes no config and leaves any existing one.
 */
export async function provision(deps: { prompt: Prompt; stateDir: string; now?: () => number }): Promise<ProvisionResult> {
	const now = deps.now ?? Date.now;
	const finish = async (r: ProvisionResult) => (await writeStatus(deps.stateDir, r, now), r);
	await writeStatus(deps.stateDir, { state: "waiting", code: "none" }, now);
	try {
		const values: Partial<Record<Field, string>> = {};
		for (const field of ["url", "key"] as const) {
			const answer = await deps.prompt(field);
			if (!answer.ok) return finish({ state: STATE_FOR[answer.reason], code: answer.reason });
			values[field] = answer.value.trim();
		}
		const valid = parseWebhookFields(values.url, values.key);
		if (!valid.ok) return finish({ state: "invalid", code: valid.code });
		const configPath = join(deps.stateDir, "webhook.json");
		await writePrivate(configPath, JSON.stringify({ url: values.url, key: values.key }));
		const reread = await readWebhookConfig(configPath);
		return finish(reread.ok ? { state: "ok", code: "webhook_config_ok" } : { state: "invalid", code: reread.code });
	} catch {
		// The thrown error is never read: a message could carry a path or the input.
		return finish({ state: "invalid", code: "provision_failed" });
	}
}

/** What the helper prints for a result: `webhook_config ok`, or the code alone. */
export const report = (r: ProvisionResult) => (r.state === "ok" ? "webhook_config ok" : r.code);

async function main() {
	const { values } = parseArgs({
		options: {
			detach: { type: "boolean", default: false },
			"state-dir": { type: "string", default: STATE_DIR },
			// Tests only: a stand-in for /usr/bin/osascript. The real prompt is the default.
			osascript: { type: "string", default: OSASCRIPT },
		},
	});
	const stateDir = values["state-dir"];
	if (values.detach) {
		// The child outlives this process and the seat's turn; it gets the same flags, never a value.
		await writeStatus(stateDir, { state: "waiting", code: "none" });
		const child = spawn(process.execPath, [import.meta.filename, "--state-dir", stateDir, "--osascript", values.osascript], {
			detached: true,
			stdio: "ignore",
			env: { HOME: process.env.HOME ?? "", PATH: "/usr/bin:/bin" },
		});
		child.unref();
		process.stdout.write(`pid=${child.pid} status=${statusPath(stateDir)}\n`);
		return;
	}
	const result = await provision({ prompt: osascriptPrompt(values.osascript), stateDir });
	process.stdout.write(`${report(result)}\n`);
	process.exitCode = result.state === "ok" ? 0 : 1;
}

if (import.meta.main) {
	main().catch(() => {
		process.stdout.write("provision_failed\n");
		process.exitCode = 1;
	});
}
