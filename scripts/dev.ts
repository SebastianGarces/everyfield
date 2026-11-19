import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { browserRun } from "./browser.ts";
import { FastCheckError, fastCheck, render } from "./fast-check.ts";

const HELP = `Browser runs, the local preview stack, its logs and the fast pre-push check, for the worktree you run them from. Node 24.
  dev browser run [--timeout <seconds>] [--session <name>] -- <command> [args...]
        runs a browser check in its own process group (default timeout 900 s), then closes its agent-browser
        session and stops every process it started, also on failure or timeout
  dev stack up [--mode development|production] [--project <path>]    waits for a free preview slot, then starts it
  dev stack status|check|down [--project <path>]
  dev logs [--project <path>] [args...]    portless preview logs of this worktree's preview
  dev check [--full]    the local checks this change needs (authors), or every check (--full, verifiers); writes a
        checks.json record outside the repo and prints its path. Selection reads the coverage map of the latest
        green GitHub nightly (.github/workflows/nightly.yml), downloaded with gh; without one it runs everything
        --full takes about 9 minutes alone and about 15 minutes each with six evf check slots side by side, test:db
        on Docker Postgres included. Every child gets a private TMPDIR, <CI home>/tmp/<checkout hash>, emptied at
        start, and capped parallelism: EVF_NODE_TEST_FLAGS=--test-concurrency=3 unless already set, test:unit with
        pnpm --workspace-concurrency=2, and oxlint in lint with --threads=3. GitHub CI runs none of these caps
        checks: lint, typecheck, test:unit, test:db, docs, ci-coverage, workflow, tools-ci, tools-qa, tools-app, github-scripts, ops-watch
        test:db runs the selected packages' database tests on a throwaway local Postgres (CI's image in Docker,
        removed when the run ends), so it needs Docker; it never uses the shared development database
        check first removes orphaned qa-test-* containers: older than EVERYFIELD_QA_SWEEP_MINUTES (default 120)
        and owned by no live run
        GitHub CI also runs: format:check, test:logs, the statement census with the one build then server-trace,
        schema generate --check, wiki
        The GitHub nightly also runs: every selectable test under coverage, typecheck:bun (bun check, until T-53),
        the tests/ui set in chromium and webkit on a seeded build over its own Postgres (scripts/nightly-ui.ts), and
        the formal replay: permissions behaviors from a fresh random seed replayed on its own Postgres; a disagreement
        files the seed (scripts/nightly-formal.ts [--seed <n>], .agents/skills/formal-permissions/SKILL.md)
  dev nightly           runs tests/ui on a preview of origin/main, one engine at a time; skips when the machine is
        loaded or no preview slot is free. The GitHub nightly runs the same set too; this stays the local run until
        it is retired. The coverage map comes from the GitHub nightly, not from this
  dev nightly schedule install     installs the launchd agent com.everyfield.nightly: bin/dev nightly from the main
        checkout at 03:30 local time every day; running it again replaces the one agent
  dev nightly schedule status      says whether the agent is installed and loaded, when it runs, its log and the last
        nightly.jsonl record
  dev nightly schedule uninstall   boots the agent out and deletes its plist
  dev fast-check [--base <ref>] [--json]   format, lint and typecheck of only the files changed since the merge base
        of origin/main (else main), in seconds, with no database, stack or network. Prints each fix command. Its
        formal step fails a branch that changes a file in a .agents/skills/formal-*/map.json without that map or its
        model, unless a branch commit has the trailer "Formal-model: unchanged"
  app help                                 interactive browser checks of this worktree's app (bin/app: agent-browser
        underneath, one line per result, one session, a local seeded app with app up)
  dev hooks install                        points this repo's core.hooksPath at tools/git-hooks (pnpm install does it)
  dev formal [--write] [<model dir>...]    runs TLC on every model under formal/ with the pinned tla2tools.jar, checks
        each model's outcomes.json and its TLC-simulated traces.json (--write rewrites both) and the
        .agents/skills/formal-*/map.json maps; local Java 11+ or a pinned Java container in Docker
        (tools/formal/formal.ts, .agents/skills/formal-permissions/SKILL.md)
  dev formal --traces <dir> [--seed <n>]   writes fresh random behaviors from a new or given seed to <dir> outside the
        repository, for the replay test's FORMAL_TRACES=<dir>

Git hooks: on a push of a task branch (refs/heads/evf/*), tools/git-hooks/pre-push runs dev fast-check and refuses
the push when it fails. Other refs pass unchecked. GitHub CI's full run over the whole repo stays required.`;

