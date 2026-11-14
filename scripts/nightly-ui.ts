// The GitHub nightly's tests/ui job (T-301): the browser set over a seeded production build of this checkout, on the
// runner's own throwaway Postgres (DATABASE_URL to `everyfield_ci`, with CI=true and EARLY_ACCESS_TEST_DATABASE=1).
// Run `pnpm build` first. Each command is one workflow step, so each engine reports on its own:
//   node scripts/nightly-ui.ts up <dir>         every tests/ui seed `up` for ORIGIN, then `next start` there, which
//                                                reads the apps/web/.env.local the seeds wrote; it keeps running
//   node scripts/nightly-ui.ts test <engine> <dir>   every tests/ui/**/*.test.mjs with UI_ENGINE=<engine>; exits 1 on a
//                                                failing, cancelled or missing test, or when no test passed
//   node scripts/nightly-ui.ts down <dir>       stops the server and runs every seed `down`
// <dir> collects server.log, <engine>.log and the mail outbox for the failure artifact; fixtures/ holds the seeds'
// fixtures (session cookies), which the artifact leaves out. The preview runs the scripted Evry model (the seeds' env
// file sets it) and the dev mail capture (no provider key, no VERCEL_ENV), as `bin/dev nightly`'s preview does.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINES, type Engine, seedsOf, TSX, uiTestFiles } from "./nightly.ts";

/** The origin the server answers at. The seeds accept only *.localhost; the workflow maps this name to 127.0.0.1. */
export const ORIGIN = "http://nightly.localhost:3000";
const PORT = "3000";

/** One engine's run, from node:test's last summary. */
export type EngineRun = { tests: number; passed: number; failed: number; cancelled: number; skipped: number };

/**
 * node:test's last summary in `output` (spec `ℹ` or tap `#` lines), and why the run is not green: no summary (it
 * crashed), no test, a failed or cancelled test, or no passing test (every test skipped). A null reason means green.
 */
export function engineVerdict(output: string): { run: EngineRun | null; reason: string | null } {
	const last = (name: string) => {
		const value = [...output.matchAll(new RegExp(`^(?:ℹ|#) ${name} (\\d+)\\s*$`, "gm"))].at(-1)?.[1];
		return value === undefined ? undefined : Number(value);
	};
	const tests = last("tests");
	if (tests === undefined) return { run: null, reason: "node:test printed no summary" };
	const run = {
		tests,
		passed: last("pass") ?? 0,
		failed: last("fail") ?? 0,
		cancelled: last("cancelled") ?? 0,
		skipped: (last("skipped") ?? 0) + (last("todo") ?? 0),
	};
	const reason =
		run.tests === 0
			? "no test ran"
			: run.failed > 0
				? `${run.failed} failed`
				: run.cancelled > 0
					? `${run.cancelled} cancelled`
					: run.passed === 0
						? "no test passed (every test skipped)"
						: null;
	return { run, reason };
}

export type UiDeps = {
	files: () => string[];
	/** Runs node:test over `files` with `engine` and returns its whole output. */
	test: (files: string[], engine: Engine) => Promise<string>;
	log: (line: string) => void;
};

/** One engine's step: 0 only when every file ran and the verdict is green. */
export async function uiTest(engine: Engine, deps: UiDeps): Promise<number> {
	const files = deps.files();
	if (!files.length) {
		deps.log(`tests/ui ${engine}: no tests/ui/**/*.test.mjs file found`);
		return 1;
	}
	const { run, reason } = engineVerdict(await deps.test(files, engine));
	const counts = run
		? `${run.tests} tests, ${run.passed} passed, ${run.failed} failed, ${run.cancelled} cancelled, ${run.skipped} skipped`
		: "no counts";
	deps.log(`tests/ui ${engine} over ${files.length} files: ${counts}${reason ? ` (failed: ${reason})` : ""}`);
	return reason ? 1 : 0;
}

