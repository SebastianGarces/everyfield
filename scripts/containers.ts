import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";

export const LABELS = {
	repository: "everyfield.repository",
	worktree: "everyfield.worktree",
	task: "everyfield.task",
} as const;
export const OLD_APP_LABEL = "everyfield.app.worktree";

type Result = { status: number; stdout: string; stderr: string };
export type Tool = (args: readonly string[]) => Result;
type Env = Record<string, string | undefined>;

const tool =
	(command: string, options: { cwd?: string; env?: Env } = {}): Tool =>
	(args) => {
		const r = spawnSync(command, args, {
			encoding: "utf8",
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
			cwd: options.cwd,
			env: (options.env ?? process.env) as NodeJS.ProcessEnv,
		});
		return {
			status: r.error ? 1 : (r.status ?? 1),
			stdout: r.stdout ?? "",
			stderr: r.error?.message ?? r.stderr ?? "",
		};
	};

const firstLine = (r: Result) => (r.stderr.trim() || r.stdout.trim()).split("\n")[0] || `exit ${r.status}`;

const nameTask = (worktree: string) => {
	const id = /^t(\d+)-/.exec(basename(worktree))?.[1];
	return id === undefined ? null : Number(id);
};
const isReview = (worktree: string) => /^t\d+-review-\d{10,}$/.test(basename(worktree));
const inside = (path: string, dir: string) => !relative(resolve(dir), resolve(path)).startsWith("..");

