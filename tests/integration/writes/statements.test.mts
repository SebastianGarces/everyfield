import { appendFileSync, globSync, statSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBudgets, checkSamples, readRuns } from "./budgets.mjs";
import { statementStep } from "./kinds.cjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

type Census = { kind: "whole" } | { kind: "part"; index: number; total: number } | { kind: "union"; folder: string };
type Row = { kind: string; [key: string]: any };

function censusMode(part = process.env.EVF_CENSUS_PART, union = process.env.EVF_CENSUS_UNION): Census {
	if (part && union) throw Error("Set EVF_CENSUS_PART or EVF_CENSUS_UNION, not both");
	if (union) return { kind: "union", folder: union };
	if (!part) return { kind: "whole" };
	const match = /^(\d+)\/(\d+)$/.exec(part);
	const index = Number(match?.[1]),
		total = Number(match?.[2]);
	if (!(index >= 1 && index <= total)) throw Error(`EVF_CENSUS_PART must be i/N with 1 <= i <= N, not "${part}"`);
	return { kind: "part", index, total };
}
const census = censusMode();

function partSuites(files: string[], index: number, total: number): string[] {
	if (total === 1) return files;
	const parts = Array.from({ length: total - 1 }, () => ({ bytes: 0, files: [] as string[] }));
	const sized = files.map((file) => ({ file, bytes: statSync(file).size }));
	sized.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
	for (const { file, bytes } of sized) {
		const lightest = parts.reduce((least, part) => (part.bytes < least.bytes ? part : least));
		lightest.bytes += bytes;
		lightest.files.push(file);
	}
	if (index === 1) return [];
	const chosen = parts[index - 2];
	if (!chosen) throw Error(`Census part ${index}/${total} has no suites to run`);
	return chosen.files;
}

const parseRows = (text: string): Row[] =>
	text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

const REQUESTS = "tests/integration/writes/requests.mjs";
const NATIVE = "tests/integration/writes/native.mjs";

async function censusSuites(): Promise<string[]> {
	const patterns = JSON.parse(await readFile(new URL("./suites.json", import.meta.url), "utf8"));
	return globSync(patterns, { cwd: root });
}

async function censusUnits(): Promise<string[]> {
	return [REQUESTS, NATIVE, ...(await censusSuites())];
}

async function unionRows(folder: string, units: string[]): Promise<Row[]> {
	const files = globSync("**/counts.jsonl", { cwd: folder });
	const rows = (await Promise.all(files.map((file) => readFile(join(folder, file), "utf8")))).flatMap(parseRows);
	const parts = rows.filter((row) => row.kind === "part").map((row) => `${row.index}/${row.total}`);
	const total = Number(parts[0]?.split("/")[1]);
	assert.ok(total > 0, "No passing census part in " + folder);
	assert.deepEqual(
		parts.sort(),
		Array.from({ length: total }, (_, i) => `${i + 1}/${total}`).sort(),
		"The census union needs every part exactly once",
	);
	assert.deepEqual(
		rows
			.filter((row) => row.kind === "part")
			.flatMap((row) => row.ran)
			.sort(),
		[...units].sort(),
		"The census parts must run every suite exactly once",
	);
	return rows;
}

function checkPart(rows: Row[], limits: object) {
	const reserves = rows.filter(
		(row) => row.kind === "sample" && row.status !== "threw" && row.name === "identity.budget.reserve",
	);
	for (const sample of reserves) assert.ok(sample.count > 0, "identity.budget.reserve counted 0 statements");
	assert.deepEqual(checkSamples(rows, limits), []);
}

function checkWhole(rows: Row[], limits: object) {
	checkPart(rows, limits);
	assert.ok(
		rows.some((row) => row.kind === "sample" && row.name.startsWith("GET ")),
		"No HTTP request was measured",
	);
	assert.deepEqual(checkBudgets(rows, limits), []);
	const covered = new Set(
		rows
			.filter(
				(row) => row.kind === "sample" && row.status !== "threw" && (row.writes > 0 || Object.hasOwn(limits, row.name)),
			)
			.map((row) => row.name.split(":")[0]),
	);
	for (const row of rows.filter((row) => row.kind === "declaration" && row.write))
		assert.ok(covered.has(row.name), "A declared write has no successful real-database exercise: " + row.name);
}

