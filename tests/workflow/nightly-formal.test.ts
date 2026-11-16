import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type FormalDeps, nightlyFormal, type Run } from "../../scripts/nightly-formal.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

function nodeTest(t: { after(fn: () => void): void }, bodies: string[]): Run {
	const dir = mkdtempSync(join(tmpdir(), "evf-nightly-formal-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const files = bodies.map((body, i) => {
		const file = join(dir, `${i}.test.mjs`);
		writeFileSync(file, `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`);
		return file;
	});
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	try {
		return {
			status: 0,
			output: execFileSync(process.execPath, ["--test", ...files], { cwd: dir, encoding: "utf8", env }),
		};
	} catch (error) {
		return { status: (error as { status: number }).status, output: String((error as { stdout: string }).stdout) };
	}
}

const DETAIL = [
	'Behavior 2 of 3 (seed 7, /runner/nightly-formal/traces/permissions/traces.json) disagrees at step 4 of 6: Run {\\"request\\":\\"r1\\",\\"kind\\":\\"adminRead\\"}',
	"  result                         refused  admitted   <- differs",
	"  session o2/1                   ended    ended",
].join("\\n");
const disagreeing = `test("b1", () => {}); test("b2", () => assert.fail("${DETAIL}")); test("b3", () => {});`;
const COMMIT = "a".repeat(40);
const REPRO = `git checkout ${COMMIT}, then bin/dev formal --traces /tmp/formal-seed-7 --seed 7, then cd packages/domain && FORMAL_TRACES=/tmp/formal-seed-7 npx tsx --conditions=react-server --test ../../tests/integration/access/formal-replay.test.mts`;
const head = [
	`Nightly formal replay: seed 7, commit ${COMMIT}`,
	"Generating: bin/dev formal --traces /runner/nightly-formal/traces --seed 7",
];
const generated = [
	`Seed 7 at commit ${COMMIT}: 3 traces, 6 steps.`,
	"The traces cover every model action.",
	"Replaying with FORMAL_TRACES=/runner/nightly-formal/traces; its output goes to /runner/nightly-formal/replay.log only.",
];
const error = (what: string) =>
	`::error title=Nightly formal replay::${what}. Seed 7, commit ${COMMIT}. Reproduce: ${REPRO}`;

async function run(over: Partial<FormalDeps>) {
	const lines: string[] = [];
	const summary: string[] = [];
	const calls: string[] = [];
	const status = await nightlyFormal({
		seed: 7,
		commit: COMMIT,
		dir: "/runner/nightly-formal",
		generate: async (traces, seed) => (calls.push(`generate ${traces} ${seed}`), { status: 0, output: "" }),
		readTraces: () => ({ behaviors: [[1], [1, 2], [1, 2, 3]] }),
		database: async () => (calls.push("database"), null),
		replay: async () => ({ status: 0, output: "ℹ tests 3\nℹ pass 3\nℹ fail 0\n" }),
		log: (line) => lines.push(line),
		summary: (s) => summary.push(...s),
		...over,
		...(over.replay ? { replay: (t, l) => (calls.push(`replay ${t} ${l}`), over.replay!(t, l)) } : {}),
	});
	return { status, lines, summary, calls };
}

test("T-401 a green replay passes and prints the seed, the counts and full coverage", async (t) => {
	const green = nodeTest(t, ['test("b1", () => {}); test("b2", () => {}); test("b3", () => {});']);
	const r = await run({ replay: async () => green });
	assert.equal(r.status, 0);
	assert.deepEqual(r.lines, [
		...head,
		...generated,
		"Passed: every behavior from seed 7 replays without disagreement.",
	]);
	assert.deepEqual(r.summary, [
		"### Nightly formal replay",
		...generated.slice(0, 2),
		"Passed: every behavior from seed 7 replays without disagreement.",
	]);
	assert.deepEqual(r.calls, [
		"generate /runner/nightly-formal/traces 7",
		"database",
		"replay /runner/nightly-formal/traces /runner/nightly-formal/replay.log",
	]);
});

test("T-401 traces that leave out a model action still replay and the gap is noted, not failed (D-1589)", async (t) => {
	const green = nodeTest(t, ['test("b1", () => {});']);
	const r = await run({
		generate: async () => ({
			status: 1,
			output: "  the traces leave out: Expire, SeatAction remove. Try another seed.\n  wrote x\n",
		}),
		replay: async () => green,
	});
	assert.equal(r.status, 0);
	assert.equal(r.lines[3], "The traces leave out: Expire, SeatAction remove. They still replay.");
	assert.equal(r.summary[2], "The traces leave out: Expire, SeatAction remove. They still replay.");
	assert.equal(r.lines.at(-1), "Passed: every behavior from seed 7 replays without disagreement.");
});

