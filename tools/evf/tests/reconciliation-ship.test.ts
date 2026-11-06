import { createHash } from "node:crypto";
import { packageContext, loadProgress, partsOf, findPackage } from "../lib.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { loadDag } from "../lib.ts";
import { fixture, setTasks, readTask, writeTask } from "./fixtures.ts";
import { parseTask, evfDataDir, loadConfig, runtimeDir } from "../lib.ts";
import { feedbackTriage } from "../feedback.ts";
import { verify } from "../verify.ts";
import { taskStart } from "../task.ts";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { ship, listShipped } from "../ship.ts";
import { driveOnce } from "../drive.ts";
import { ensureTask, openWorkDb } from "../db.ts";
import { approve } from "../approve.ts";
import { requireImplementation, requireTaskScope } from "../policy.ts";
import { existsSync } from "node:fs";
import { stack } from "../task.ts";
import { producerReady, reconcileProgress } from "../progress.ts";
import { principles } from "../principles.ts";
import { chmodSync } from "node:fs";
import { DEFAULT_DOCUMENT_TEMPLATES } from "../policy.ts";
import { mergePullRequest, templateClass } from "../merge.ts";
import { drive } from "../drive.ts";
import { markMergedByBranch, workDbPath } from "../db.ts";
import { sessionStartJs } from "./fixtures.ts";
import { fileFollowUps } from "../followups.ts";
import {
	AUTHOR,
	DRIVE_TIMING,
	PR375_FILES,
	VERIFIER,
	approvable,
	approvePr,
	approveWrites,
	approvedExperience,
	approvedQuality,
	at,
	behindCode,
	callsWith,
	capturedLog,
	currentCode,
	inFakeCwd,
	mergeCalls,
	mergeFixture,
	pr375,
	source,
	templateConfig,
	validPrBody,
	verifiedStatus,
	withCode,
	wpShipFixture,
} from "./reconciliation-helpers.ts";

const importGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const quiet = <T>(fn: () => T): T => {
	const log = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = log;
	}
};

test("INV-wp-scope: verify accepts only the task's own new-package lock importer, scaffold, at-start cases and generated projections", () => {
	const f = fixture();
	try {
		f.authorize("WP-002");
		const lock =
			"lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/db:\n    dependencies:\n      pg:\n        specifier: 8.0.0\n        version: 8.0.0\n\npackages:\n\n  pg@8.0.0:\n    resolution: {integrity: sha512-fixture}\n";
		const generateIn = (root: string) => {
			for (const flag of ["--refresh-manifest", "--refresh-plan"])
				execFileSync("python3", ["docs/package-context.py", flag, "--root", root], { cwd: root, stdio: "ignore" });
		};
		// The fixture owns its base: projections start equal to the generators' output, whatever the live docs hold.
		generateIn(f.root);
		writeFileSync(join(f.root, "pnpm-lock.yaml"), lock);
		f.git("add", "pnpm-lock.yaml");
		f.commit();
		const wt = f.task("wp-002"),
			git = (...args: string[]) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
		const index = JSON.parse(readFileSync(join(wt, "docs/catalog/index.json"), "utf8"));
		const atStart: string[] = loadDag(wt).packages.find((p) => p.id === "WP-002")!.context_scope
			.case_requirements_at_start;
		const file = index.case_files.find((path: string) =>
			JSON.parse(readFileSync(join(wt, path), "utf8")).cases.some(
				(c: { work_packages: string[]; requirement: string }) =>
					c.work_packages.join() === "WP-002" && atStart.includes(c.requirement),
			),
		);
		const addCase = (id: string, requirement?: string) => {
			const payload = JSON.parse(readFileSync(join(wt, file), "utf8"));
			const own = structuredClone(
				payload.cases.find(
					(c: { work_packages: string[]; requirement: string }) =>
						c.work_packages.join() === "WP-002" && atStart.includes(c.requirement),
				),
			);
			own.id = id;
			if (requirement) {
				own.requirement = requirement;
				own.requirement_ids = [requirement];
			}
			payload.cases.push(own);
			writeFileSync(join(wt, file), JSON.stringify(payload, null, 2) + "\n");
		};
		const generate = () => generateIn(wt);
		// Which projections a new case changes depends on the catalog; derive them from the generators' actual output.
		const projections = () =>
			git(
				"diff",
				"--name-only",
				"main",
				"--",
				"docs/plan/context-manifest.json",
				"docs/plan/dag.json",
				"docs/plan/build-plan.md",
			)
				.split("\n")
				.filter(Boolean);
		const write = (path: string, text: string) => {
			mkdirSync(join(wt, path, ".."), { recursive: true });
			writeFileSync(join(wt, path), text);
		};
		let printed: string[] = [];
		const scopeOf = () => {
			git("add", "-A");
			git("commit", "-qm", "Candidate");
			const log = console.log;
			printed = [];
			console.log = (...m) => {
				printed.push(...m.join(" ").split("\n"));
			};
			let s;
			try {
				s = verify(f.root, parseTask("WP-002"), "author", "full").scope!;
			} finally {
				console.log = log;
			}
			return {
				owned: s.owned,
				accepted: Object.fromEntries(s.accepted.map((a) => [a.path, a.rule])),
				outside: [...s.outside].sort(),
			};
		};
		for (const name of ["package.json", "tsconfig.json", "eslint.config.mjs"])
			write(`packages/contracts/${name}`, "{}\n");
		write("packages/contracts/src/common/values.ts", "export {};\n");
		write("apps/web/package.json", "{}\n");
		writeFileSync(
			join(wt, "pnpm-lock.yaml"),
			lock.replace("\n  packages/db:", "\n  packages/contracts: {}\n\n  packages/db:"),
		);
		addCase("SCOPE-FIXTURE-001");
		generate();
		const generated = projections();
		assert.ok(generated.includes("docs/plan/context-manifest.json"));
		assert.deepEqual(scopeOf(), {
			owned: ["packages/contracts/src/common/values.ts"],
			accepted: {
				[file]: "own-at-start-cases",
				...Object.fromEntries(generated.map((p) => [p, "generated-projection"])),
				"packages/contracts/eslint.config.mjs": "own-package-scaffold",
				"packages/contracts/package.json": "own-package-scaffold",
				"packages/contracts/tsconfig.json": "own-package-scaffold",
				"pnpm-lock.yaml": "own-lock-importer",
			},
			outside: ["apps/web/package.json"],
		});
		assert.deepEqual(
			printed.filter((l) => l.startsWith("  outside: ")),
			["  outside: apps/web/package.json (verifier: confirm a recorded ruling)"],
		);
		// Each widening stays outside: a lock entry beyond the importer, another package's case and a hand-edited projection.
		writeFileSync(
			join(wt, "pnpm-lock.yaml"),
			readFileSync(join(wt, "pnpm-lock.yaml"), "utf8") + "\n  zod@4.0.0:\n    resolution: {integrity: sha512-extra}\n",
		);
		addCase("SCOPE-FIXTURE-002", "REQ-KNOW-078");
		generate();
		writeFileSync(
			join(wt, "docs/plan/build-plan.md"),
			readFileSync(join(wt, "docs/plan/build-plan.md"), "utf8") + "\nHand-written line.\n",
		);
		assert.deepEqual(scopeOf(), {
			owned: ["packages/contracts/src/common/values.ts"],
			accepted: {
				"packages/contracts/eslint.config.mjs": "own-package-scaffold",
				"packages/contracts/package.json": "own-package-scaffold",
				"packages/contracts/tsconfig.json": "own-package-scaffold",
			},
			outside: [
				...new Set(["apps/web/package.json", "docs/plan/build-plan.md", ...projections(), file, "pnpm-lock.yaml"]),
			].sort(),
		});
	} finally {
		f.close();
	}
});

test("BUG-ops6-stack-start: task start fails when stack up fails", () => {
	const f = fixture();
	try {
		f.cfg.stack = { usesPaidProviders: false, up: [process.execPath, "-e", "process.exit(3)"] };
		f.authorize("WP-001");
		f.commit();
		assert.throws(
			() => quiet(() => taskStart(f.root, parseTask("WP-001"), { allowUnready: false, noStack: false })),
			/stack up failed with exit code 3/,
		);
	} finally {
		f.close();
	}
});

test("BUG-ops6-stack-node: stack commands named node run on evf's Node, not the first node on PATH", () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, "fake-bin/node"), "#!/bin/sh\nexit 9\n");
		execFileSync("chmod", ["+x", join(f.root, "fake-bin/node")]);
		f.cfg.stack = {
			usesPaidProviders: false,
			up: [
				"node",
				"-e",
				'require("node:fs").writeFileSync(process.env.EVF_RUNTIME_DIR+"/stack.json",JSON.stringify({node:process.execPath}))',
			],
		};
		f.authorize("WP-001");
		f.commit();
		const task = parseTask("WP-001");
		quiet(() => taskStart(f.root, task, { allowUnready: false, noStack: true }));
		assert.equal(
			quiet(() => stack(f.root, task, "up")),
			0,
		);
		assert.equal(
			JSON.parse(readFileSync(join(evfDataDir(f.root), "runtime", task.slug, "stack.json"), "utf8")).node,
			process.execPath,
		);
	} finally {
		f.close();
	}
});

test("BUG-ops6-principles-target: principles --apply writes the task worktree and leaves the home checkout unchanged", () => {
	const f = fixture();
	try {
		const skill = Buffer.from("---\nname: principle-fixture\n---\n\n# Fixture principle\n"),
			blob = createHash("sha1").update(`blob ${skill.length}\0`).update(skill).digest("hex"),
			commit = "c".repeat(40);
		const repo = "up/plugins",
			state = f.getState();
		state.api = {
			[`repos/${repo}/commits/main`]: { sha: commit, commit: { committer: { date: "2026-10-18T00:00:00Z" } } },
			[`repos/${repo}/commits/${commit}`]: { sha: commit, commit: { committer: { date: "2026-10-18T00:00:00Z" } } },
			[`repos/${repo}/git/trees/${commit}?recursive=1`]: {
				truncated: false,
				tree: [{ path: "pstack/skills/principle-fixture/SKILL.md", type: "blob", sha: blob }],
			},
			[`repos/${repo}/git/blobs/${blob}`]: { content: skill.toString("base64"), encoding: "base64" },
		};
		f.setState(state);
		(f.cfg as Record<string, unknown>).principles = { repo, path: "pstack/skills", prefix: "principle-", ref: "main" };
		f.tasks = {
			"OPS-1": {
				title: "Principle refresh",
				owningPaths: [".agents/skills/", "skills-lock.json"],
				checks: f.cfg.checks,
			},
		};
		writeFileSync(join(f.root, "skills-lock.json"), '{"version":1,"skills":{}}\n');
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		setTasks(f.root, f.tasks);
		f.git("add", "skills-lock.json");
		f.commit();
		const wt = f.task("ops-1"),
			homeLock = readFileSync(join(f.root, "skills-lock.json"), "utf8");
		assert.equal(
			quiet(() => principles(f.root, { apply: true, task: parseTask("OPS-1") })),
			0,
		);
		assert.equal(existsSync(join(f.root, ".agents/skills/principle-fixture")), false);
		assert.equal(readFileSync(join(f.root, "skills-lock.json"), "utf8"), homeLock);
		assert.deepEqual(readFileSync(join(wt, ".agents/skills/principle-fixture/SKILL.md")), skill);
		assert.equal(
			JSON.parse(readFileSync(join(wt, "skills-lock.json"), "utf8")).skills["principle-fixture"].upstreamCommit,
			commit,
		);
		assert.throws(() => principles(f.root, { apply: true }), /Give the maintenance task/);
		assert.equal(existsSync(join(f.root, ".agents/skills/principle-fixture")), false);
	} finally {
		f.close();
	}
});

