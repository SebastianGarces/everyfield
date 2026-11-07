import { baseRef, loadConfig, MAINTENANCE_TASKS_DIR, run } from "./lib.ts";

/**
 * OPS-172: what counts as evf work. These are evf's code and the files outside it that evf runs or that its tests read
 * as a contract. Other docs and app files stay out, even though fixtures copy some of them: the push to main runs the
 * whole suite and fail-forward reports a failure. A path that ends in "/" is a folder.
 */
const EVF_PATHS = [
	"tools/evf/",
	"tools/evf-tui/",
	"tools/qa/",
	"tools/ci/",
	"tools/wiki/pr-images.ts",
	"tools/wiki/drafts.ts",
	"scripts/browser.ts",
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
	"evf.config.json",
];

/** Every OPS task adds its own entry file, so an entry file alone is no evf work. */
const isEvfPath = (path: string) =>
	!path.startsWith(MAINTENANCE_TASKS_DIR) && EVF_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));

/**
 * Why `evf test` can skip this checkout, or undefined when the suite must run. The checkout's changes are its commits
 * since the merge base with main, plus uncommitted and untracked files. A checkout with no commits of its own runs, so
 * main runs whatever stray files it holds. So does a checkout whose merge base git cannot find, such as a shallow clone.
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
	const mergeBase = base.stdout.trim();
	if (mergeBase === run("git", ["rev-parse", "HEAD"], { cwd: checkout }).stdout.trim()) return undefined;
	const changed = lines("diff", "--name-only", "--no-renames", "-z", mergeBase),
		untracked = lines("ls-files", "--others", "--exclude-standard", "-z");
	if (!changed || !untracked) return undefined;
	const files = [...changed, ...untracked];
	if (!files.length || files.some(isEvfPath)) return undefined;
	return `${files.length} changed file(s) since ${mergeBase.slice(0, 12)} and none is evf work`;
}
