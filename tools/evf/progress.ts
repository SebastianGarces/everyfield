import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	baseRef,
	evfDataDir,
	fail,
	findPackage,
	git,
	gitOk,
	independentReview,
	loadConfig,
	loadDag,
	parseTask,
	partsOf,
	pathsForPart,
	readJson,
	readParty,
	recordedPathsFor,
	run,
} from "./lib.ts";
import { carryProof, type MergeEvidence } from "./ship.ts";

export type ShippedRecord = {
	task: string;
	package_id: string | null;
	part: string | null;
	merge_commit: string;
	shipped_at: string;
	verification: MergeEvidence;
	base_sha: string;
	verified_head: string;
	acknowledged?: boolean;
	evidence: { path: string; commit: string; test: string; result: string; note: string };
};
/** The explorer reads these four lists. evf records no case or gate portions since W1, so they stay empty (D20). */
const PORTIONS = [
	"passed_case_portions",
	"passed_gate_portions",
	"deferred_case_portions",
	"deferred_gate_portions",
] as const;
type Portions = Record<(typeof PORTIONS)[number], unknown[]>;
const noPortions = (): Portions => ({
	passed_case_portions: [],
	passed_gate_portions: [],
	deferred_case_portions: [],
	deferred_gate_portions: [],
});
type Milestone = { task: string; merge_commit: string; acknowledged: boolean; stage: string } & Portions;
type ProgressPackage = {
	status: string;
	revision: number;
	updated_at: string | null;
	evidence: ShippedRecord["evidence"][];
	notes: string;
	fast_track?: FastTrackEvidence;
	milestones?: Record<string, Milestone>;
	retired_into?: string;
};
type Progress = { revision: number; updated_at: string; packages: Partial<Record<string, ProgressPackage>> };

/** Records written before D82 carry model families. The family rule that shipped them stays frozen for them. */
export const LEGACY_FAMILY_WAIVER_END = "2026-10-27T19:00:00.000Z";
function legacyFamilyReview(author: unknown, verifier: unknown, at: number): boolean {
	if (typeof author !== "string" || typeof verifier !== "string") return false;
	if (author === "xai" && verifier === "xai") return Number.isFinite(at) && at < Date.parse(LEGACY_FAMILY_WAIVER_END);
	return author !== verifier && (author === "anthropic" || verifier === "anthropic");
}
/** The stored review is independent by session, seat and model (D82), or by the frozen family rule for older records. */
function independentRecord(v: MergeEvidence): boolean {
	const legacy = v as unknown as { authorFamily?: unknown; approval?: { verifierFamily?: unknown } };
	if (legacy.authorFamily !== undefined)
		return legacyFamilyReview(legacy.authorFamily, legacy.approval?.verifierFamily, Date.parse(v.checkedAt));
	const author = readParty(v.author),
		verifier = readParty(v.approval?.verifier);
	return typeof author === "object" && typeof verifier === "object" && independentReview(author, verifier) === null;
}

function retained(root: string, task: string): ShippedRecord | null {
	const path = join(evfDataDir(root), "shipped", `${parseTask(task).slug}.json`);
	return existsSync(path) ? readJson<ShippedRecord>(path) : null;
}
/**
 * Retained review names the exact tested head, or an earlier head whose recorded carry still proves itself
 * (carryProof); merged owning-path bytes must match the tested head.
 */