test("T-401 a disagreement fails with the seed, the commit and the repro, and none of the replay's own text", async (t) => {
	const replayed = nodeTest(t, [disagreeing]);
	assert.match(replayed.output, /disagrees at step 4 of 6: Run/);
	const r = await run({ replay: async () => replayed });
	assert.equal(r.status, 1);
	const failure = error("a replayed behavior disagrees with the code; its detail stays off the public log");
	assert.deepEqual(r.lines, [...head, ...generated, failure]);
	assert.deepEqual(r.summary, [
		"### Nightly formal replay",
		...generated.slice(0, 2),
		"**Failed:** a replayed behavior disagrees with the code; its detail stays off the public log.",
		`Seed 7, commit ${COMMIT}.`,
		`Reproduce: \`${REPRO}\``,
	]);
	for (const text of [...r.lines, ...r.summary])
		assert.doesNotMatch(text, /Behavior \d|adminRead|request|differs|session o2|step 4/);
});

test("T-401 a crashed, empty or summary-less replay fails and says so, not as a disagreement", async (t) => {
	const cases: [Run, string][] = [
		[
			nodeTest(t, ['test("b1", () => { throw Error("connection terminated"); }); test("b2", () => {});']),
			"the replay crashed (1 failed, with no disagreement)",
		],
		[nodeTest(t, []), "no replay test ran"],
		[
			{ status: 1, output: "Error: Cannot find module 'tsx'\n" },
			"the replay crashed before node:test printed a summary",
		],
		[
			{ status: null, output: "ℹ tests 3\nℹ pass 3\nℹ fail 0\n" },
			"the replay exited on a signal after every test passed",
		],
	];
	for (const [replayed, what] of cases) {
		const r = await run({ replay: async () => replayed });
		assert.equal(r.status, 1, what);
		assert.deepEqual(r.lines, [...head, ...generated, error(what)]);
		assert.doesNotMatch(r.lines.join("\n"), /connection terminated/);
	}
});

test("T-401 a failed generation fails before the database or the replay, still naming the seed", async () => {
	for (const over of [
		{ generate: async () => ({ status: 1, output: "Error: TLC threw an unexpected exception\n" }) },
		{ readTraces: () => null },
	] as Partial<FormalDeps>[]) {
		const r = await run({ ...over, replay: async () => assert.fail("no replay after a failed generation") });
		assert.equal(r.status, 1);
		assert.deepEqual(r.lines, [...head, error("TLC generation failed")]);
		assert.deepEqual(r.summary, [
			"**Failed:** TLC generation failed.",
			`Seed 7, commit ${COMMIT}.`,
			`Reproduce: \`${REPRO}\``,
		]);
		assert.ok(!r.calls.includes("database"));
	}
});

test("T-401 an unreachable database fails before the replay, and a crash in the driver still names the seed", async () => {
	const closed = await run({
		database: async () => "ECONNREFUSED",
		replay: async () => assert.fail("no replay without a database"),
	});
	assert.equal(closed.status, 1);
	assert.deepEqual(closed.lines, [
		...head,
		...generated.slice(0, 2),
		error("the database was not reachable (ECONNREFUSED)"),
	]);
	const crashed = await run({
		generate: async () => {
			throw Error("spawn failed");
		},
	});
	assert.equal(crashed.status, 1);
	assert.deepEqual(crashed.lines, [...head, error("the driver crashed")]);
});

test("T-401 the nightly formal job runs on its own Postgres, with no secret, no upload and no other job's result", () => {
	const workflow = readFileSync(join(root, ".github/workflows/nightly.yml"), "utf8");
	const start = workflow.indexOf("\n  formal:\n");
	assert.ok(start > 0, "formal job");
	const next = workflow.slice(start + 1).search(/\n  [\w-]+:\n/);
	const job = next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
	assert.doesNotMatch(workflow, /secrets\./);
	assert.doesNotMatch(job, /needs:|upload-artifact|nightly-formal\/replay/);
	assert.match(job, /\n    timeout-minutes: (\d+)\n/);
	assert.ok(Number(/\n    timeout-minutes: (\d+)\n/.exec(job)![1]) <= 20);
	assert.match(job, /image: pgvector\/pgvector:0\.8\.7-pg18\n/);
	assert.match(job, /DATABASE_URL: postgres:\/\/ci:ci@localhost:5432\/everyfield_ci\n/);
	assert.match(job, /EARLY_ACCESS_TEST_DATABASE: "1"\n/);
	assert.match(job, /uses: \.\/\.github\/actions\/setup\n/);
	assert.ok(job.indexOf("run: pnpm db:migrate\n") > 0);
	assert.ok(job.indexOf("run: node scripts/nightly-formal.ts\n") > job.indexOf("run: pnpm db:migrate\n"));
	assert.match(workflow, /\non:\n  schedule:\n    - cron: "[^"]+"\n  workflow_dispatch:\n/);
});
