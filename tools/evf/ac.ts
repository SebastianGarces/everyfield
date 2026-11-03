import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { findTask, openWorkDb, record } from "./db.ts";
import {
	evidenceDir,
	fail,
	git,
	isClean,
	loadConfig,
	readJson,
	run,
	worktreePath,
	isUiPath,
	findPackage,
	type Dag,
	type TaskRef,
} from "./lib.ts";
import { acCriteria } from "./spec.ts";

/**
 * The answer key (OPS-112). A Done criterion with `Check: AC:<task>-<n>` is proven only by tests whose node:test name
 * carries that marker. `evf ac run` finds them in the worktree's `tests/ui/**\/*.test.mjs` and
 * `tools/evf/tests/**\/*.test.ts`, runs browser tests on Chromium and WebKit against the worktree's ready portless
 * preview of HEAD, inside `evf browser run`, and writes one proof row per marker at HEAD. evf writes these rows; a seat
 * cannot write `met` or `n/a` for them. Everything runs on this machine: no CI job and no paid API.
 */

const AC_ENGINES = ["chromium", "webkit"] as const;
type Engine = "node" | (typeof AC_ENGINES)[number];
type AcRow = {
	criterion: string;
	marker: string;
	status: "met" | "unmet";
	notes: string;
	evidence: string | null;
};

const MAIN = join(import.meta.dirname, "main.ts");
const REPORTER = pathToFileURL(join(import.meta.dirname, "ac-reporter.mjs")).href;
const VIDEO = pathToFileURL(join(import.meta.dirname, "ac-video.mjs")).href;
/** A browser run of one marker on one engine may take this long before evf browser run stops it. */
const BROWSER_TIMEOUT_SECONDS = 1800;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The marker as a test name pattern: `AC:OPS-1-1` does not match a name that carries `AC:OPS-1-10`. */
const markerPattern = (marker: string) => `${escape(marker)}(?!\\d)`;

/** A UI task: part `ui`, or a whole package whose owning paths include a UI path. */
export function isUiTask(root: string, task: TaskRef): boolean {
	if (task.part === "ui") return true;
	if (task.kind !== "wp" || task.part !== null) return false;
	return findPackage(readJson<Dag>(join(root, "docs/plan/dag.json")), task.wp).owning_paths.some(isUiPath);
}

function testFiles(wt: string, dir: string, suffix: string): string[] {
	const base = join(wt, dir);
	if (!existsSync(base)) return [];
	return (readdirSync(base, { recursive: true }) as string[])
		.filter((f) => f.endsWith(suffix) && !f.split("/").includes("node_modules"))
		.map((f) => join(dir, f))
		.sort();
}

