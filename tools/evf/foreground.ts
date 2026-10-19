import { fail, run } from "./lib.ts";

/** A piped agent shell cannot prove that its caller will keep waiting. Require an explicit promise. */
export function requireForeground(command: string, duration: string): void {
	const [tpgid, pgid] = run("ps", ["-o", "tpgid=,pgid=", "-p", String(process.pid)])
		.stdout.trim()
		.split(/\s+/)
		.map(Number);
	const terminalForeground = tpgid > 0 && tpgid === pgid;
	if (!terminalForeground && !process.env.EVF_MONITOR?.trim() && process.env.EVF_FOREGROUND !== "1")
		fail(
			`evf ${command} is detached from a terminal. Stay in your turn and run with EVF_FOREGROUND=1 while waiting for the result, or register a monitor and set EVF_MONITOR to its name.`,
		);
	console.error(
		`evf ${command}: expected duration ${duration}. Stay in your turn until the final result, or keep the registered monitor active.`,
	);
}