test("BUG-wp003-shared-report: each check keeps its own report and only AC: reports turn on case coverage", () => {
	const f = fixture();
	try {
		const ids = packageContext(f.root, "WP-002").case_ids,
			writer = (tests: unknown[]) => [
				process.execPath,
				"-e",
				`require("node:fs").writeFileSync(process.env.EVF_TEST_REPORT,${JSON.stringify(JSON.stringify({ tests }))})`,
			];
		const tooling = { name: "workflow", run: writer([{ name: "INV-workflow: stack isolation", status: "passed" }]) };
		const cases = {
			name: "package cases",
			run: writer([
				{
					name:
						ids
							.slice(0, -1)
							.map((id) => `AC:${id}`)
							.join(" ") + " package behavior",
					status: "passed",
				},
			]),
		};
		f.authorize("WP-002");
		f.commit();
		const wt = f.task("wp-002");
		const run = (checks: unknown[]) => {
			f.cfg.checks = checks as typeof f.cfg.checks;
			writeFileSync(join(wt, "evf.config.json"), JSON.stringify(f.cfg));
			importGit(wt, "add", "evf.config.json");
			importGit(wt, "commit", "-qm", "Commit check definitions");
			return quiet(() => verify(f.root, parseTask("WP-002"), "author", "full"));
		};
		const toolingOnly = run([tooling]);
		assert.deepEqual(
			toolingOnly.checks.map((c) => c.name),
			["workflow"],
		);
		assert.equal(toolingOnly.passed, true);
		const both = run([cases, tooling]);
		assert.deepEqual(
			both.checks.map((c) => [c.name, c.passed]),
			[
				["package cases", true],
				["workflow", true],
				["case-coverage", false],
			],
		);
		assert.deepEqual(JSON.parse(readFileSync(both.checks[2].log, "utf8")).missing, ids.slice(-1));
		// Check names that slug alike keep separate reports and logs.
		const alike = run([cases, { ...tooling, name: "package_cases" }]);
		assert.deepEqual(
			alike.checks.map((c) => [c.name, c.passed]),
			[
				["package cases", true],
				["package_cases", true],
				["case-coverage", false],
			],
		);
		assert.equal(new Set(alike.checks.map((c) => c.log)).size, 3);
		for (const c of alike.checks.slice(0, 2)) assert.equal(existsSync(c.log.replace(/\.log$/, ".tests.json")), true);
		assert.deepEqual(JSON.parse(readFileSync(alike.checks[2].log, "utf8")).missing, ids.slice(-1));
	} finally {
		f.close();
	}
});

test("BUG-ops6-fixture-cleanup: fixture commits and bare pushes start no background maintenance, so close removes the whole fixture", () => {
	// Git's detached auto-maintenance kept writing into a fixture's .git while close() removed it (ENOTEMPTY on CI).
	const f = fixture(),
		traces = mkdtempSync(join(tmpdir(), "evf-trace-")),
		trace = join(traces, "git.json");
	try {
		f.git("config", "gc.auto", "1");
		for (let i = 0; i < 50; i++) writeFileSync(join(f.root, `loose-${i}.txt`), `loose object ${i}`);
		f.git("add", ".");
		const traced = (...args: string[]) =>
			execFileSync("git", ["-C", f.root, ...args], { env: { ...process.env, GIT_TRACE2_EVENT: trace }, stdio: "pipe" });
		traced("commit", "-qm", "Many loose objects");
		// The receiving side of a local push does not inherit the test's git environment.
		traced("push", "-q", f.bare(join(f.root, "fake-bin/receiver.git")), "main");
		const events = readFileSync(trace, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const command of ["commit", "push"])
			assert.equal(
				events.some((e) => e.event === "start" && e.argv.includes(command)),
				true,
				`${command} actually ran`,
			);
		const children = events.filter((e) => e.event === "child_start").map((e) => e.argv.join(" "));
		assert.deepEqual(
			children.filter((argv) => /\b(maintenance|gc)\b/.test(argv)),
			[],
		);
	} finally {
		f.close();
		rmSync(traces, { recursive: true, force: true });
	}
	assert.equal(existsSync(f.root), false);
});

test("BUG-ops15-ship: an outside-path merge succeeds and cleans up without package progress", () => {
	const f = mergeFixture(),
		log = console.log,
		lines = [];
	try {
		f.authorize("WP-001");
		f.cfg.stack = {
			down: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.env.EVF_RUNTIME_DIR+"/stopped", "yes")'],
		};
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.commit();
		f.git("push", "-q", "origin", "main");
		const task = parseTask("WP-001"),
			wt = f.task(task.slug);
		writeFileSync(join(wt, "README.md"), "Outside the package owning paths\n");
		const candidateGit = (...args) => execFileSync("git", ["-C", wt, ...args], { encoding: "utf8" }).trim();
		candidateGit("add", "README.md");
		candidateGit("commit", "-qm", "Reviewed outside-path change");
		const sha = candidateGit("rev-parse", "HEAD"),
			state = f.getState();
		state.allowMerge = true;
		state.mergeBranch = task.branch;
		state.pr.headRefOid = sha;
		state.comments["77"][0].body =
			`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		f.setState(state);
		mkdirSync(runtimeDir(f.root, task), { recursive: true });
		const before = readFileSync(join(f.root, "docs/build-progress.json"), "utf8");
		console.log = (...args) => lines.push(args.join(" "));
		assert.equal(ship(f.root, task), 0);
		assert.match(lines.join("\n"), /progress: WP-001 merged but its reviewed-milestone checks failed.*evf shipped/);
		assert.equal(readFileSync(join(f.root, "docs/build-progress.json"), "utf8"), before);
		assert.equal(readFileSync(join(runtimeDir(f.root, task), "stopped"), "utf8"), "yes");
		assert.equal(existsSync(wt), false);
		listShipped(f.root, [task.id]);
		assert.equal(readFileSync(join(f.root, "docs/build-progress.json"), "utf8"), before);
		assert.equal(
			JSON.parse(readFileSync(join(evfDataDir(f.root), "shipped", task.slug + ".json"), "utf8")).acknowledged,
			true,
		);
		assert.equal(producerReady(f.root, "WP-001"), false, "maintenance alone cannot create a producer milestone");
	} finally {
		console.log = log;
		f.close();
	}
});

test("BUG-ops15-dependencies: task start installs before stack startup and stops on install failure", () => {
	for (const installCode of [0, 7]) {
		const f = fixture();
		try {
			writeFileSync(join(f.root, "package.json"), '{"private":true}');
			f.git("add", "package.json");
			f.cfg.stack = {
				usesPaidProviders: false,
				up: [
					process.execPath,
					"-e",
					'const fs=require("node:fs"); if(!fs.existsSync("node_modules/ready")) process.exit(9); fs.writeFileSync("stack-started", "yes")',
				],
			};
			f.authorize("WP-001");
			f.commit();
			// Give the child its own Node directory, so its fake installer is first on PATH too.
			const nodeDir = join(f.root, "fake-bin/runtime");
			mkdirSync(nodeDir);
			cpSync(process.execPath, join(nodeDir, "node"));
			const installer = join(nodeDir, "corepack");
			writeFileSync(
				installer,
				`#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync('install-args', JSON.stringify(process.argv.slice(2))); fs.mkdirSync('node_modules',{recursive:true}); fs.writeFileSync('node_modules/ready','yes'); process.exit(${installCode});`,
			);
			execFileSync("chmod", ["+x", installer]);
			const task = parseTask("WP-001"),
				wt = join(f.root, ".worktrees", task.slug);
			const code = `import {taskStart} from ${JSON.stringify(join(source, "tools/evf/task.ts"))}; import {parseTask} from ${JSON.stringify(join(source, "tools/evf/lib.ts"))}; process.exit(taskStart(${JSON.stringify(f.root)}, parseTask("WP-001"), {allowUnready:false, noStack:false}));`;
			const result = spawnSync(join(nodeDir, "node"), ["--input-type=module", "-e", code], { encoding: "utf8" });
			assert.equal(result.status, installCode ? 1 : 0, result.stderr);
			if (installCode) assert.match(result.stderr, /Dependency install failed with exit code 7/);
			assert.deepEqual(JSON.parse(readFileSync(join(wt, "install-args"), "utf8")), [
				"pnpm",
				"install",
				"--frozen-lockfile",
			]);
			assert.equal(existsSync(join(wt, "stack-started")), installCode === 0);
		} finally {
			f.close();
		}
	}
});

test("INV-design-route: a design task owns only design/, waits after the verifier and merges only on Sebastian's approval", () => {
	const f = mergeFixture({ owningPaths: ["design/"], route: "design" });
	try {
		// The registration under check is the one committed on the task branch.
		const commitScope = (next: Record<string, unknown>) => {
			writeTask(f.wt, f.taskRef.id, { ...readTask(f.wt, f.taskRef.id), ...next });
			execFileSync("git", ["-C", f.wt, "commit", "-qam", "Change the registration"]);
		};
		commitScope({ owningPaths: ["design/"], route: undefined });
		assert.throws(() => requireTaskScope(f.root, f.wt, f.taskRef), /must stay in documentation and workflow tooling/);
		commitScope({ owningPaths: ["design/", "tools/evf/"], route: "design" });
		assert.throws(() => requireTaskScope(f.root, f.wt, f.taskRef), /A design task owns only design\/ paths/);
		execFileSync("git", ["-C", f.wt, "reset", "-q", "--hard", f.sha]);
		requireTaskScope(f.root, f.wt, f.taskRef);
		f.git("push", "-q", "origin", f.taskRef.branch);

		const merges = () => f.getState().calls.filter((c: any) => c.args[0] === "pr" && c.args[1] === "merge");
		assert.equal(ship(f.root, f.taskRef), 0);
		assert.deepEqual(merges(), []);
		const status = f.getState().calls.find((c: any) => c.args.some((a: string) => a.endsWith(`statuses/${f.sha}`)));
		assert.ok(
			status.args.includes("state=success") &&
				status.args.includes(`description=Verified by claude-opus-5-5 (session 22222222) at ${f.sha.slice(0, 10)}`),
		);

		const s = f.getState();
		const pr = { ...s.pr, ...approvePr("task/ops-1", { headRefOid: f.sha }) };
		s.pr = { ...pr, files: [{ path: "design/everyfield-ui.html" }] };
		s.calls = [];
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
			/outside its owning paths or design\/everyfield-ui.html/,
		);
		s.pr = { ...pr, files: [{ path: "design/everyfield-marketing.html" }] };
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
			/needs the verifier to pass it first \(bin\/evf ship OPS-1\)/,
		);
		assert.deepEqual(approveWrites(f), []);
		s.commitStatus = {
			statuses: [
				{ context: "evf/verify", state: "success", description: `Verified by anthropic at ${f.sha.slice(0, 10)}` },
			],
		};
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR", head: f.sha }),
			/fixture merge barrier/,
		);
		assert.deepEqual(merges()[0].args, ["pr", "merge", "77", "--squash", "--match-head-commit", f.sha]);

		writeFileSync(join(f.wt, "design/everyfield-ui.html"), "<!-- changed prototype -->\n");
		execFileSync("git", ["-C", f.wt, "add", "design"]);
		execFileSync("git", ["-C", f.wt, "commit", "-qm", "Change the approved prototype"]);
		assert.throws(
			() => verify(f.root, f.taskRef, "author", "full"),
			/design\/everyfield-ui.html keeps its approved bytes/,
		);
	} finally {
		f.close();
	}
});

