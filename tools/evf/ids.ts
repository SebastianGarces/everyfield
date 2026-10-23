import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { baseRef, committedConfig, fail, git, run, type Config, type TaskRef } from "./lib.ts";

/**
 * OPS-52 (P5): workspaces share one remote, not one checkout, so the remote holds the reservations. An ID is
 * taken once `refs/evf/ids/<ID>` exists there. Each reservation is a new parentless commit, so a plain push to a
 * ref that already exists can never fast-forward: the remote rejects it, and exactly one caller wins.
 */
export type IdKind = "ops" | "decision";
const PREFIX: Record<IdKind, string> = { ops: "OPS-", decision: "D" };
const RESERVED = /^refs\/evf\/ids\/(OPS-|D)([1-9]\d*)$/;
const TASK_BRANCH = /^refs\/heads\/task\/ops-([1-9]\d*)$/;

export const reservationRef = (id: string) => `refs/evf/ids/${id}`;

function remoteRefs(root: string, cfg: Config): string[] {
	const r = run("git", ["ls-remote", cfg.remote, "refs/evf/ids/*", "refs/heads/task/*"], { cwd: root });
	if (r.code !== 0) fail(`Cannot read ${cfg.remote}'s ID reservations: ${r.stderr.trim()}`);
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t")[1]);
}

/** Every number of this kind in use: reservations, main's records and, for OPS, task branches on the remote. */
function usedNumbers(root: string, cfg: Config, kind: IdKind): number[] {
	const used: number[] = [];
	for (const ref of remoteRefs(root, cfg)) {
		const reserved = RESERVED.exec(ref);
		if (reserved && reserved[1] === PREFIX[kind]) used.push(Number(reserved[2]));
		const branch = kind === "ops" && TASK_BRANCH.exec(ref);
		if (branch) used.push(Number(branch[1]));
	}
	git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const main = baseRef(root, cfg);
	if (kind === "ops")
		for (const id of Object.keys(committedConfig(root, main).maintenanceTasks ?? {})) {
			const m = /^OPS-(\d+)$/.exec(id);
			if (m) used.push(Number(m[1]));
		}
	else
		for (const m of git(root, "show", `${main}:docs/architecture/decisions.md`).matchAll(/^## D(\d+)\b/gm))
			used.push(Number(m[1]));
	return used;
}

/** Push a fresh reservation for `id`. Returns false when another caller holds it. */
export function reserve(root: string, cfg: Config, id: string): boolean {
	const tree = git(root, "hash-object", "-w", "-t", "tree", "/dev/null");
	const who = run("git", ["config", "user.name"], { cwd: root }).stdout.trim() || "unknown";
	const note = `${id} reserved ${new Date().toISOString()} by ${who} on ${hostname()} (${randomUUID()})`;
	const commit = git(root, "commit-tree", tree, "-m", note);
	const push = run("git", ["push", "--quiet", cfg.remote, `${commit}:${reservationRef(id)}`], { cwd: root });
	if (push.code === 0) return true;
	// A rejected push means the ref exists. Anything else (network, permissions) is not an answer.
	if (/rejected/.test(push.stderr) && remoteRefs(root, cfg).includes(reservationRef(id))) return false;
	fail(`Cannot reserve ${id}: ${push.stderr.trim()}`);
}

/** Reserve and return the lowest unused ID above every one in use. A lost race moves to the next number. */
export function nextId(root: string, cfg: Config, kind: IdKind): string {
	let n = Math.max(0, ...usedNumbers(root, cfg, kind)) + 1;
	for (let attempt = 0; attempt < 20; attempt++, n++)
		if (reserve(root, cfg, `${PREFIX[kind]}${n}`)) return `${PREFIX[kind]}${n}`;
	fail(`Twenty ${PREFIX[kind]} IDs in a row were taken while reserving. Retry.`);
}

/**
 * A new OPS branch needs its ID reserved. A reservation from `evf id next ops` stands; without one, task start
 * reserves the ID itself. A task branch on the remote means another checkout started this ID already.
 */
export function requireOpsReservation(root: string, cfg: Config, task: TaskRef): void {
	const refs = remoteRefs(root, cfg);
	if (refs.includes(`refs/heads/${task.branch}`))
		fail(
			`${task.branch} already exists on ${cfg.remote}: another checkout started ${task.id}. Get a new ID with evf id next ops.`,
		);
	if (refs.includes(reservationRef(task.id))) return;
	if (!reserve(root, cfg, task.id))
		fail(`${task.id} was reserved by another caller just now. Get a new ID with evf id next ops.`);
	console.log(`id: reserved ${task.id} on ${cfg.remote}.`);
}
