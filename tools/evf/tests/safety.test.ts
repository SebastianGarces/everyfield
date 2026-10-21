import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { evfDataDir, git, parseTask } from "../lib.ts";
import { verify } from "../verify.ts";
import { prOpen } from "../ship.ts";
import { gc } from "../doctor.ts";
import { taskStart } from "../task.ts";

function setup(script = "console.log(process.cwd())") {
	const f = fixture();
	f.cfg.maintenanceTasks = {
		"OPS-1": {
			title: "Safety",
			owningPaths: ["tools/evf/", "evf.config.json"],
			checks: [{ name: "check", run: [process.execPath, "-e", script] }],
		},
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
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
		assert.match(readFileSync(report.checks[0].log, "utf8"), new RegExp(realpathSync(reviewer)));
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
		assert.match(readFileSync(report.checks[0].log, "utf8"), /Retry.*Next build lock/);
		const run = (error: string) => {
			const cfg = JSON.parse(readFileSync(join(f.wt, "evf.config.json"), "utf8"));
			cfg.maintenanceTasks["OPS-1"].checks[0].run[2] =
				`const fs=require('node:fs');const p=${JSON.stringify(attempts)};fs.writeFileSync(p,String(Number(fs.readFileSync(p,'utf8'))+1));console.error(${JSON.stringify(error)});process.exit(1)`;
			writeFileSync(join(f.wt, "evf.config.json"), JSON.stringify(cfg));
			git(f.wt, "add", "evf.config.json");
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
		f.cfg.maintenanceTasks["OPS-1"].checks[0].run = ["sh", "-c", "node --version"];
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
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
			readFileSync(report.checks[0].log, "utf8"),
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

test("BUG-home-registration: an OPS task registers on its own branch and verifies without touching the home config", () => {
	const f = fixture();
	try {
		const home = readFileSync(join(f.root, "evf.config.json")),
			task = parseTask("OPS-900");
		assert.throws(
			() => capture(() => taskStart(f.root, task, { allowUnready: false, noStack: true })),
			/Commit the reviewed OPS-900 entry .* on the task branch/,
		);
		const wt = join(f.root, ".worktrees/ops-900"),
			cfg = JSON.parse(readFileSync(join(wt, "evf.config.json"), "utf8"));
		cfg.maintenanceTasks = {
			...cfg.maintenanceTasks,
			"OPS-900": {
				title: "Branch registration",
				owningPaths: ["tools/evf/"],
				checks: [{ name: "check", run: [process.execPath, "-e", "console.log('branch check ran')"] }],
			},
		};
		writeFileSync(join(wt, "evf.config.json"), JSON.stringify(cfg));
		mkdirSync(join(wt, "tools/evf"), { recursive: true });
		writeFileSync(join(wt, "tools/evf/change.ts"), "export {};\n");
		git(wt, "add", "evf.config.json", "tools/evf/change.ts");
		git(wt, "commit", "-qm", "Register OPS-900 and change tooling");
		assert.match(
			capture(() => taskStart(f.root, task, { allowUnready: false, noStack: true })),
			/# OPS-900: Branch registration/,
		);
		const report = verify(f.root, task, "author", "full");
		assert.equal(report.passed, true);
		assert.match(readFileSync(report.checks[0].log, "utf8"), /branch check ran/);
		cfg.checks = [];
		writeFileSync(join(wt, "evf.config.json"), JSON.stringify(cfg));
		git(wt, "commit", "-qam", "Change another config key");
		assert.throws(() => verify(f.root, task, "author", "full"), /outside its reviewed owning paths/);
		assert.deepEqual(readFileSync(join(f.root, "evf.config.json")), home);
	} finally {
		f.close();
	}
});