const PROTOTYPE_APPROVAL = { quote: "Evry is good to go", approvedAt: "2026-10-31T17:07:00Z" };

/** A design task whose branch changes the prototype under the given registration, pushed with its PR at that head. */
function prototypeFixture(next: Record<string, unknown>) {
	const f = mergeFixture({ owningPaths: ["design/"], route: "design" });
	writeTask(f.wt, f.taskRef.id, { ...readTask(f.wt, f.taskRef.id), ...next });
	mkdirSync(join(f.wt, "design"), { recursive: true });
	writeFileSync(join(f.wt, "design/everyfield-ui.html"), "<!-- changed prototype -->\n");
	execFileSync("git", ["-C", f.wt, "add", "-A"]);
	execFileSync("git", ["-C", f.wt, "commit", "-qm", "Change the approved prototype"]);
	const head = execFileSync("git", ["-C", f.wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	f.git("push", "-q", "origin", f.taskRef.branch);
	const s = f.getState();
	s.pr = { ...s.pr, ...approvePr("task/ops-1", { headRefOid: head }), files: [{ path: "design/everyfield-ui.html" }] };
	s.calls = [];
	f.setState(s);
	return { ...f, head };
}

test("INV-prototype-approval: maintenanceScope refuses a malformed prototypeApproval", () => {
	const refuse = (next: Record<string, unknown>, message: RegExp) => {
		const f = mergeFixture({ owningPaths: ["design/"], route: "design" });
		try {
			writeTask(f.wt, f.taskRef.id, { ...readTask(f.wt, f.taskRef.id), ...next });
			execFileSync("git", ["-C", f.wt, "commit", "-qam", "Change the registration"]);
			assert.throws(() => requireTaskScope(f.root, f.wt, f.taskRef), message);
		} finally {
			f.close();
		}
	};
	refuse(
		{ route: undefined, owningPaths: ["tools/evf/"], prototypeApproval: PROTOTYPE_APPROVAL },
		/prototypeApproval.*needs the design route/,
	);
	for (const quote of [undefined, 7, "", "  \n"])
		refuse({ prototypeApproval: { ...PROTOTYPE_APPROVAL, quote } }, /prototypeApproval\.quote/);
	for (const approvedAt of [
		"2026-10-31 1:07 PM ET",
		"2026-10-31T13:07:00-04:00",
		"2026-13-01T00:00:00Z",
		"2026-02-30T00:00:00Z",
		"",
		undefined,
	])
		refuse({ prototypeApproval: { ...PROTOTYPE_APPROVAL, approvedAt } }, /prototypeApproval\.approvedAt/);
});

test("INV-prototype-approval: evf verify allows the prototype only for the recorded design-route exception", () => {
	const approved = ["design/everyfield-ui.html"];
	for (const [label, next, outcome] of [
		["a", { owningPaths: approved }, /design\/everyfield-ui.html keeps its approved bytes/],
		[
			"b",
			{ route: undefined, owningPaths: ["tools/evf/"], prototypeApproval: PROTOTYPE_APPROVAL },
			/needs the design route/,
		],
		[
			"c",
			{ owningPaths: ["design/"], prototypeApproval: PROTOTYPE_APPROVAL },
			/design\/everyfield-ui.html keeps its approved bytes/,
		],
		["d", { owningPaths: approved, prototypeApproval: PROTOTYPE_APPROVAL }, undefined],
	] as const) {
		const f = prototypeFixture(next);
		try {
			let message = "";
			try {
				verify(f.root, f.taskRef, "author", "full");
			} catch (e) {
				message = String((e as Error).message);
			}
			if (outcome) assert.match(message, outcome, label);
			else assert.doesNotMatch(message, /keeps its approved bytes|prototypeApproval/, label);
		} finally {
			f.close();
		}
	}
});

test("INV-prototype-approval: evf approve reads the entry at the PR head", () => {
	const ask = (f: ReturnType<typeof prototypeFixture>) => () =>
		approve(f.root, 77, { ownerApproval: "Approved for this PR" });
	const c = prototypeFixture({ owningPaths: ["design/"], prototypeApproval: PROTOTYPE_APPROVAL });
	try {
		assert.throws(ask(c), /outside its owning paths or design\/everyfield-ui.html/);
	} finally {
		c.close();
	}
	const d = prototypeFixture({ owningPaths: ["design/everyfield-ui.html"], prototypeApproval: PROTOTYPE_APPROVAL });
	try {
		assert.throws(ask(d), /Missing verifier approval for the exact PR head/);
	} finally {
		d.close();
	}
});

test("AC:OPS-148-7 a design PR may change its own entry file, and no other task's or evf.config.json", () => {
	const d = prototypeFixture({ owningPaths: ["design/everyfield-ui.html"], prototypeApproval: PROTOTYPE_APPROVAL });
	const ask = () => approve(d.root, 77, { ownerApproval: "Approved for this PR" });
	const files = (...paths: string[]) => {
		const s = d.getState();
		s.pr.files = paths.map((path) => ({ path }));
		d.setState(s);
	};
	try {
		const own = `tools/evf/tasks/${d.taskRef.id}.json`;
		files("design/everyfield-ui.html", own);
		assert.throws(ask, /Missing verifier approval for the exact PR head/);
		for (const path of ["tools/evf/tasks/OPS-2.json", "evf.config.json"]) {
			files("design/everyfield-ui.html", own, path);
			assert.throws(ask, new RegExp(`outside its owning paths or design/everyfield-ui.html \\(${path}\\)`));
		}
	} finally {
		d.close();
	}
});

test("INV-prototype-approval: an approval only in the home checkout does not allow the change", () => {
	const f = prototypeFixture({ owningPaths: ["design/everyfield-ui.html"] });
	try {
		writeTask(f.root, f.taskRef.id, {
			...readTask(f.root, f.taskRef.id),
			owningPaths: ["design/everyfield-ui.html"],
			prototypeApproval: PROTOTYPE_APPROVAL,
		});
		assert.throws(() => verify(f.root, f.taskRef, "author", "full"), /keeps its approved bytes/);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
			/outside its owning paths or design\/everyfield-ui.html/,
		);
	} finally {
		f.close();
	}
});

test("INV-prototype-approval: evf ship verifies the approved prototype task and never merges it", () => {
	const f = prototypeFixture({ owningPaths: ["design/everyfield-ui.html"], prototypeApproval: PROTOTYPE_APPROVAL });
	try {
		const s = f.getState();
		s.comments["77"] = [
			{
				body: `Verified the actual tooling behavior.\n\nEVF-Review: ${JSON.stringify({ head: f.head, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
				html_url: "https://github.com/test/private/pull/77#issuecomment-1",
			},
		];
		f.setState(s);
		assert.equal(ship(f.root, f.taskRef), 0);
		const calls = f.getState().calls;
		assert.deepEqual(
			calls.filter((c: any) => c.args[0] === "pr" && c.args[1] === "merge"),
			[],
		);
		assert.ok(
			calls.some(
				(c: any) => c.args.some((a: string) => a.endsWith(`statuses/${f.head}`)) && c.args.includes("state=success"),
			),
		);
	} finally {
		f.close();
	}
});

test("INV-copy-overlap: only WP-103 can bypass unordered ownership for its approved copy change", () => {
	const f = fixture();
	try {
		const path = join(f.root, "docs/plan/dag.json");
		const original = JSON.parse(readFileSync(path, "utf8"));
		const check = (dag: typeof original) => {
			writeFileSync(path, JSON.stringify(dag));
			return spawnSync("python3", ["docs/package-context.py", "--check-plan"], {
				cwd: f.root,
				encoding: "utf8",
			});
		};
		const accepted = check(original);
		assert.equal(accepted.status, 0, accepted.stderr);
		const exception = original.packages.find((p) => p.id === "WP-103").overlap_exempt;
		const second = structuredClone(original);
		second.packages.find((p) => p.id === "WP-005").overlap_exempt = exception;
		const refused = check(second);
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /Only WP-103 may declare the approved copy-only overlap exemption: WP-005/);
		const unapproved = structuredClone(original);
		unapproved.packages.find((p) => p.id === "WP-103").overlap_exempt.kind = "any-change";
		const invalid = check(unapproved);
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /Only WP-103 may declare the approved copy-only overlap exemption: WP-103/);
		const ordinary = structuredClone(original);
		for (const id of ["WP-026", "WP-049"])
			ordinary.packages.find((p) => p.id === id).owning_paths.push("copy-overlap/");
		const overlap = check(ordinary);
		assert.equal(overlap.status, 1);
		assert.match(overlap.stderr, /Unordered owning path overlap: WP-026 and WP-049/);
	} finally {
		f.close();
	}
});

test("INV-plan-progress: explorer renders a newly planned package without writing progress and rejects unknown records", () => {
	const f = fixture();
	const output = f.root + ".html";
	try {
		reconcileProgress(f.root);
		const path = join(f.root, "docs/build-progress.json");
		const progress = JSON.parse(readFileSync(path, "utf8"));
		delete progress.packages["WP-103"];
		const recorded = JSON.stringify(progress);
		writeFileSync(path, recorded);
		const render = () =>
			spawnSync("python3", ["docs/render-build-explorer.py", "--output", output], {
				cwd: f.root,
				encoding: "utf8",
			});
		const planned = render();
		assert.equal(planned.status, 0, planned.stderr);
		const embedded = readFileSync(output, "utf8").match(/id="canonical-progress">(.*?)<\/script>/s)![1];
		const view = JSON.parse(embedded);
		assert.deepEqual(view.packages["WP-103"], {
			status: "not_started",
			evidence: [],
			notes: "New planned package; no canonical progress recorded yet.",
		});
		assert.equal(readFileSync(path, "utf8"), recorded);
		progress.packages["WP-999"] = { status: "done" };
		writeFileSync(path, JSON.stringify(progress));
		const unknown = render();
		assert.equal(unknown.status, 1);
		assert.match(unknown.stderr, /Progress IDs differ from active\/retired DAG IDs/);
	} finally {
		rmSync(output, { force: true });
		f.close();
	}
});

test("OPS-59-ship: a work-store row for the branch does not stop an ordinary PR; a driven task ships only with the sessions evf launched", () => {
	const f = mergeFixture();
	const db = openWorkDb(f.root);
	try {
		const state = f.getState();
		state.pr.headRefName = f.taskRef.branch;
		f.setState(state);
		const t = ensureTask(db, f.taskRef, "implement");
		const insertRun = (stage: string, role: string, session: string | null) =>
			db
				.prepare(
					"INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?, ?, ?, 0, ?, 'passed', ?)",
				)
				.run(t.id, stage, role, session, new Date().toISOString());
		assert.throws(
			() => ship(f.root, f.taskRef),
			/fixture merge barrier/,
			"a task row alone (evf check) changes nothing",
		);
		insertRun("pr", "evf", null);
		assert.throws(() => ship(f.root, f.taskRef), /no implementer session/, "a driven task needs launched sessions");
		insertRun("implement", "implementer", AUTHOR.session);
		insertRun("verify", "verifier", VERIFIER.session);
		assert.throws(() => ship(f.root, f.taskRef), /fixture merge barrier/, "and ships with them");
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-67-ship-ack: the drive's ship stage acknowledges a reviewed milestone, so producerReady is true without shipped --clear", () => {
	const { f, db, task, progressPath, shipped } = wpShipFixture(),
		log = console.log;
	try {
		console.log = () => {};
		assert.equal(driveOnce(f.root, task, DRIVE_TIMING).stage, "done");
		const stage = db.prepare("SELECT status FROM runs WHERE stage = 'ship'").get() as { status: string };
		assert.equal(stage.status, "passed");
		assert.equal(producerReady(f.root, "WP-001"), true, "dependents verify right away");
		assert.equal(shipped().acknowledged, true);
		assert.equal(loadProgress(f.root)["WP-001"].milestones[task.id].acknowledged, true);

		// --clear on a record ship already acknowledged changes nothing.
		const progress = readFileSync(progressPath, "utf8"),
			record = readFileSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`), "utf8");
		listShipped(f.root, [task.id]);
		assert.equal(readFileSync(progressPath, "utf8"), progress);
		assert.equal(readFileSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`), "utf8"), record);

		// --clear still works on an older unacknowledged record.
		const older = shipped();
		delete older.acknowledged;
		writeFileSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`), JSON.stringify(older));
		const canonical = JSON.parse(progress);
		canonical.packages["WP-001"].milestones[task.id].acknowledged = false;
		writeFileSync(progressPath, JSON.stringify(canonical));
		assert.equal(producerReady(f.root, "WP-001"), false);
		listShipped(f.root, [task.id]);
		assert.equal(producerReady(f.root, "WP-001"), true);
		assert.equal(shipped().acknowledged, true);
	} finally {
		console.log = log;
		db.close();
		f.close();
	}
});

