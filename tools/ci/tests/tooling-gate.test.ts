import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decide, type GateId, testFiles } from "../tooling-gate.ts";

const ran = (paths: string[] | null, event = "pull_request") =>
	Object.fromEntries(Object.entries(decide(event, paths)).map(([id, d]) => [id, d.run])) as Record<GateId, boolean>;
const none = { typecheck: false, formal: false, qa: false, wiki: false, app: false, stack: false };
const every = { typecheck: true, formal: true, qa: true, wiki: true, app: true, stack: true };

test("INV-tooling-gate: a PR that touches no tool path skips every gated self-test, and says why", () => {
	assert.deepEqual(ran(["apps/web/src/features/people/page.tsx", "docs/runbooks/ci.md"]), none);
	assert.match(decide("pull_request", ["docs/x.md"]).qa.reason, /^no changed path matches tools\/qa\/\*\*, bin\/qa/);
});

test("INV-tooling-gate: each self-test runs on its own paths", async (t) => {
	await t.test("typecheck: the typecheck tool and a package tsconfig run it; a domain file does not", () => {
		assert.equal(ran(["tools/ci/typecheck.ts"]).typecheck, true);
		assert.equal(ran(["tools/ci/typecheck-corpus.ts"]).typecheck, true);
		assert.equal(ran(["packages/db/tsconfig.json"]).typecheck, true);
		assert.equal(ran(["packages/domain/package.json"]).typecheck, true);
		assert.equal(ran(["packages/domain/src/people/list.ts"]).typecheck, false);
	});
	await t.test("formal: formal/, a formal map, a mapped permissions file and the formal test run it", () => {
		assert.deepEqual(ran(["formal/permissions/Permissions.tla"]), { ...none, formal: true, stack: true });
		assert.equal(ran([".agents/skills/formal-permissions/map.json"]).formal, true);
		assert.equal(ran(["packages/domain/src/access/session.ts"]).formal, true);
		assert.equal(ran(["tests/integration/access/formal-conformance.test.mts"]).formal, true);
		assert.equal(ran(["tests/workflow/formal.test.ts"]).formal, true);
		assert.equal(ran(["packages/domain/src/people/list.ts"]).formal, false);
	});
	await t.test("qa: a migration, tools/qa, prod-identity and bin/qa run it; an unrelated path does not", () => {
		assert.equal(ran(["packages/db/migrations/0100_people.sql"]).qa, true);
		assert.equal(ran(["tools/qa/qa.ts"]).qa, true);
		assert.equal(ran(["tools/prod-identity/main.ts"]).qa, true);
		assert.deepEqual(ran(["bin/qa"]), { ...none, qa: true, stack: true });
		assert.equal(ran(["packages/db/src/schema/tables.ts"]).qa, false);
	});
	await t.test("wiki and app: each runs on its own tool, and neither on the other's", () => {
		assert.deepEqual(ran(["tools/wiki/src/render.ts"]), { ...none, wiki: true });
		assert.deepEqual(ran(["tools/app/app.ts"]), { ...none, app: true });
		assert.deepEqual(ran(["bin/app"]), { ...none, app: true, stack: true });
	});
	await t.test("stack: bin/, scripts/ and tests/workflow/ run it; formal runs it; a domain file does not", () => {
		assert.equal(ran(["bin/dev"]).stack, true);
		assert.equal(ran(["scripts/nightly.ts"]).stack, true);
		assert.equal(ran(["tests/workflow/dev.test.mjs"]).stack, true);
		const formal = decide("pull_request", ["formal/permissions/Permissions.tla"]).stack;
		assert.deepEqual(formal, {
			run: true,
			reason: "the formal tests run in this step (formal/permissions/Permissions.tla matches formal/**)",
		});
		assert.equal(ran(["packages/domain/src/people/list.ts"]).stack, false);
	});
});

