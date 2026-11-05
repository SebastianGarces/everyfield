import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseRef, loadConfig, run } from "./lib.ts";

/**
 * OPS-172: what counts as evf work. These are evf's code and the files outside it that evf runs or that its tests read
 * as a contract. Other docs and app files stay out, even though fixtures copy some of them: the push to main runs the
 * whole suite and fail-forward reports a failure. A path that ends in "/" is a folder.
 */
const EVF_PATHS = [
	"tools/evf/",
	"tools/wiki/pr-images.ts",
	"bin/evf",
	"bin/wiki",
	".github/workflows/",
	".claude/agents/",
	".claude/settings.json",
	".agents/roles/",
	".agents/skills/everyfield-pr/",
	".agents/skills/verify-preview/",
	"docs/package-context.py",
	"docs/runbooks/qa-preview.md",
];
const CONFIG = "evf.config.json";

const isEvfPath = (path: string) => EVF_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));

/** Every OPS task adds its own `maintenanceTasks` entry, so that key alone is no evf work. An unreadable file counts. */
function configChanged(checkout: string, mergeBase: string): boolean {
	const settings = (text: string) => {
		const { maintenanceTasks: _, ...rest } = JSON.parse(text) as Record<string, unknown>;
		return JSON.stringify(rest);
	};
	const before = run("git", ["show", `${mergeBase}:${CONFIG}`], { cwd: checkout });
	if (before.code !== 0) return true;
	try {
		return settings(before.stdout) !== settings(readFileSync(join(checkout, CONFIG), "utf8"));
	} catch {
		return true;
	}
}

/**
 * Why `evf test` can skip this checkout, or undefined when the suite must run. The checkout's changes are its commits
 * since the merge base with main, plus uncommitted and untracked files. Main itself has no changes, so it runs. So does
 * a checkout whose merge base git cannot find, such as a shallow clone.
 */
export function evfTestSkip(checkout: string): string | undefined {
	const lines = (...args: string[]) => {
		const r = run("git", args, { cwd: checkout });
		return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : undefined;
	};
	let ref: string;
	try {
		ref = baseRef(checkout, loadConfig(checkout));
	} catch {
		return undefined;
	}
	const base = run("git", ["merge-base", "HEAD", ref], { cwd: checkout });
	if (base.code !== 0) return undefined;
	const mergeBase = base.stdout.trim(),
		changed = lines("diff", "--name-only", "--no-renames", "-z", mergeBase),
		untracked = lines("ls-files", "--others", "--exclude-standard", "-z");
	if (!changed || !untracked) return undefined;
	const files = [...changed, ...untracked];
	if (!files.length || files.some(isEvfPath)) return undefined;
	if (files.includes(CONFIG) && configChanged(checkout, mergeBase)) return undefined;
	return `${files.length} changed file(s) since ${mergeBase.slice(0, 12)} and none is evf work`;
}
