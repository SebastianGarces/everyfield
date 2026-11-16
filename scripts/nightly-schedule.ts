import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	checkout: string;
	path: string;
	log: string;
};

const xml = (s: string) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

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

export type Launchctl = (args: readonly string[]) => { status: number; output: string };

export type ScheduleDeps = {
	agentsDir: string;
	uid: number;
	home: string;
	checkout: string;
	path: string;
	launchctl: Launchctl;
	log: (line: string) => void;
	sleep: (ms: number) => void;
};

export const plistPath = (agentsDir: string) => join(agentsDir, `${LABEL}.plist`);
export const jobLog = (home: string) => join(home, "nightly.log");
const time = `${String(HOUR).padStart(2, "0")}:${String(MINUTE).padStart(2, "0")}`;

const loaded = (d: ScheduleDeps) => d.launchctl(["print", `gui/${d.uid}/${LABEL}`]).status === 0;

function bootout(d: ScheduleDeps): boolean {
	if (!loaded(d)) return false;
	d.launchctl(["bootout", `gui/${d.uid}/${LABEL}`]);
	for (let waited = 0; loaded(d); waited += 100) {
		if (waited >= 10_000) throw new Error(`launchctl bootout left ${LABEL} loaded after 10 s.`);
		d.sleep(100);
	}
	return true;
}

export function install(d: ScheduleDeps): number {
	const file = plistPath(d.agentsDir);
	mkdirSync(d.agentsDir, { recursive: true });
	mkdirSync(d.home, { recursive: true });
	const replaced = bootout(d);
	writeFileSync(
		file,
		plist({ label: LABEL, hour: HOUR, minute: MINUTE, checkout: d.checkout, path: d.path, log: jobLog(d.home) }),
	);
	const r = d.launchctl(["bootstrap", `gui/${d.uid}`, file]);
	if (r.status !== 0) throw new Error(`launchctl bootstrap failed:\n${r.output}`);
	d.log(`${replaced ? "replaced" : "installed"} ${LABEL}: bin/dev nightly from ${d.checkout} at ${time} every day`);
	d.log(`plist: ${file}`);
	d.log(`log: ${jobLog(d.home)}`);
	return 0;
}

export function lastRecord(home: string): string | null {
	const file = nightlyLog(home);
	if (!existsSync(file)) return null;
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	for (const line of lines.reverse()) {
		try {
			const { type } = JSON.parse(line) as { type?: string };
			if (type === "nightly_result" || type === "nightly_skipped") return line;
		} catch {}
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

const which = (command: string) => {
	const r = spawnSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim() : null;
};

export function jobPath(found: (command: string) => string | null = which, node = process.execPath): string {
	const dirs = [dirname(found("node") ?? node)];
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

export function scheduleCommand(args: string[], root: string): number | null {
	const [name, ...rest] = args;
	const actions = { install, status, uninstall };
	if (name === undefined || rest.length || !Object.hasOwn(actions, name)) return null;
	const action = actions[name as keyof typeof actions];
	if (process.platform !== "darwin") throw new Error("The nightly schedule is a launchd agent: macOS only.");
	return action(realDeps(root));
}