export function repositoryOf(root: string): { common: string; worktree: string } {
	const git = tool("git", { cwd: root });
	const r = git(["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
	const [common, worktree] = r.stdout.trim().split("\n");
	if (r.status !== 0 || !common || !worktree) throw new Error(`${root} is not a git worktree: ${firstLine(r)}`);
	return { common, worktree };
}

export function ownerLabels(root: string, env: Env = process.env): string[] {
	const { common, worktree } = repositoryOf(root);
	const seat = /^(?:T-)?(\d+)$/.exec(env.EVF_TASK ?? "")?.[1];
	const sameStore = !env.EVF_HOME || inside(env.EVF_HOME, common);
	const task = seat !== undefined && sameStore ? Number(seat) : nameTask(worktree);
	const labels: Record<string, string> = { [LABELS.repository]: common, [LABELS.worktree]: worktree };
	if (task !== null) labels[LABELS.task] = String(task);
	return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

type Inspected = {
	Id: string;
	Name: string;
	Created: string;
	Config: { Image: string; Labels: Record<string, string> | null };
};

type Owned = { tasks: number[]; worktree: string | null; match: "path" | "name"; legacyHash?: string };

const onlyImageLabels = (labels: Record<string, string>) =>
	Object.keys(labels).every(
		(key) => key.startsWith("desktop.docker.io/") || key.startsWith("org.opencontainers.image."),
	);

function ownerOf(container: Inspected, common: string): Owned | null {
	const name = container.Name.replace(/^\//, "");
	const labels = container.Config.Labels ?? {};
	if (name.startsWith("qa-test-") || Object.keys(labels).some((k) => k.startsWith("dev.evf."))) return null;
	const { [LABELS.repository]: repository, [LABELS.worktree]: worktree, [OLD_APP_LABEL]: old } = labels;
	if (repository !== undefined) {
		if (repository !== common || !worktree) return null;
		const named = nameTask(worktree);
		const tasks = [labels[LABELS.task], named].filter((id) => id !== undefined && id !== null).map(Number);
		return { tasks: [...new Set(tasks)], worktree, match: "path" };
	}
	if (old && name.startsWith("evf-app-")) {
		const named = nameTask(old);
		const legacyHash = name.slice("evf-app-".length);
		return { tasks: named === null ? [] : [named], worktree: old, match: "name", legacyHash };
	}
	const unlabeled = /^t(\d+)-/.exec(name)?.[1];
	if (unlabeled && onlyImageLabels(labels) && /^pgvector\/pgvector(?:[:@]|$)/.test(container.Config.Image))
		return { tasks: [Number(unlabeled)], worktree: null, match: "name" };
	return null;
}

type Answer<T> = { value: T } | { problem: string };
type Facts = { tasks: () => Answer<Map<number, string>>; worktrees: () => Answer<string[]> };

function readTasks(r: Result): Answer<Map<number, string>> {
	if (r.status !== 0) return { problem: `evf cannot be read: ${firstLine(r)}` };
	let rows: unknown;
	try {
		rows = JSON.parse(r.stdout);
	} catch {
		return { problem: "evf task list is not JSON" };
	}
	if (!Array.isArray(rows)) return { problem: "evf task list is not a list" };
	const tasks = new Map<number, string>();
	for (const row of rows as ({ id?: unknown; lifecycle?: unknown } | null)[]) {
		if (!Number.isInteger(row?.id) || typeof row?.lifecycle !== "string" || tasks.has(row.id as number))
			return { problem: "evf task list has a row with no id or lifecycle, or the same id twice" };
		tasks.set(row.id as number, row.lifecycle);
	}
	return { value: tasks };
}

function readWorktrees(r: Result, common: string): Answer<string[]> {
	if (r.status !== 0) return { problem: `git cannot be read: ${firstLine(r)}` };
	const entries = r.stdout
		.split("\0\0")
		.filter(Boolean)
		.map((entry) => entry.split("\0"));
	if (!entries.length || entries.some(([first]) => !first?.startsWith("worktree /")))
		return { problem: "git worktree list cannot be parsed" };
	const listed = entries
		.filter((lines) => !lines.some((line) => /^prunable\b/.test(line)))
		.map(([first]) => first!.slice("worktree ".length));
	if (!listed.includes(dirname(common))) return { problem: "git worktree list does not name the main checkout" };
	return { value: listed };
}

type Verdict = { remove: boolean; reason: string; blocked?: boolean };

function worktreeGone(owned: Owned, worktrees: string[]): boolean {
	return !worktrees.some((path) => (owned.match === "path" ? path : basename(path)) === owned.worktree);
}

function fromThisRepository(owned: Owned, common: string): boolean {
	if (owned.legacyHash === undefined) return true;
	const base = dirname(common);
	return [base, join(base, ".worktrees", owned.worktree!), join(dirname(base), owned.worktree!)].some(
		(path) => createHash("sha256").update(path).digest("hex").slice(0, 12) === owned.legacyHash,
	);
}

function judge(owned: Owned, common: string, facts: Facts): Verdict {
	const { tasks, worktree } = owned;
	if (!tasks.length) {
		const worktrees = facts.worktrees();
		if ("problem" in worktrees) return { remove: false, reason: worktrees.problem, blocked: true };
		if (!worktreeGone(owned, worktrees.value)) return { remove: false, reason: "its worktree is live" };
		if (!fromThisRepository(owned, common))
			return { remove: false, reason: "an old app container that may belong to another checkout", blocked: true };
		return { remove: true, reason: `its worktree ${worktree} is gone` };
	}
	const known = facts.tasks();
	if ("problem" in known) return { remove: false, reason: known.problem, blocked: true };
	const states = tasks.map((id) => ({ id, state: known.value.get(id) }));
	const open: number[] = [];
	for (const { id, state } of states) {
		if (state === undefined) return { remove: false, reason: `evf does not know T-${id}`, blocked: true };
		if (state === "open") open.push(id);
		else if (state !== "landed" && state !== "abandoned")
			return { remove: false, reason: `evf says T-${id} is ${state}`, blocked: true };
	}
	if (!open.length) return { remove: true, reason: states.map(({ id, state }) => `T-${id} ${state}`).join(", ") };
	const keep = { remove: false, reason: open.map((id) => `T-${id} is open`).join(", ") };
	if (!worktree || !isReview(worktree) || open.some((id) => id !== nameTask(worktree))) return keep;
	const worktrees = facts.worktrees();
	if ("problem" in worktrees) return { remove: false, reason: worktrees.problem, blocked: true };
	return worktreeGone(owned, worktrees.value)
		? { remove: true, reason: `its review worktree ${basename(worktree)} is gone` }
		: keep;
}

export type Deps = { common: string; docker: Tool; evf: Tool; git: Tool };

export function realDeps(root: string): Deps {
	const { common } = repositoryOf(root);
	const base = dirname(common);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EVF_")));
	return { common, docker: tool("docker"), evf: tool("evf", { cwd: base, env }), git: tool("git", { cwd: base, env }) };
}

function readFacts({ common, evf, git }: Deps): Facts {
	let tasks: ReturnType<Facts["tasks"]> | undefined, worktrees: ReturnType<Facts["worktrees"]> | undefined;
	return {
		tasks: () => (tasks ??= readTasks(evf(["task", "list", "--all", "--json"]))),
		worktrees: () => (worktrees ??= readWorktrees(git(["worktree", "list", "--porcelain", "-z"]), common)),
	};
}

class DockerProblem extends Error {}

function inspect(docker: Tool, id: string): Inspected | null {
	const r = docker(["inspect", "--type", "container", id]);
	if (r.status !== 0) {
		if (/no such (?:container|object)/i.test(r.stderr)) return null;
		throw new DockerProblem(`docker inspect failed: ${firstLine(r)}`);
	}
	try {
		const [container] = JSON.parse(r.stdout) as Inspected[];
		if (container?.Id && container.Name && container.Config?.Image) return container;
	} catch {}
	throw new DockerProblem(`docker inspect of ${id} cannot be parsed`);
}

type Entry = { id: string; name: string; owner: string; ageMinutes: number; verdict: Verdict };

function describe(container: Inspected, owned: Owned, verdict: Verdict): Entry {
	const owner = [
		...owned.tasks.map((id) => `T-${id}`),
		...(owned.worktree ? [owned.match === "path" ? owned.worktree : basename(owned.worktree)] : []),
	].join(" ");
	const ageMinutes = Math.floor((Date.now() - Date.parse(container.Created)) / 60_000);
	return { id: container.Id, name: container.Name.replace(/^\//, ""), owner, ageMinutes, verdict };
}

type Survey = { entries: Entry[]; problems: string[] };

export function survey(deps: Deps): Survey {
	const entries: Entry[] = [],
		problems: string[] = [];
	const listed = deps.docker(["ps", "-a", "-q", "--no-trunc"]);
	if (listed.status !== 0) return { entries, problems: [`Docker cannot be reached: ${firstLine(listed)}`] };
	const owners: [Inspected, Owned][] = [];
	for (const id of listed.stdout.split("\n").filter(Boolean)) {
		try {
			const container = inspect(deps.docker, id);
			const owned = container && ownerOf(container, deps.common);
			if (container && owned) owners.push([container, owned]);
		} catch (error) {
			if (!(error instanceof DockerProblem)) throw error;
			problems.push(error.message);
		}
	}
	const facts = readFacts(deps);
	for (const [container, owned] of owners) entries.push(describe(container, owned, judge(owned, deps.common, facts)));
	return { entries, problems };
}

function sweep(deps: Deps): Survey & { removed: Entry[] } {
	const { entries, problems } = survey(deps);
	const removed: Entry[] = [],
		kept: Entry[] = [];
	for (const entry of entries) {
		if (!entry.verdict.remove) {
			kept.push(entry);
			continue;
		}
		try {
			const container = inspect(deps.docker, entry.id);
			if (!container) continue;
			const owned = ownerOf(container, deps.common);
			if (!owned) continue;
			const now = describe(container, owned, judge(owned, deps.common, readFacts(deps)));
			if (!now.verdict.remove) {
				kept.push(now);
				continue;
			}
			const r = deps.docker(["rm", "-f", "-v", now.id]);
			if (r.status === 0) removed.push(now);
			else if (!/no such container|already in progress/i.test(r.stderr))
				throw new DockerProblem(`docker rm of ${now.name} failed: ${firstLine(r)}`);
		} catch (error) {
			if (!(error instanceof DockerProblem)) throw error;
			problems.push(error.message);
		}
	}
	return { entries: kept, problems, removed };
}

export function reportSweep(deps: Deps, log: (line: string) => void): number {
	const { entries, problems, removed } = sweep(deps);
	const at = new Date().toISOString();
	for (const { name, verdict } of removed) log(`${at} containers sweep removed ${name}: ${verdict.reason}`);
	const blocked = entries.filter(({ verdict }) => verdict.blocked);
	for (const { name, verdict } of blocked) log(`${at} containers sweep kept ${name}: ${verdict.reason}`);
	for (const problem of problems) log(`${at} containers sweep: ${problem}`);
	return problems.length ? 1 : 0;
}

export function sweepQuietly(root: string, log: (line: string) => void = console.error): void {
	try {
		reportSweep(realDeps(root), log);
	} catch (error) {
		log(`containers sweep skipped: ${error instanceof Error ? error.message : String(error)}`);
	}
}