// ---- The real runner: node, next and the seeds in this checkout. ----

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureEnv = (dir: string) =>
	Object.fromEntries(
		seedsOf(root).map(({ name }) => [`${name.toUpperCase()}_UI_FIXTURE`, join(dir, "fixtures", `${name}.json`)]),
	);
/** The settings the server, the seeds and the tests share: one fixture folder and one mail outbox. */
const shared = (dir: string): NodeJS.ProcessEnv => {
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	return { ...env, ...fixtureEnv(dir), EVERYFIELD_DEV_OUTBOX: join(dir, "outbox") };
};

function seed(dir: string, action: "up" | "down") {
	const seeds = seedsOf(root);
	for (const { file } of action === "up" ? seeds : seeds.toReversed()) {
		console.log(`seed ${file} ${action}`);
		const r = spawnSync(
			process.execPath,
			["--conditions=react-server", "--import", TSX, file, action, ...(action === "up" ? [ORIGIN] : [])],
			{ cwd: root, env: shared(dir), stdio: "inherit" },
		);
		if (r.status !== 0) throw Error(`seed ${file} ${action} exited ${r.status ?? r.signal}`);
	}
}

const pidFile = (dir: string) => join(dir, "server.pid");

/** `next start` on the build, in its own process group, logging to server.log; resolves once it answers. */
async function startServer(dir: string) {
	const log = openSync(join(dir, "server.log"), "a");
	const server = spawn(
		process.execPath,
		["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", PORT],
		{
			cwd: join(root, "apps/web"),
			env: { ...shared(dir), NODE_ENV: "production" },
			detached: true,
			stdio: ["ignore", log, log],
		},
	);
	let exited: number | null | undefined;
	server.once("exit", (code) => (exited = code));
	server.unref();
	writeFileSync(pidFile(dir), String(server.pid));
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (exited !== undefined) throw Error(`next start exited ${exited}; see ${join(dir, "server.log")}`);
		try {
			await fetch(`http://127.0.0.1:${PORT}/`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
			console.log(`serving ${ORIGIN} (pid ${server.pid})`);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	throw Error(`next start did not answer within 120 s; see ${join(dir, "server.log")}`);
}

function stopServer(dir: string) {
	if (!existsSync(pidFile(dir))) return;
	try {
		process.kill(-Number(readFileSync(pidFile(dir), "utf8")), "SIGTERM");
	} catch {
		// Already gone.
	}
	rmSync(pidFile(dir));
}

/** node:test over `files`, streamed to this step's log and to <dir>/<engine>.log. */
function runTests(dir: string, files: string[], engine: Engine): Promise<string> {
	const out = createWriteStream(join(dir, `${engine}.log`));
	const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
		cwd: root,
		env: { ...shared(dir), UI_BASE_URL: ORIGIN, UI_ENGINE: engine },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk: Buffer) => {
			output += chunk;
			process.stdout.write(chunk);
			out.write(chunk);
		});
	return new Promise((resolve) => child.once("close", () => out.end(() => resolve(output))));
}

const USAGE = "usage: node scripts/nightly-ui.ts up <dir> | test chromium|webkit <dir> | down <dir>";

export async function nightlyUiCommand(args: string[]): Promise<number> {
	const [command, ...rest] = args;
	const dir = rest.at(-1);
	if (!dir || !["up", "test", "down"].includes(command ?? "")) return (console.error(USAGE), 2);
	mkdirSync(join(dir, "fixtures"), { recursive: true });
	if (command === "up") {
		try {
			seed(dir, "up");
			await startServer(dir);
			return 0;
		} catch (error) {
			stopServer(dir);
			console.error((error as Error).message);
			return 1;
		}
	}
	if (command === "down") {
		stopServer(dir);
		seed(dir, "down");
		return 0;
	}
	const engine = rest[0] as Engine;
	if (rest.length !== 2 || !ENGINES.includes(engine)) return (console.error(USAGE), 2);
	return uiTest(engine, {
		files: () => uiTestFiles(root),
		test: (files, e) => runTests(dir, files, e),
		log: console.log,
	});
}

if (import.meta.main) process.exitCode = await nightlyUiCommand(process.argv.slice(2));
