import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
	baseRef,
	committedConfig,
	git,
	fail,
	findPackage,
	loadDag,
	loadConfig,
	readJson,
	prerequisitesForPart,
	type Config,
	type DocumentTemplatePolicy,
	type MaintenanceScope,
	type Part,
	type TaskRef,
} from "./lib.ts";
import { producerReady } from "./progress.ts";

/** The approved prototype keeps its bytes: design/handoff/tokens.css, and through it the app, derive from it. */
export const APPROVED_PROTOTYPE = "design/everyfield-ui.html";

/** Local reviewed source policy is an operator boundary, never inferred from a role flag or severity. */
export function requireImplementation(root: string, wp: string, part: Part = null): void {
	const gates = readJson<{ gates: Array<{ id: string; status: string; scope?: string; work_packages: string[] }> }>(
		join(root, "docs/plan/release-gates.json"),
	).gates;
	for (const id of ["G-AUTH", "G-WORKFLOW"]) {
		const g = gates.find((g) => g.id === id),
			expected = id === "G-AUTH" ? "authorized" : "reconciled-independent-review";
		if (!g || (g.scope !== "global" && g.work_packages?.length !== 0) || g.status !== expected)
			fail(
				`${id} is not closed for application implementation. Global action gates apply to every application package; read-only work does not open them.`,
			);
	}
	const p = findPackage(loadDag(root), wp);
	const blocked = prerequisitesForPart(p, part).filter((id) => !producerReady(root, id));
	if (blocked.length)
		fail(
			`Prerequisites need reviewed producer/interface milestones: ${blocked.join(", ")}. --allow-unready cannot grant implementation authority.`,
		);
}
/** Check actual paid commitments separately from local implementation and synthetic proof. */
export function requireSpend(root: string): void {
	const gates = readJson<{ gates: Array<{ id: string; status: string }> }>(
		join(root, "docs/plan/release-gates.json"),
	).gates;
	if (!["approved", "closed", "passed"].includes(gates.find((g) => g.id === "G-SPEND")?.status ?? ""))
		fail("G-SPEND must approve the concrete paid provider envelope before usage or subscription commitment.");
}

/**
 * An OPS task's registration is its maintenanceTasks entry committed at the checked commit: the task branch
 * for the author, the PR head for the verifier. evf never reads or edits the home checkout's file for it.
 */
export function maintenanceScope(checkout: string, task: TaskRef, rev = "HEAD"): MaintenanceScope {
	const scope = committedConfig(checkout, rev).maintenanceTasks?.[task.id];
	if (!scope?.title || !scope.owningPaths?.length || !scope.checks?.length)
		fail(
			`Commit the reviewed ${task.id} entry (title, owning paths, tooling checks) to maintenanceTasks in evf.config.json on the task branch in ${checkout}. evf reads it from the checked commit, never from the home checkout.`,
		);
	for (const path of scope.owningPaths) {
		if (!path.endsWith("/") && existsSync(join(checkout, path)) && statSync(join(checkout, path)).isDirectory())
			fail(`Maintenance owning path ${path} is a folder; use ${path}/ to include its files.`);
	}
	const ledger = "docs/build-progress.json";
	if (
		scope.owningPaths.join("\n") !== ledger &&
		scope.owningPaths.some((p) => (p.endsWith("/") ? ledger.startsWith(p) : p === ledger))
	)
		fail(`Only a transfer task that owns exactly ${ledger} may commit the progress ledger (OPS-7).`);
	const files = [
		"README.md",
		"AGENTS.md",
		"evf.config.json",
		"skills-lock.json",
		".gitignore",
		"bin/evf",
		"everyfield-feature-review.html",
		"design/handoff/screens.md",
		"scripts/preview.json",
		"scripts/stack.mjs",
	];
	const directories = [".agents/", ".claude/", "docs/", "tools/evf/", "tools/evf-tui/", "tests/workflow/", ".github/"];
	if (scope.route === "design") {
		if (scope.owningPaths.some((path) => !path.startsWith("design/") || path.split("/").includes("..")))
			fail("A design task owns only design/ paths.");
	} else if (
		scope.owningPaths.some(
			(path) =>
				path.split("/").includes("..") || (!files.includes(path) && !directories.some((dir) => path.startsWith(dir))),
		)
	)
		fail(
			"Maintenance owning paths must stay in documentation and workflow tooling; OPS cannot authorize application code.",
		);
	const risk = scope.risk ?? "ordinary";
	if (risk !== "ordinary")
		fail(`${task.id} is ${risk}; get the owner's scoped approval in Intent before implementation or merge.`);
	return scope;
}

