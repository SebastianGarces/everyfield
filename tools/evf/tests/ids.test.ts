import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { loadConfig, parseTask } from "../lib.ts";
import { reserve } from "../ids.ts";
import { taskStart } from "../task.ts";

function withRemote() {
	const f = fixture();
	const check = [{ name: "check", run: [process.execPath, "-e", ""] }];
	f.cfg.maintenanceTasks = {
		"OPS-7": { title: "Seven", owningPaths: ["tools/evf/"], checks: check },
		"OPS-12": { title: "Twelve", owningPaths: ["tools/evf/"], checks: check },
	};
	writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
	mkdirSync(join(f.root, "docs/architecture"), { recursive: true });
	writeFileSync(
		join(f.root, "docs/architecture/decisions.md"),
		"# Architecture decisions\n\n## D7, 2026-10-01: seven\n\nText.\n\n## D9 and its update, 2026-10-02: nine\n\nText.\n",
	);
	f.git("add", "docs/architecture/decisions.md");
	f.commit();
	const remote = f.bare(join(f.root, "fake-bin/origin.git"));
	f.git("remote", "add", "origin", remote);
	f.git("push", "-q", "origin", "main");
	const remoteRef = (ref: string) =>
		spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref]).status === 0;
	return { ...f, remote, remoteRef };
}

function nextId(cwd: string, kind: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [join(source, "tools/evf/main.ts"), "id", "next", kind], { cwd });
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
	return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr })));
}

test("OPS-52-P5: concurrent callers reserve different IDs above every one in use", async () => {
	const f = withRemote();
	try {
		// OPS-15 is in use only as a task branch on the remote; main registers OPS-7 and OPS-12.
		f.git("push", "-q", "origin", "main:refs/heads/task/ops-15");
		const all = await Promise.all([1, 2, 3].map(() => nextId(f.root, "ops")));
		for (const r of all) assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(all.map((r) => r.stdout).sort(), ["OPS-16", "OPS-17", "OPS-18"]);

		// The race itself, without timing luck: a second reservation of a held ID loses and the first stays.
		const cfg = loadConfig(f.root),
			held = () =>
				spawnSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%s", "refs/evf/ids/OPS-16"], {
					encoding: "utf8",
				}).stdout;
		const first = held();
		assert.equal(reserve(f.root, cfg, "OPS-16"), false);
		assert.equal(held(), first);

		// Decisions count main's headings (D7, D9) and reservations on the remote (D10, pushed by hand here).
		const tree = f.git("hash-object", "-w", "-t", "tree", "/dev/null");
		f.git("push", "-q", "origin", `${f.git("commit-tree", tree, "-m", "D10 reserved by hand")}:refs/evf/ids/D10`);
		const decision = await nextId(f.root, "decision");
		assert.equal(decision.code, 0, decision.stderr);
		assert.equal(decision.stdout, "D11");
	} finally {
		f.close();
	}
});

test("OPS-52-P5: task start reserves a new OPS ID and refuses one another checkout already started", () => {
	const f = withRemote();
	try {
		const quiet = (fn: () => unknown) => {
			const log = console.log;
			console.log = () => {};
			try {
				return fn();
			} finally {
				console.log = log;
			}
		};
		// The new branch has no registration yet, so start stops there, after the reservation and the worktree.
		assert.throws(
			() => quiet(() => taskStart(f.root, parseTask("OPS-20"), { allowUnready: false, noStack: true })),
			/Commit the reviewed OPS-20 entry/,
		);
		assert.ok(f.remoteRef("refs/evf/ids/OPS-20"));

		f.git("push", "-q", "origin", "main:refs/heads/task/ops-21");
		assert.throws(
			() => quiet(() => taskStart(f.root, parseTask("OPS-21"), { allowUnready: false, noStack: true })),
			/task\/ops-21 already exists on origin: another checkout started OPS-21/,
		);
		assert.equal(existsSync(join(f.root, ".worktrees/ops-21")), false);
		assert.equal(f.remoteRef("refs/evf/ids/OPS-21"), false);
	} finally {
		f.close();
	}
});