export function reviewedMilestone(root: string, record: ShippedRecord): boolean {
	const task = parseTask(record.task),
		cfg = loadConfig(root),
		v = record.verification;
	if (task.kind !== "wp" || record.package_id !== task.wp || record.part !== task.part) return false;
	if (
		!v ||
		v.head !== record.verified_head ||
		(v.approval.head !== v.head &&
			(v.carry?.approvedHead !== v.approval.head ||
				v.carry.head !== v.head ||
				typeof carryProof(root, v.approval.head, v.head, baseRef(root, cfg)) === "string")) ||
		v.approval.verdict !== "approved" ||
		!independentRecord(v) ||
		!v.checks.length ||
		v.checks.some((c) => c.bucket !== "pass")
	)
		return false;
	if (!gitOk(root, "merge-base", "--is-ancestor", record.merge_commit, baseRef(root, cfg))) return false;
	const paths = recordedPathsFor(findPackage(loadDag(root), task.wp), task.part);
	const tested = git(root, "diff", "--binary", record.base_sha, record.verified_head, "--", ...paths);
	return (
		!!tested && tested === git(root, "diff", "--binary", `${record.merge_commit}^`, record.merge_commit, "--", ...paths)
	);
}
export function producerReady(root: string, wp: string): boolean {
	const path = join(root, "docs/build-progress.json");
	const p = existsSync(path) ? readJson<Progress>(path).packages[wp] : undefined;
	if (p?.status === "done") return true;
	const pkg = findPackage(loadDag(root), wp);
	const anchor = partsOf(pkg).includes("api") ? "api" : null;
	const task = anchor ? `${wp}/${anchor}` : wp,
		record = retained(root, task);
	if (record?.acknowledged && reviewedMilestone(root, record)) return true;
	const milestone = p?.milestones?.[task];
	if (!record || !milestone?.acknowledged || milestone.task !== task) return false;
	const paths = pathsForPart(pkg, anchor);
	// A maintenance-only merge does not replace the canonical, already reviewed producer.
	if (git(root, "diff", "--binary", record.base_sha, record.verified_head, "--", ...paths)) return false;
	return (
		gitOk(root, "merge-base", "--is-ancestor", milestone.merge_commit, baseRef(root, loadConfig(root))) &&
		!!git(root, "diff", "--binary", `${milestone.merge_commit}^`, milestone.merge_commit, "--", ...paths)
	);
}
/**
 * Ship's one path to progress (drive ship stage and standalone `evf ship`): record the milestone and acknowledge it
 * when reviewedMilestone passes, the end state of `evf shipped --clear`. A failing record stays unacknowledged and
 * does not throw (the merge is done). Package closures wait for the coordinator. OPS and FB records write nothing.
 */
export function acknowledgeShipped(
	root: string,
	record: ShippedRecord,
): "none" | "acknowledged" | "closures" | "unreviewed" {
	if (record.package_id === null) return "none";
	const paths = recordedPathsFor(findPackage(loadDag(root), record.package_id), record.part);
	if (!git(root, "diff", "--binary", record.base_sha, record.verified_head, "--", ...paths)) return "none";
	if (!reviewedMilestone(root, record)) return "unreviewed";
	const closures = !!record.verification.approval.packageClosures?.length;
	recordProgress(root, record, !closures);
	return closures ? "closures" : "acknowledged";
}
/** Only evf writes canonical progress. Lock and atomic rename protect concurrent ships/acks. */
export function recordProgress(root: string, record: ShippedRecord, acknowledged: boolean): boolean {
	const wp = record.package_id;
	if (wp === null) return false; // Feedback and upkeep do not complete build packages.
	const paths = recordedPathsFor(findPackage(loadDag(root), wp), record.part);
	if (!git(root, "diff", "--binary", record.base_sha, record.verified_head, "--", ...paths)) return false;
	if (!reviewedMilestone(root, record)) fail("Progress requires an independently reviewed, integrated shipped record.");
	updateProgress(root, (progress) => {
		// A new package may not yet have a canonical progress entry.
		const p = (progress.packages[wp] ??= {
			status: "not_started",
			revision: 0,
			updated_at: null,
			evidence: [],
			notes: "",
		});
		const milestone: Milestone = {
			task: record.task,
			merge_commit: record.merge_commit,
			acknowledged,
			stage: record.part ?? "producer",
			...noPortions(),
		};
		if (p.milestones?.[record.task]?.acknowledged) milestone.acknowledged = true;
		if (JSON.stringify(p.milestones?.[record.task]) === JSON.stringify(milestone)) return;
		p.milestones = { ...p.milestones, [record.task]: milestone };
		if (!p.evidence.some((e) => e.commit === record.merge_commit && e.test === record.evidence.test))
			p.evidence.push(record.evidence);
		if (p.status !== "done") p.status = "in_progress";
		p.notes = "Reviewed task milestones retained; full package closure remains at integration.";
		p.revision++;
		p.updated_at = new Date().toISOString();
		progress.revision++;
		progress.updated_at = p.updated_at;
		// An integration verifier may name packages it fully exercised. Acknowledgement rechecks cases and prerequisites.
		if (acknowledged)
			for (const targetId of record.verification.approval.packageClosures ?? []) {
				if (!["WP-056", "WP-057"].includes(record.task)) fail("Package closure belongs to full-target integration.");
				const pkg = findPackage(loadDag(root), targetId),
					target = progress.packages[targetId];
				if ([...pkg.depends_on, ...(pkg.ui_depends_on ?? [])].some((id) => progress.packages[id]?.status !== "done"))
					fail("Closure requires done direct prerequisites.");
				if (
					!target ||
					partsOf(pkg).some((part) => {
						const id = part ? `${targetId}/${part}` : targetId,
							merged = retained(root, id);
						return !merged?.acknowledged || !reviewedMilestone(root, merged);
					})
				)
					fail(`Closure requires every reviewed merged part of ${targetId}.`);
				for (const args of [
					[join(root, "docs/acceptance/check.py"), "--root", root, "--package", targetId],
					[join(root, "docs/package-context.py"), targetId, "--root", root, "--check-case-actions"],
				]) {
					const result = run("python3", args, { cwd: root });
					if (result.code !== 0) fail(`Closure requires runnable owned cases: ${result.stderr || result.stdout}`);
				}
				if (target.status !== "done") {
					target.status = "done";
					target.evidence.push(record.evidence);
					target.notes = `Full package behavior reviewed at integration by ${record.task}.`;
					target.revision++;
					target.updated_at = p.updated_at;
				}
			}
		return true;
	});
	return true;
}

