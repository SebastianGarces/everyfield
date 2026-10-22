import { appendFileSync, mkdirSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { evfDataDir, fail, loadConfig, sleep } from "./lib.ts";

export type LoadLimit = { cores: number; maxPerCore: number; limit: number; maxWaitMinutes: number };
export type LoadProbe = { read: () => number; sleep: (ms: number) => void; now: () => number };
const machine: LoadProbe = { read: () => loadavg()[0], sleep, now: Date.now };

/** The shared machine's limit (C51, C81) from the home checkout's evf.config.json. */
export function loadLimit(root: string): LoadLimit {
	const setting = loadConfig(root).machineLoad;
	if (
		!setting ||
		!(Number.isFinite(setting.maxPerCore) && setting.maxPerCore > 0) ||
		!(Number.isFinite(setting.maxWaitMinutes) && setting.maxWaitMinutes >= 0)
	)
		fail("evf.config.json needs machineLoad: { maxPerCore: <positive number>, maxWaitMinutes: <minutes> }.");
	const cores = availableParallelism();
	return { cores, ...setting, limit: setting.maxPerCore * cores };
}

export function describeLoad(load: number, gate: LoadLimit): string {
	return `load ${load.toFixed(1)}, limit ${gate.limit} (${gate.maxPerCore} × ${gate.cores} cores)`;
}

/**
 * Heavy commands wait while the 1-minute load average is above the limit, print one line per minute and give up
 * after maxWaitMinutes. `--ignore-load <reason>` runs at once and appends the override to load-overrides.jsonl.
 */
export function awaitLoad(root: string, command: string, override: string | undefined, probe = machine): void {
	const gate = loadLimit(root);
	if (override !== undefined) {
		if (!override.trim()) fail("--ignore-load needs a reason.");
		const load = probe.read();
		mkdirSync(evfDataDir(root), { recursive: true });
		appendFileSync(
			join(evfDataDir(root), "load-overrides.jsonl"),
			JSON.stringify({ at: new Date(probe.now()).toISOString(), command, load, limit: gate.limit, reason: override }) +
				"\n",
		);
		console.error(`evf ${command}: load override logged (${describeLoad(load, gate)}): ${override}`);
		return;
	}
	const start = probe.now(),
		maxWaitMs = gate.maxWaitMinutes * 60_000;
	for (let printed = 0; ;) {
		const load = probe.read();
		if (load <= gate.limit) return;
		const waited = probe.now() - start;
		if (waited >= maxWaitMs)
			fail(
				`The machine stayed above its load limit for ${gate.maxWaitMinutes} min (${describeLoad(load, gate)}). Retry later, or pass --ignore-load "<reason>", which evf logs.`,
			);
		if (waited >= printed * 60_000) {
			console.error(
				`evf ${command}: ${describeLoad(load, gate)}; waiting, ${Math.floor(waited / 60_000)} of ${gate.maxWaitMinutes} min.`,
			);
			printed = Math.floor(waited / 60_000) + 1;
		}
		probe.sleep(Math.min(15_000, maxWaitMs - waited));
	}
}
