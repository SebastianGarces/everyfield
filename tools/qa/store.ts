import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

export function repoHome(root: string): string {
	const common = commonDir(root);
	return basename(common) === ".git" ? dirname(common) : common;
}

export const driverLogPath = (root: string, id: string) => join(commonDir(root), "qa", `${id}.cron.log`);

export const cronSecretPath = (root: string, id: string) => join(commonDir(root), "qa", `${id}.cron-secret`);

export function writeCronSecret(root: string, id: string, secret: string): void {
	const file = cronSecretPath(root, id);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	rmSync(file, { force: true });
	writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
}

export const driveLockPath = (root: string) => join(commonDir(root), "qa", "drive.lock");

export function drivePid(root: string): number | undefined {
	let pid: number;
	try {
		pid = Number(readFileSync(driveLockPath(root), "utf8").trim());
	} catch {
		return undefined;
	}
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
	return /\bmain\.ts drive\b/.test(command) ? pid : undefined;
}

function readFile(file: string): PreviewFile {
	if (!existsSync(file)) return { previews: [] };
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PreviewFile>;
	if (!Array.isArray(parsed.previews)) fail(`${file} has no previews list. Inspect it before you run qa again.`);
	return { previews: parsed.previews };
}

export function readPreviews(root: string): QaPreview[] {
	return readFile(previewsPath(root)).previews.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

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