function updateProgress(root: string, update: (progress: Progress) => boolean | void): void {
	const dir = evfDataDir(root);
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, "progress.lock");
	let fd: number;
	try {
		fd = openSync(lock, "wx");
	} catch {
		fail(
			"Progress writer is busy. Retry after the other evf operation completes; reconcile a stale lock before retrying.",
		);
	}
	const path = join(root, "docs/build-progress.json"),
		temp = join(root, `docs/.build-progress-${process.pid}.tmp`);
	try {
		const progress = readJson<Progress>(path);
		if (!update(progress)) return;
		writeFileSync(temp, JSON.stringify(progress, null, 2) + "\n");
		renameSync(temp, path);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
		closeSync(fd);
		unlinkSync(lock);
	}
}

export type FastTrackEvidence = {
	commit: string;
	checks: Array<{ command: string; result: "passed"; evidence: string }>;
	author: { actor: string; model_family: string };
	verifier: { actor: string; model_family: string; verdict: "approved"; commit: string; evidence: string };
	owner_go_live: { actor: string; commit: string; evidence: string };
};

/** Documentary evidence for the single owner-approved unsigned exception; never normal proof authority. */
export function recordFastTrack(root: string, wp: string, input: unknown): void {
	const pkg = findPackage(loadDag(root), wp);
	if (wp !== "WP-097" || !pkg.fast_track || pkg.fast_track.signed_evf_proof_required !== false)
		fail("Fast-track completion is limited to the declared WP-097 exception.");
	const object = (value: unknown): Record<string, unknown> => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			fail(
				"Fast-track evidence must contain the reviewed commit, tests, independent verifier approval and owner go-live approval.",
			);
		return value as Record<string, unknown>;
	};
	const text = (value: unknown): string => {
		if (typeof value !== "string" || !value.trim()) fail("Fast-track evidence fields must be nonempty strings.");
		return value;
	};
	const data = object(input),
		commit = text(data.commit);
	if (
		!/^[a-f0-9]{40}$/.test(commit) ||
		!gitOk(root, "cat-file", "-e", `${commit}^{commit}`) ||
		git(root, "rev-parse", `${commit}^{commit}`) !== commit ||
		!gitOk(root, "merge-base", "--is-ancestor", commit, baseRef(root, loadConfig(root)))
	)
		fail("Fast-track reviewed commit must be a full commit SHA already on main.");
	if (!Array.isArray(data.checks) || !data.checks.length)
		fail("Fast-track completion requires passing normal test evidence.");
	const checks = data.checks.map((value) => {
		const check = object(value);
		if (check.result !== "passed") fail("Every fast-track test must pass at the reviewed commit.");
		return { command: text(check.command), result: "passed" as const, evidence: text(check.evidence) };
	});
	const author = object(data.author),
		verifier = object(data.verifier),
		owner = object(data.owner_go_live);
	if (
		verifier.verdict !== "approved" ||
		verifier.commit !== commit ||
		owner.commit !== commit ||
		owner.actor !== pkg.fast_track.owner
	)
		fail("Independent verifier and declared owner go-live approvals must name the reviewed commit.");
	const evidence: FastTrackEvidence = {
		commit,
		checks,
		author: { actor: text(author.actor), model_family: text(author.model_family) },
		verifier: {
			actor: text(verifier.actor),
			model_family: text(verifier.model_family),
			verdict: "approved",
			commit,
			evidence: text(verifier.evidence),
		},
		owner_go_live: { actor: text(owner.actor), commit, evidence: text(owner.evidence) },
	};
	if (
		evidence.author.actor === evidence.verifier.actor ||
		evidence.author.model_family === evidence.verifier.model_family
	)
		fail("Fast-track review requires distinct author/verifier actors and model families.");
	for (const args of [
		[join(root, "docs/acceptance/check.py"), "--root", root, "--package", wp],
		[join(root, "docs/package-context.py"), wp, "--root", root, "--check-case-actions"],
	]) {
		const result = run("python3", args, { cwd: root });
		if (result.code !== 0)
			fail(`Fast-track completion requires runnable owned cases: ${result.stderr || result.stdout}`);
	}
	updateProgress(root, (progress) => {
		const p = progress.packages[wp];
		if (!p) fail("Reconcile the declared fast-track package before recording completion.");
		if (p.fast_track) {
			if (JSON.stringify(p.fast_track) !== JSON.stringify(evidence))
				fail("Fast-track completion already records different evidence; reconcile with the owner.");
			return;
		}
		if (p.status === "done") fail("Fast-track package is already done without this receipt; reconcile with the owner.");
		p.fast_track = evidence;
		p.status = "done";
		p.notes = "Owner-approved fast-track completion with normal tests and independent review; no signed evf proof.";
		p.evidence.push({
			path: evidence.verifier.evidence,
			commit,
			test: checks.map((c) => c.command).join("; "),
			result: "passed",
			note: `Owner go-live approval: ${evidence.owner_go_live.evidence}`,
		});
		p.revision++;
		p.updated_at = new Date().toISOString();
		progress.revision++;
		progress.updated_at = p.updated_at;
		return true;
	});
}

