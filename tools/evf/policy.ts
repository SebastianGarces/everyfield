import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import {
	baseRef,
	git,
	fail,
	findPackage,
	loadDag,
	loadConfig,
	readJson,
	prerequisitesForPart,
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

export function requireTaskScope(root: string, task: TaskRef, wp?: string): void {
	if (task.kind === "ops") {
		const scope = loadConfig(root).maintenanceTasks?.[task.id];
		if (!scope?.title || !scope.owningPaths.length || !scope.checks?.length)
			fail("Maintenance requires a reviewed title, owning paths and local tooling checks in maintenanceTasks.");
		for (const path of scope.owningPaths) {
			if (!path.endsWith("/") && existsSync(join(root, path)) && statSync(join(root, path)).isDirectory())
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
		];
		const directories = [".agents/", ".claude/", "docs/", "tools/evf/", ".github/"];
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
	} else {
		if (!wp) fail("Missing reviewed task scope.");
		requireImplementation(root, wp, task.part);
	}
	requireTaskRisk(root, task);
}

/** Sensitive work still needs an owner decision in Intent. Ordinary task scope is the default. */
export function requireTaskRisk(root: string, task: TaskRef): void {
	const cfg = loadConfig(root),
		risk = cfg.taskRisks?.[task.id] ?? cfg.maintenanceTasks?.[task.id]?.risk ?? "ordinary";
	if (risk !== "ordinary")
		fail(`${task.id} is ${risk}; get the owner's scoped approval in Intent before implementation or merge.`);
}

/** Check the task's scope, including candidate tooling changes. */
export function requireMaintenancePaths(root: string, wt: string, task: TaskRef): void {
	const cfg = loadConfig(root);
	if (task.kind === "ops") {
		const owns = (path: string) =>
			cfg.maintenanceTasks![task.id].owningPaths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
		const changed = git(wt, "diff", "--name-only", "--no-renames", baseRef(root, cfg), "HEAD")
			.split("\n")
			.filter(Boolean);
		if (changed.some((p) => !owns(p))) fail("Maintenance candidate changes paths outside its reviewed owning paths.");
		if (changed.includes(APPROVED_PROTOTYPE)) fail(`${APPROVED_PROTOTYPE} keeps its approved bytes.`);
	}
}
