// One poll per launchd run: launchd's StartInterval owns cadence and restart, so there is no loop.
// Usage: node run.mts [--transport dry-run|webhook] [--test-wake | --check-config] [--state-dir <dir>] [--log-dir <dir>]
// The webhook URL and key live only in <state-dir>/webhook.json (0600), never in argv or the plist.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	acquireLock, createLog, createTransport, deliver, loadState, LOG_DIR, readWebhookConfig, runAllowed, saveState, STATE_DIR, WEBHOOK_SENDS_PER_HOUR,
	type CommandName, type ExecResult, type Log, type Transport,
} from "./io.mts";
import { advance, buildPayload, buildTestPayload, markDelivered, normalize, parseCi, parseStatus, type Ci } from "./observe.mts";

export type Deps = {
	now: () => number;
	exec: (name: CommandName) => Promise<ExecResult>;
	transport: Transport;
	log: Log;
	stateDir: string;
	sleep?: (ms: number) => Promise<void>;
};
export type Outcome = "locked" | "poll_failed" | "baseline" | "no_change" | "woke" | "wake_failed" | "wake_capped";

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export async function pollOnce(deps: Deps): Promise<Outcome> {
	const lock = await acquireLock(join(deps.stateDir, "watch.lock"), deps.now());
	if (!lock) {
		await deps.log("skip another instance holds the lock");
		return "locked";
	}
	try {
		const evf = await deps.exec("evf-status");
		if (!evf.ok) {
			await deps.log(`poll_failed code=${evf.code}`);
			return "poll_failed";
		}
		const raw = parseJson(evf.stdout);
		if (raw === undefined) {
			await deps.log("poll_failed code=evf_invalid_json");
			return "poll_failed";
		}
		const status = parseStatus(raw);
		if (!status.ok) {
			await deps.log(`poll_failed code=${status.code}${status.detail ? ` ${status.detail}` : ""}`);
			return "poll_failed";
		}

		const statePath = join(deps.stateDir, "state.json");
		const loaded = await loadState(statePath);
		// gh missing, logged out or odd output turns only the CI check off: keep the last known CI so
		// its condition neither clears nor re-fires.
		let ci: Ci | null = loaded.state?.snapshot.ci ?? null;
		const gh = await deps.exec("gh-main-ci");
		const ghRaw = gh.ok ? parseJson(gh.stdout) : undefined;
		const parsedCi = !gh.ok ? gh : ghRaw === undefined ? { ok: false as const, code: "gh_invalid_json" } : parseCi(ghRaw);
		if (parsedCi.ok) ci = parsedCi.value;
		else await deps.log(`ci_unavailable code=${parsedCi.code}`);

		const cur = normalize(status.value, ci);
		const { next, due } = advance(loaded.state, cur);
		const fingerprint = createHash("sha256").update(JSON.stringify(cur)).digest("hex").slice(0, 12);
		let state = next;
		let outcome: Outcome;
		if (!loaded.state) {
			await deps.log(`baseline reason=${loaded.code} active=${next.sent.length} snapshot=${fingerprint}`);
			outcome = "baseline";
		} else if (due.length === 0) {
			await deps.log(`poll ok events=0 snapshot=${fingerprint}`);
			outcome = "no_change";
		} else {
			const mode = deps.transport.mode;
			const result = await deliver(deps.transport, buildPayload(due, deps.now()), {
				sleep: deps.sleep,
				cap: { sends: next.sends, now: deps.now },
			});
			state = { ...next, sends: result.sends };
			const keys = due.map((e) => e.key).join(",");
			if (result.ok) {
				state = markDelivered(state, due);
				await deps.log(`wake ${mode} result=${result.result} events=${due.length} keys=${keys} snapshot=${fingerprint}`);
				outcome = "woke";
			} else if (result.capped) {
				await deps.log(`wake_capped transport=${mode} sends_last_hour=${result.sends.length} cap=${WEBHOOK_SENDS_PER_HOUR} pending=${due.length} keys=${keys}`);
				outcome = "wake_capped";
			} else {
				await deps.log(`wake_failed transport=${mode} tries=${result.tries} result=${result.result} pending=${due.length} keys=${keys}`);
				outcome = "wake_failed";
			}
		}
		await saveState(statePath, state);
		return outcome;
	} finally {
		await lock.release();
	}
}

/** One test payload, one try, no lock, no cap and no dedup state: it neither reads nor writes state.json. */
export async function testWake(deps: { transport: Transport; log: Log; now: () => number }): Promise<{ ok: boolean; line: string }> {
	const result = await deliver(deps.transport, buildTestPayload(deps.now()), { tries: 1 });
	const line = `test-wake transport=${deps.transport.mode} result=${result.result}`;
	await deps.log(line);
	return { ok: result.ok, line };
}

async function main() {
	const { values } = parseArgs({
		options: {
			transport: { type: "string", default: "dry-run" },
			"state-dir": { type: "string", default: STATE_DIR },
			"log-dir": { type: "string", default: LOG_DIR },
			"test-wake": { type: "boolean", default: false },
			"check-config": { type: "boolean", default: false },
		},
	});
	const stateDir = values["state-dir"];
	if (values["check-config"]) {
		// Reads webhook.json through the send-time loader and says only whether it would be used.
		// It sends nothing, logs nothing and never touches state.json.
		const read = await readWebhookConfig(join(stateDir, "webhook.json"));
		process.stdout.write(`${read.ok ? "webhook_config ok" : read.code}\n`);
		process.exitCode = read.ok ? 0 : 1;
		return;
	}
	const log = createLog(join(values["log-dir"], "watch.log"));
	const transport = createTransport(values.transport, log, { configPath: join(stateDir, "webhook.json") });
	if (!transport.ok) {
		await log(transport.code);
		process.exitCode = 2;
		return;
	}
	if (values["test-wake"]) {
		const { ok, line } = await testWake({ transport: transport.transport, log, now: Date.now });
		process.stdout.write(`${line}\n`);
		process.exitCode = ok ? 0 : 1;
		return;
	}
	await pollOnce({ now: Date.now, exec: (name) => runAllowed(name), transport: transport.transport, log, stateDir });
}

if (import.meta.main) {
	main().catch(async (e) => {
		// Never print raw errors: they can carry paths or command output.
		await createLog(join(LOG_DIR, "watch.log"))(`internal_error name=${(e as Error)?.name ?? "unknown"}`).catch(() => undefined);
		process.exitCode = 1;
	});
}
