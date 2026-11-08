// One poll per launchd run: launchd's StartInterval owns cadence and restart, so there is no loop.
// Usage: node run.mts [--transport dry-run] [--state-dir <dir>] [--log-dir <dir>]
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	acquireLock, createLog, createTransport, deliver, loadState, LOG_DIR, runAllowed, saveState, STATE_DIR,
	type CommandName, type ExecResult, type Log, type Transport,
} from "./io.mts";
import { advance, buildPayload, markDelivered, normalize, parseCi, parseStatus, type Ci } from "./observe.mts";

export type Deps = {
	now: () => number;
	exec: (name: CommandName) => Promise<ExecResult>;
	transport: Transport;
	log: Log;
	stateDir: string;
	sleep?: (ms: number) => Promise<void>;
};
export type Outcome = "locked" | "poll_failed" | "baseline" | "no_change" | "woke" | "wake_failed";

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
			await deps.log(`poll_failed code=${status.code}`);
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
			const result = await deliver(deps.transport, buildPayload(due, deps.now()), { sleep: deps.sleep });
			const keys = due.map((e) => e.key).join(",");
			if (result.ok) {
				state = markDelivered(next, due);
				await deps.log(`wake ${deps.transport.mode} events=${due.length} keys=${keys} snapshot=${fingerprint}`);
				outcome = "woke";
			} else {
				await deps.log(`wake_failed tries=${result.tries} pending=${due.length} keys=${keys}`);
				outcome = "wake_failed";
			}
		}
		await saveState(statePath, state);
		return outcome;
	} finally {
		await lock.release();
	}
}

async function main() {
	const { values } = parseArgs({
		options: {
			transport: { type: "string", default: "dry-run" },
			"state-dir": { type: "string", default: STATE_DIR },
			"log-dir": { type: "string", default: LOG_DIR },
		},
	});
	const stateDir = values["state-dir"];
	const log = createLog(join(values["log-dir"], "watch.log"));
	const transport = createTransport(values.transport, log);
	if (!transport.ok) {
		await log(transport.code);
		process.exitCode = 2;
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