test("BUG-PR193: a pooled query counts in the request that issued it", { skip: census.kind === "union" }, async () => {
	const output = join(await mkdtemp(join(tmpdir(), "evf-write-pool-")), "counts.jsonl");
	process.env.EVF_WRITE_COUNTS = output;
	const { measure, observeDatabase } = await import("./counter.mjs").finally(() => delete process.env.EVF_WRITE_COUNTS);
	const pg = createRequire(join(root, "packages/db/package.json"))("pg");
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	observeDatabase({ $client: pool });
	try {
		await Promise.all(["a", "b", "c"].map((name) => measure(name, () => pool.query("SELECT 1"))));
	} finally {
		await pool.end();
	}
	const counts = (await readFile(output, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((row) => row.kind === "sample")
		.map((row) => [row.name, row.count]);
	assert.deepEqual(Object.fromEntries(counts), { a: 1, b: 1, c: 1 });
});

test(
	"INV-census: the load hook refuses a listed standalone name its file does not declare",
	{ skip: census.kind === "union" },
	async () => {
		const { instrument } = await import("./counter.mjs");
		const path = join(root, "apps/web/src/server/jobs/mail.ts");
		const source = await readFile(path, "utf8");
		const listed = (names: string[]) => ({ "/apps/web/src/server/jobs/mail.ts": names });
		assert.match(
			instrument(path, source, listed(["claimUnknownMail"])),
			/measureWrapper\("jobs\/mail\.claimUnknownMail"/,
		);
		assert.throws(() => instrument(path, source, listed(["claimUnknownMail", "claimUnknownMailX"])), {
			message:
				"Statement counter lists claimUnknownMailX for apps/web/src/server/jobs/mail.ts, which declares no such function",
		});
	},
);

test("INV-census: a budget fails on growth, slack, a write above six without its measured statement mix, a promised review and a growing page", () => {
	const sample = (name: string, count: number, writes = 1, rollbacks = 0) => ({
		kind: "sample",
		name,
		count,
		writes,
		rollbacks,
		status: "ok",
		kinds: { write: writes, read: count - writes },
	});
	const rows = [
		sample("POST people.createPerson", 3),
		sample("people.addNote", 5),
		sample("people.addNote", 7, 1, 1),
		sample("tasks.edit", 9),
		...["tasks.move", "tasks.pause", "tasks.later", "tasks.copy", "tasks.split", "tasks.merge"].map((name) =>
			sample(name, 8),
		),
		sample("GET /people", 4, 0),
		sample("GET /people", 5, 0),
	];
	const limits = {
		"POST people.createPerson": { limit: 2 },
		"people.addNote": { limit: 6, retry: 7 },
		"tasks.edit": { limit: 9 },
		"tasks.move": { limit: 8, reason: "Above the pattern; RT-6 will look at it." },
		"tasks.pause": { limit: 8, reason: "Pending a follow-up review (RT-6)." },
		"tasks.later": { limit: 8, reason: "TODO: RT-6" },
		"tasks.copy": {
			limit: 8,
			reason: "Above the pattern today; RT-6 reviews it. Its largest first run: 7 read, 1 write.",
		},
		"tasks.split": { limit: 8, reason: "One read per field. Its largest first run: 6 read, 2 write." },
		"tasks.merge": { limit: 8, reason: "One read per copied field. Its largest first run: 7 read, 1 write." },
		"GET /people": { limit: 5 },
		"retired.write": { limit: 3 },
	};
	assert.deepEqual(checkBudgets(rows, limits), [
		"POST people.createPerson: 3 statements, limit 2 (1 write, 2 read)",
		"people.addNote: 5 statements at most, limit 6; set it to 5",
		"tasks.edit: limit 9 is above the 6-statement write pattern; add a reason",
		...["tasks.move", "tasks.pause", "tasks.later"].map(
			(name) => `${name}: its reason must state the measured statement mix: "Its largest first run: 7 read, 1 write."`,
		),
		'tasks.copy: its reason promises ("today") instead of naming the structural cause of each statement',
		"tasks.split: its reason states a largest first run of 6 read, 2 write, but it sent 7 read, 1 write",
		"GET /people: 4 and 5 statements as its data grows; a page read must be fixed",
		"retired.write: budgeted but never measured; remove it or exercise it",
	]);
});

test("INV-census: a missing budget fails the same way with the read rule on", () => {
	const rows = [
		{ kind: "sample", name: "people.unbudgeted", count: 2, writes: 1, rollbacks: 0, status: "ok", kinds: {} },
		{ kind: "sample", name: "people.read", count: 1, writes: 0, rollbacks: 0, status: "ok", kinds: {} },
	];
	assert.deepEqual(checkSamples(rows, {}), ["people.unbudgeted: 2 statements, no budget in limits.json"]);
	assert.deepEqual(checkBudgets(rows, { "people.unbudgeted": { limit: 2 } }), []);
});

const steps = (prefix: string, list: Array<[string, string[], boolean?, string?]>) =>
	list.map(([kind, tables, linked = false, skip], i) => ({
		id: `${prefix}:${i}`,
		kind,
		tables,
		linked,
		...(skip ? { skip } : {}),
	}));
const written = (name: string, list: ReturnType<typeof steps>) => ({
	kind: "sample",
	name,
	count: list.length,
	writes: list.filter((s) => s.kind === "write").length,
	rollbacks: 0,
	status: "ok",
	kinds: {},
	steps: list,
});
const baseTask = ["meeting", "obligation", "person", "plant", "recurrence", "task", "task_assignee", "team"];
const baseFacts = ["contact_outcome", "meeting", "obligation", "person", "task"];

test("INV-census: related reads in a row inside one write fail without a reads reason", () => {
	const gate = ["account", "onboarding_setup", "organization", "plant", "seat"];
	const lean = steps("a", [
		["transaction", []],
		["locked read", gate, false, "write gate"],
		["locked read", ["person", "task"]],
		["write", ["task"], true],
		["transaction", []],
	]);
	const added = steps("b", [
		["transaction", []],
		["locked read", gate, false, "write gate"],
		["locked read", ["person", "task"]],
		["read", ["contact_outcome"], true],
		["write", ["task"], true],
		["transaction", []],
	]);
	const limits = { "tasks.complete": { limit: 5 } };
	assert.deepEqual(checkBudgets([written("tasks.complete", lean)], limits), []);
	assert.deepEqual(checkBudgets([written("tasks.complete", added)], { "tasks.complete": { limit: 6 } }), [
		"tasks.complete: 2 reads in a row on related rows (locked read of person+task, then read of contact_outcome); make them one statement or give a reads reason",
	]);
	assert.deepEqual(
		checkBudgets([written("tasks.complete", added)], {
			"tasks.complete": { limit: 6, reads: "T-1: they wait on a lock" },
		}),
		[],
	);
	assert.deepEqual(checkBudgets([written("tasks.complete", lean)], { "tasks.complete": { limit: 5, reads: "T-1" } }), [
		"tasks.complete: no related reads in a row; remove its reads reason",
	]);
});

test("INV-census: the read rule flags the base commit's recordOutcome and holds a run to its innermost frame", () => {
	const domain = steps("r", [
		["locked read", baseTask],
		["locked read", baseFacts, true],
		["write", ["seat", "task"], true],
	]);
	const wrapped = [
		{ id: "w:0", kind: "transaction", tables: [], linked: false },
		{ id: "w:1", kind: "locked read", tables: ["account", "plant", "seat"], linked: false, skip: "write gate" },
		...domain,
		{ id: "w:2", kind: "transaction", tables: [], linked: false },
	];
	const limits = {
		"followups.recordOutcome": { limit: 3 },
		"followups/core.withFollowUpWrite": { limit: 6 },
	};
	assert.deepEqual(
		checkBudgets(
			[
				written("followups.recordOutcome", domain),
				written("followups/core.withFollowUpWrite:followups.recordOutcome", wrapped),
			],
			limits,
		),
		[
			"followups.recordOutcome: 2 reads in a row on related rows (locked read of meeting+obligation+person+plant+recurrence+task+task_assignee+team, then locked read of contact_outcome+meeting+obligation+person+task); make them one statement or give a reads reason",
		],
	);
	const merged = steps("m", [
		["locked read", [...new Set([...baseTask, ...baseFacts])].sort()],
		["write", ["seat", "task"], true],
	]);
	assert.deepEqual(
		checkBudgets([written("followups.recordOutcome", merged)], { "followups.recordOutcome": { limit: 2 } }),
		[],
	);
});

test("INV-census: platform statements and unrelated reads start a new run; a passed result value relates two reads", () => {
	assert.deepEqual(
		readRuns(
			steps("u", [
				["read", ["seat"], false, "session lookup"],
				["read", ["seat", "person"]],
				["read", ["meeting"]],
				["locked read", ["venue"], true],
			]),
		).map((run) => run.map((s) => s.id)),
		[["u:2", "u:3"]],
	);
	const id = "6f1c0b9e-6a51-4f0e-9d0b-1b7a3e0d2c11";
	const seen = new Set([id]);
	const facts = statementStep(
		`WITH k AS (SELECT t.id FROM task t JOIN plant pl ON pl.id=t.plant_id WHERE t.id=$1 FOR UPDATE OF t)
		SELECT (SELECT display_name FROM seat_identity($2)), (SELECT 1 FROM "public"."person" p WHERE p.id IN (SELECT id FROM k)
			AND p.state IS DISTINCT FROM 'merged' FOR SHARE), unnest($3::uuid[])`,
		["short", id],
		seen,
	);
	assert.deepEqual(facts, { kind: "locked read", tables: ["person", "plant", "task"], linked: true });
	assert.equal(statementStep("SELECT 1 FROM person WHERE id=$1", ["contacted"], new Set(["contacted"])).linked, false);
	assert.equal(statementStep(`WITH "write_gate" AS (SELECT 1) SELECT 1`, [], undefined).skip, "write gate");
});

test("INV-census: a zero-write replay with a suffixed name is held to its operation's retry budget", () => {
	const save = "people/commitments/index.saveCommitmentDocument";
	const name = save + ":people/core.withPeopleWrite:" + save;
	const rows = [
		{
			kind: "sample",
			name,
			count: 6,
			writes: 1,
			rollbacks: 0,
			status: "ok",
			ms: 271,
			kinds: { read: 1, transaction: 2, "locked read": 2, write: 1 },
		},
		{
			kind: "sample",
			name,
			count: 10,
			writes: 0,
			rollbacks: 2,
			status: "ok",
			ms: 590,
			kinds: { read: 3, transaction: 4, "locked read": 3 },
		},
	];
	assert.deepEqual(checkBudgets(rows, { [save]: { limit: 6, retry: 9 } }), [
		name + ": 10 statements, limit 9 (retry) (3 read, 4 transaction, 3 locked read)",
	]);
	assert.deepEqual(checkBudgets(rows, { [save]: { limit: 6, retry: 10 } }), []);
});

test("INV-census: the census union fails on a budget no part measured, a missing part and a skipped suite", async () => {
	const folder = await mkdtemp(join(tmpdir(), "evf-census-union-"));
	const sample = (name: string) => ({
		kind: "sample",
		name,
		count: 2,
		writes: 1,
		rollbacks: 0,
		status: "ok",
		kinds: {},
	});
	const limits = { "GET /people": { limit: 2 }, "people.addNote": { limit: 2 }, "tasks.edit": { limit: 2 } };
	const write = async (part: string, rows: object[]) => {
		await mkdir(join(folder, part), { recursive: true });
		await writeFile(join(folder, part, "counts.jsonl"), rows.map((row) => JSON.stringify(row) + "\n").join(""));
	};
	const units = ["requests.mjs", "people.test.mts", "tasks.test.mts", "unit.test.mts"];
	const marker = (index: number, ran: string[]) => ({ kind: "part", index, total: 2, ran });
	await write("part-1", [sample("GET /people"), marker(1, ["requests.mjs"])]);
	await write("part-2", [sample("people.addNote"), marker(2, ["people.test.mts", "tasks.test.mts", "unit.test.mts"])]);
	const rows = await unionRows(folder, units);
	assert.deepEqual(checkSamples(rows, limits), []);
	assert.deepEqual(checkBudgets(rows, limits), ["tasks.edit: budgeted but never measured; remove it or exercise it"]);
	const measured = [sample("people.addNote"), sample("tasks.edit")];
	await write("part-2", [...measured, marker(2, ["people.test.mts", "tasks.test.mts", "unit.test.mts"])]);
	assert.deepEqual(checkBudgets(await unionRows(folder, units), limits), []);
	await write("part-2", [...measured, marker(2, ["people.test.mts", "tasks.test.mts"])]);
	await assert.rejects(unionRows(folder, units), /The census parts must run every suite exactly once/);
	await write("part-2", [
		...measured,
		marker(2, ["requests.mjs", "people.test.mts", "tasks.test.mts", "unit.test.mts"]),
	]);
	await assert.rejects(unionRows(folder, units), /The census parts must run every suite exactly once/);
	await write("part-2", measured);
	await assert.rejects(unionRows(folder, units), /The census union needs every part exactly once/);
});

test("INV-census: every request and write stays within its statement budget", { timeout: 30 * 60 * 1000 }, async () => {
	const limits = JSON.parse(await readFile(new URL("./limits.json", import.meta.url), "utf8"));
	if (census.kind === "union") return checkWhole(await unionRows(census.folder, await censusUnits()), limits);
	const parent = process.env.EVF_CENSUS_LOGS ?? tmpdir();
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "evf-write-counts-")),
		output = join(directory, "counts.jsonl");
	await writeFile(output, "");
	const requestsScript = join(root, REQUESTS),
		nativeScript = join(root, NATIVE);
	const suites = (await censusSuites()).map((file) => join(root, file));
	const part = census.kind === "part" ? census : { index: 1, total: 1 };
	const files = partSuites(suites, part.index, part.total);
	const ran: string[] = [];
	const typescript = [
		process.env.NODE_OPTIONS ?? "",
		"--conditions=react-server",
		"--import=" + pathToFileURL(join(root, "packages/domain/node_modules/tsx/dist/esm/index.mjs")).href,
	];
	const counted = [...typescript, "--import=" + pathToFileURL(join(root, "tests/integration/writes/counter.mjs")).href];
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	async function run(label: string, args: string[], nodeOptions: string[]) {
		const child = spawn(process.execPath, ["--env-file-if-exists=" + join(root, "apps/web/.env.local"), ...args], {
			cwd: join(root, "packages/domain"),
			env: {
				...environment,
				EARLY_ACCESS_TEST_DATABASE: "1",
				EVF_WRITE_COUNTS: output,
				NODE_OPTIONS: nodeOptions.join(" "),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (chunk) => {
				log += chunk;
				appendFileSync(join(directory, label + ".log"), chunk);
			});
		const exit = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		return { exit, log, evidence: join(directory, label + ".log") };
	}
	if (part.index === 1) {
		const requests = await run("requests", [requestsScript], typescript);
		assert.equal(
			requests.exit,
			0,
			"HTTP request proof failed: " + requests.evidence + "\n" + requests.log.slice(-2000),
		);
		const native = await run("native", [nativeScript], counted);
		assert.equal(native.exit, 0, "Native boundary proof failed: " + native.evidence + "\n" + native.log.slice(-1000));
		ran.push(requestsScript, nativeScript);
	}
	if (files.length) {
		const behaviors = await run("behaviors", ["--test", "--test-concurrency=2", ...files], counted);
		assert.equal(
			behaviors.exit,
			0,
			"Behavior suites failed; evidence: " +
				behaviors.evidence +
				"\n" +
				behaviors.log
					.split("\n")
					.filter((line) => line.includes("✖"))
					.join("\n"),
		);
		ran.push(...files);
	}
	console.log("Statement census:", output);

	const rows = parseRows(await readFile(output, "utf8"));
	if (census.kind === "whole") return checkWhole(rows, limits);
	checkPart(rows, limits);
	const marker = { kind: "part", index: part.index, total: part.total, ran: ran.map((file) => relative(root, file)) };
	appendFileSync(output, JSON.stringify(marker) + "\n");
});
