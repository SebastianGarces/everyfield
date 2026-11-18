import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { FastCheckError, mergeBase } from "./fast-check.ts";

type Trigger = { paths?: string[]; added?: string };
type Item = { id: string; trigger: Trigger; check: string; source: string };

export const CHECKLIST = "docs/reliability-checklist.json";
export const NO_MATCH = "No checklist items match this diff.";

function parse(text: string): Item[] {
	const items: unknown = JSON.parse(text);
	const valid = (item: Item) =>
		["id", "check", "source"].every((key) => typeof item[key as keyof Item] === "string") &&
		typeof item.trigger === "object" &&
		(Array.isArray(item.trigger.paths) || typeof item.trigger.added === "string");
	if (!Array.isArray(items) || !items.every(valid))
		throw new FastCheckError(`${CHECKLIST} is malformed; run python3 docs/check-all.py.`);
	return items;
}

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

export function matching(items: Item[], files: Map<string, string[]>): Item[] {
	return items.filter(({ trigger }) => {
		const added = trigger.added === undefined ? undefined : new RegExp(trigger.added);
		return [...files].some(
			([path, lines]) =>
				(!trigger.paths || trigger.paths.some((glob) => matchesGlob(path, glob))) &&
				(!added || lines.some((line) => added.test(line))),
		);
	});
}

export function render(items: Item[]): string {
	if (!items.length) return NO_MATCH;
	return items.map((item) => `${item.id}\n  Check: ${item.check}\n  Source: ${item.source}`).join("\n\n");
}

export function checklist(root: string, baseRef?: string): string {
	const items = parse(readFileSync(join(root, CHECKLIST), "utf8"));
	return render(matching(items, addedLines(root, mergeBase(root, baseRef).sha)));
}
