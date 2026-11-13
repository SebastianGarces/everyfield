import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The open QA previews, in one small JSON file under the git common directory, so every worktree of the repository
 * sees the same list and nothing is tracked. A record is written before the Neon branch exists, so a crash at any later
 * step leaves what `qa down` needs. It holds names only: never a connection string, key or password.
 */
export type QaPreview = {
	id: string;
	branch: string;
	head: string;
	neon_branch: string;
	url: string;
	deployment: string | null;
	created_at: string;
};

type PreviewFile = { previews: QaPreview[] };

/** A refusal or failure to show as one line. */
export class QaError extends Error {
	name = "ToolError";
}

export function fail(message: string): never {
	throw new QaError(message);
}

const LOCK_WAIT_MS = 10_000;

function commonDir(root: string): string {
	const r = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8" });
	if (r.status !== 0) fail("qa must run inside the everyfield repository.");
	return resolve(root, r.stdout.trim());
}

export const previewsPath = (root: string) => join(commonDir(root), "qa", "previews.json");

/** The checkout that owns the git common directory, where `bin/qa drive` runs from. */
export function repoHome(root: string): string {
	const common = commonDir(root);
	return basename(common) === ".git" ? dirname(common) : common;
}

/** The scheduled-send log of one preview, next to the records: times, HTTP statuses and counts only. */
export const driverLogPath = (root: string, id: string) => join(commonDir(root), "qa", `${id}.cron.log`);

/**
 * T-289: one preview's cron secret, which `qa drive` reads to call its /api/cron/jobs. Only the owner can read it
 * (0600); it is never in the records. `qa down` deletes it, which also tells `qa drive` to stop calling the preview.
 */
export const cronSecretPath = (root: string, id: string) => join(commonDir(root), "qa", `${id}.cron-secret`);

export function writeCronSecret(root: string, id: string, secret: string): void {
	const file = cronSecretPath(root, id);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	rmSync(file, { force: true });
	writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
}

/** The lock of the one `qa drive` of this repository: a file holding its pid. */
export const driveLockPath = (root: string) => join(commonDir(root), "qa", "drive.lock");

/** The pid of the running `qa drive` of this repository, or undefined when none runs (a stale lock counts as none). */
export function drivePid(root: string): number | undefined {
	let pid: number;
	try {
		pid = Number(readFileSync(driveLockPath(root), "utf8").trim());
	} catch {
		return undefined;
	}
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	// The pid must still be a qa drive: after a crash or a restart the number can belong to another process.
	const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
	return /\bmain\.ts drive\b/.test(command) ? pid : undefined;
}

function readFile(file: string): PreviewFile {
	if (!existsSync(file)) return { previews: [] };
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PreviewFile>;
	if (!Array.isArray(parsed.previews)) fail(`${file} has no previews list. Inspect it before you run qa again.`);
	// Only the previews list is kept, so any other key an older qa wrote drops on the next write.
	return { previews: parsed.previews };
}

/** Every open preview, oldest first. */
export function readPreviews(root: string): QaPreview[] {
	return readFile(previewsPath(root)).previews.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** One read, change and atomic replace under a lock, because two `qa` commands can run at once. */
function change<T>(root: string, edit: (records: PreviewFile) => T): T {
	const file = previewsPath(root),
		lock = `${file}.lock`;
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	for (let waited = 0; ; waited += 100) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (waited >= LOCK_WAIT_MS) fail(`${lock} is held. If no qa command is running, remove that directory.`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
		}
	}
	try {
		const records = readFile(file),
			result = edit(records),
			next = `${file}.${process.pid}.tmp`;
		writeFileSync(next, `${JSON.stringify(records, null, "\t")}\n`, { mode: 0o600 });
		renameSync(next, file);
		return result;
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

export const addPreview = (root: string, preview: QaPreview) =>
	change(root, (records) => void records.previews.push(preview));

export const setDeployment = (root: string, id: string, deployment: string) =>
	change(root, (records) => {
		for (const preview of records.previews) if (preview.id === id) preview.deployment = deployment;
	});

export const removePreview = (root: string, id: string) =>
	change(root, (records) => {
		records.previews = records.previews.filter((preview) => preview.id !== id);
	});