/** `checkout` is the commit under check; OPS tasks read their registration there. */
export function requireTaskScope(root: string, checkout: string, task: TaskRef, wp?: string): void {
	if (task.kind === "ops") maintenanceScope(checkout, task);
	else {
		if (!wp) fail("Missing reviewed task scope.");
		requireImplementation(root, wp, task.part);
	}
	requireTaskRisk(root, task);
}

/** Sensitive work still needs an owner decision in Intent. Ordinary task scope is the default. */
export function requireTaskRisk(root: string, task: TaskRef): void {
	const risk = loadConfig(root).taskRisks?.[task.id] ?? "ordinary";
	if (risk !== "ordinary")
		fail(`${task.id} is ${risk}; get the owner's scoped approval in Intent before implementation or merge.`);
}

/** True when evf.config.json differs between `base` and `head` only in the task's own maintenanceTasks entry. */
export function changesOnlyOwnRegistration(repo: string, task: TaskRef, base: string, head: string): boolean {
	const withoutOwnEntry = (rev: string) => {
		const cfg = committedConfig(repo, rev);
		delete cfg.maintenanceTasks?.[task.id];
		return JSON.stringify(cfg);
	};
	return withoutOwnEntry(base) === withoutOwnEntry(head);
}

/**
 * Check the task's changed paths. An OPS branch may change evf.config.json only in its own maintenanceTasks
 * entry, whether or not it owns the file: that is how it registers, and the verifier reviews the entry.
 */
export function requireMaintenancePaths(root: string, wt: string, task: TaskRef): void {
	if (task.kind !== "ops") return;
	const base = baseRef(root, loadConfig(root)),
		scope = maintenanceScope(wt, task);
	// evf.config.json holds every task's registration, so owning it never waives the own-entry rule.
	const owns = (path: string) =>
		path === "evf.config.json"
			? changesOnlyOwnRegistration(wt, task, base, "HEAD")
			: scope.owningPaths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
	const changed = git(wt, "diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean);
	if (changed.some((p) => !owns(p))) fail("Maintenance candidate changes paths outside its reviewed owning paths.");
	if (changed.includes(APPROVED_PROTOTYPE)) fail(`${APPROVED_PROTOTYPE} keeps its approved bytes.`);
}

/**
 * The built-in document-template class (OPS-80). It applies when `mergePolicy.documentTemplates` is absent from
 * evf.config.json; an explicit key replaces it. `evf ship`, `evf approve` and the merge read it only through
 * `templateClass` in merge.ts, from the base branch's config.
 */
export const DEFAULT_DOCUMENT_TEMPLATES: DocumentTemplatePolicy = {
	paths: [
		"docs/reference/document-templates.ts",
		"docs/catalog/document-templates.json",
		"packages/domain/src/documents/",
		"packages/domain/src/branding/theme.ts",
	],
	approvedAtUtc: "2026-10-30T15:51:00Z",
	quote:
		"This looks good - while we develop all the final versions of all the templates, I want to approve them one by one",
	scope:
		"A PR whose exact-head diff touches a document-template path never merges through evf ship; after the verifier passes it, Sebastian approves it in chat and an agent merges it with evf approve.",
};
