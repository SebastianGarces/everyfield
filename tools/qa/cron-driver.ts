import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cronSecretPath, driveLockPath, drivePid, driverLogPath, fail, previewsPath, readPreviews } from "./store.ts";

/**
 * T-255, T-289: `qa drive`, the scheduled-send host of every QA preview. Vercel runs apps/web/vercel.json's crons on
 * production only, so this one process on the lead's Mac calls each preview's real /api/cron/jobs once a minute, as the
 * production schedule does. The lead starts it in a terminal outside any seat, because a seat's processes end with its
 * turn; seats only add and remove preview records. It reads previews.json every few seconds: a new preview with a
 * deployment and a cron secret file gets its first call at once, and one whose secret file or record is gone (`qa down`)
 * stops. One runs per repository, held by a lock file with its pid. Ctrl-C or SIGTERM stops it.
 *
 * A secret leaves its 0600 file only into a private header file that curl reads; `vercel curl` adds the project's
 * existing Protection Bypass for Automation. Each preview's log holds times, HTTP statuses and the route's counts.
 */

const VERCEL_PROJECT = { orgId: "team_JKEPRxDWACtp9hugEthW215I", projectId: "prj_N6MhFGqi0UW5Iaa6RBDpusMKxMwu" };
const ROUTE = "/api/cron/jobs";
/** The route's turn may run 180 s after a start in the first 60 s (maxDuration 300). */
const MAX_SECONDS = "330";
const MARK = "qa-cron-http:";

type Driven = { deployment: string; secret: string; header: string; log: string };

/** Starts the host and returns; its timers keep the process running until a signal stops it. */
export function drive(root: string): number {
	// The tests shorten the minute; Jonah's runs use the real one.
	const minute = Number(process.env.QA_DRIVE_MINUTE_MS) || 60_000;
	/** A tick lands this long after the minute starts, as a minute cron does (2 s of a real minute). */
	const offset = Math.round(minute / 30);
	const scanMs = Math.min(5_000, Math.round(minute / 5));

	const lock = driveLockPath(root);
	takeLock(root, lock);
	// The linked project vercel curl needs, and the Authorization headers, in a directory only this user can read.
	const dir = mkdtempSync(join(tmpdir(), "evf-qa-cron-"));
	const cleanup = () => {
		rmSync(dir, { recursive: true, force: true });
		try {
			if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock, { force: true });
		} catch {
			// The lock is already gone.
		}
	};
	process.on("exit", cleanup);
	mkdirSync(join(dir, ".vercel"));
	writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify(VERCEL_PROJECT));

	const driven = new Map<string, Driven>();
	const noted = new Set<string>();
	const write = (d: Driven, line: string) =>
		appendFileSync(d.log, `${new Date().toISOString()} ${line.split(d.secret).join("<redacted>")}\n`, { mode: 0o600 });

	function stopOne(id: string, why: string): void {
		const d = driven.get(id);
		if (!d) return;
		driven.delete(id);
		write(d, `stopped: ${why}`);
		rmSync(d.header, { force: true });
		console.log(`qa drive: stopped ${id}: ${why}`);
	}

	/** One call of the route. Ticks may overlap, as production's do: the route's workers claim with SKIP LOCKED. */
	function tick(id: string, d: Driven): void {
		const child = spawn(
			"vercel",
			[
				"curl",
				ROUTE,
				"--deployment",
				d.deployment,
				"--",
				"--silent",
				"--show-error",
				"--max-time",
				MAX_SECONDS,
				"--header",
				`@${d.header}`,
				"--write-out",
				`\n${MARK}%{http_code}\n`,
			],
			{ cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "",
			err = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (err += chunk));
		// A call that answers after its preview stopped writes nothing, so `qa down` leaves no log behind.
		const record = (line: string) => driven.get(id) === d && write(d, line);
		child.on("error", (error) => record(`failed: vercel could not start (${error.message})`));
		child.on("close", (code) => {
			const at = out.lastIndexOf(MARK);
			const status = at === -1 ? "" : out.slice(at + MARK.length).trim();
			const body = (at === -1 ? out : out.slice(0, at)).trim().replace(/\s+/g, " ").slice(0, 300);
			if (status === "200") record(`ok: HTTP 200 ${body}`);
			else if (code !== null || status)
				record(
					`failed: ${status ? `HTTP ${status} ${body}` : `vercel curl exit ${code}`} ${err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`.trim(),
				);
		});
	}

	/** Matches the driven set to the records: starts new previews with one call now, stops removed ones. */
	function sync(): void {
		let records;
		try {
			records = readPreviews(root);
		} catch {
			return; // A file being rewritten reads again on the next pass.
		}
		const ids = new Set(records.map((r) => r.id));
		for (const id of [...driven.keys()])
			if (!ids.has(id)) stopOne(id, "the preview's record is gone");
			else if (!existsSync(cronSecretPath(root, id))) stopOne(id, "bin/qa down removed the preview");
		for (const r of records) {
			if (driven.has(r.id) || !r.deployment) continue;
			let secret: string;
			try {
				secret = readFileSync(cronSecretPath(root, r.id), "utf8").trim();
			} catch {
				if (!noted.has(r.id))
					console.log(`qa drive: ${r.id} has no cron secret file yet; it starts once bin/qa up writes one.`);
				noted.add(r.id);
				continue;
			}
			if (!secret) continue;
			const header = join(dir, `${r.id}.header`);
			writeFileSync(header, `Authorization: Bearer ${secret}\n`, { mode: 0o600 });
			const d = { deployment: r.deployment, secret, header, log: driverLogPath(root, r.id) };
			driven.set(r.id, d);
			write(d, `started: qa drive pid ${process.pid}, ${ROUTE} every minute on ${r.deployment}`);
			console.log(`qa drive: driving ${r.id} (${r.deployment}). Log: ${d.log}`);
			tick(r.id, d);
		}
	}

	function schedule(): void {
		const now = Date.now();
		const next = Math.ceil((now - offset + 1) / minute) * minute + offset;
		setTimeout(() => {
			for (const [id, d] of driven) tick(id, d);
			schedule();
		}, next - now);
	}

	let stopping = false;
	const stop = (signal: string) => {
		if (stopping) return;
		stopping = true;
		for (const id of [...driven.keys()]) stopOne(id, `qa drive ended (${signal})`);
		cleanup();
		console.log(`qa drive: stopped (${signal}).`);
		process.exit(0);
	};
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop(signal));

	console.log(
		`qa drive: pid ${process.pid} calls ${ROUTE} once a minute for every preview in ${previewsPath(root)}. Stop it with Ctrl-C.`,
	);
	sync();
	schedule();
	setInterval(sync, scanMs);
	return 0;
}

/** Creates the lock with this pid in one step, or refuses while another qa drive holds it. A stale lock is replaced. */
function takeLock(root: string, lock: string): void {
	mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
	const draft = `${lock}.${process.pid}`;
	writeFileSync(draft, `${process.pid}\n`, { mode: 0o600 });
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				linkSync(draft, lock);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const held = drivePid(root);
				if (held)
					fail(`qa drive already runs for this repository (pid ${held}). Stop it with Ctrl-C in its terminal first.`);
				if (attempt) fail(`${lock} could not be replaced. If no qa drive runs, remove that file.`);
				rmSync(lock, { force: true }); // Left by a qa drive that is no longer running.
			}
		}
	} finally {
		rmSync(draft, { force: true });
	}
}
