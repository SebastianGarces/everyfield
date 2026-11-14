// The nightly full run behind selection (T-41, T-216). `node scripts/nightly.ts coverage-map <file>` is what the GitHub
// nightly (.github/workflows/nightly.yml) runs on main: every selectable test file under coverage, writing the map
// that `bin/dev check` downloads and selects through, and only when every test passed. `bin/dev nightly` is a manual
// local run of the tests/ui browser set on a preview of origin/main, one engine at a time; no scheduler starts it. A
// loaded machine or a full preview pool records `nightly_skipped` and starts nothing. Results go to nightly.jsonl
// outside the repository; a failure opens or comments once on one GitHub issue.
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CoverageMap, suiteOf } from "../tools/ci/select.ts";
import { ciHome, type Gh, REPO } from "./check.ts";

export type SuiteRun = { passed: number; failed: number };
export type Engine = "chromium" | "webkit";
export const ENGINES: readonly Engine[] = ["chromium", "webkit"];

export type NightlyDeps = {
	home: string;
	now: () => number;
	/** The 1-minute load and the CPU count. */
	load: () => { load: number; cores: number };
	/** Null when a preview slot is free now, else why not. Never waits. */
	slot: (project: string) => Promise<string | null>;
	/** A clean worktree of origin/main. `remove` deletes it. */
	checkout: () => { head: string; worktree: string; remove(): void };
	/** Starts the seeded preview. `close` stops it and drops its seeds. */
	preview: (worktree: string) => Promise<{ url: string; close(): void }>;
	/** Runs tests/ui with one engine against `url`. */
	ui: (worktree: string, url: string, engine: Engine) => SuiteRun;
	gh: Gh;
	log: (line: string) => void;
};

type Entry =
	| { type: "nightly_skipped"; at: string; head: string | null; suite: string; reason: string }
	| ({ type: "nightly_result"; at: string; head: string; suite: string; durationMs: number } & SuiteRun);

export const nightlyLog = (home: string) => join(home, "nightly.jsonl");

const MARKER = "<!-- everyfield-nightly -->";

/**
 * Reports a failed suite at most once per head and suite: one open issue keyed by MARKER, opened on the first failure
 * and commented on for each later one. A key already in the ledger, or already in the issue, adds nothing.
 */
export function reportFailure(
	home: string,
	gh: Gh,
	entry: Extract<Entry, { type: "nightly_result" }>,
): "opened" | "commented" | "known" {
	const key = `<!-- nightly:${entry.head}:${entry.suite} -->`;
	const ledgerFile = join(home, "nightly-reported.json");
	const ledger: string[] = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")) : [];
	if (ledger.includes(key)) return "known";
	const text = `${key}\nNightly \`${entry.suite}\` failed on main at ${entry.head}: ${entry.failed} failed, ${entry.passed} passed in ${Math.round(entry.durationMs / 1000)} s. Rerun with \`bin/dev nightly\`; the full log is in ${nightlyLog(home)}.`;
	const listed = gh([
		"issue",
		"list",
		"--repo",
		REPO,
		"--state",
		"open",
		"--search",
		`"everyfield-nightly" in:body`,
		"--json",
		"number,body,comments",
		"--limit",
		"100",
	]);
	if (listed.status !== 0) throw new Error("gh issue list failed; the nightly failure is not reported yet.");
	const issue = (JSON.parse(listed.stdout) as { number: number; body: string; comments?: { body: string }[] }[]).find(
		(i) => i.body.includes(MARKER),
	);
	let outcome: "opened" | "commented" | "known";
	if (issue && [issue.body, ...(issue.comments ?? []).map((c) => c.body)].some((b) => b.includes(key)))
		outcome = "known";
	else if (issue) {
		if (gh(["issue", "comment", String(issue.number), "--repo", REPO, "--body", text]).status !== 0)
			throw new Error("gh issue comment failed.");
		outcome = "commented";
	} else {
		const body = `${MARKER}\n${text}\n\nEach later failed nightly suite and head adds one comment here. Close this when main is green.`;
		if (
			gh(["issue", "create", "--repo", REPO, "--title", "Nightly checks failed on main", "--body", body]).status !== 0
		)
			throw new Error("gh issue create failed.");
		outcome = "opened";
	}
	writeFileSync(ledgerFile, JSON.stringify([...ledger, key]) + "\n");
	return outcome;
}