test("OPS-67-ship-ack: a record that fails reviewedMilestone stays unacknowledged, ship does not throw and names the task", () => {
	const { f, db, task, shipped } = wpShipFixture("other-bytes"),
		log = console.log,
		lines: string[] = [];
	try {
		console.log = (...a: unknown[]) => lines.push(a.join(" "));
		assert.equal(driveOnce(f.root, task, DRIVE_TIMING).stage, "done");
		const stage = db.prepare("SELECT status FROM runs WHERE stage = 'ship'").get() as { status: string };
		assert.equal(stage.status, "passed", "the merge is done, so the stage does not fail");
		assert.equal(shipped().acknowledged, undefined);
		assert.equal(producerReady(f.root, "WP-001"), false);
		const line = lines.filter((l) => l.startsWith("progress:") && l.includes("WP-001") && l.includes("evf shipped"));
		assert.equal(line.length, 1, lines.join("\n"));
		assert.ok(!lines.some((l) => /shipped --clear WP-001/.test(l)), "ship does not tell the coordinator to clear it");
	} finally {
		console.log = log;
		db.close();
		f.close();
	}
});

test("OPS-67-ship-ack: a WP record with no owning-path diff stays unacknowledged and names the task", () => {
	const { f, db, task, shipped } = wpShipFixture(undefined, "outside-owned-paths/note.txt"),
		log = console.log,
		lines: string[] = [];
	try {
		console.log = (...a: unknown[]) => lines.push(a.join(" "));
		assert.equal(driveOnce(f.root, task, DRIVE_TIMING).stage, "done");
		assert.equal(shipped().acknowledged, undefined);
		assert.equal(producerReady(f.root, "WP-001"), false);
		const line = lines.filter((l) => l.startsWith("progress:") && l.includes("WP-001") && l.includes("evf shipped"));
		assert.equal(line.length, 1, lines.join("\n"));
	} finally {
		console.log = log;
		db.close();
		f.close();
	}
});

// OPS-117: a split package (api and ui parts) that shipped as one whole task counts as its producer milestone.
const quietDrive = (root: string, task: ReturnType<typeof parseTask>) =>
	quiet(() => driveOnce(root, task, DRIVE_TIMING).stage);

const PHASES_API = "packages/domain/src/phases/declare.ts",
	PHASES_UI = "apps/web/src/features/phases/panel.tsx";

