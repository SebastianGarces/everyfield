import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

/** `carriedFromV1` lists every id already read from the v1 store, so a second carry-over cannot revive a removed preview. */
type PreviewFile = { previews: QaPreview[]; carriedFromV1: string[] };

/** A refusal or failure to show as one line. bin/evf reports this name the same way as its own errors. */
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

function readFile(file: string): PreviewFile {
	if (!existsSync(file)) return { previews: [], carriedFromV1: [] };
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PreviewFile>;
	if (!Array.isArray(parsed.previews)) fail(`${file} has no previews list. Inspect it before you run qa again.`);
	return { previews: parsed.previews, carriedFromV1: parsed.carriedFromV1 ?? [] };
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

/**
 * Copies the previews recorded in the v1 work store into the preview file. It reads the store and never writes to it.
 * It stops nothing: every preview stays up and `qa list` shows it. A second run adds only ids it has not seen.
 */
export function carryOverV1(root: string): { added: QaPreview[]; seen: number } {
	const store = join(commonDir(root), "evf", "work.sqlite");
	if (!existsSync(store)) fail(`No v1 store at ${store}, so there is nothing to carry over.`);
	const db = new DatabaseSync(store, { readOnly: true });
	let rows: QaPreview[];
	try {
		rows = db
			.prepare("SELECT id, branch, head, neon_branch, url, deployment, created_at FROM qa_previews ORDER BY created_at")
			.all()
			.map((row) => ({ ...row }) as QaPreview);
	} finally {
		db.close();
	}
	return change(root, (records) => {
		const known = new Set([...records.carriedFromV1, ...records.previews.map((preview) => preview.id)]);
		const added = rows.filter((row) => !known.has(row.id));
		records.previews.push(...added);
		records.carriedFromV1 = [...new Set([...records.carriedFromV1, ...rows.map((row) => row.id)])];
		return { added, seen: rows.length };
	});
}
