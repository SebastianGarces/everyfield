import test from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source, setTasks, readTask, writeTask } from "./fixtures.ts";
import { evfDataDir, git, parseTask } from "../lib.ts";
import { verify } from "../verify.ts";
import { prOpen } from "../ship.ts";
import { gc } from "../doctor.ts";
import { taskStart } from "../task.ts";

function setup(script = "console.log(process.cwd())") {
	const f = fixture();
	f.tasks = {
		"OPS-1": {
			title: "Safety",
			owningPaths: ["tools/evf/", "evf.config.json"],
			checks: [{ name: "check", run: [process.execPath, "-e", script] }],
		},
	};
	setTasks(f.root, f.tasks);
	f.commit();
	const wt = f.task("ops-1"),
		task = parseTask("OPS-1");
	return { ...f, wt, task };
}
function cli(cwd: string, ...args: string[]) {
	return spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], { cwd, encoding: "utf8" });
}
function capture(fn: () => unknown) {
	const lines: string[] = [],
		original = console.log;
	console.log = (...args) => lines.push(args.join(" "));
	try {
		fn();
		return lines.join("\n");
	} finally {
		console.log = original;
	}
}

test("BUG-OPS9-verifier: check caller checkout and refuse a dirty tree or mismatched exact head", () => {
	const f = setup();
	try {
		const reviewer = join(f.root, ".worktrees/reviewer");
		f.git("worktree", "add", "--detach", reviewer, "HEAD");
		const sha = git(reviewer, "rev-parse", "HEAD");
		writeFileSync(join(f.wt, "author-edit"), "author is editing");
		const result = cli(reviewer, "verify", "OPS-1", "--role", "verifier", "--head", sha);
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(
			readFileSync(join(evfDataDir(f.root), "evidence/ops-1", sha, "verifier-full/checks.json"), "utf8"),
		);
		assert.match(readFileSync(report.checks[1].log, "utf8"), new RegExp(realpathSync(reviewer)));
		const mismatch = cli(reviewer, "verify", "OPS-1", "--role", "verifier", "--head", "a".repeat(40));
		assert.equal(mismatch.status, 1);
		assert.match(mismatch.stderr, /HEAD.*does not match/);
		writeFileSync(join(reviewer, "dirty"), "dirty");
		const dirty = cli(reviewer, "verify", "OPS-1", "--role", "verifier", "--head", sha);
		assert.equal(dirty.status, 1);
		assert.match(dirty.stderr, /checkout.*not clean/i);
	} finally {
		f.close();
	}
});

test("BUG-OPS9-mutation: report INVALIDATED when a check edits the checked tree", () => {
	const f = setup('require("node:fs").appendFileSync("evf.config.json", " "); process.exit(2)');
	try {
		const result = cli(f.root, "verify", "OPS-1");
		assert.equal(result.status, 1);
		assert.match(result.stdout, /INVALIDATED.*changed during/);
		const sha = git(f.wt, "rev-parse", "HEAD");
		const report = JSON.parse(
			readFileSync(join(evfDataDir(f.root), "evidence/ops-1", sha, "author-full/checks.json"), "utf8"),
		);
		assert.equal(report.passed, false);
		assert.equal(report.unchanged, false);
	} finally {
		f.close();
	}
});

