import { appendFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// One regression checks real writes across the existing behavior suites. It records no SQL or parameters.
test("D69/D70: every shipped write stays within its statement budget", { timeout: 30 * 60 * 1000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "evf-write-counts-")),
		output = join(directory, "counts.jsonl");
	const patterns = JSON.parse(await readFile(new URL("./suites.json", import.meta.url), "utf8"));
	const { globSync } = await import("node:fs");
	const files = globSync(patterns, { cwd: root }).map((file) => join(root, file));
	const nodeOptions = [
		process.env.NODE_OPTIONS ?? "",
		"--conditions=react-server",
		"--import=" + pathToFileURL(join(root, "packages/domain/node_modules/tsx/dist/esm/index.mjs")).href,
		"--import=" + pathToFileURL(join(root, "tests/integration/writes/counter.mjs")).href,
	].join(" ");
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	// Check native entry points first so retired imports or producers fail before the long corpus.
	const native = spawn(
		process.execPath,
		["--env-file-if-exists=" + join(root, "apps/web/.env.local"), join(root, "tests/integration/writes/native.mjs")],
		{
			cwd: join(root, "packages/domain"),
			env: { ...environment, EARLY_ACCESS_TEST_DATABASE: "1", EVF_WRITE_COUNTS: output, NODE_OPTIONS: nodeOptions },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let nativeLog = "";
	for (const stream of [native.stdout, native.stderr])
		stream.on("data", (chunk) => {
			nativeLog += chunk;
			appendFileSync(join(directory, "native.log"), chunk);
		});
	const nativeExit = await new Promise<number | null>((resolve, reject) => {
		native.once("error", reject);
		native.once("exit", resolve);
	});
	assert.equal(
		nativeExit,
		0,
		"Native boundary proof failed: " + join(directory, "native.log") + "\n" + nativeLog.slice(-1000),
	);
	const child = spawn(
		process.execPath,
		["--env-file-if-exists=" + join(root, "apps/web/.env.local"), "--test", "--test-concurrency=2", ...files],
		{
			cwd: join(root, "packages/domain"),
			env: { ...environment, EARLY_ACCESS_TEST_DATABASE: "1", EVF_WRITE_COUNTS: output, NODE_OPTIONS: nodeOptions },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let log = "";
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk) => {
			log += chunk;
			appendFileSync(join(directory, "behaviors.log"), chunk);
		});
	const exit = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	await writeFile(join(directory, "behaviors.log"), log);
	console.log("Statement census:", output);
	assert.equal(
		exit,
		0,
		"Behavior suites failed; evidence: " +
			join(directory, "behaviors.log") +
			"\n" +
			log
				.split("\n")
				.filter((line) => line.includes("✖"))
				.join("\n"),
	);

	const rows = (await readFile(output, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const limits = JSON.parse(await readFile(new URL("./limits.json", import.meta.url), "utf8"));
	// Writes always need a budget; a read named in the budget file (a native read boundary) is held to it too.
	const samples = rows.filter(
		(row) => row.kind === "sample" && row.status !== "threw" && (row.writes > 0 || Object.hasOwn(limits, row.name)),
	);
	assert.ok(samples.length > 0, "No database writes were measured");
	for (const sample of samples) {
		const name = Object.hasOwn(limits, sample.name) ? sample.name : sample.name.split(":")[0];
		assert.ok(Object.hasOwn(limits, name), "A write needs an explicit statement budget: " + sample.name);
		const budget = limits[name];
		assert.ok(
			sample.count <= (sample.rollbacks ? budget.retry : budget.limit),
			`${sample.name}: ${sample.count} statements, budget ${sample.rollbacks ? budget.retry : budget.limit}`,
		);
	}
	// BUG-PR193: reserve always issues its one statement, so zero means another request took its count.
	for (const sample of samples.filter((row) => row.name === "identity.budget.reserve"))
		assert.ok(sample.count > 0, "identity.budget.reserve counted 0 statements");
	const covered = new Set(samples.map((row) => row.name.split(":")[0]));
	for (const row of rows.filter((row) => row.kind === "declaration" && row.write))
		assert.ok(covered.has(row.name), "A declared write has no successful real-database exercise: " + row.name);
});