test("OPS-117-whole-task: a reviewed, acknowledged whole-task record of a split package unlocks its dependents", () => {
	const { f, db, task, shipped } = wpShipFixture(undefined, PHASES_API, { task: "WP-038", extraFiles: [PHASES_UI] });
	try {
		assert.deepEqual(partsOf(findPackage(loadDag(f.root), "WP-038")), ["api", "ui"]);
		assert.equal(quietDrive(f.root, task), "done");
		assert.equal(shipped().part, null);
		assert.equal(shipped().acknowledged, true);
		assert.equal(existsSync(join(evfDataDir(f.root), "shipped", "wp-038-api.json")), false);
		assert.equal(producerReady(f.root, "WP-038"), true);

		const recordPath = join(evfDataDir(f.root), "shipped", `${task.slug}.json`),
			good = readFileSync(recordPath, "utf8"),
			edit = (change: (r: any) => void) => {
				const r = JSON.parse(good);
				change(r);
				writeFileSync(recordPath, JSON.stringify(r));
			};
		edit((r) => delete r.acknowledged);
		assert.equal(producerReady(f.root, "WP-038"), false, "an unacknowledged whole-task record stays refused");
		edit((r) => (r.verification.approval.verdict = "changes_requested"));
		assert.equal(producerReady(f.root, "WP-038"), false, "a verdict other than approved stays refused");
		edit((r) => (r.merge_commit = "a".repeat(40)));
		assert.equal(producerReady(f.root, "WP-038"), false, "a merge commit off the base branch stays refused");
		rmSync(recordPath);
		assert.equal(producerReady(f.root, "WP-038"), false, "no shipped record stays refused");
		writeFileSync(recordPath, good);
		assert.equal(producerReady(f.root, "WP-038"), true);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-117-whole-task: the ledger keeps a whole-task milestone after a later maintenance-only record", () => {
	const { f, db, task, progressPath, shipped } = wpShipFixture(undefined, PHASES_API, { task: "WP-038" });
	try {
		assert.equal(quietDrive(f.root, task), "done");
		const milestone = loadProgress(f.root)["WP-038"].milestones["WP-038"];
		assert.equal(milestone.acknowledged, true);
		const reviewedMerge = milestone.merge_commit;
		// A later reviewed merge of the same task changes only a path outside the owning paths.
		f.git("push", "-q", "origin", "main");
		const later = f.task(task.slug);
		writeFileSync(join(later, "README.md"), "Later reviewed outside-path fix\n");
		execFileSync("git", ["-C", later, "add", "README.md"]);
		execFileSync("git", ["-C", later, "commit", "-qm", "Later maintenance"]);
		const laterSha = f.git("rev-parse", task.branch),
			state = f.getState();
		state.pr.headRefOid = laterSha;
		state.comments["77"][0].body =
			`EVF-Review: ${JSON.stringify({ head: laterSha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
		f.setState(state);
		assert.equal(
			quiet(() => ship(f.root, task)),
			0,
		);
		assert.notEqual(shipped().merge_commit, reviewedMerge, "the retained record is now the maintenance merge");
		assert.equal(producerReady(f.root, "WP-038"), true, "the ledger milestone still counts");

		const progress = readFileSync(progressPath, "utf8"),
			canonical = JSON.parse(progress);
		canonical.packages["WP-038"].milestones["WP-038"].acknowledged = false;
		writeFileSync(progressPath, JSON.stringify(canonical));
		assert.equal(producerReady(f.root, "WP-038"), false, "an unacknowledged ledger milestone stays refused");
		canonical.packages["WP-038"].milestones["WP-038"] = { ...milestone, merge_commit: "a".repeat(40) };
		writeFileSync(progressPath, JSON.stringify(canonical));
		assert.equal(producerReady(f.root, "WP-038"), false, "an unintegrated ledger milestone stays refused");
		canonical.packages["WP-038"].milestones["WP-038"] = { ...milestone, task: "WP-038/ui" };
		writeFileSync(progressPath, JSON.stringify(canonical));
		assert.equal(producerReady(f.root, "WP-038"), false, "a milestone keyed for another task stays refused");
		writeFileSync(progressPath, progress);
		assert.equal(producerReady(f.root, "WP-038"), true);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-117-whole-task: a whole-task record that changed only ui paths does not unlock dependents", () => {
	const { f, db, task, shipped } = wpShipFixture(undefined, PHASES_UI, { task: "WP-038" });
	try {
		assert.equal(quietDrive(f.root, task), "done");
		assert.equal(shipped().acknowledged, true, "the review itself is valid");
		assert.equal(loadProgress(f.root)["WP-038"].milestones["WP-038"].acknowledged, true);
		assert.equal(producerReady(f.root, "WP-038"), false);
		assert.throws(
			() => requireImplementation(f.root, "WP-026"),
			/Prerequisites need reviewed producer\/interface milestones: [^\n]*WP-038/,
		);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-117-whole-task: a WP-038/api record still unlocks dependents as before", () => {
	const { f, db, task, shipped } = wpShipFixture(undefined, PHASES_API, { task: "WP-038/api" });
	try {
		assert.equal(quietDrive(f.root, task), "done");
		assert.equal(shipped().acknowledged, true);
		assert.equal(producerReady(f.root, "WP-038"), true);
	} finally {
		db.close();
		f.close();
	}
});

const TEMPLATE_ERR = "evf.config.json mergePolicy.documentTemplates";

test("INV-document-templates-config: an absent key uses the built-in default; an empty list and a duplicate path stop loadConfig with the exact line", () => {
	const f = fixture();
	try {
		const load = (edit: (c: any) => void) => {
			const cfg = structuredClone(f.cfg);
			cfg.mergePolicy.documentTemplates = structuredClone(DEFAULT_DOCUMENT_TEMPLATES);
			edit(cfg);
			writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(cfg));
			return () => loadConfig(f.root);
		};
		// The key is optional: an absent key loads and the built-in default in policy.ts applies.
		assert.equal(load((c) => delete c.mergePolicy.documentTemplates)().mergePolicy.documentTemplates, undefined);
		assert.throws(
			load((c) => (c.mergePolicy.documentTemplates = "yes")),
			{ message: `${TEMPLATE_ERR} must be an object with paths, approvedAtUtc, quote and scope.` },
		);
		assert.throws(
			load((c) => (c.mergePolicy.documentTemplates.paths = [])),
			{
				message: `${TEMPLATE_ERR}.paths must be a non-empty list of distinct relative paths with no .. part; got [].`,
			},
		);
		assert.throws(
			load((c) => (c.mergePolicy.documentTemplates.paths = ["a.ts", "a.ts"])),
			{
				message: `${TEMPLATE_ERR}.paths must be a non-empty list of distinct relative paths with no .. part; got ["a.ts","a.ts"].`,
			},
		);
		for (const bad of ["/abs.ts", "docs/../x.ts"])
			assert.throws(
				load((c) => (c.mergePolicy.documentTemplates.paths = [bad])),
				new RegExp(`documentTemplates.paths must be a non-empty list.*${bad.replace(/[./]/g, "\\$&")}`),
			);
		assert.throws(
			load((c) => (c.mergePolicy.documentTemplates.approvedAtUtc = "2026-10-30 11:51 EDT")),
			{ message: `${TEMPLATE_ERR}.approvedAtUtc must be an ISO UTC timestamp; got "2026-10-30 11:51 EDT".` },
		);
		for (const field of ["quote", "scope"])
			assert.throws(
				load((c) => (c.mergePolicy.documentTemplates[field] = " ")),
				{ message: `${TEMPLATE_ERR}.${field} must be a non-empty string.` },
			);
		const real = DEFAULT_DOCUMENT_TEMPLATES;
		assert.equal(real.approvedAtUtc, "2026-10-30T15:51:00Z");
		assert.equal(real.paths.length, 4);
		assert.match(real.quote, /^This looks good - while we develop all the final versions of all the templates/);
	} finally {
		f.close();
	}
});

test("INV-document-templates-policy: the class reads the whole head diff, counts both sides of a rename and matches folders by prefix", () => {
	const f = fixture();
	try {
		f.git("checkout", "-q", "-b", "setup");
		mkdirSync(join(f.root, "packages/domain/src/documents"), { recursive: true });
		writeFileSync(join(f.root, "packages/domain/src/documents/render.ts"), "export {};\n");
		writeFileSync(join(f.root, "packages/domain/src/documents-extra.ts"), "export {};\n");
		f.git("add", "packages");
		f.git("commit", "-qm", "Template code");
		f.git("branch", "-f", "main", "setup");
		f.git("checkout", "-q", "main");
		const cfg = loadConfig(f.root);
		const branch = (name: string, ...commits: Array<(() => void) | string>) => {
			f.git("checkout", "-q", "-b", name, "main");
			for (const c of commits) {
				if (typeof c === "string") {
					mkdirSync(dirname(join(f.root, c)), { recursive: true });
					writeFileSync(join(f.root, c), `${name}\n`);
					f.git("add", c);
				} else c();
				f.git("commit", "-qm", name);
			}
			f.git("checkout", "-q", "main");
			return templateClass(f.root, cfg, f.git("rev-parse", name).trim()).paths;
		};
		// The template change sits in the first commit; later commits touch other files only.
		assert.deepEqual(branch("split", "docs/reference/document-templates.ts", "tools/a.ts", "tools/b.ts"), [
			"docs/reference/document-templates.ts",
		]);
		// A rename out of the folder counts the old path.
		assert.deepEqual(
			branch("renamed", () => f.git("mv", "packages/domain/src/documents/render.ts", "packages/domain/src/render.ts")),
			["packages/domain/src/documents/render.ts"],
		);
		// A rename into the folder counts the new path.
		assert.deepEqual(
			branch("renamed-in", () =>
				f.git("mv", "packages/domain/src/documents-extra.ts", "packages/domain/src/documents/extra.ts"),
			),
			["packages/domain/src/documents/extra.ts"],
		);
		// A sibling that shares the prefix, a file that only ends alike and a nested template path.
		assert.deepEqual(
			branch("sibling", "packages/domain/src/documents-extra.ts", "docs/reference/document-templates.tsx"),
			[],
		);
		assert.deepEqual(branch("nested", "packages/domain/src/documents/deep/x.ts"), [
			"packages/domain/src/documents/deep/x.ts",
		]);
	} finally {
		f.close();
	}
});

test("INV-document-templates-ship: a verified WP part that changes a template is verified, never queued or merged, and names the approve command", () => {
	const { f, db, task } = wpShipFixture();
	try {
		templateConfig(f, ["packages/reference/"]);
		const head = f.getState().pr.headRefOid,
			before = f.getState().calls.length;
		const { value, lines } = capturedLog(() => ship(f.root, task));
		assert.equal(value, 0);
		const calls = f.getState().calls.slice(before);
		assert.deepEqual(
			calls.filter((c: any) => c.args.includes("POST")).map((c: any) => c.args),
			[
				[
					"api",
					"-X",
					"POST",
					`repos/test/private/statuses/${head}`,
					"-f",
					"state=success",
					"-f",
					"context=evf/verify",
					"-f",
					`description=Verified by claude-opus-5-5 (session 22222222) at ${head.slice(0, 10)}`,
				],
			],
		);
		assert.deepEqual(mergeCalls(f), [], "no merge and no update-branch call");
		assert.deepEqual(lines, [
			`evf ship does not merge PR #77: it changes document-template paths (packages/reference/fixture.txt). The verifier passed it. Sebastian approves each document-template PR for its exact head; after his approval in chat, run: bin/evf approve 77 --owner-approval "<his words>" --head ${head}`,
		]);
		assert.equal(existsSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`)), false, "nothing shipped yet");
	} finally {
		db.close();
		f.close();
	}
});

test("INV-document-templates-ship: an OPS task and a P1 fix join the class; more than five paths show five and a count", () => {
	for (const kind of ["ops", "fb"] as const) {
		const f = mergeFixture();
		const log = console.log;
		try {
			let task = f.taskRef,
				wt = f.wt;
			if (kind === "fb") {
				f.authorize("WP-034");
				f.commit();
				f.git("push", "-q", "origin", "main");
				feedbackTriage(f.root, 1, { cls: "p1", reason: "scoped feedback", wp: "WP-034" });
				task = parseTask("FB-1");
				wt = f.task(task.slug);
			}
			const files = Array.from({ length: 7 }, (_, i) => `docs/reference/document-templates.ts${i ? `-${i}` : ""}`);
			templateConfig(f, ["docs/reference/document-templates.ts", ...files.slice(1)]);
			for (const file of files) {
				mkdirSync(dirname(join(wt, file)), { recursive: true });
				writeFileSync(join(wt, file), "x");
			}
			execFileSync("git", ["-C", wt, "add", "docs"]);
			execFileSync("git", ["-C", wt, "commit", "-qm", "Templates"]);
			const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
				state = f.getState();
			state.pr.headRefOid = sha;
			state.comments["77"][0].body =
				`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
			f.setState(state);
			const { value, lines } = capturedLog(() => ship(f.root, task));
			assert.equal(value, 0, kind);
			assert.deepEqual(mergeCalls(f), [], kind);
			assert.equal(callsWith(f, "state=success").length, 1, kind);
			assert.equal(lines.length, 1, kind);
			assert.match(lines[0], /^evf ship does not merge PR #77: it changes document-template paths \(/);
			assert.match(lines[0], / \(7 paths in all\)\. /);
			assert.equal(lines[0].match(/document-templates\.ts/g)!.length, 5, "five paths show");
		} finally {
			console.log = log;
			f.close();
		}
	}
});

test("INV-document-templates-ship: a template PR without an independent review fails like any PR and posts no status", () => {
	const { f, db, task } = wpShipFixture();
	try {
		templateConfig(f, ["packages/reference/"]);
		const state = f.getState();
		state.comments["77"] = [];
		state.calls = [];
		f.setState(state);
		assert.throws(() => ship(f.root, task), { message: "Missing verifier approval for the exact PR head." });
		assert.deepEqual(callsWith(f, "POST"), []);
		assert.deepEqual(mergeCalls(f), []);
	} finally {
		db.close();
		f.close();
	}
});

test("INV-document-templates-unchanged: an ordinary WP part still merges through the queue and evf approve still refuses it", () => {
	const { f, db, task } = wpShipFixture();
	try {
		const head = f.getState().pr.headRefOid;
		approvable(f as any, task.branch, ["packages/reference/fixture.txt"], head);
		const s = f.getState();
		s.calls = [];
		f.setState(s);
		assert.throws(
			() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }),
			/cannot merge it.*bin\/evf ship/,
		);
		assert.deepEqual(approveWrites(f), []);
		assert.equal(capturedLog(() => ship(f.root, task)).value, 0);
		const merge = callsWith(f, "pr", "merge");
		assert.equal(merge.length, 1);
		assert.deepEqual(merge[0].args, ["pr", "merge", "77", "--squash", "--match-head-commit", head]);
	} finally {
		db.close();
		f.close();
	}
});

/** Commit one file in the task worktree and point the fixture PR and its review at the new head. */
function templateHead(f: ReturnType<typeof mergeFixture>, wt: string, file: string): string {
	mkdirSync(dirname(join(wt, file)), { recursive: true });
	writeFileSync(join(wt, file), "x");
	execFileSync("git", ["-C", wt, "add", file]);
	execFileSync("git", ["-C", wt, "commit", "-qm", "Template"]);
	const sha = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		state = f.getState();
	state.pr.headRefOid = sha;
	state.comments["77"][0].body =
		`EVF-Review: ${JSON.stringify({ head: sha, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`;
	f.setState(state);
	return sha;
}

test("INV-document-templates-unchanged: a P2 fix that touches a template keeps its owner route and its approve behavior", () => {
	const f = mergeFixture();
	try {
		f.authorize("WP-034");
		f.commit();
		f.git("push", "-q", "origin", "main");
		feedbackTriage(f.root, 1, { cls: "p2", reason: "scoped feedback", wp: "WP-034" });
		const task = parseTask("FB-1"),
			sha = templateHead(f, f.task(task.slug), "docs/reference/document-templates.ts");
		const { value, lines } = capturedLog(() => ship(f.root, task));
		assert.equal(value, 0);
		assert.deepEqual(lines, ["PR #77 is verified and waits for Sebastian's chat approval, then evf approve."]);
		assert.deepEqual(mergeCalls(f), []);
		// evf approve keeps the verified route for P2: no after-merge steps, no shipped record.
		approvable(f, task.branch, ["docs/reference/document-templates.ts"], sha);
		const s = f.getState();
		s.commitStatus = verifiedStatus(sha);
		f.setState(s);
		assert.throws(() => approve(f.root, 77, { ownerApproval: "Approved for this PR" }), /fixture merge barrier/);
		assert.equal(existsSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`)), false);
	} finally {
		f.close();
	}
});

test("INV-document-templates-unchanged: a design task that touches a template keeps the design route", () => {
	const f = mergeFixture({ owningPaths: ["design/"], route: "design" });
	try {
		const sha = templateHead(f, f.wt, "docs/reference/document-templates.ts");
		const { value, lines } = capturedLog(() => ship(f.root, f.taskRef));
		assert.equal(value, 0);
		assert.deepEqual(lines, [
			"PR #77 is a verified design task and waits for Sebastian's chat approval, then evf approve.",
		]);
		assert.deepEqual(mergeCalls(f), []);
		assert.equal(callsWith(f, "state=success").length, 1);
		void sha;
	} finally {
		f.close();
	}
});

test("INV-document-templates-approve: refuses before any write without an approved review or the verified status, naming evf ship", () => {
	const { f, db, task } = wpShipFixture();
	try {
		templateConfig(f, ["packages/reference/"]);
		const head = f.getState().pr.headRefOid;
		approvable(f as any, task.branch, ["packages/reference/fixture.txt"], head);
		const ask = () => approve(f.root, 77, { ownerApproval: "Approved for this PR", head });
		// No verified status yet.
		let s = f.getState();
		s.calls = [];
		f.setState(s);
		assert.throws(ask, {
			message: `PR #77 needs the verifier to pass it first (bin/evf ship WP-001) at ${head.slice(0, 10)}; a branch update needs a fresh verification.`,
		});
		assert.deepEqual(approveWrites(f), []);
		// No review of the exact head.
		s = f.getState();
		s.comments["77"] = [];
		s.commitStatus = verifiedStatus(head);
		s.calls = [];
		f.setState(s);
		assert.throws(ask, {
			message: `PR #77 changes document templates and needs the verifier to pass it first (bin/evf ship WP-001) at ${head.slice(0, 10)}: Missing verifier approval for the exact PR head.`,
		});
		assert.deepEqual(approveWrites(f), []);
	} finally {
		db.close();
		f.close();
	}
});

