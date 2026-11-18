import { appendFileSync, globSync, statSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBudgets, checkSamples, tighten } from "./budgets.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

type Census = { kind: "whole" } | { kind: "part"; index: number; total: number } | { kind: "union"; folder: string };
type Row = { kind: string; [key: string]: any };

function censusMode(part = process.env.EVF_CENSUS_PART, union = process.env.EVF_CENSUS_UNION): Census {
	if (part && union) throw Error("Set EVF_CENSUS_PART or EVF_CENSUS_UNION, not both");
	if (union) return { kind: "union", folder: union };
	if (!part) return { kind: "whole" };
	const [index, total] = (/^(\d+)\/(\d+)$/.exec(part) ?? []).slice(1).map(Number);
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
	return index === 1 ? [] : parts[index - 2].files;
}

const parseRows = (text: string): Row[] =>
	text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

async function censusUnits(): Promise<string[]> {
	const patterns = JSON.parse(await readFile(new URL("./suites.json", import.meta.url), "utf8"));
	return [
		"tests/integration/writes/requests.mjs",
		"tests/integration/writes/native.mjs",
		...globSync(patterns, { cwd: root }),
	];
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

async function finishWhole(rows: Row[], limits: object, units: string[]) {
	const tightened = tighten(rows, limits, units);
	for (const change of tightened?.changes ?? []) console.log("Census notice: " + change);
	const folder = process.env.EVF_CENSUS_TIGHTENED;
	if (folder && tightened?.changes.length) {
		await mkdir(folder, { recursive: true });
		await writeFile(join(folder, "limits.json"), JSON.stringify(tightened.limits, null, "\t") + "\n");
		await writeFile(
			join(folder, "changes.md"),
			"### Statement budgets tightened\n\nCommit this `tests/integration/writes/limits.json` in the same PR:\n\n" +
				tightened.changes.map((change) => "- " + change + "\n").join(""),
		);
	}
	checkWhole(rows, limits);
}

let counter: Promise<{ output: string; module: any }> | undefined;
function countedDatabase() {
	counter ??= (async () => {
		const output = join(await mkdtemp(join(tmpdir(), "evf-write-pool-")), "counts.jsonl");
		process.env.EVF_WRITE_COUNTS = output;
		const module = await import("./counter.mjs").finally(() => delete process.env.EVF_WRITE_COUNTS);
		return { output, module };
	})();
	return counter;
}
const countedRows = async (output: string) => parseRows(await readFile(output, "utf8"));

test("BUG-PR193: a pooled query counts in the request that issued it", { skip: census.kind === "union" }, async () => {
	const {
		output,
		module: { measure, observeDatabase },
	} = await countedDatabase();
	const pg = createRequire(join(root, "packages/db/package.json"))("pg");
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	observeDatabase({ $client: pool });
	try {
		await Promise.all(["a", "b", "c"].map((name) => measure(name, () => pool.query("SELECT 1"))));
	} finally {
		await pool.end();
	}
	const counts = (await countedRows(output))
		.filter((row) => row.kind === "sample" && ["a", "b", "c"].includes(row.name))
		.map((row) => [row.name, row.count]);
	assert.deepEqual(Object.fromEntries(counts), { a: 1, b: 1, c: 1 });
});

test(
	"INV-census: a real write over its budget fails, and a per-row loop fails as N+1 where its batched twin passes",
	{ skip: census.kind === "union" },
	async () => {
		const {
			output,
			module: { measure, observeDatabase },
		} = await countedDatabase();
		const pg = createRequire(join(root, "packages/db/package.json"))("pg");
		const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
		observeDatabase({ $client: pool });
		const ids = [1, 2, 3];
		try {
			await pool.query("CREATE TEMP TABLE census_note (id int PRIMARY KEY, body text NOT NULL)");
			await measure("census.overBudget", async () => {
				await pool.query("SELECT 1");
				await pool.query("INSERT INTO census_note (id, body) VALUES ($1, $2)", [0, "first"]);
				await pool.query("SELECT 2");
			});
			await measure("census.perRow", async () => {
				for (const id of ids) await pool.query("INSERT INTO census_note (id, body) VALUES ($1, $2)", [id, "row"]);
			});
			await measure("census.batched", () =>
				pool.query("INSERT INTO census_note (id, body) SELECT id, 'set' FROM unnest($1::int[]) AS id", [
					ids.map((id) => id + 10),
				]),
			);
		} finally {
			await pool.end();
		}
		const rows = (await countedRows(output)).filter((row) => row.name?.startsWith("census."));
		const limits = { "census.overBudget": { limit: 2 }, "census.perRow": { limit: 6 }, "census.batched": { limit: 1 } };
		const perRow =
			"census.perRow: N+1, sends the same statement 3 times in one run: INSERT INTO census_note (id, body) VALUES (?); batch it into one set-based statement, or give limits.json a repeats reason";
		assert.deepEqual(checkSamples(rows, limits), [
			"census.overBudget: 3 statements, limit 2 (2 read, 1 write)",
			perRow,
		]);
		assert.deepEqual(
			rows.map((row) => [row.name, row.count]),
			[
				["census.overBudget", 3],
				["census.perRow", 3],
				["census.batched", 1],
			],
		);
		assert.deepEqual(checkSamples(rows, { ...limits, "census.overBudget": { limit: 3 } }), [perRow]);
	},
);

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

const sample = (name: string, count: number, writes = 1, rollbacks = 0, repeats?: Record<string, number>) => ({
	kind: "sample",
	name,
	count,
	writes,
	rollbacks,
	status: "ok",
	kinds: { write: writes, read: count - writes },
	...(repeats ? { repeats } : {}),
});

test("INV-census: a budget fails on growth, an unexplained write above six and a growing page", () => {
	const rows = [
		sample("POST people.createPerson", 3),
		sample("people.addNote", 5),
		sample("people.addNote", 7, 1, 1),
		sample("tasks.edit", 9),
		sample("GET /people", 4, 0),
		sample("GET /people", 5, 0),
	];
	const limits = {
		"POST people.createPerson": { limit: 2 },
		"people.addNote": { limit: 6, retry: 7 },
		"tasks.edit": { limit: 9 },
		"GET /people": { limit: 5 },
		"retired.write": { limit: 3 },
	};
	assert.deepEqual(checkBudgets(rows, limits), [
		"POST people.createPerson: 3 statements, limit 2 (1 write, 2 read)",
		"tasks.edit: 9 statements is above the 6-statement write pattern; add a reason",
		"GET /people: 4 and 5 statements as its data grows; a page read must be fixed",
		"retired.write: budgeted but never measured; remove it or exercise it",
	]);
});

test("INV-census: slack, a stale reason and an unbudgeted retry pass and print the tightened entry", () => {
	const rows = [
		sample("people.addNote", 5),
		sample("tasks.edit", 4),
		sample("meetings.save", 3),
		sample("meetings.save", 7, 1, 1),
		{ kind: "part", index: 1, total: 1, ran: ["a.test.mts"] },
	];
	const limits = {
		"people.addNote": { limit: 6 },
		"tasks.edit": { limit: 4, reason: "Used to send nine statements." },
		"meetings.save": { limit: 3 },
	};
	assert.deepEqual(checkSamples(rows, limits), []);
	assert.deepEqual(checkBudgets(rows, limits), []);
	assert.deepEqual(tighten(rows, limits, ["a.test.mts"])?.changes, [
		'people.addNote: 5 statements at most, limit 6; tightened to {"limit":5}',
		'tasks.edit: within the 6-statement write pattern, so its reason is stale; tightened to {"limit":4}',
		'meetings.save: a retry run sent 7 statements and had no retry budget; tightened to {"limit":3,"retry":7}',
	]);
});

test("INV-census: a statement sent once per row fails as N+1 inside its budget unless limits.json says why", () => {
	const shape = "insert into note (id, body) values (?)";
	const rows = [
		sample("people.addNotes", 4, 3, 0, { [shape]: 3 }),
		sample("people.addNotes", 6, 5, 0, { [shape]: 5 }),
		sample("people.addNote", 4, 2, 0, { [shape]: 2 }),
		sample("people.addNote", 9, 3, 1, { [shape]: 6 }),
		sample("GET /people", 5, 0, 0, { "select * from person where id = ?": 4 }),
	];
	const limits = {
		"people.addNotes": { limit: 6 },
		"people.addNote": { limit: 4, retry: 9 },
		"GET /people": { limit: 5 },
	};
	assert.deepEqual(checkSamples(rows, limits), [
		`people.addNotes: N+1, sends the same statement 5 times in one run: ${shape}; batch it into one set-based statement, or give limits.json a repeats reason`,
		"GET /people: N+1, sends the same statement 4 times in one run: select * from person where id = ?; batch it into one set-based statement, or give limits.json a repeats reason",
	]);
	const explained = {
		...limits,
		"people.addNotes": { limit: 6, repeats: "One insert per imported file, at most three." },
		"GET /people": { limit: 5, repeats: "One read per fixed section." },
	};
	assert.deepEqual(checkBudgets(rows, explained), []);
});

test("INV-census: the tightener rewrites limits.json after every suite ran and leaves a subset alone", async () => {
	const folder = await mkdtemp(join(tmpdir(), "evf-census-tighten-"));
	const units = ["requests.mjs", "people.test.mts"];
	const write = async (part: string, rows: object[]) => {
		await mkdir(join(folder, part), { recursive: true });
		await writeFile(join(folder, part, "counts.jsonl"), rows.map((row) => JSON.stringify(row) + "\n").join(""));
	};
	await write("part-1", [sample("GET /people", 2, 0), { kind: "part", index: 1, total: 2, ran: ["requests.mjs"] }]);
	await write("part-2", [
		sample("people.addNote", 4),
		sample("people.addNote", 6, 1, 1),
		sample("people.merge", 3),
		{ kind: "part", index: 2, total: 2, ran: ["people.test.mts"] },
	]);
	const limits = {
		"GET /people": { limit: 3 },
		"people.addNote": { limit: 8, reason: "Reads both people." },
		"people.merge": { limit: 3, repeats: "One update per merged field." },
	};
	const rows = await unionRows(folder, units);
	assert.deepEqual(checkBudgets(rows, limits), []);
	assert.deepEqual(tighten(rows, limits, units)?.limits, {
		"GET /people": { limit: 2 },
		"people.addNote": { limit: 4, retry: 6 },
		"people.merge": { limit: 3 },
	});
	const part2 = rows.filter((row) => !(row.kind === "part" && row.index === 1));
	assert.equal(tighten(part2, limits, units), null);
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
	const two = (name: string) => ({
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
	await write("part-1", [two("GET /people"), marker(1, ["requests.mjs"])]);
	await write("part-2", [two("people.addNote"), marker(2, ["people.test.mts", "tasks.test.mts", "unit.test.mts"])]);
	const rows = await unionRows(folder, units);
	assert.deepEqual(checkSamples(rows, limits), []);
	assert.deepEqual(checkBudgets(rows, limits), ["tasks.edit: budgeted but never measured; remove it or exercise it"]);
	const measured = [two("people.addNote"), two("tasks.edit")];
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
	const units = await censusUnits();
	if (census.kind === "union") return finishWhole(await unionRows(census.folder, units), limits, units);
	const parent = process.env.EVF_CENSUS_LOGS ?? tmpdir();
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "evf-write-counts-")),
		output = join(directory, "counts.jsonl");
	await writeFile(output, "");
	const [requestsScript, nativeScript, ...suites] = units.map((file) => join(root, file));
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
	const marker = { kind: "part", index: part.index, total: part.total, ran: ran.map((file) => relative(root, file)) };
	if (census.kind === "whole") return finishWhole([...rows, marker], limits, units);
	checkPart(rows, limits);
	appendFileSync(output, JSON.stringify(marker) + "\n");
});
