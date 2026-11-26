import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Deps, realDeps, reportSweep, survey } from "./containers.ts";
import { agentDeps, bootout, jobPath, loaded, type ScheduleDeps, xml } from "./nightly-schedule.ts";

export const AGENT = "com.everyfield.containers";
const SECONDS = 300;
const USAGE = "usage: dev containers sweep|status|install|uninstall";

const RUN = `checkout=$1 log=$2
git -C "$checkout" cat-file -e HEAD:scripts/containers-command.ts 2>/dev/null || exit 0
if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt 262144 ]; then tail -c 65536 "$log" >"$log.tmp" && mv "$log.tmp" "$log"; fi
exec >>"$log" 2>&1
git -C "$checkout" merge-base --is-ancestor HEAD refs/remotes/origin/main &&
git -C "$checkout" diff --quiet HEAD -- bin scripts tools || { echo "$(date -u +%FT%TZ) skipped: $checkout holds code that has not landed"; exit 0; }
exec "$checkout/bin/dev" containers sweep`;

export function plist({ checkout, path, log }: { checkout: string; path: string; log: string }): string {
	const args = ["/bin/sh", "-c", RUN, "sweep", checkout, log];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${AGENT}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n")}
	</array>
	<key>WorkingDirectory</key>
	<string>${xml(checkout)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(path)}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>${SECONDS}</integer>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>/dev/null</string>
</dict>
</plist>
`;
}

const plistFile = (d: ScheduleDeps) => join(d.agentsDir, `${AGENT}.plist`);

export function install(d: ScheduleDeps): number {
	const file = plistFile(d),
		log = join(d.home, "containers.log");
	const text = plist({ checkout: d.checkout, path: d.path, log });
	mkdirSync(d.agentsDir, { recursive: true });
	mkdirSync(d.home, { recursive: true });
	const replaced = bootout(d, AGENT);
	writeFileSync(file, text);
	const r = d.launchctl(["bootstrap", `gui/${d.uid}`, file]);
	if (r.status !== 0) throw new Error(`launchctl bootstrap failed:\n${r.output}`);
	d.log(
		`${replaced ? "replaced" : "installed"} ${AGENT}: ${d.checkout}'s containers sweep, every ${SECONDS / 60} minutes`,
	);
	d.log(`plist: ${file}`);
	d.log(`log: ${log}`);
	return 0;
}

export function uninstall(d: ScheduleDeps): number {
	const was = bootout(d, AGENT) || existsSync(plistFile(d));
	rmSync(plistFile(d), { force: true });
	d.log(was ? `uninstalled ${AGENT}` : `nothing was installed: ${AGENT}`);
	return 0;
}

export function agentState(d: ScheduleDeps): string {
	const installed = existsSync(plistFile(d));
	if (!installed && !loaded(d, AGENT)) return "not installed. Install it with bin/dev containers install";
	return `${installed ? "installed" : "plist missing"}, ${loaded(d, AGENT) ? "loaded" : "not loaded"}`;
}

const age = (minutes: number) =>
	minutes < 60 ? `${minutes}m` : minutes < 2880 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;

export function status(deps: Deps, agent: string, log: (line: string) => void): number {
	const { entries, problems } = survey(deps);
	for (const { name, owner, ageMinutes, verdict } of entries)
		log(`${verdict.remove ? "remove" : "keep"}  ${name}  ${owner}  ${age(ageMinutes)} old: ${verdict.reason}`);
	if (!entries.length) log("no container of this repository");
	for (const problem of problems) log(problem);
	log(`LaunchAgent ${AGENT}: ${agent}`);
	return problems.length || entries.some(({ verdict }) => verdict.remove) ? 1 : 0;
}

export function containersCommand([action, ...rest]: string[], root: string): number {
	if (rest.length || !["sweep", "status", "install", "uninstall"].includes(action ?? "")) {
		console.error(USAGE);
		return 2;
	}
	const log = (line: string) => console.log(line);
	const mac = process.platform === "darwin";
	try {
		const agent = () => agentDeps(root, () => jobPath(undefined, undefined, ["docker", "git", "evf"], AGENT));
		if (action === "sweep") return reportSweep(realDeps(root), log);
		if (action === "status") return status(realDeps(root), mac ? agentState(agent()) : "macOS only", log);
		if (!mac) throw new Error(`${AGENT} is a launchd agent: macOS only.`);
		return action === "install" ? install(agent()) : uninstall(agent());
	} catch (error) {
		console.error(`dev containers: ${(error as Error).message}`);
		return 1;
	}
}
