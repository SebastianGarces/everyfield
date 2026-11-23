import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { FastCheckError, mergeBase } from "./fast-check.ts";

type Trigger = { paths?: string[]; added?: string };
type Item = { id: string; trigger: Trigger; check: string; source: string };

function addedLines(root: string, sha: string): Map<string, string[]> {
	const run = spawnSync("git", ["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U0", sha, "HEAD"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 1 << 30,
	});
	if (run.status !== 0) throw new FastCheckError(`git diff ${sha} HEAD failed: ${run.stderr.trim()}`);
	const files = new Map<string, string[]>();
	let lines: string[] = [];
	for (const line of run.stdout.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const path = line.slice(line.indexOf(" b/") + 3);
			lines = [];
			files.set(path, lines);
		} else if (line.startsWith("+") && !line.startsWith("+++ ")) lines.push(line.slice(1));
	}
	return files;
}

function matching(items: Item[], files: Map<string, string[]>): Item[] {
	return items.filter(({ trigger }) => {
		const added = trigger.added === undefined ? undefined : new RegExp(trigger.added);
		return [...files].some(
			([path, lines]) =>
				(!trigger.paths || trigger.paths.some((glob) => matchesGlob(path, glob))) &&
				(!added || lines.some((line) => added.test(line))),
		);
	});
}

function render(items: Item[]): string {
	if (!items.length) return "No checklist items match this diff.";
	return items.map((item) => `${item.id}\n  Check: ${item.check}\n  Source: ${item.source}`).join("\n\n");
}

export function checklist(root: string, baseRef?: string): string {
	const items: Item[] = JSON.parse(readFileSync(join(root, "docs/reliability-checklist.json"), "utf8"));
	return render(matching(items, addedLines(root, mergeBase(root, baseRef).sha)));
}