test("INV-document-templates-approve: with review and verified status it records his words, merges that head and runs the after-merge steps", () => {
	const { f, db, task, shipped, progressPath } = wpShipFixture();
	try {
		templateConfig(f, ["packages/reference/"]);
		const head = f.getState().pr.headRefOid,
			wt = join(f.root, ".worktrees", task.slug);
		approvable(f as any, task.branch, ["packages/reference/fixture.txt"], head);
		const s = f.getState();
		s.commitStatus = verifiedStatus(head);
		s.calls = [];
		f.setState(s);
		const words = "Approved: the invoice template looks right";
		const { value } = capturedLog(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head })));
		assert.equal(value, 0);
		const comment = callsWith(f, "pr", "comment")[0];
		assert.match(
			comment.body,
			new RegExp(
				`^Approved by Sebastian at \`${head.slice(0, 10)}\`:\\n\\n> ${words}\\n\\nEVF-Owner: \\{"head":"${head}","quote":"${words}","at":"[^"]+"\\}$`,
			),
		);
		const status = callsWith(f, "POST", `repos/test/private/statuses/${head}`);
		assert.deepEqual(status.at(-1).args.slice(-2), ["-f", `description=Approved by Sebastian at ${head.slice(0, 10)}`]);
		assert.deepEqual(callsWith(f, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			head,
		]);
		// The shipped record is the one evf ship writes, plus his approval.
		const record = shipped();
		assert.deepEqual(Object.keys(record).sort(), [
			"acknowledged",
			"base_sha",
			"evidence",
			"merge_commit",
			"owner_approval",
			"package_completion",
			"package_id",
			"part",
			"pr",
			"shipped_at",
			"task",
			"verification",
			"verified_head",
		]);
		assert.equal(record.task, "WP-001");
		assert.equal(record.package_id, "WP-001");
		assert.equal(record.pr, 77);
		assert.equal(record.verified_head, head);
		assert.equal(record.verification.head, head);
		assert.deepEqual(record.verification.approval.verifier, VERIFIER);
		assert.equal(record.evidence.test, "GitHub required CI and claude-opus-5-5 (session 22222222) approval");
		assert.equal(
			record.evidence.note,
			`WP-001 merged in PR #77 after independent verification at ${head.slice(0, 10)}. https://github.com/test/private/pull/77#issuecomment-1`,
		);
		assert.deepEqual(record.owner_approval, {
			quote: words,
			approved_head: head,
			approved_at: record.owner_approval.approved_at,
		});
		assert.ok(Number.isFinite(Date.parse(record.owner_approval.approved_at)));
		assert.equal(record.acknowledged, true);
		assert.equal(loadProgress(f.root)["WP-001"].milestones[task.id].acknowledged, true);
		assert.equal(producerReady(f.root, "WP-001"), true, "dependents unlock");
		const row = db.prepare("SELECT status, merge_commit FROM tasks WHERE ref = ?").get(task.id) as {
			status: string;
			merge_commit: string;
		};
		assert.equal(row.status, "merged");
		assert.equal(row.merge_commit, f.git("rev-parse", "HEAD"));
		assert.equal(existsSync(wt), false, "the task worktree is gone");
		void progressPath;
	} finally {
		db.close();
		f.close();
	}
});

test("INV-document-templates-drive-failed-ship: a failed ship on an ordinary PR still moves to a new implement round", () => {
	const { f, db, task } = wpShipFixture();
	const log = console.log;
	try {
		console.log = () => {};
		// No approved independent review comment exists, so ship fails as it did before OPS-80.
		const state = f.getState();
		state.comments["77"][0].body = "No review yet";
		f.setState(state);
		const out = driveOnce(f.root, task, DRIVE_TIMING);
		assert.notEqual(out.stage, "done");
		assert.doesNotMatch(out.reason, /waits for Sebastian/);
		const id = (db.prepare("SELECT id FROM tasks WHERE ref = ?").get(task.id) as { id: number }).id;
		assert.equal(db.prepare("SELECT status FROM runs WHERE task_id = ? AND stage = 'ship'").get(id)!.status, "failed");
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'owner_approval_wait'").get(id)!.n,
			0,
		);
	} finally {
		console.log = log;
		db.close();
		f.close();
	}
});

