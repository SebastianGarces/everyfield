import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, source } from "./fixtures.ts";

/** A fixture repo whose main holds one tooling test. `run` calls real `evf test` and says whether that test started. */
function scoped() {
	const f = fixture();
	mkdirSync(join(f.root, "tools/evf/tests"), { recursive: true });
	mkdirSync(join(f.root, ".github/workflows"), { recursive: true });
	writeFileSync(join(f.root, ".github/workflows/ci.yml"), "jobs:\n  a:\n    steps:\n      - run: bin/evf test\n");
	writeFileSync(join(f.root, "package.json"), JSON.stringify({ scripts: {} }));
	const started = join(f.root, "started.txt");
	writeFileSync(join(f.root, ".gitignore"), `${readFileSync(join(f.root, ".gitignore"), "utf8")}started.txt\n`);
	writeFileSync(
		join(f.root, "tools/evf/tests/one.test.ts"),
		`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(started)}, "started");\n`,
	);
	const commit = () => {
		f.git("add", "-A");
		f.git("commit", "-qm", "change");
	};
	commit();
	const write = (path: string, text = "changed\n") => {
		mkdirSync(join(f.root, path, ".."), { recursive: true });
		writeFileSync(join(f.root, path), text);
	};
	const run = (...args: string[]) => {
		rmSync(started, { force: true });
		const env: NodeJS.ProcessEnv = { ...process.env, EVF_RUN: "", EVF_WORKTREE: "" };
		delete env.NODE_TEST_CONTEXT;
		const r = spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "test", ...args], {
			cwd: f.root,
			encoding: "utf8",
			env,
		});
		assert.equal(r.status, 0, r.stdout + r.stderr);
		return { ran: existsSync(started), stdout: r.stdout };
	};
	return { f, commit, write, run };
}

test("OPS-172: a branch with no evf path starts no tooling test, and --all still runs them", () => {
	const { f, commit, write, run } = scoped();
	try {
		f.git("checkout", "-qb", "task");
		write("apps/web/page.tsx");
		write("docs/plan/notes.md");
		commit();
		const skipped = run();
		assert.equal(skipped.ran, false);
		assert.match(skipped.stdout, /skipped the tooling tests: 2 changed file\(s\) since \w+ and none is evf work/);
		assert.equal(run("--all").ran, true);
	} finally {
		f.close();
	}
});

test("OPS-172: evf code, a file evf's tests read, and uncommitted or untracked evf files run the tooling tests", () => {
	for (const path of ["tools/evf/x.ts", "bin/evf", ".github/workflows/ci.yml", ".claude/agents/implementer.md"]) {
		const { f, commit, write, run } = scoped();
		try {
			f.git("checkout", "-qb", "task");
			write("docs/plan/notes.md");
			commit();
			write(path); // Untracked, or uncommitted for the tracked ci.yml, on a branch that commits only a doc.
			assert.equal(run().ran, true, `${path} uncommitted`);
			commit();
			assert.equal(run().ran, true, `${path} committed`);
		} finally {
			f.close();
		}
	}
});

test("OPS-172: a new maintenanceTasks entry alone is no evf work; any other evf.config.json change is", () => {
	const { f, commit, write, run } = scoped();
	try {
		const config = JSON.parse(readFileSync(join(f.root, "evf.config.json"), "utf8"));
		f.git("checkout", "-qb", "task");
		write(
			"evf.config.json",
			JSON.stringify({ ...config, maintenanceTasks: { ...config.maintenanceTasks, "OPS-9": { title: "x" } } }),
		);
		commit();
		assert.equal(run().ran, false);
		write("evf.config.json", JSON.stringify({ ...config, checks: [] }));
		commit();
		assert.equal(run().ran, true);
	} finally {
		f.close();
	}
});

test("OPS-172: main itself and a checkout with no merge base run the tooling tests", () => {
	const { f, commit, write, run } = scoped();
	try {
		assert.equal(run().ran, true, "main has no changes");
		f.git("checkout", "-q", "--orphan", "unrelated");
		write("docs/plan/notes.md");
		commit();
		assert.equal(run().ran, true, "no merge base");
	} finally {
		f.close();
	}
});

test("OPS-172: main's own changes after the fork are not the branch's work, so a merge of main keeps the skip", () => {
	const { f, commit, write, run } = scoped();
	try {
		f.git("checkout", "-qb", "task");
		write("docs/plan/notes.md");
		commit();
		f.git("checkout", "-q", "main");
		write("tools/evf/from-main.ts");
		commit();
		f.git("checkout", "-q", "task");
		f.git("merge", "-q", "--no-edit", "main");
		assert.equal(run().ran, false);
	} finally {
		f.close();
	}
});

test("OPS-172: CI's evf job has the history the skip needs and still calls evf test", () => {
	const job = readFileSync(join(source, ".github/workflows/ci.yml"), "utf8")
		.split(/^  evf:$/m)[1]
		.split(/^  \w+:$/m)[0];
	assert.match(job, /actions\/checkout@\S+\n\s+with:\n\s+fetch-depth: 0/);
	assert.match(job, /^ +- run: bin\/evf test$/m);
});
