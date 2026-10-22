import { appendFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBudgets } from "./budgets.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// pg-pool hands a freed client to a waiting request inside the release of the request before it.
test("BUG-PR193: a pooled query counts in the request that issued it", async () => {
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

// One regression checks every budget in limits.json: real HTTP requests on the production build, the native write
// boundaries and every write the behavior suites run. It records no SQL or parameters.
test("D69/D70: every request and write stays within its statement budget", { timeout: 30 * 60 * 1000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "evf-write-counts-")),
		output = join(directory, "counts.jsonl");
	const patterns = JSON.parse(await readFile(new URL("./suites.json", import.meta.url), "utf8"));
	const { globSync } = await import("node:fs");
	const files = globSync(patterns, { cwd: root }).map((file) => join(root, file));
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
	const requests = await run("requests", [join(root, "tests/integration/writes/requests.mjs")], typescript);
	assert.equal(requests.exit, 0, "HTTP request proof failed: " + requests.evidence + "\n" + requests.log.slice(-2000));
	const native = await run("native", [join(root, "tests/integration/writes/native.mjs")], counted);
	assert.equal(native.exit, 0, "Native boundary proof failed: " + native.evidence + "\n" + native.log.slice(-1000));
	const behaviors = await run("behaviors", ["--test", "--test-concurrency=2", ...files], counted);
	console.log("Statement census:", output);
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

	const rows = (await readFile(output, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const limits = JSON.parse(await readFile(new URL("./limits.json", import.meta.url), "utf8"));
	assert.ok(
		rows.some((row) => row.kind === "sample" && row.name.startsWith("GET ")),
		"No HTTP request was measured",
	);
	assert.deepEqual(checkBudgets(rows, limits), []);
	// BUG-PR193: reserve always issues its one statement, so zero means another request took its count.
	const reserves = rows.filter(
		(row) => row.kind === "sample" && row.status !== "threw" && row.name === "identity.budget.reserve",
	);
	for (const sample of reserves) assert.ok(sample.count > 0, "identity.budget.reserve counted 0 statements");
	const covered = new Set(
		rows
			.filter(
				(row) => row.kind === "sample" && row.status !== "threw" && (row.writes > 0 || Object.hasOwn(limits, row.name)),
			)
			.map((row) => row.name.split(":")[0]),
	);
	for (const row of rows.filter((row) => row.kind === "declaration" && row.write))
		assert.ok(covered.has(row.name), "A declared write has no successful real-database exercise: " + row.name);
});