/** One local tests/ui run. Every exit path closes the preview it started and removes its worktree. */
export async function nightly(deps: NightlyDeps): Promise<Entry[]> {
	mkdirSync(deps.home, { recursive: true });
	const entries: Entry[] = [];
	const at = () => new Date(deps.now()).toISOString();
	const record = (entry: Entry) => {
		entries.push(entry);
		appendFileSync(nightlyLog(deps.home), JSON.stringify(entry) + "\n");
		deps.log(JSON.stringify(entry));
		if (entry.type === "nightly_result" && entry.failed > 0)
			deps.log(`reported ${entry.suite}: ${reportFailure(deps.home, deps.gh, entry)}`);
	};
	const skip = (head: string | null, suite: string, reason: string) =>
		record({ type: "nightly_skipped", at: at(), head, suite, reason });
	const result = (head: string, suite: string, startedAt: number, run: SuiteRun) => {
		const end = deps.now();
		record({
			type: "nightly_result",
			at: new Date(end).toISOString(),
			head,
			suite,
			...run,
			durationMs: end - startedAt,
		});
	};

	// Why nothing may start now: a loaded machine, else no free preview slot. The slot is probed only when not loaded.
	const { load, cores } = deps.load();
	const busy =
		load > 2 * cores ? `the 1-minute load ${load.toFixed(1)} is above 2 × ${cores} cores` : await deps.slot("nightly");
	if (busy !== null) {
		skip(null, "all", busy);
		return entries;
	}
	const { head, worktree, remove } = deps.checkout();
	let close: (() => void) | undefined;
	try {
		const preview = await deps.preview(worktree);
		close = preview.close;
		for (const engine of ENGINES) {
			const t0 = deps.now();
			result(head, `tests/ui ${engine}`, t0, deps.ui(worktree, preview.url, engine));
		}
		return entries;
	} finally {
		try {
			close?.();
		} finally {
			remove();
		}
	}
}

// ---- The real machine: everything below talks to git, node, portless and gh. ----

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
	const r = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	return { status: r.status ?? 1, stdout: r.stdout ?? "", output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const must = <R extends { status: number; output: string }>(r: R, what: string): R => {
	if (r.status !== 0) throw new Error(`${what} failed:\n${r.output.slice(-2000)}`);
	return r;
};
/** The counts of node:test's own summary: the last one, since a test may print a nested run's summary first. */
export const counts = (output: string): SuiteRun => {
	const last = (name: string) => [...output.matchAll(new RegExp(`^(?:ℹ|#) ${name} (\\d+)\\s*$`, "gm"))].at(-1)?.[1];
	const tests = last("tests");
	// No summary at all means the run crashed before reporting: count it as a failure.
	return { passed: Number(last("pass") ?? 0), failed: Number(last("fail") ?? 0) + (tests === undefined ? 1 : 0) };
};

/** Preloaded into every coverage process: it records the paths each one reads or lists through node:fs. */
const TRACE_READS = pathToFileURL(fileURLToPath(new URL("./trace-reads.mjs", import.meta.url))).href;

/**
 * The repository files each selectable test file reached: the modules it ran, through NODE_V8_COVERAGE, and the files
 * it read as text or directories it listed, through the trace-reads preload. Child processes inherit both. A listed
 * directory is kept with a trailing "/", so a later file under it is reached as well.
 */
export function coverageMap(worktree: string, node = process.execPath): SuiteRun & { tests: Record<string, string[]> } {
	// Coverage URLs hold real paths (macOS tmp is /private/var), so compare against the real worktree path.
	worktree = realpathSync(worktree);
	const tracked = new Set(run("git", ["-C", worktree, "ls-files", "-z"]).stdout.split("\0").filter(Boolean));
	const trackedDirs = new Set(
		[...tracked].flatMap((f) =>
			f
				.split("/")
				.slice(0, -1)
				.map((_, i, parts) => parts.slice(0, i + 1).join("/") + "/"),
		),
	);
	const inRepo = (absolute: string) => {
		const path = relative(worktree, absolute).split(sep).join("/");
		return path.startsWith("../") ? null : path;
	};
	const tests: Record<string, string[]> = {};
	const total = { passed: 0, failed: 0 };
	for (const file of [...tracked].filter((f) => suiteOf(f)).sort()) {
		const dir = mkdtempSync(join(tmpdir(), "evf-coverage-"));
		const reads = mkdtempSync(join(tmpdir(), "evf-reads-"));
		try {
			// Without NODE_TEST_CONTEXT: a runner that inherits it reports to its parent and prints no counts.
			const { NODE_TEST_CONTEXT: _, ...env } = process.env;
			const options = `${env.NODE_OPTIONS ?? ""} --import=${TRACE_READS}`.trim();
			const r = run(node, ["--test", file], {
				cwd: worktree,
				env: { ...env, NODE_V8_COVERAGE: dir, TRACE_READS_DIR: reads, NODE_OPTIONS: options },
			});
			const c = counts(r.output);
			total.passed += c.passed;
			total.failed += c.failed;
			const reached = new Set<string>();
			for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
				const { result } = JSON.parse(readFileSync(join(dir, name), "utf8")) as { result: { url: string }[] };
				for (const { url } of result) {
					if (!url.startsWith("file://")) continue;
					const path = inRepo(fileURLToPath(url));
					if (path && tracked.has(path) && path !== file) reached.add(path);
				}
			}
			for (const name of readdirSync(reads))
				for (const line of readFileSync(join(reads, name), "utf8").split("\n").filter(Boolean)) {
					// Reads hold the path as the test named it; a symlinked tmp dir resolves to the same real worktree.
					const isDir = line.endsWith("/");
					let real = line;
					try {
						real = realpathSync(line) + (isDir ? "/" : "");
					} catch {
						// A path that does not exist names no repository file.
					}
					const path = inRepo(real.replace(/\/$/, ""));
					if (path === null || path === "") continue;
					if (isDir ? trackedDirs.has(path + "/") : tracked.has(path) && path !== file)
						reached.add(isDir ? path + "/" : path);
				}
			tests[file] = [...reached].sort();
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(reads, { recursive: true, force: true });
		}
	}
	return { ...total, tests };
}