type Preview = { project: string; state: string; head?: string; url: string; createdAt?: number };
const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/** The newest ready portless preview of the worktree. It must serve HEAD, or a passing test proves another commit. */
function readyPreview(wt: string, head: string): string {
	const r = run("portless", ["preview", "status", "--json"], { cwd: wt });
	if (r.code !== 0) fail(`Cannot read the portless preview status: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
	const own = (JSON.parse(r.stdout) as Preview[])
		.filter((p) => p.state === "ready" && real(p.project) === real(wt))
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
	const start = `node .agents/skills/verify-preview/scripts/preview.mjs ${wt}`;
	if (!own) fail(`No ready portless preview of ${wt}; browser tests need one. Start it with ${start}.`);
	if (own.head !== head)
		fail(
			`The preview ${own.url} serves ${own.head?.slice(0, 10) ?? "an unknown head"}, not the worktree HEAD ${head.slice(0, 10)}. Start a preview of HEAD with ${start}.`,
		);
	return own.url;
}

type Result = "passed" | "failed" | "skipped";
type Outcome = { code: number; engine: Engine; results: Array<{ name: string; result: Result }>; output: string };

/** One `node --test` run of the files with the marker pattern; in a browser run it goes through `evf browser run`. */
function nodeTest(wt: string, files: string[], marker: string, engine: Engine, env: NodeJS.ProcessEnv): Outcome {
	const tmp = mkdtempSync(join(tmpdir(), "evf-ac-")),
		out = join(tmp, "results.jsonl");
	// Inside a node:test process this names the parent's protocol; the nested run would then skip its reporters.
	const { NODE_TEST_CONTEXT: _, ...clean } = env;
	try {
		const test = [
			"--test",
			...(engine === "node" ? [] : [`--import=${VIDEO}`]),
			`--test-name-pattern=${markerPattern(marker)}`,
			`--test-reporter=${REPORTER}`,
			`--test-reporter-destination=${out}`,
			"--test-reporter=spec",
			"--test-reporter-destination=stdout",
			...files,
		];
		const browser = [
			"--disable-warning=ExperimentalWarning",
			MAIN,
			"browser",
			"run",
			"--timeout",
			String(BROWSER_TIMEOUT_SECONDS),
			"--",
			process.execPath,
		];
		const r = run(process.execPath, engine === "node" ? test : [...browser, ...test], { cwd: wt, env: clean });
		const lines = existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : [];
		const pattern = new RegExp(markerPattern(marker));
		const results = lines
			.map((l) => JSON.parse(l) as { name: string; result: Result })
			.filter((t) => pattern.test(t.name));
		return { code: r.code, engine, results, output: `${r.stdout}${r.stderr}` };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

const videosIn = (dir: string): string[] =>
	existsSync(dir)
		? (readdirSync(dir, { recursive: true }) as string[])
				.filter((f) => /\.(webm|mp4)$/.test(f))
				.map((f) => join(dir, f))
				.sort()
		: [];

/** The proof row of one marker from its runs: met only when a test carries it and every run of it passed. */
function rowOf(criterion: string, marker: string, head: string, runs: Outcome[], evidence: string[]): AcRow {
	const names = [...new Set(runs.flatMap((r) => r.results.map((t) => t.name)))];
	const exits = runs.filter((r) => r.code !== 0).map((r) => `node --test exited ${r.code} on ${r.engine}`);
	if (!names.length)
		return {
			criterion,
			marker,
			status: "unmet",
			notes: [`no test carries ${marker}`, ...exits].join("; "),
			evidence: null,
		};
	const met = !exits.length && runs.every((r) => r.results.every((t) => t.result === "passed"));
	const tests = names.map((name) => {
		const seen = runs.flatMap((r) => r.results.filter((t) => t.name === name).map((t) => `${r.engine} ${t.result}`));
		return `"${name}" (${seen.join(", ")})`;
	});
	return {
		criterion,
		marker,
		status: met ? "met" : "unmet",
		notes: [`evf ac run at ${head.slice(0, 10)}: ${met ? "met" : "unmet"}`, ...tests, ...exits].join("; "),
		evidence: evidence.length ? evidence.join(" ") : null,
	};
}

/**
 * Run the answer key of a task at its worktree HEAD and write one evf proof row per `AC:` criterion. The worktree must
 * be clean, so the tests run the committed HEAD. Returns the rows; a task whose spec has no `AC:` line returns none.
 */
export function acRun(root: string, task: TaskRef, opts: { runId?: number | null } = {}): AcRow[] {
	const db = openWorkDb(root);
	let spec: string | null;
	try {
		spec = findTask(db, task)?.spec ?? null;
	} finally {
		db.close();
	}
	const criteria = acCriteria(spec);
	if (!criteria.length) {
		console.log(`ac: ${task.id} has no AC: criteria in its stored spec; nothing to run.`);
		return [];
	}
	const wt = worktreePath(root, loadConfig(root), task);
	if (!existsSync(wt)) fail(`No worktree for ${task.id}; evf ac run tests the worktree HEAD.`);
	if (!isClean(wt)) fail(`${wt} has uncommitted changes. Commit them: evf ac run proves the committed HEAD.`);
	const head = git(wt, "rev-parse", "HEAD");
	const ui = testFiles(wt, "tests/ui", ".test.mjs"),
		tools = testFiles(wt, "tools/evf/tests", ".test.ts");
	const carrying = (files: string[], marker: string) => {
		const pattern = new RegExp(markerPattern(marker));
		return files.filter((f) => pattern.test(readFileSync(join(wt, f), "utf8")));
	};
	const plan = criteria.map((c) => ({ ...c, ui: carrying(ui, c.marker), tools: carrying(tools, c.marker) }));
	const url = plan.some((p) => p.ui.length) ? readyPreview(wt, head) : null;
	const rows = plan.map(({ criterion, marker, ui: uiFiles, tools: toolFiles }) => {
		console.log(`ac: ${marker}: ${uiFiles.length + toolFiles.length} file(s) carry it`);
		const runs: Outcome[] = [],
			videos: string[] = [];
		if (toolFiles.length) runs.push(nodeTest(wt, toolFiles, marker, "node", process.env));
		for (const engine of uiFiles.length ? AC_ENGINES : []) {
			const dir = join(evidenceDir(root, task, head, "ac"), `criterion-${criterion}`, engine);
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			runs.push(
				nodeTest(wt, uiFiles, marker, engine, {
					...process.env,
					UI_ENGINE: engine,
					UI_BASE_URL: url!,
					EVF_AC_VIDEO_DIR: dir,
				}),
			);
			videos.push(...videosIn(dir));
		}
		for (const r of runs.filter((r) => r.code !== 0))
			console.error(
				`ac: ${marker} on ${r.engine} exited ${r.code}:\n${r.output.trim().split("\n").slice(-40).join("\n")}`,
			);
		return rowOf(criterion, marker, head, runs, videos.length ? videos : [...uiFiles, ...toolFiles]);
	});
	const store = openWorkDb(root);
	try {
		const t = findTask(store, task)!;
		const insert = store.prepare(
			"INSERT INTO proofs (task_id, run_id, head_sha, criterion, status, evidence_url, notes, created_at, written_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'evf')",
		);
		store.exec("BEGIN IMMEDIATE");
		try {
			for (const row of rows) {
				insert.run(
					t.id,
					opts.runId ?? null,
					head,
					row.criterion,
					row.status,
					row.evidence,
					row.notes,
					new Date().toISOString(),
				);
				record(store, t.id, opts.runId ?? null, "proof", {
					criterion: row.criterion,
					status: row.status,
					head,
					written_by: "evf",
					summary: `criterion ${row.criterion} ${row.status} at ${head.slice(0, 10)} (evf ac run)`,
				});
			}
			store.exec("COMMIT");
		} catch (e) {
			store.exec("ROLLBACK");
			throw e;
		}
	} finally {
		store.close();
	}
	for (const row of rows) console.log(`ac: criterion ${row.criterion} ${row.status}: ${row.notes}`);
	if (url)
		console.log(
			`ac: videos under ${relative(wt, evidenceDir(root, task, head, "ac")) || "."}; publish them with .agents/skills/verify-preview/scripts/publish.mjs and link each in the PR body proof table.`,
		);
	return rows;
}

/**
 * The markers whose latest evf row stores a video: a browser test proved them, so their PR body proof row links a
 * video. Rows proven only by tools/evf/tests tests need none.
 */
export function acVideoMarkers(root: string, task: TaskRef): Set<string> {
	const db = openWorkDb(root);
	try {
		const t = findTask(db, task);
		if (!t) return new Set();
		const byCriterion = new Map(acCriteria(t.spec).map((c) => [c.criterion, c.marker]));
		const latest = new Map<string, string | null>();
		for (const p of db
			.prepare("SELECT criterion, evidence_url FROM proofs WHERE task_id = ? AND written_by = 'evf' ORDER BY id")
			.all(t.id) as Array<{ criterion: string; evidence_url: string | null }>)
			latest.set(p.criterion, p.evidence_url);
		return new Set(
			[...latest]
				.filter(([c, evidence]) => byCriterion.has(c) && /\.(webm|mp4)\b/.test(evidence ?? ""))
				.map(([c]) => byCriterion.get(c)!),
		);
	} finally {
		db.close();
	}
}
