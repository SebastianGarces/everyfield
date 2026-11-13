// `bin/dev nightly schedule install|status|uninstall` (T-104): a launchd user agent that runs `bin/dev nightly` from the
// main checkout at 03:30 local time on this Mac (D-347). launchd runs a missed calendar job when the Mac next wakes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ciHome } from "./check.ts";
import { nightlyLog } from "./nightly.ts";

export const LABEL = "com.everyfield.nightly";
export const HOUR = 3;
export const MINUTE = 30;

export type PlistInput = {
	label: string;
	hour: number;
	minute: number;
	/** The main checkout: the job runs its `bin/dev nightly` from there. */
	checkout: string;
	/** The PATH the job runs with. */
	path: string;
	/** stdout and stderr both append here. */
	log: string;
};

const xml = (s: string) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The agent's plist. No RunAtLoad and no KeepAlive: it runs only at the calendar time. */
export function plist({ label, hour, minute, checkout, path, log }: PlistInput): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${xml(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(join(checkout, "bin/dev"))}</string>
		<string>nightly</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${xml(checkout)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(path)}</string>
	</dict>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>${hour}</integer>
		<key>Minute</key>
		<integer>${minute}</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** A command runner shaped like `launchctl`: tests pass a fake. */
export type Launchctl = (args: readonly string[]) => { status: number; output: string };

export type ScheduleDeps = {
	/** ~/Library/LaunchAgents. */
	agentsDir: string;
	uid: number;
	/** The CI home that holds nightly.jsonl and the job's log. */
	home: string;
	checkout: string;
	path: string;
	launchctl: Launchctl;
	log: (line: string) => void;
	/** Blocks for `ms`; bootout finishes asynchronously, so install waits for it. */
	sleep: (ms: number) => void;
};

export const plistPath = (agentsDir: string) => join(agentsDir, `${LABEL}.plist`);
export const jobLog = (home: string) => join(home, "nightly.log");
const time = `${String(HOUR).padStart(2, "0")}:${String(MINUTE).padStart(2, "0")}`;

const loaded = (d: ScheduleDeps) => d.launchctl(["print", `gui/${d.uid}/${LABEL}`]).status === 0;

/** Boots out a loaded agent and waits until launchd has let it go. True when one was loaded. */
function bootout(d: ScheduleDeps): boolean {
	if (!loaded(d)) return false;
	d.launchctl(["bootout", `gui/${d.uid}/${LABEL}`]);
	for (let waited = 0; loaded(d); waited += 100) {
		if (waited >= 10_000) throw new Error(`launchctl bootout left ${LABEL} loaded after 10 s.`);
		d.sleep(100);
	}
	return true;
}

/** Writes the plist and (re)loads it. Running it again replaces the one agent. */
export function install(d: ScheduleDeps): number {
	const file = plistPath(d.agentsDir);
	mkdirSync(d.agentsDir, { recursive: true });
	mkdirSync(d.home, { recursive: true });
	const replaced = bootout(d);
	writeFileSync(
		`${file}.tmp`,
		plist({ label: LABEL, hour: HOUR, minute: MINUTE, checkout: d.checkout, path: d.path, log: jobLog(d.home) }),
	);
	renameSync(`${file}.tmp`, file);
	const r = d.launchctl(["bootstrap", `gui/${d.uid}`, file]);
	if (r.status !== 0) throw new Error(`launchctl bootstrap failed:\n${r.output}`);
	d.log(`${replaced ? "replaced" : "installed"} ${LABEL}: bin/dev nightly from ${d.checkout} at ${time} every day`);
	d.log(`plist: ${file}`);
	d.log(`log: ${jobLog(d.home)}`);
	return 0;
}

/** The last nightly_result or nightly_skipped line, or null. */
export function lastRecord(home: string): string | null {
	const file = nightlyLog(home);
	if (!existsSync(file)) return null;
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const { type } = JSON.parse(lines[i]) as { type?: string };
			if (type === "nightly_result" || type === "nightly_skipped") return lines[i];
		} catch {
			// A torn line from a killed run says nothing.
		}
	}
	return null;
}

export function status(d: ScheduleDeps): number {
	const file = plistPath(d.agentsDir);
	const installed = existsSync(file);
	const isLoaded = loaded(d);
	if (!installed && !isLoaded) d.log(`${LABEL} is not installed. Install it with bin/dev nightly schedule install.`);
	else {
		d.log(`${LABEL}: ${installed ? "installed" : "plist missing"}, ${isLoaded ? "loaded" : "not loaded"}`);
		d.log(`runs: bin/dev nightly at ${time} local time every day`);
		d.log(`plist: ${file}`);
		d.log(`log: ${jobLog(d.home)}`);
	}
	d.log(`last record (${nightlyLog(d.home)}): ${lastRecord(d.home) ?? "none"}`);
	return 0;
}

export function uninstall(d: ScheduleDeps): number {
	const file = plistPath(d.agentsDir);
	const wasLoaded = bootout(d);
	const hadPlist = existsSync(file);
	rmSync(file, { force: true });
	d.log(
		wasLoaded || hadPlist ? `uninstalled ${LABEL}` : `nothing was installed: ${LABEL} had no plist and was not loaded`,
	);
	return 0;
}

// ---- The real machine. ----

const which = (command: string) => {
	const r = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : null;
};

/** The node bin/dev runs on first, then the dirs of every tool `bin/dev nightly` calls, then the system dirs. */
export function jobPath(found: (command: string) => string | null = which, node = process.execPath): string {
	const dirs = [dirname(node)];
	for (const tool of ["pnpm", "corepack", "gh", "portless", "git"]) {
		const at = found(tool);
		if (at) dirs.push(dirname(at));
		else throw new Error(`${tool} is not on PATH; bin/dev nightly needs it.`);
	}
	return [...new Set([...dirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

function realDeps(root: string): ScheduleDeps {
	const common = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
		encoding: "utf8",
	});
	if (common.status !== 0) throw new Error("Not in a git checkout: cannot find the main checkout.");
	return {
		agentsDir: join(homedir(), "Library", "LaunchAgents"),
		uid: userInfo().uid,
		home: ciHome(),
		checkout: dirname(common.stdout.trim()),
		get path() {
			return jobPath();
		},
		launchctl: (args) => {
			const r = spawnSync("launchctl", args, { encoding: "utf8" });
			return { status: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
		},
		log: (line) => console.log(line),
		sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
	};
}

/** `bin/dev nightly schedule <action>`. */
export function scheduleCommand(args: string[], root: string): number | null {
	if (args.length !== 1) return null;
	const actions = { install, status, uninstall };
	if (!Object.hasOwn(actions, args[0])) return null;
	const action = actions[args[0] as keyof typeof actions];
	if (process.platform !== "darwin") throw new Error("The nightly schedule is a launchd agent: macOS only.");
	return action(realDeps(root));
}