const SLOTS = join(root, ".agents/skills/verify-preview/scripts/preview-slots.mjs");
const PREVIEW = join(root, ".agents/skills/verify-preview/scripts/preview.mjs");
const TSX = "./packages/db/node_modules/tsx/dist/esm/index.mjs";

/** The seeds tests/ui needs, with the fixture name each writes. */
const seedsOf = (worktree: string) =>
	globSync("tests/ui/**/*seed.mts", { cwd: worktree })
		.filter((f) => !f.endsWith("seed-env.mts"))
		.sort()
		.map((file) => ({
			file,
			name: basename(file) === "seed.mts" ? basename(dirname(file)) : basename(file).replace(/-seed\.mts$/, ""),
		}));

function realDeps(): NightlyDeps {
	const common = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim();
	const main = dirname(common);
	const home = ciHome();
	const fixtures = join(home, "nightly-fixtures");
	const fixtureEnv = (worktree: string) =>
		Object.fromEntries(
			seedsOf(worktree).map(({ name }) => [`${name.toUpperCase()}_UI_FIXTURE`, join(fixtures, `${name}.json`)]),
		);
	const startPreview = (worktree: string) => {
		const r = must(
			run(process.execPath, [PREVIEW, worktree], { env: { ...process.env, EVF_PREVIEW_WAIT_MS: "1" } }),
			"preview.mjs",
		);
		return JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { id: string; url: string };
	};
	const seed = (worktree: string, action: "up" | "down", url?: string) => {
		for (const { file } of seedsOf(worktree))
			must(
				run(
					process.execPath,
					[
						`--env-file=${join(main, "apps/web/.env.local")}`,
						"--conditions=react-server",
						"--import",
						TSX,
						file,
						action,
						...(url ? [url] : []),
					],
					{
						cwd: worktree,
						env: { ...process.env, ...fixtureEnv(worktree) },
					},
				),
				`seed ${file} ${action}`,
			);
	};
	return {
		home,
		now: Date.now,
		load: () => ({ load: loadavg()[0]!, cores: availableParallelism() }),
		slot: async (project) => {
			const { ensurePreviewSlot } = (await import(SLOTS)) as {
				ensurePreviewSlot(o: object): Promise<unknown>;
			};
			try {
				await ensurePreviewSlot({ project, waitMs: 1, pollMs: 1, log: () => {} });
				return null;
			} catch (error) {
				return (error as Error).message;
			}
		},
		checkout: () => {
			must(run("git", ["-C", main, "fetch", "--quiet", "origin", "main"]), "git fetch");
			const head = must(run("git", ["-C", main, "rev-parse", "origin/main^{commit}"]), "git rev-parse").stdout.trim();
			const worktree = join(main, ".worktrees", `nightly-${head.slice(0, 12)}`);
			const remove = () => {
				rmSync(join(common, "evf-evidence", `verify-preview-${basename(worktree)}.json`), { force: true });
				run("git", ["-C", main, "worktree", "remove", "--force", worktree]);
			};
			if (!existsSync(worktree))
				must(run("git", ["-C", main, "worktree", "add", "--detach", worktree, head]), "git worktree add");
			try {
				must(run("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: worktree }), "pnpm install");
			} catch (error) {
				// nightly() removes the worktree only once checkout returns; a failed install must not leave it behind.
				remove();
				throw error;
			}
			return { head, worktree, remove };
		},
		preview: async (worktree) => {
			let preview = startPreview(worktree);
			const stop = () => run("portless", ["preview", "down", preview.id]);
			try {
				// The seeds write the worktree's env file for this URL; a restart makes the preview read it.
				mkdirSync(fixtures, { recursive: true });
				seed(worktree, "up", preview.url);
				stop();
				preview = startPreview(worktree);
			} catch (error) {
				stop();
				seed(worktree, "down");
				throw error;
			}
			return {
				url: preview.url,
				close: () => {
					stop();
					seed(worktree, "down");
				},
			};
		},
		ui: (worktree, url, engine) => {
			const files = globSync("tests/ui/**/*.test.mjs", { cwd: worktree }).sort();
			// bin/dev browser run gives the run its own process group and closes every browser it started.
			const r = run(
				join(worktree, "bin/dev"),
				["browser", "run", "--timeout", "7200", "--", process.execPath, "--test", "--test-concurrency=1", ...files],
				{
					cwd: worktree,
					env: { ...process.env, ...fixtureEnv(worktree), UI_BASE_URL: url, UI_ENGINE: engine },
				},
			);
			return counts(r.output);
		},
		gh: (args) => run("gh", args),
		log: (line) => console.log(line),
	};
}

/**
 * `node scripts/nightly.ts coverage-map <file>`: the GitHub nightly's coverage run over this checkout. It writes the map
 * for HEAD to `file` only when every test passed: a test that fails early reaches less than it would, so a map from a
 * failing run would select too little. Exits 1 then, and the workflow uploads no map.
 */
export function coverageMapCommand(args: string[], checkout = root, now = () => new Date()): number {
	if (args.length !== 1) {
		console.error("usage: node scripts/nightly.ts coverage-map <file>");
		return 2;
	}
	const head = must(run("git", ["-C", checkout, "rev-parse", "HEAD"]), "git rev-parse").stdout.trim();
	const { tests, passed, failed } = coverageMap(checkout);
	console.log(`coverage: ${passed} passed, ${failed} failed over ${Object.keys(tests).length} test files at ${head}`);
	if (failed > 0) {
		console.error("coverage had failures; no coverage map is written");
		return 1;
	}
	const map: CoverageMap = { head, createdAt: now().toISOString(), tests };
	const file = args[0]!;
	writeFileSync(file + ".tmp", JSON.stringify(map, null, 2) + "\n");
	renameSync(file + ".tmp", file);
	console.log(`coverage map: ${file}`);
	return 0;
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2);
	process.exitCode = coverageMapCommand(command === "coverage-map" ? rest : []);
}

/** The `bin/dev nightly` command line. */
export async function nightlyCommand(args: string[]): Promise<number> {
	if (args[0] === "schedule") {
		const { scheduleCommand } = await import("./nightly-schedule.ts");
		try {
			const status = scheduleCommand(args.slice(1), root);
			if (status !== null) return status;
		} catch (error) {
			console.error(`dev nightly schedule: ${(error as Error).message}`);
			return 1;
		}
	}
	if (args.length) {
		console.error("usage: dev nightly [schedule install|status|uninstall]");
		return 2;
	}
	const entries = await nightly(realDeps());
	console.log(`nightly record: ${nightlyLog(ciHome())}`);
	return entries.some((e) => e.type === "nightly_result" && e.failed > 0) ? 1 : 0;
}