test("INV-document-templates-drive: the drive stops at a verified template PR without a merge and records the merge on the next pass", () => {
	const { f, db, task } = wpShipFixture();
	const log = console.log;
	try {
		templateConfig(f, ["packages/reference/"]);
		writeFileSync(
			join(f.root, "fake-bin/herdr"),
			`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(join(f.root, "herdr-calls.jsonl"))},JSON.stringify(process.argv.slice(2))+"\\n");process.stdout.write("{}");\n`,
		);
		chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
		console.log = () => {};
		const id = (db.prepare("SELECT id FROM tasks WHERE ref = ?").get(task.id) as { id: number }).id;
		const rounds = () => (db.prepare("SELECT round FROM tasks WHERE id = ?").get(id) as { round: number }).round;
		const first = driveOnce(f.root, task, DRIVE_TIMING);
		assert.equal(first.stage, "done");
		assert.match(first.reason, /^PR #77 waits for Sebastian's approval$/);
		const row = () => db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string };
		assert.notEqual(row().status, "merged");
		assert.equal(rounds(), 0, "no new implement round");
		assert.deepEqual(mergeCalls(f), []);
		const waits = db
			.prepare("SELECT payload FROM events WHERE task_id = ? AND type = 'owner_approval_wait'")
			.all(id) as Array<{ payload: string }>;
		assert.equal(waits.length, 1);
		assert.match(JSON.parse(waits[0].payload).summary, /PR #77 .*bin\/evf approve 77 --owner-approval "<his words>"/);
		const notes = readFileSync(join(f.root, "herdr-calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		assert.equal(notes.filter((c: string[]) => c[0] === "notification").length, 1);
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'merged'").get(id)!.n, 0);

		// Sebastian approves; GitHub shows the PR merged. The next pass records it and runs no ship.
		const s = f.getState();
		s.pr.state = "MERGED";
		s.pr.mergeCommit = { oid: "c".repeat(40) };
		s.calls = [];
		f.setState(s);
		const second = driveOnce(f.root, task, DRIVE_TIMING);
		assert.equal(second.stage, "done");
		assert.equal(row().status, "merged");
		assert.deepEqual(
			{ ...(db.prepare("SELECT merge_commit FROM tasks WHERE id = ?").get(id) as object) },
			{
				merge_commit: "c".repeat(40),
			},
		);
		assert.deepEqual(callsWith(f, "POST"), [], "ship did not run again");
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'ship'").get(id)!.n, 1);
	} finally {
		console.log = log;
		db.close();
		f.close();
	}
});

// OPS-123: a drive stays on the row it pinned, ends by itself at the merge and never starts the slice the merge releases.
/** A Herdr that logs each call and answers `{}`, so a launch would show as an `agent start` or `workspace` call. */
const loggingHerdr = (f: { root: string }) => {
	const log = join(f.root, "herdr-calls.jsonl");
	writeFileSync(
		join(f.root, "fake-bin/herdr"),
		`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+"\\n");process.stdout.write("{}");\n`,
	);
	chmodSync(join(f.root, "fake-bin/herdr"), 0o755);
	return () =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l) as string[])
			: [];
};

/** File one later slice of the WP task as a queued row with the same ref, as storing its spec does (OPS-86). */
const queuedSlice = (db: ReturnType<typeof openWorkDb>, task: { id: string }) => {
	const parent = db.prepare("SELECT id, ref, ask, goal_id FROM tasks WHERE ref = ?").get(task.id) as {
		id: number;
		ref: string;
		ask: string;
		goal_id: number | null;
	};
	const spec = "Goal: g.\nDone criteria:\n1. One.\nNon-goals: none.\n\n## Later slices\n\n1. The second slice.";
	db.prepare("UPDATE tasks SET spec = ? WHERE id = ?").run(spec, parent.id);
	fileFollowUps(db, parent, spec, []);
	return {
		parent: parent.id,
		slice: (db.prepare("SELECT id FROM tasks WHERE parent_task_id = ?").get(parent.id) as { id: number }).id,
	};
};

const tasksTable = (db: ReturnType<typeof openWorkDb>) =>
	(db.prepare("SELECT * FROM tasks ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));

test("OPS-123-ship AC:OPS-123-1: the drive merges its own row in its ship stage and starts no seat on the WP slice the merge releases", () => {
	const { f, db, task } = wpShipFixture();
	try {
		const herdr = loggingHerdr(f);
		const { parent, slice } = queuedSlice(db, task);
		// The slice is a follow-up, so the PR body opens with the Partial: line the body standard asks for.
		const s = f.getState();
		s.pr.body = s.pr.body.replace(
			"## Summary\n",
			"## Summary\n\nPartial: this PR covers only part of the ask. Deferred: The second slice. (WP-001 slice 2).\n",
		);
		f.setState(s);
		const { value: code, lines } = capturedLog(() => drive(f.root, task, {}, DRIVE_TIMING));
		assert.equal(code, 0, lines.join("\n"));
		const merge = f.git("rev-parse", "HEAD");
		const rows = db.prepare("SELECT id, status, merge_commit FROM tasks WHERE ref = ? ORDER BY id").all(task.id);
		assert.deepEqual(
			rows.map((r) => ({ ...r })),
			[
				{ id: parent, status: "merged", merge_commit: merge },
				{ id: slice, status: "new", merge_commit: null },
			],
			"the drive's row merged; the merge released the slice",
		);
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'merged'").get(parent)!.n,
			1,
		);
		assert.ok(
			lines.some((l) => l.includes(`drive ${task.id}: done (merged as ${merge})`)),
			lines.join("\n"),
		);
		assert.ok(!lines.some((l) => /waits for Sebastian's approval/.test(l)), lines.join("\n"));
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(slice)!.n,
			0,
			"no run on the slice",
		);
		assert.deepEqual(
			herdr().filter((c) => c[0] === "workspace" || c[0] === "pane" || (c[0] === "agent" && c[1] === "start")),
			[],
			"no seat launched",
		);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-123-owner AC:OPS-123-8: an owner-route ship stops the drive at the wait with the PR open; after evf approve a fresh drive ends merged", () => {
	const { f, db, task } = wpShipFixture();
	try {
		templateConfig(f, ["packages/reference/"]);
		loggingHerdr(f);
		const id = (db.prepare("SELECT id FROM tasks WHERE ref = ?").get(task.id) as { id: number }).id;
		const first = capturedLog(() => drive(f.root, task, {}, DRIVE_TIMING));
		assert.equal(first.value, 0, first.lines.join("\n"));
		assert.ok(
			first.lines.some((l) => /drive WP-001: done \(PR #77 waits for Sebastian's approval\)/.test(l)),
			first.lines.join("\n"),
		);
		assert.notEqual(
			(db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status,
			"merged",
		);
		assert.deepEqual(mergeCalls(f), [], "the PR stays open");
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'owner_approval_wait'").get(id)!.n,
			1,
		);
		// Sebastian approves: evf approve merges and records it by branch. A fresh drive then ends at the merge.
		const commit = "c".repeat(40);
		markMergedByBranch(f.root, task.branch, commit);
		const rows = tasksTable(db);
		const second = capturedLog(() => drive(f.root, task, {}, DRIVE_TIMING));
		assert.equal(second.value, 0, second.lines.join("\n"));
		assert.ok(
			second.lines.some((l) => l.includes(`drive WP-001: done (merged as ${commit})`)),
			second.lines.join("\n"),
		);
		assert.deepEqual(tasksTable(db), rows, "no row inserted or changed");
		assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = 'ship'").get(id)!.n, 1);
	} finally {
		db.close();
		f.close();
	}
});

const WHOLE_SPEC =
	"Goal: a reference bundle.\nDone criteria:\n1. The bundle exists.\nCheck: owner — a reader judges the bundle\nNon-goals: none.";

/**
 * A whole `evf drive WP-001` process from plan to its end, with no --once and no outside kill. Fake seats close their
 * stages on `herdr agent wait`: the planner stores `spec`, the implementer commits a file and a proof (the first one
 * under the PR body's author session), the verifier posts the exact-head review under its own session. `refuseMerges` makes that many
 * `gh pr merge` calls fail first. Returns the process result and the drive's row id.
 */
function wholeDrive(fx: ReturnType<typeof wpShipFixture>, opts: { spec: string; body: string; refuseMerges?: number }) {
	const { f, db, task } = fx;
	const id = (db.prepare("SELECT id FROM tasks WHERE ref = ?").get(task.id) as { id: number }).id;
	db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
	db.prepare(
		"UPDATE tasks SET spec = NULL, status = 'new', pr_number = NULL, title = 'Reference bundle', ask = 'Build the reference bundle.' WHERE id = ?",
	).run(id);
	mkdirSync(runtimeDir(f.root, task), { recursive: true });
	writeFileSync(join(runtimeDir(f.root, task), "pr-body.md"), opts.body);
	const dir = join(f.root, "fake-bin"),
		wt = join(f.root, ".worktrees", task.slug),
		spec = join(dir, "spec.md"),
		summary = join(dir, "summary.md"),
		calls = join(f.root, "herdr-calls.json"),
		refused = join(dir, "merges-refused");
	writeFileSync(spec, opts.spec);
	writeFileSync(summary, "Done.");
	writeFileSync(calls, "[]");
	writeFileSync(refused, "0");
	const review = JSON.stringify({ verdict: "approved", quality: approvedQuality, experience: approvedExperience });
	const seat = `const seat=(name)=>{const m=/^(planner|implementer|simplifier|verifier)-${task.slug}-(\\d+)$/.exec(name);if(!m)return;
const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(workDbPath(f.root))});d.exec("PRAGMA busy_timeout = 5000");
const open=d.prepare("SELECT 1 FROM runs WHERE id = ? AND status = 'started'").get(Number(m[2]));
const author=${JSON.stringify(AUTHOR.session)},own=open&&d.prepare("SELECT session_id FROM runs WHERE id = ?").get(Number(m[2])).session_id;
if(open&&m[1]==="implementer"&&!d.prepare("SELECT 1 FROM runs WHERE session_id = ?").get(author))d.prepare("UPDATE runs SET session_id = ? WHERE id = ?").run(author,Number(m[2]));d.close();if(!open)return;
const cp=require("node:child_process"),wt=${JSON.stringify(wt)};
const evf=(...x)=>cp.spawnSync(process.execPath,[${JSON.stringify(join(source, "tools/evf/main.ts"))},...x],{cwd:${JSON.stringify(f.root)},encoding:"utf8",env:{...process.env,EVF_RUN:"",EVF_WORKTREE:"",EVF_STAGE:"",EVF_SESSION:"",EVF_ROLE:""}});
if(m[1]==="planner")evf("task","spec",${JSON.stringify(task.id)},"--file",${JSON.stringify(spec)});
if(m[1]==="implementer"){fs.writeFileSync(wt+"/packages/reference/round-"+m[2]+".txt","x");cp.spawnSync("git",["-C",wt,"add","packages/reference"]);cp.spawnSync("git",["-C",wt,"commit","-qm","round "+m[2]]);evf("proof","add",${JSON.stringify(task.id)},"--criterion","1","--status","met","--evidence","shot.png")}
if(m[1]==="verifier"){const head=cp.execFileSync("git",["-C",wt,"rev-parse","HEAD"],{encoding:"utf8"}).trim();const p=process.env.EVF_FAKE_GH_STATE,s=JSON.parse(fs.readFileSync(p,"utf8"));s.pr.headRefOid=head;s.comments["77"]=[{body:"Verified.\\n\\nEVF-Review: "+JSON.stringify(Object.assign({head},${review},{verifier:Object.assign({},${JSON.stringify(VERIFIER)},{session:own})})),html_url:"https://github.com/test/private/pull/77#issuecomment-1"}];fs.writeFileSync(p,JSON.stringify(s))}
const r=evf("run","done",m[2],"--status","passed","--summary-file",${JSON.stringify(summary)});fs.appendFileSync(${JSON.stringify(join(dir, "seats.log"))},name+" "+r.status+" "+r.stdout+r.stderr+"\\n")};\n`;
	writeFileSync(
		join(dir, "herdr"),
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);const st={};\n` +
			`const calls=JSON.parse(fs.readFileSync(${JSON.stringify(calls)},"utf8"));calls.push(a);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));\n` +
			seat +
			sessionStartJs(workDbPath(f.root)) +
			`let r={};if(a[0]==="workspace"&&a[1]==="create")r={workspace:"w9",tab:"w9:t1",root_pane:{pane_id:"w9:p1"}};\n` +
			`else if(a[0]==="pane"&&a[1]==="process-info")r={process_info:{shell_pid:7,foreground_process_group_id:7}};\n` +
			`else if(a[0]==="agent"&&a[1]==="wait"){try{seat(a[2])}catch(e){fs.appendFileSync(${JSON.stringify(join(dir, "seats.log"))},String(e.stack)+"\\n")}r={agent:{agent_status:"idle"}}}\n` +
			`else if(a[0]==="agent"&&a[1]==="get")r={agent:{agent_session:{value:"55555555-5555-4555-8555-555555555555"},agent_status:calls.some(c=>c[0]==="agent"&&c[1]==="prompt"&&c[2]===a[2])?"working":"idle"}};\n` +
			`process.stdout.write(JSON.stringify({result:r}));\n`,
	);
	chmodSync(join(dir, "herdr"), 0o755);
	// GitHub refuses the first `refuseMerges` merges; every other call goes to the fixture's fake gh.
	const gh = join(dir, "gh"),
		base = join(dir, "gh-base");
	writeFileSync(base, readFileSync(gh));
	chmodSync(base, 0o755);
	writeFileSync(
		gh,
		`#!${process.execPath}\nconst fs=require("node:fs"),a=process.argv.slice(2),n=Number(fs.readFileSync(${JSON.stringify(refused)},"utf8"));` +
			`if(a[0]==="pr"&&a[1]==="merge"&&n<${opts.refuseMerges ?? 0}){fs.writeFileSync(${JSON.stringify(refused)},String(n+1));process.stderr.write("fixture: GitHub refused the merge");process.exit(1)}` +
			`const r=require("node:child_process").spawnSync(${JSON.stringify(base)},a,{stdio:"inherit"});process.exit(r.status??1);\n`,
	);
	chmodSync(gh, 0o755);
	const r = spawnSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", join(source, "tools/evf/main.ts"), "drive", task.id],
		{
			cwd: f.root,
			encoding: "utf8",
			timeout: 300_000,
			env: { ...process.env, EVF_RUN: "", EVF_WORKTREE: "", EVF_SESSION: "", EVF_ROLE: "", EVF_STAGE: "" },
		},
	);
	const seats = existsSync(join(dir, "seats.log")) ? readFileSync(join(dir, "seats.log"), "utf8") : "";
	const events = (
		db.prepare("SELECT type, payload FROM events WHERE task_id = ? ORDER BY id").all(id) as Array<{
			type: string;
			payload: string;
		}>
	).map((e) => `${e.type} ${String(JSON.parse(e.payload).summary ?? "").slice(0, 300)}`);
	return { ...r, id, log: [r.stdout, r.stderr, seats, ...events].join("\n") };
}

const runsOfRow = (db: ReturnType<typeof openWorkDb>, id: number) =>
	(
		db.prepare("SELECT stage, status, round FROM runs WHERE task_id = ? ORDER BY id").all(id) as Array<{
			stage: string;
			status: string;
			round: number;
		}>
	).map((r) => `${r.stage}:${r.status}:${r.round}`);

test("OPS-123-whole AC:OPS-123-9: a whole drive whose ship fails once runs a second round, merges and exits 0 by itself; the released slice stays new", () => {
	const fx = wpShipFixture(),
		{ f, db, task } = fx;
	try {
		const body = validPrBody().replace(
			"## Summary\n",
			"## Summary\nPartial: this PR covers only part of the ask. Deferred: The second slice. (WP-001 slice 2).\n",
		);
		const r = wholeDrive(fx, {
			spec: `${WHOLE_SPEC}\n\n## Later slices\n\n1. The second slice.`,
			body,
			refuseMerges: 1,
		});
		assert.equal(r.status, 0, r.log);
		const merge = f.git("rev-parse", "HEAD");
		assert.match(r.stdout, new RegExp(`drive WP-001: done \\(merged as ${merge}\\)`), r.log);
		assert.deepEqual(
			runsOfRow(db, r.id),
			[
				"plan:passed:0",
				"implement:passed:0",
				"simplify:passed:0",
				"pr:passed:0",
				"verify:passed:0",
				"ci:passed:0",
				"ship:failed:0",
				"implement:passed:1",
				"simplify:passed:1",
				"pr:passed:1",
				"verify:passed:1",
				"ci:passed:1",
				"ship:passed:1",
			],
			r.log,
		);
		const slice = db.prepare("SELECT id, status FROM tasks WHERE ref = ? AND id <> ?").all(task.id, r.id) as Array<{
			id: number;
			status: string;
		}>;
		assert.deepEqual(
			slice.map((s) => s.status),
			["new"],
			"the merge released the slice",
		);
		assert.equal(
			db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(slice[0]!.id)!.n,
			0,
			"never started",
		);
		assert.equal(
			(db.prepare("SELECT status FROM tasks WHERE id = ?").get(r.id) as { status: string }).status,
			"merged",
		);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-123-whole AC:OPS-123-9: a whole drive whose ship is an owner route exits 0 by itself at the wait", () => {
	const fx = wpShipFixture(),
		{ f, db } = fx;
	try {
		templateConfig(f, ["packages/reference/"]);
		execFileSync("git", ["-C", join(f.root, ".worktrees", fx.task.slug), "merge", "-q", "--no-edit", "main"]);
		const r = wholeDrive(fx, { spec: WHOLE_SPEC, body: validPrBody() });
		assert.equal(r.status, 0, r.log);
		assert.match(r.stdout, /drive WP-001: done \(PR #77 waits for Sebastian's approval\)/, r.log);
		assert.deepEqual(
			runsOfRow(db, r.id),
			[
				"plan:passed:0",
				"implement:passed:0",
				"simplify:passed:0",
				"pr:passed:0",
				"verify:passed:0",
				"ci:passed:0",
				"ship:passed:0",
			],
			r.log,
		);
		assert.notEqual(
			(db.prepare("SELECT status FROM tasks WHERE id = ?").get(r.id) as { status: string }).status,
			"merged",
		);
		assert.deepEqual(mergeCalls(f), [], "the PR stays open");
	} finally {
		db.close();
		f.close();
	}
});

const PR375_CLASS = [
	"packages/domain/src/documents/templates/registry.ts",
	"packages/domain/src/documents/templates/layouts/invoice.tsx",
	"packages/domain/src/documents/templates/fonts/Inter-Regular.ttf",
	"packages/domain/src/documents/theme.ts",
	"docs/catalog/document-templates.json",
];

test("OPS-83-choke-point: only merge.ts calls gh pr merge or the GitHub merge API", () => {
	const dir = resolve(import.meta.dirname, "..");
	const merging = [
		/["']pr["']\s*,\s*["']merge["']/,
		/gh\s+pr\s+merge/,
		/\/pulls\/[^"'`\s]*\/merge/,
		/["'`]\/merge["'`]/,
	];
	const files = (readdirSync(dir, { recursive: true }) as string[]).filter(
		(n) => n.endsWith(".ts") && !/(^|[\\/])(tests|node_modules)([\\/]|$)/.test(n),
	);
	assert.ok(files.includes("merge.ts") && files.includes("ship.ts") && files.includes("approve.ts"));
	const offenders = files.filter((name) => {
		const code = readFileSync(join(dir, name), "utf8")
			.split("\n")
			.filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
			.join("\n");
		return merging.some((re) => re.test(code));
	});
	assert.deepEqual(offenders, ["merge.ts"]);
});

test("OPS-83-375-ship: a WP-036/api-shaped PR with approved review and green CI is verified and held, never merged", () => {
	const { f, db, task } = pr375();
	try {
		const head = f.getState().pr.headRefOid;
		assert.equal(task.id, "WP-036/api");
		const { value, lines } = capturedLog(() => ship(f.root, task));
		assert.equal(value, 0);
		assert.deepEqual(mergeCalls(f), []);
		assert.equal(callsWith(f, "pr", "merge").length, 0);
		assert.equal(callsWith(f, "POST", `repos/test/private/statuses/${head}`).length, 1, "the verified status");
		assert.equal(lines.length, 1);
		for (const path of PR375_CLASS) assert.match(lines[0], new RegExp(path.replace(/[.]/g, "\\.")));
		assert.match(lines[0], /bin\/evf approve 77 --owner-approval "<his words>"/);
		assert.equal(existsSync(join(evfDataDir(f.root), "shipped", `${task.slug}.json`)), false);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-83-375-approve: his recorded words merge that exact head through the choke point; another head refuses", () => {
	const { f, db, task, shipped } = pr375();
	try {
		const head = f.getState().pr.headRefOid;
		approvable(f as any, task.branch, PR375_FILES, head);
		const s = f.getState();
		s.commitStatus = verifiedStatus(head);
		s.calls = [];
		f.setState(s);
		const words = "Approved: the eleven templates look right";
		for (const wrong of ["deadbee", head.slice(0, 7).replace(/^./, head[0] === "0" ? "1" : "0")])
			assert.throws(
				() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head: wrong })),
				/His approval does not carry over/,
			);
		assert.deepEqual(callsWith(f, "pr", "merge"), []);
		capturedLog(() => inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: words, head })));
		assert.deepEqual(callsWith(f, "pr", "merge")[0].args, [
			"pr",
			"merge",
			"77",
			"--squash",
			"--match-head-commit",
			head,
		]);
		const record = shipped();
		assert.equal(record.owner_approval.quote, words);
		assert.equal(record.owner_approval.approved_head, head);
		assert.equal(record.pr, 77);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-83-375-approve: ship holds and approve releases from one class, even when the home config differs from the base", () => {
	const { f, db, task, shipped } = pr375();
	try {
		const head = f.getState().pr.headRefOid;
		// The home checkout's uncommitted config narrows the list; the base branch keeps the default.
		f.cfg.mergePolicy.documentTemplates = { ...structuredClone(DEFAULT_DOCUMENT_TEMPLATES), paths: ["nothing/"] };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		const { lines } = capturedLog(() => ship(f.root, task));
		assert.match(lines[0], /bin\/evf approve 77 --owner-approval/);
		approvable(f as any, task.branch, PR375_FILES, head);
		const s = f.getState();
		s.commitStatus = verifiedStatus(head);
		s.calls = [];
		f.setState(s);
		capturedLog(() =>
			inFakeCwd(f, () => approve(f.root, 77, { ownerApproval: "Approved: these templates look right", head })),
		);
		assert.equal(callsWith(f, "pr", "merge").length, 1);
		assert.equal(shipped().owner_approval.approved_head, head);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-83-choke-point: the class is decided on the sha passed to the merge, from the base config, and needs his words for that head", () => {
	const { f, db, task } = pr375();
	try {
		const wt = join(f.root, ".worktrees", task.slug),
			sha = f.getState().pr.headRefOid;
		// The home checkout's own config (uncommitted) cannot narrow the class, and the loaded cfg carries the narrowed list.
		f.cfg.mergePolicy.documentTemplates = { ...structuredClone(DEFAULT_DOCUMENT_TEMPLATES), paths: ["nothing/"] };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		const cfg = loadConfig(f.root);
		assert.deepEqual(cfg.mergePolicy.documentTemplates?.paths, ["nothing/"]);
		const merge = (ownerApproval?: { quote: string; approved_head: string }) =>
			mergePullRequest({ root: f.root, cfg, cwd: wt, number: 77, sha, ownerApproval });
		assert.throws(
			() => merge(),
			(e: Error) =>
				e.message.includes("packages/domain/src/documents/templates/registry.ts") &&
				e.message.includes('bin/evf approve 77 --owner-approval "<his words>"'),
		);
		assert.throws(() => merge({ quote: "Approved", approved_head: sha }), /does not merge PR #77/);
		assert.throws(
			() => merge({ quote: "Approved: looks right", approved_head: "a".repeat(40) }),
			/does not carry over/,
		);
		assert.deepEqual(callsWith(f, "pr", "merge"), []);
		assert.equal(merge({ quote: "Approved: looks right", approved_head: sha }).code, 0);
		assert.equal(callsWith(f, "pr", "merge").length, 1);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-83-fail-closed: a class that cannot be computed holds the PR and says why", () => {
	const cases: Array<[string, (f: ReturnType<typeof mergeFixture>, sha: string) => string, RegExp]> = [
		["a missing head commit", () => "f".repeat(40), /is not in the repository/],
		["an empty head", () => "", /not a full commit sha/],
		[
			"no merge base",
			(f) => f.git("commit-tree", "HEAD^{tree}", "-m", "orphan"),
			/git merge-base origin\/main .* failed/,
		],
		[
			"a failed diff",
			(f, sha) => {
				// The commit and its parents exist, so cat-file and merge-base succeed; the tree object is gone.
				const tree = f.git("rev-parse", `${sha}^{tree}`);
				rmSync(join(f.root, ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });
				return sha;
			},
			/git diff to .* failed/,
		],
		[
			"an unreadable base config",
			(f, sha) => {
				writeFileSync(join(f.root, "evf.config.json"), "{ not json");
				f.git("commit", "-qam", "Break config");
				f.git("push", "-q", "origin", "main");
				return sha;
			},
			/origin\/main evf\.config\.json is unreadable/,
		],
	];
	for (const [name, setup, why] of cases) {
		const { f, db, task } = wpShipFixture();
		try {
			const cfg = loadConfig(f.root),
				wt = join(f.root, ".worktrees", task.slug),
				sha = setup(f, f.getState().pr.headRefOid);
			assert.throws(
				() => mergePullRequest({ root: f.root, cfg, cwd: wt, number: 77, sha }),
				(e: Error) =>
					/cannot tell whether it changes document templates/.test(e.message) &&
					why.test(e.message) &&
					e.message.includes('bin/evf approve 77 --owner-approval "<his words>"'),
				name,
			);
			assert.deepEqual(callsWith(f, "pr", "merge"), [], name);
		} finally {
			db.close();
			f.close();
		}
	}
});

test("OPS-83-fail-closed: a failed fetch refuses the merge and counts as the class", () => {
	const { f, db, task } = wpShipFixture();
	try {
		const cfg = loadConfig(f.root),
			wt = join(f.root, ".worktrees", task.slug),
			sha = f.getState().pr.headRefOid;
		f.git("remote", "set-url", "origin", "/nonexistent/origin.git");
		assert.throws(
			() => mergePullRequest({ root: f.root, cfg, cwd: wt, number: 77, sha }),
			/git fetch origin main failed/,
		);
		assert.match(templateClass(f.root, cfg, sha).doubt!, /git fetch origin main failed/);
		assert.deepEqual(callsWith(f, "pr", "merge"), []);
	} finally {
		db.close();
		f.close();
	}
});

test("OPS-83-stale-code: evf code that differs from the base branch, or is edited, refuses every merge and names the rerun", () => {
	const { f, db, task } = wpShipFixture();
	try {
		const cfg = loadConfig(f.root),
			wt = join(f.root, ".worktrees", task.slug),
			sha = f.getState().pr.headRefOid,
			base = f.git("rev-parse", "origin/main").slice(0, 10);
		// Ordinary PR, current code: merges.
		const ordinary = () => mergePullRequest({ root: f.root, cfg, cwd: wt, number: 77, sha });
		const binOnly = (b: any) => ({ ...currentCode(b), binTree: "3".repeat(40) });
		for (const claim of [behindCode, binOnly, (b: any) => ({ ...currentCode(b), dirty: true })] as const)
			withCode(claim, () => {
				assert.throws(
					() => ordinary(),
					(e: Error) =>
						e.message.includes("1111111111") === (claim === behindCode) &&
						e.message.includes(`main is at ${base}`) &&
						e.message.includes(`git -C ${f.root} merge --ff-only origin/main`),
				);
				assert.throws(() => ship(f.root, task), /does not merge PR #77/);
			});
		assert.deepEqual(callsWith(f, "pr", "merge"), []);
		assert.equal(ordinary().code, 0, "current code still merges an ordinary PR");
	} finally {
		db.close();
		f.close();
	}
});