/** Reconcile plan membership through the sole progress writer; preserve all prior evidence. */
export function reconcileProgress(root: string): void {
	// The home checkout owns the ledger; a task worktree that commits it blocks the home fast-forward.
	if (resolve(root, git(root, "rev-parse", "--git-dir")) !== resolve(root, git(root, "rev-parse", "--git-common-dir")))
		fail("Reconcile progress in the home checkout, not a task worktree. Transfer the result through OPS-7.");
	const dag = loadDag(root),
		retired =
			readJson<{ retired_packages?: { id: string; scope_moved_to: string }[] }>(join(root, "docs/plan/dag.json"))
				.retired_packages ?? [];
	const active = new Set(dag.packages.map((p) => p.id)),
		known = new Set([...active, ...retired.map((p) => p.id)]);
	const dir = evfDataDir(root);
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, "progress.lock");
	let fd: number;
	try {
		fd = openSync(lock, "wx");
	} catch {
		fail("Progress writer is busy. Retry after the other evf operation completes.");
	}
	const path = join(root, "docs/build-progress.json"),
		temp = join(root, `docs/.build-progress-${process.pid}.tmp`);
	try {
		const progress = readJson<Progress>(path);
		for (const id of Object.keys(progress.packages))
			if (!known.has(id)) fail(`Unknown canonical progress package ${id}.`);
		let changed = false;
		const now = new Date().toISOString();
		for (const pkg of dag.packages) {
			const existing = progress.packages[pkg.id];
			if (existing?.status === "retired") fail(`Retired ID ${pkg.id} cannot be reused.`);
			if (!existing) {
				progress.packages[pkg.id] = { status: "not_started", revision: 0, updated_at: null, evidence: [], notes: "" };
				changed = true;
			}
		}
		// Upgrade milestones written before D20 to the shape the explorer reads; keep any recorded portions.
		for (const p of Object.values(progress.packages))
			for (const m of Object.values(p?.milestones ?? {}))
				for (const field of PORTIONS) {
					if (!Array.isArray(m[field])) {
						m[field] = [];
						changed = true;
					}
				}
		for (const pkg of retired) {
			if (active.has(pkg.id) || !active.has(pkg.scope_moved_to)) fail(`Invalid retirement ${pkg.id}.`);
			const p = (progress.packages[pkg.id] ??= {
				status: "not_started",
				revision: 0,
				updated_at: null,
				evidence: [],
				notes: "",
			});
			if (p.status !== "retired" || p.retired_into !== pkg.scope_moved_to) {
				p.status = "retired";
				p.retired_into = pkg.scope_moved_to;
				p.revision++;
				p.updated_at = now;
				p.notes = `Scope moved to ${pkg.scope_moved_to}; ID must not be reused.`;
				changed = true;
			}
		}
		if (!changed) return;
		progress.revision++;
		progress.updated_at = now;
		writeFileSync(temp, JSON.stringify(progress, null, 2) + "\n");
		renameSync(temp, path);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
		closeSync(fd);
		unlinkSync(lock);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv[2] !== "--reconcile" || process.argv.length > 4)
		fail("Use Node 24+ tools/evf/progress.ts --reconcile [repository-root].");
	reconcileProgress(process.argv[3] ?? process.cwd());
	console.log(
		"Canonical progress reconciled with active and retired plan packages. Commit through reviewed OPS maintenance.",
	);
}
