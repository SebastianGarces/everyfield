import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export const EXIT = { ok: 0, failed: 1, usage: 2, notFound: 3, noTarget: 4, browser: 5 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class AppError extends Error {
	code: ExitCode;
	constructor(code: ExitCode, message: string) {
		super(message);
		this.code = code;
	}
}

export type Repo = { root: string; common: string; name: string };

export function run(command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
	return {
		status: result.status ?? 1,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
		error: result.error,
	};
}

export const firstLine = (text: string) =>
	text
		.trim()
		.split("\n")
		.find((line) => line.trim()) ?? "";

export function repoAt(cwd: string): Repo {
	const top = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	const common = run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (top.status !== 0 || common.status !== 0) throw new AppError(EXIT.noTarget, "run app inside a git checkout");
	const root = top.stdout.trim();
	return { root, common: common.stdout.trim(), name: basename(root) };
}

const stateRoot = (repo: Repo) => join(repo.common, "evf-app");
export const appDir = (repo: Repo) => join(stateRoot(repo), repo.name);

export function removeAppDir(repo: Repo) {
	const dir = appDir(repo);
	const tail = relative(stateRoot(repo), dir);
	if (!repo.name || !tail || tail.startsWith("..") || tail.includes(sep) || !repo.common.endsWith(".git"))
		throw new AppError(EXIT.noTarget, `refused to delete ${dir}: not this worktree's app folder`);
	rmSync(dir, { recursive: true, force: true });
}

export function sessionName(raw: string): string {
	if (!/^[\w.-]+$/.test(raw))
		throw new AppError(EXIT.usage, "session names use letters, digits, dot, dash or underscore");
	return raw;
}

const sessionFile = (repo: Repo, session: string) => join(stateRoot(repo), "sessions", `${sessionName(session)}.json`);

export function readJson<T>(path: string): T | null {
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

export function writePrivate(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify(value, null, "\t"), { mode: 0o600 });
}

export type Ports = { app: number; pg: number; bucket: number };
export type LocalApp = {
	worktree: string;
	origin: string;
	mode: "dev" | "prod";
	head: string;
	ports: Ports;
	container: string;
	image: string;
	phase: string;
	startedAt: string;
	pid?: number;
	readyMs?: number;
};

export const localAppPath = (repo: Repo) => join(appDir(repo), "app.json");
export const readLocalApp = (repo: Repo) => readJson<LocalApp>(localAppPath(repo));
export const writeLocalApp = (repo: Repo, app: LocalApp) => writePrivate(localAppPath(repo), app);

export type Element = { ref: string; role: string; name: string; attrs: string };
export type SessionState = {
	origin?: string;
	persona?: string;
	seenErrors: number;
	baseline?: { url: string; scope: string; elements: Element[] };
};

export const readSession = (repo: Repo, session: string): SessionState =>
	readJson<SessionState>(sessionFile(repo, session)) ?? { seenErrors: 0 };
export const writeSession = (repo: Repo, session: string, state: SessionState) =>
	writePrivate(sessionFile(repo, session), state);
export const dropSession = (repo: Repo, session: string) => rmSync(sessionFile(repo, session), { force: true });

export function insideWorkTree(path: string): boolean {
	let dir = path;
	while (!existsSync(dir)) dir = dirname(dir);
	const inside = run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
	return inside.status === 0 && inside.stdout.trim() === "true";
}

export function evidenceDir(repo: Repo, task: string | undefined): string {
	const branch = run("git", ["-C", repo.root, "branch", "--show-current"]).stdout.trim();
	const head = run("git", ["-C", repo.root, "rev-parse", "--short=7", "HEAD"]).stdout.trim() || "nohead";
	const label = (task ?? (branch || repo.name)).replace(/[^\w.-]+/g, "-");
	return join(repo.common, "evf-evidence", label, head);
}

export const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