const root = resolve(import.meta.dirname, "..");
const SLOTS = join(root, ".agents/skills/verify-preview/scripts/preview-slots.mjs");
const STACK = join(root, "scripts/stack.mjs");

class DevError extends Error {}

const node = (script: string, args: string[], capture = false) =>
	spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});

function take(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const [, value] = args.splice(at, 2);
	if (!value) throw new DevError(`${name} needs a value.`);
	return value;
}

async function browser(args: string[]): Promise<number> {
	const sep = args.indexOf("--");
	if (args[0] !== "run" || sep < 0 || sep === args.length - 1) return usage();
	const options = args.slice(1, sep),
		timeout = Number(take(options, "--timeout") ?? 900),
		session = take(options, "--session");
	if (options.length) return usage();
	if (!Number.isFinite(timeout) || timeout <= 0) throw new DevError("--timeout takes a number of seconds.");
	return browserRun(args.slice(sep + 1), { timeoutSeconds: timeout, session });
}

function stack(args: string[]): number {
	const [action, ...rest] = args;
	if (!action || !["up", "status", "check", "down"].includes(action)) return usage();
	if (action === "up") {
		const options = [...rest],
			project = take(options, "--project") ?? root;
		const slot = node(SLOTS, ["--project", project]);
		if (slot.status !== 0) return slot.status ?? 1;
	}
	return node(STACK, [action, ...rest]).status ?? 1;
}

function logs(args: string[]): number {
	const extra = [...args],
		project = take(extra, "--project");
	const status = node(STACK, ["status", ...(project ? ["--project", project] : [])], true);
	if (status.status !== 0) return status.status ?? 1;
	const { id } = JSON.parse(status.stdout) as { id?: string };
	if (!id) throw new DevError("This worktree has no running preview. Start it with bin/dev stack up.");
	const shown = spawnSync("portless", ["preview", "logs", id, ...extra], { stdio: "inherit" });
	if (shown.error)
		throw new DevError("Cannot run managed Portless. Run portless preview --help to check installation.");
	return shown.status ?? 1;
}

async function fastCheckCommand(args: string[]): Promise<number> {
	const options = [...args],
		base = take(options, "--base"),
		json = options.includes("--json");
	if (options.some((option) => option !== "--json")) return usage();
	const report = await fastCheck(root, base);
	console.log(json ? JSON.stringify(report, null, 2) : render(report));
	return report.ok ? 0 : 1;
}

const HOOKS = "tools/git-hooks";

function hooks(args: string[]): number {
	if (args[0] !== "install" || args.length > 1) return usage();
	if (process.env.CI) return 0;
	const git = (...gitArgs: string[]) => spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
	if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") return 0;
	if (git("config", "--local", "--get", "core.hooksPath").stdout.trim() === HOOKS) return 0;
	if (git("config", "--local", "core.hooksPath", HOOKS).status !== 0) throw new DevError("Cannot set core.hooksPath.");
	console.log(`dev: core.hooksPath is ${HOOKS}. A push of a task branch runs bin/dev fast-check first.`);
	return 0;
}

function usage(): number {
	console.error(HELP);
	return 2;
}

async function main([command, ...args]: string[]): Promise<number> {
	switch (command) {
		case "browser":
			return browser(args);
		case "stack":
			return stack(args);
		case "logs":
			return logs(args);
		case "check":
			return (await import("./check.ts")).checkCommand(args, root);
		case "nightly":
			return (await import("./nightly.ts")).nightlyCommand(args);
		case "fast-check":
			return fastCheckCommand(args);
		case "formal":
			return (await import("../tools/formal/formal.ts")).formalCommand(args, root);
		case "hooks":
			return hooks(args);
		case "help":
		case "--help":
		case undefined:
			console.log(HELP);
			return 0;
		default:
			return usage();
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof DevError || error instanceof FastCheckError)) throw error;
	console.error(`dev: ${error.message}`);
	process.exitCode = 1;
}
