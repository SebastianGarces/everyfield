import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverLogPath, readPreviews } from "./store.ts";

/**
 * T-255: the scheduled-send driver of one QA preview. Vercel runs apps/web/vercel.json's crons on production only, so
 * `qa up` starts this process on the lead's Mac to call the preview's real /api/cron/jobs once a minute, as the
 * production schedule does, until `qa down` stops it. It also stops on its own once the preview's record is gone.
 *
 * Usage (from `qa up` only): node cron-driver.ts <repo root> <qa id> <deployment url>, with QA_CRON_SECRET in the
 * environment. The secret leaves this process only in a private header file that curl reads; `vercel curl` adds the
 * project's existing Protection Bypass for Automation. The log holds times, HTTP statuses and the route's counts.
 */

const VERCEL_PROJECT = { orgId: "team_JKEPRxDWACtp9hugEthW215I", projectId: "prj_N6MhFGqi0UW5Iaa6RBDpusMKxMwu" };
const ROUTE = "/api/cron/jobs";
/** The route's turn may run 180 s after a start in the first 60 s (maxDuration 300). */
const MAX_SECONDS = "330";
const MINUTE = 60_000;
/** A tick lands this long after the minute starts, as a minute cron does. */
const OFFSET_MS = 2_000;

const [root, id, deployment] = process.argv.slice(2);
const secret = process.env.QA_CRON_SECRET;
delete process.env.QA_CRON_SECRET;
if (!root || !id || !deployment || !secret) {
	console.error("cron-driver: usage: cron-driver.ts <root> <id> <deployment>, with QA_CRON_SECRET set.");
	process.exit(2);
}

const log = driverLogPath(root, id);
const write = (line: string) =>
	appendFileSync(log, `${new Date().toISOString()} ${line.split(secret).join("<redacted>")}\n`);

// The linked project vercel curl needs, and the Authorization header, in a directory only this user can read.
const dir = mkdtempSync(join(tmpdir(), "evf-qa-cron-"));
mkdirSync(join(dir, ".vercel"));
writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify(VERCEL_PROJECT));
const header = join(dir, "authorization.header");
writeFileSync(header, `Authorization: Bearer ${secret}\n`, { mode: 0o600 });

let stopping = false;
function stop(why: string): never {
	if (!stopping) write(`stopped: ${why}`);
	stopping = true;
	rmSync(dir, { recursive: true, force: true });
	process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop(signal));

const MARK = "qa-cron-http:";

/** One call of the route. Ticks may overlap, as production's do: the route's workers claim with SKIP LOCKED. */
function tick(): void {
	const child = spawn(
		"vercel",
		[
			"curl",
			ROUTE,
			"--deployment",
			deployment!,
			"--",
			"--silent",
			"--show-error",
			"--max-time",
			MAX_SECONDS,
			"--header",
			`@${header}`,
			"--write-out",
			`\n${MARK}%{http_code}\n`,
		],
		{ cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
	);
	let out = "",
		err = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (err += d));
	child.on("error", (error) => write(`failed: vercel could not start (${error.message})`));
	child.on("close", (code) => {
		const at = out.lastIndexOf(MARK);
		const status = at === -1 ? "" : out.slice(at + MARK.length).trim();
		const body = (at === -1 ? out : out.slice(0, at)).trim().replace(/\s+/g, " ").slice(0, 300);
		if (status === "200") write(`ok: HTTP 200 ${body}`);
		else
			write(
				`failed: ${status ? `HTTP ${status} ${body}` : `vercel curl exit ${code}`} ${err.trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`.trim(),
			);
	});
}

function schedule(): void {
	const now = Date.now();
	const next = Math.ceil((now - OFFSET_MS + 1) / MINUTE) * MINUTE + OFFSET_MS;
	setTimeout(() => {
		tick();
		schedule();
	}, next - now);
}

write(`started: pid ${process.pid}, ${ROUTE} every minute on ${deployment}`);
tick();
schedule();
// The record is the preview's life: once `qa down` (or anything else) removes it, this driver ends too.
setInterval(() => {
	try {
		if (!readPreviews(root).some((r) => r.id === id)) stop("the preview's record is gone");
	} catch {
		// A record being rewritten reads again on the next pass.
	}
}, 5_000);
