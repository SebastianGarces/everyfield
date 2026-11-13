import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
	/** T-255: the process id of the preview's scheduled-send driver (cron-driver.ts), once it runs. */
	driver_pid?: number;
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

const previewsPath = (root: string) => join(commonDir(root), "qa", "previews.json");

/** The scheduled-send driver's log of one preview, next to the records: times, HTTP statuses and counts only. */
export const driverLogPath = (root: string, id: string) => join(commonDir(root), "qa", `${id}.cron.log`);

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

export const setDriver = (root: string, id: string, pid: number) =>
	change(root, (records) => {
		for (const preview of records.previews) if (preview.id === id) preview.driver_pid = pid;
	});

export const removePreview = (root: string, id: string) =>
	change(root, (records) => {
		records.previews = records.previews.filter((preview) => preview.id !== id);
	});