test("INV-tooling-gate: workflow, action, gate and shared input changes run the full set", () => {
	for (const path of [
		".github/workflows/ci.yml",
		".github/actions/setup/action.yml",
		"tools/ci/tooling-gate.ts",
		"tools/ci/select.ts",
		"pnpm-lock.yaml",
		"tsconfig.tools.json",
		"scripts/test-workflow.mjs",
	])
		assert.deepEqual(ran(["docs/x.md", path]), every, path);
	assert.equal(
		decide("pull_request", [".github/workflows/ci.yml"]).wiki.reason,
		"full set: .github/workflows/ci.yml matches .github/workflows/**, a tooling-wide input",
	);
});

test("INV-tooling-gate: push, merge_group and schedule events, and an unreadable or empty diff, run the full set", () => {
	for (const event of ["push", "merge_group", "schedule", "workflow_dispatch"]) {
		assert.deepEqual(ran(["docs/x.md"], event), every, event);
		assert.equal(decide(event, null).qa.reason, `a ${event} event runs the full tooling set`);
	}
	assert.deepEqual(ran(null), every);
	assert.deepEqual(ran([]), every);
});

test("INV-tooling-gate: skipped typecheck and formal leave their test files out, and the rest run", () => {
	const toolsCi = [
		"tools/ci/tests/select.test.ts",
		"tools/ci/tests/typecheck-corpus.test.ts",
		"tools/ci/tests/typecheck.test.ts",
	];
	const workflow = [
		"tests/workflow/dev.test.mjs",
		"tests/workflow/evry-evals-coverage.test.mjs",
		"tests/workflow/formal.test.ts",
		"tests/workflow/server-logs.test.mjs",
	];
	assert.deepEqual(testFiles(decide("pull_request", ["bin/dev"]), toolsCi, workflow), {
		toolsCi: ["tools/ci/tests/select.test.ts"],
		workflow: ["tests/workflow/dev.test.mjs"],
	});
	assert.deepEqual(testFiles(decide("push", null), toolsCi, workflow), {
		toolsCi,
		workflow: ["tests/workflow/dev.test.mjs", "tests/workflow/formal.test.ts"],
	});
});

test("INV-tooling-gate: the script diffs against the merge base, not the base tip, and logs each decision", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "tooling-gate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
			cwd: dir,
			encoding: "utf8",
		}).trim();
	const commit = (file: string) => {
		execFileSync("sh", ["-c", `mkdir -p "$(dirname ${file})" && echo x >> ${file}`], { cwd: dir });
		git("add", "-A");
		git("commit", "-qm", file);
		return git("rev-parse", "HEAD");
	};
	git("init", "-q", "-b", "main");
	commit("README.md");
	git("checkout", "-qb", "pr");
	const head = commit("tools/wiki/render.ts");
	git("checkout", "-q", "main");
	const base = commit("tools/qa/qa.ts");
	const output = join(dir, "github-output");
	const repo = resolve(import.meta.dirname, "../../..");
	const r = spawnSync(process.execPath, [join(repo, "tools/ci/tooling-gate.ts")], {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			EVENT: "pull_request",
			BASE_SHA: base,
			HEAD_SHA: head,
			GITHUB_OUTPUT: output,
			GIT_DIR: join(dir, ".git"),
		},
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /1 changed paths against the merge base/);
	assert.match(
		r.stdout,
		/^run  wiki \(wiki tool install, Chromium and tests\): tools\/wiki\/render\.ts matches tools\/wiki\/\*\*$/m,
	);
	assert.match(r.stdout, /^skip qa \(QA preview tool\): no changed path matches/m);
	const outputs = readFileSync(output, "utf8");
	assert.match(outputs, /^wiki=true$/m);
	assert.match(outputs, /^qa=false$/m);
	assert.doesNotMatch(outputs, /^tools-ci-tests=.*typecheck\.test\.ts/m);
	assert.match(outputs, /^tools-ci-tests=.*tools\/ci\/tests\/tooling-gate\.test\.ts/m);
});
