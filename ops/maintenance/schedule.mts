import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ScheduleInput = { agents: string; config: string; cli: string; logs: string };
const DAILY = { label: "app.everyfield.backup-daily", command: "backup-daily" };
const EXPIRE = { label: "app.everyfield.backup-expire", command: "backup-expire" };

const xml = (text: string) => text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function plist(job: typeof DAILY, input: ScheduleInput) {
	const when =
		job === DAILY
			? "<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Hour</key>\n\t\t<integer>3</integer>\n\t\t<key>Minute</key>\n\t\t<integer>30</integer>\n\t</dict>"
			: "<key>StartInterval</key>\n\t<integer>3600</integer>";
	const args = ["/usr/bin/env", "node", "--conditions=react-server", input.cli, job.command, "--config", input.config];
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${job.label}</string>
	<key>ProgramArguments</key>
	<array>
${args.map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n")}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>${xml(join(homedir(), ".local/bin"))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
	</dict>
	${when}
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	<string>${xml(join(input.logs, `${job.command}.log`))}</string>
	<key>StandardErrorPath</key>
	<string>${xml(join(input.logs, `${job.command}.log`))}</string>
</dict>
</plist>
`;
}

const launchctl = (...args: string[]) => execFileSync("launchctl", args, { stdio: "ignore" });
const domain = () => `gui/${process.getuid!()}`;

export async function installSchedule(input: ScheduleInput, load: boolean) {
	await mkdir(input.agents, { recursive: true });
	await mkdir(input.logs, { recursive: true, mode: 0o700 });
	const written: string[] = [];
	for (const job of [DAILY, EXPIRE]) {
		const path = join(input.agents, `${job.label}.plist`);
		await writeFile(path, plist(job, input), { mode: 0o600, flag: "wx" });
		written.push(path);
		if (load) launchctl("bootstrap", domain(), path);
	}
	return { written, loaded: load };
}

export async function uninstallSchedule(agents: string, unload: boolean) {
	const removed: string[] = [];
	for (const job of [DAILY, EXPIRE]) {
		if (unload)
			try {
				launchctl("bootout", `${domain()}/${job.label}`);
			} catch {}
		const path = join(agents, `${job.label}.plist`);
		await rm(path, { force: true });
		removed.push(path);
	}
	return { removed, unloaded: unload };
}
