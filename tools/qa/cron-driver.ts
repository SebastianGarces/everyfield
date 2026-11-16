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

const VERCEL_PROJECT = { orgId: "team_JKEPRxDWACtp9hugEthW215I", projectId: "prj_N6MhFGqi0UW5Iaa6RBDpusMKxMwu" };
const ROUTE = "/api/cron/jobs";
const MAX_SECONDS = "330";
const MARK = "qa-cron-http:";

type Driven = { deployment: string; secret: string; header: string; log: string };

export function drive(root: string): number {
	const minute = Number(process.env.QA_DRIVE_MINUTE_MS) || 60_000;
	const offset = Math.round(minute / 30);
	const scanMs = Math.min(5_000, Math.round(minute / 5));
	const tickLog = process.env.QA_DRIVE_TICK_LOG;
	const note = (line: string, at = Date.now()) => {
		if (tickLog) appendFileSync(tickLog, `${at} ${line}\n`);
	};

	const lock = driveLockPath(root);
	takeLock(root, lock);
	const dir = mkdtempSync(join(tmpdir(), "evf-qa-cron-"));
	const cleanup = () => {
		rmSync(dir, { recursive: true, force: true });
		try {
			if (readFileSync(lock, "utf8").trim() === String(process.pid)) rmSync(lock, { force: true });
		} catch {}
	};
	process.on("exit", cleanup);
	mkdirSync(join(dir, ".vercel"));
	writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify(VERCEL_PROJECT));

	const driven = new Map<string, Driven>();
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

	function tick(id: string, d: Driven, due: number | "now"): void {
		note(`call ${id} ${due}`);
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

	function sync(): void {
		note("scan");
		let records;
		try {
			records = readPreviews(root);
		} catch {
			return;
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
				continue;
			}
			const header = join(dir, `${r.id}.header`);
			writeFileSync(header, `Authorization: Bearer ${secret}\n`, { mode: 0o600 });
			const d = { deployment: r.deployment, secret, header, log: driverLogPath(root, r.id) };
			driven.set(r.id, d);
			write(d, `started: qa drive pid ${process.pid}, ${ROUTE} every minute on ${r.deployment}`);
			console.log(`qa drive: driving ${r.id} (${r.deployment}). Log: ${d.log}`);
			tick(r.id, d, "now");
		}
	}

	function schedule(): void {
		const now = Date.now();
		const next = Math.ceil((now - offset + 1) / minute) * minute + offset;
		note(`next ${next}`, now);
		setTimeout(() => {
			for (const [id, d] of driven) tick(id, d, next);
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
				rmSync(lock, { force: true });
			}
		}
	} finally {
		rmSync(draft, { force: true });
	}
}
