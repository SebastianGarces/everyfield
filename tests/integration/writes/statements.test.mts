import { appendFileSync, globSync, statSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBudgets, checkSamples } from "./budgets.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// CI splits the census into parts. EVF_CENSUS_PART=i/N runs part i of N: part 1 runs the HTTP requests and the native
// boundaries, and the behavior suites spread over the other parts. A part checks only what its own samples show. Each
// passing part adds a marker to its counts file that names the scripts and suites it ran. EVF_CENSUS_UNION=<folder>
// requires each of them exactly once over all N parts, then checks every rule over their counts files, so a skipped suite
// or a budget that no part measured still fails. Without either variable one run does all of it.
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

/** The behavior suites of part `index`: the largest file goes to the part with the fewest bytes, so parts stay even. */
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

/** Everything one census runs, as repository paths: the request and native scripts, then the behavior suites. */
async function censusUnits(): Promise<string[]> {
	const patterns = JSON.parse(await readFile(new URL("./suites.json", import.meta.url), "utf8"));
	return [
		"tests/integration/writes/requests.mjs",
		"tests/integration/writes/native.mjs",
		...globSync(patterns, { cwd: root }),
	];
}

/** The rows of every counts file under `folder`: each part of one split exactly once, together running `units` once. */
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

/** What one part's samples show alone: each sample within its budget, and reserve never counted at zero. */
function checkPart(rows: Row[], limits: object) {
	// BUG-PR193: reserve always issues its one statement, so zero means another request took its count.
	const reserves = rows.filter(
		(row) => row.kind === "sample" && row.status !== "threw" && row.name === "identity.budget.reserve",
	);
	for (const sample of reserves) assert.ok(sample.count > 0, "identity.budget.reserve counted 0 statements");
	assert.deepEqual(checkSamples(rows, limits), []);
}

/** Every rule over the whole census: the part rules, every budget measured, and every declared write exercised. */
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

// pg-pool hands a freed client to a waiting request inside the release of the request before it.
test("BUG-PR193: a pooled query counts in the request that issued it", { skip: census.kind === "union" }, async () => {
	const output = join(await mkdtemp(join(tmpdir(), "evf-write-pool-")), "counts.jsonl");
	process.env.EVF_WRITE_COUNTS = output;
	const { measure, observeDatabase } = await import("./counter.mjs").finally(() => delete process.env.EVF_WRITE_COUNTS);
	const pg = createRequire(join(root, "packages/db/package.json"))("pg");
	const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	observeDatabase({ $client: pool });
	try {
		await Promise.all(["a", "b", "c"].map((name) => measure(name, () => pool.query("SELECT pg_sleep(0.05)"))));
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

// The budget rules themselves: growth, slack, a write above the pattern without a reason and a page that grows.
test("RT-4: a budget fails on growth, slack, an unexplained write above six and a growing page", () => {
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
		"people.addNote: 5 statements at most, limit 6; set it to 5",
		"tasks.edit: limit 9 is above the 6-statement write pattern; add a reason",
		"GET /people: 4 and 5 statements as its data grows; a page read must be fixed",
		"retired.write: budgeted but never measured; remove it or exercise it",
	]);
});

// F8: a replay through a shared wrapper writes nothing and carries a variant suffix; it still meets its retry budget.
test("F8: a zero-write replay with a suffixed name is held to its operation's retry budget", () => {
	const save = "people/commitments/index.saveCommitmentDocument";
	const name = save + ":people/core.withPeopleWrite:" + save;
	// Two samples from the #251 verifier's census: the first save and its replay.
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

// WP-087: the union of the parts holds every whole-census rule. A budget that no part measured fails, and so does a
// missing part, which would otherwise drop its budgets from the check. A suite that no part ran fails even when it
// measured nothing of its own, and so does a suite that two parts ran.
test("WP-087: the census union fails on a budget no part measured, a missing part and a skipped suite", async () => {
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
	// unit.test.mts measures nothing, so only the list of suites the part ran shows that it was skipped.
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

// One regression checks every budget in limits.json: real HTTP requests on the production build, the native write
// boundaries and every write the behavior suites run. It records no SQL or parameters.
test("D69/D70: every request and write stays within its statement budget", { timeout: 30 * 60 * 1000 }, async () => {
	const limits = JSON.parse(await readFile(new URL("./limits.json", import.meta.url), "utf8"));
	if (census.kind === "union") return checkWhole(await unionRows(census.folder, await censusUnits()), limits);
	// CI names a folder (EVF_CENSUS_LOGS) and uploads it: these logs and the counts file.
	const parent = process.env.EVF_CENSUS_LOGS ?? tmpdir();
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(join(parent, "evf-write-counts-")),
		output = join(directory, "counts.jsonl");
	await writeFile(output, "");
	const [requestsScript, nativeScript, ...suites] = (await censusUnits()).map((file) => join(root, file));
	const part = census.kind === "part" ? census : { index: 1, total: 1 };
	const files = partSuites(suites, part.index, part.total);
	// What this part ran and passed, as repository paths, for the union to require each exactly once.
	const ran: string[] = [];
	const typescript = [
		process.env.NODE_OPTIONS ?? "",
		"--conditions=react-server",
		"--import=" + pathToFileURL(join(root, "packages/domain/node_modules/tsx/dist/esm/index.mjs")).href,
	];
	const counted = [...typescript, "--import=" + pathToFileURL(join(root, "tests/integration/writes/counter.mjs")).href];
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	// Runs one node process with the counts file; answers its exit code and keeps its output as evidence.
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
	// HTTP requests and native entry points first, so a missing build or a retired producer fails before the corpus.
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