test("BUG-OPS9-push: PR open refuses an unverified head before any push, and pre-push requires a full exact-head pass", () => {
	const f = setup();
	try {
		const remote = f.bare(join(f.root, "fake-bin/origin.git"));
		f.git("remote", "add", "origin", remote);
		f.git("push", "-q", "origin", "main");
		assert.throws(() => prOpen(f.root, f.task), /passing full.*verify.*exact HEAD/);
		assert.equal(spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/task/ops-1"]).status, 128);
		assert.equal(cli(f.wt, "pre-push", "OPS-1").status, 1);
		verify(f.root, f.task, "author", "quick");
		assert.equal(cli(f.wt, "pre-push", "OPS-1").status, 1);
		verify(f.root, f.task, "author", "full");
		assert.equal(cli(f.wt, "pre-push", "OPS-1").status, 0);
		git(f.wt, "commit", "--allow-empty", "-qm", "New head");
		assert.equal(cli(f.wt, "pre-push", "OPS-1").status, 1);
	} finally {
		f.close();
	}
});

test("BUG-164-ci-parity: OPS verify adds CI's format and unit checks; PR open refuses files CI would not see", () => {
	const f = setup();
	try {
		const remote = f.bare(join(f.root, "fake-bin/origin.git"));
		f.git("remote", "add", "origin", remote);
		f.git("push", "-q", "origin", "main");
		const report = verify(f.root, f.task, "author", "full");
		assert.deepEqual(
			report.checks.map((c) => [c.name, c.passed]),
			[
				["format", true],
				["check", true],
				["package-unit-tests", true],
			],
		);
		git(f.wt, "config", "status.showUntrackedFiles", "no");
		writeFileSync(join(f.wt, "tools/evf/photo.jpg"), "not committed");
		assert.throws(() => prOpen(f.root, f.task), /not clean/);
		git(f.wt, "add", "tools/evf/photo.jpg");
		assert.throws(() => prOpen(f.root, f.task), /not clean/);
		assert.equal(spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/task/ops-1"]).status, 128);
	} finally {
		f.close();
	}
});

// Captured from Next 16.4.1 acquireWithRetriesOrExit with a held .next/lock and FORCE_COLOR=1.
const nextBuildLockOutput =
	"\u001b[31m\u001b[1m⨯\u001b[22m\u001b[39m Another \u001b[36mnext build\u001b[39m process is already running.";

test("BUG-OPS9-lock: retry a held Next build lock, bound retries, and do not retry other failures", () => {
	const f = setup(`
const fs = require('node:fs'), p = process.env.EVF_RUNTIME_DIR + '/attempts';
fs.mkdirSync(process.env.EVF_RUNTIME_DIR, {recursive:true});
const n = fs.existsSync(p) ? Number(fs.readFileSync(p,'utf8')) + 1 : 1;
fs.writeFileSync(p,String(n));
if (n === 1) {console.error(${JSON.stringify(nextBuildLockOutput)}); process.exit(1);}
console.log('built');`);
	try {
		let report = verify(f.root, f.task, "author", "full");
		assert.equal(report.passed, true);
		const attempts = join(evfDataDir(f.root), "runtime/ops-1/attempts");
		assert.equal(readFileSync(attempts, "utf8"), "2");
		assert.match(readFileSync(report.checks[1].log, "utf8"), /Retry.*Next build lock/);
		const run = (error: string) => {
			const entry = readTask(f.wt, "OPS-1");
			entry.checks[0].run[2] = `const fs=require('node:fs');const p=${JSON.stringify(attempts)};fs.writeFileSync(p,String(Number(fs.readFileSync(p,'utf8'))+1));console.error(${JSON.stringify(error)});process.exit(1)`;
			writeTask(f.wt, "OPS-1", entry);
			git(f.wt, "add", "tools/evf/tasks");
			git(f.wt, "commit", "-qm", "Failing provider");
			writeFileSync(attempts, "0");
			return verify(f.root, f.task, "author", "full");
		};
		report = run("Another next build process is already running.");
		assert.equal(report.passed, false);
		assert.equal(readFileSync(attempts, "utf8"), "4");
		report = run("Type error: bad Next config");
		assert.equal(report.passed, false);
		assert.equal(readFileSync(attempts, "utf8"), "1");
	} finally {
		f.close();
	}
});

test("BUG-OPS9-node: checks launched from a Node 22 shell inherit evf's Node 24", () => {
	const f = setup();
	try {
		const node22 = join(f.root, "fake-bin/node");
		writeFileSync(node22, '#!/bin/sh\nif [ "$1" = "-e" ]; then exit 1; fi\necho v22.16.0\n');
		chmodSync(node22, 0o755);
		f.tasks["OPS-1"].checks[0].run = ["sh", "-c", "node --version"];
		setTasks(f.root, f.tasks);
		f.commit();
		git(f.wt, "merge", "--ff-only", "main");
		const home = join(f.root, "fake-bin/home");
		const bin = join(home, ".nvm/versions/node/v24.0.0/bin");
		mkdirSync(bin, { recursive: true });
		symlinkSync(process.execPath, join(bin, "node"));
		const result = spawnSync(join(source, "bin/evf"), ["verify", "OPS-1"], {
			cwd: f.root,
			encoding: "utf8",
			env: { ...process.env, HOME: home },
		});
		assert.equal(result.status, 0, result.stderr);
		const sha = git(f.wt, "rev-parse", "HEAD");
		const report = JSON.parse(
			readFileSync(join(evfDataDir(f.root), "evidence/ops-1", sha, "author-full/checks.json"), "utf8"),
		);
		assert.match(
			readFileSync(report.checks[1].log, "utf8"),
			new RegExp(`v${process.versions.node.replaceAll(".", "\\.")}`),
		);
	} finally {
		f.close();
	}
});

test("BUG-OPS9-gc: dry run and apply preserve active tasks, open PRs and live previews; unknown provider state keeps worktrees", () => {
	const f = setup();
	try {
		capture(() => taskStart(f.root, f.task, { allowUnready: false, noStack: true }));
		const remote = f.bare(join(f.root, "fake-bin/origin.git"));
		f.git("remote", "add", "origin", remote);
		const shipped = join(evfDataDir(f.root), "shipped");
		mkdirSync(shipped, { recursive: true });
		const runtime = join(evfDataDir(f.root), "runtime/ops-1");
		mkdirSync(runtime, { recursive: true });
		const sha = git(f.wt, "rev-parse", "HEAD");
		writeFileSync(
			join(shipped, "ops-1.json"),
			JSON.stringify({ task: "OPS-1", verified_head: sha, shipped_at: "2026-10-18T00:00:00Z" }),
		);

		const portless = join(f.root, "fake-bin/portless");
		writeFileSync(portless, '#!/bin/sh\necho "[]"\n');
		chmodSync(portless, 0o755);
		const state = f.getState();
		state.openPrs = [];
		f.setState(state);
		assert.match(
			capture(() => gc(f.root, false)),
			/ops-1: keep \(active task\)/,
		);
		capture(() => gc(f.root, true));
		assert.equal(existsSync(f.wt), true);
		writeFileSync(join(runtime, "active.json"), JSON.stringify({ startedAt: "2026-10-17T00:00:00Z" }));
		state.openPrs = [{ number: 1 }];
		f.setState(state);
		assert.match(
			capture(() => gc(f.root, true)),
			/keep \(open PR\)/,
		);
		assert.equal(existsSync(f.wt), true);
		state.openPrs = [];
		f.setState(state);
		writeFileSync(portless, `#!/bin/sh\necho '${JSON.stringify([{ project: realpathSync(f.wt), state: "ready" }])}'\n`);
		assert.match(
			capture(() => gc(f.root, true)),
			/keep \(running preview\)/,
		);
		assert.equal(existsSync(f.wt), true);
		writeFileSync(portless, "#!/bin/sh\nexit 1\n");
		assert.match(
			capture(() => gc(f.root, true)),
			/keep \(preview status unavailable\)/,
		);
		assert.equal(existsSync(f.wt), true);
		writeFileSync(portless, '#!/bin/sh\necho "[]"\n');
		assert.match(
			capture(() => gc(f.root, false)),
			/remove \(shipped, clean\)/,
		);
		assert.equal(existsSync(f.wt), true);
		capture(() => gc(f.root, true));
		assert.equal(existsSync(f.wt), false);
	} finally {
		f.close();
	}
});

test("BUG-home-registration AC:OPS-148-3 AC:OPS-148-4: an OPS task registers on its own branch and verifies without touching the home config", () => {
	const f = fixture();
	try {
		const home = readFileSync(join(f.root, "evf.config.json")),
			task = parseTask("OPS-900");
		assert.throws(
			() => capture(() => taskStart(f.root, task, { allowUnready: false, noStack: true })),
			/Commit the reviewed OPS-900 entry .* on the task branch/,
		);
		const wt = join(f.root, ".worktrees/ops-900"),
			entry = {
				title: "Branch registration",
				owningPaths: ["tools/evf/"],
				checks: [{ name: "check", run: [process.execPath, "-e", "console.log('branch check ran')"] }],
			};
		writeTask(wt, "OPS-900", entry);
		mkdirSync(join(wt, "tools/evf"), { recursive: true });
		writeFileSync(join(wt, "tools/evf/change.ts"), "export {};\n");
		git(wt, "add", "tools/evf/tasks", "tools/evf/change.ts");
		git(wt, "commit", "-qm", "Register OPS-900 and change tooling");
		assert.match(
			capture(() => taskStart(f.root, task, { allowUnready: false, noStack: true })),
			/# OPS-900: Branch registration/,
		);
		const report = verify(f.root, task, "author", "full");
		assert.equal(report.passed, true);
		assert.match(readFileSync(report.checks[1].log, "utf8"), /branch check ran/);
		// Owning the file or the folder waives no rule: the branch changes only its own entry.
		writeTask(wt, "OPS-900", { ...entry, owningPaths: ["tools/evf/", "evf.config.json"] });
		git(wt, "commit", "-qam", "Own the config file");
		assert.equal(verify(f.root, task, "author", "full").passed, true);
		const config = JSON.parse(readFileSync(join(wt, "evf.config.json"), "utf8"));
		const refusals: Array<[string, RegExp, () => void]> = [
			// AC:OPS-148-3 another task's entry file.
			[
				"changes another task's entry",
				/outside its reviewed owning paths: tools\/evf\/tasks\/OPS-1\.json\./,
				() => writeTask(wt, "OPS-1", { ...readTask(wt, "OPS-1"), owningPaths: ["tools/evf/"] }),
			],
			[
				"adds another task's entry",
				/outside its reviewed owning paths: tools\/evf\/tasks\/OPS-901\.json\./,
				() => writeTask(wt, "OPS-901", entry),
			],
			// AC:OPS-148-4 a machineLoad key in evf.config.json.
			[
				"adds machineLoad",
				/outside its reviewed owning paths: evf\.config\.json\./,
				() =>
					writeFileSync(
						join(wt, "evf.config.json"),
						JSON.stringify({ ...config, machineLoad: { maxPerCore: 99, maxWaitMinutes: 0 } }),
					),
			],
		];
		for (const [what, refusal, edit] of refusals) {
			edit();
			git(wt, "add", "-A");
			git(wt, "commit", "-qm", what);
			assert.throws(() => verify(f.root, task, "author", "full"), refusal, what);
			git(wt, "reset", "-q", "--hard", "HEAD~1");
		}
		assert.deepEqual(readFileSync(join(f.root, "evf.config.json")), home);
	} finally {
		f.close();
	}
});

test("BUG-OPS32-fresh: parallel fresh checks of one head both pass, and a crashed run's leftover blocks nothing", async () => {
	const f = fixture();
	try {
		// The fake install marks its checkout, waits, then needs the mark: a run whose checkout another run removed
		// or replaced fails, as PR #207's author and verifier did.
		const fake = join(f.root, "fake-bin/fresh-step.cjs");
		writeFileSync(
			fake,
			`const fs=require('node:fs');\n` +
				`if(process.argv[2]==='install'){fs.writeFileSync('mark','');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);}\n` +
				`process.exit(fs.existsSync('mark')&&fs.existsSync('evf.config.json')?0:1);\n`,
		);
		const steps = [
			[process.execPath, fake, "install"],
			[process.execPath, fake, "typecheck"],
		];
		const sha = git(f.root, "rev-parse", "HEAD"),
			fresh = join(evfDataDir(f.root), "fresh");
		const check = (role: string) => {
			const dir = join(evfDataDir(f.root), "evidence", role);
			mkdirSync(dir, { recursive: true });
			const script = `import(${JSON.stringify(join(source, "tools/evf/verify.ts"))}).then(m=>process.exit(m.freshCheckoutTypecheck(${JSON.stringify(f.root)},${JSON.stringify(f.root)},${JSON.stringify(sha)},${JSON.stringify(dir)},${JSON.stringify(role)},${JSON.stringify(steps)}).passed?0:1))`;
			return new Promise<number | null>((done) =>
				spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" }).on("exit", done),
			);
		};
		assert.deepEqual(await Promise.all([check("author"), check("verifier")]), [0, 0]);
		// A crashed run leaves a folder, and a worktree whose folder was deleted stays registered until pruned.
		mkdirSync(join(fresh, sha), { recursive: true });
		writeFileSync(join(fresh, sha, "leftover"), "crashed run");
		git(f.root, "worktree", "add", "--quiet", "--detach", join(fresh, "gone"), sha);
		rmSync(join(fresh, "gone"), { recursive: true, force: true });
		assert.equal(await check("verifier"), 0);
		assert.deepEqual(readdirSync(fresh), [sha]);
		// Runs remove only their own registration: an unrelated missing-folder registration stays for its owner.
		const listed = git(f.root, "worktree", "list", "--porcelain");
		assert.equal(listed.match(/^worktree /gm)?.length, 2);
		assert.match(listed, new RegExp(`^worktree ${join(realpathSync(fresh), "gone")}$`, "m"));
		assert.equal(readdirSync(join(git(f.root, "rev-parse", "--absolute-git-dir"), "worktrees")).length, 1);
	} finally {
		f.close();
	}
});
