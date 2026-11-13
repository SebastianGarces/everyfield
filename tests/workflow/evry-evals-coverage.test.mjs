// OPS-102: every Evry adapter operation and catalog tool ships with recorded eval cases. Operations are discovered from
// the adapter source (reads and commands) and catalog tools from packages/evry/src/catalog/catalog.ts, never from a
// hand-kept list. This is the only test that asserts operation coverage. An operation is covered when a case object in
// tests/evry/evals/*.cases.json has "operation": "<name>". The baseline lists operations uncovered today and only
// shrinks (rule: .agents/skills/test-standard/SKILL.md). Discovery is held to what the package itself registers: its
// read domains, its reviewed writes and the catalog's exported tool names. No database, env, network or build.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const NAME = "[a-z][A-Za-z]*(?:\\.[a-z][A-Za-z]*)+";

// An operation is a string in an `operation: "x.y",` property or a factory call such as `readHousehold("x.y")`
// inside an exported declaration. A union type (`"a" | "b"`) and non-exported helpers add nothing by themselves.
function discoverOperations() {
	const found = new Set();
	const adapters = path("packages/evry/src/adapters/");
	for (const group of readdirSync(adapters, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
		for (const kind of ["reads", "commands"]) {
			let files;
			try {
				files = readdirSync(`${adapters}${group.name}/${kind}`).filter((f) => /\.ts$/.test(f) && !/\.test\./.test(f));
			} catch {
				continue;
			}
			for (const file of files) {
				const source = readFileSync(`${adapters}${group.name}/${kind}/${file}`, "utf8");
				for (const chunk of source.split(/^export /m).slice(1)) {
					for (const m of chunk.matchAll(new RegExp(`\\boperation:\\s*"(${NAME})"\\s*,`, "g"))) found.add(m[1]);
					for (const m of chunk.matchAll(new RegExp(`\\b[A-Za-z]\\w*\\(\\s*"(${NAME})"\\s*\\)`, "g"))) found.add(m[1]);
				}
			}
		}
	}
	return [...found].sort();
}

// A catalog tool is an exported `"evry.x"` string constant in catalog.ts, such as SELECT_RETURNED_ROWS.
function discoverCatalogTools() {
	const source = readFileSync(path("packages/evry/src/catalog/catalog.ts"), "utf8");
	return [...source.matchAll(/^export const \w+\s*=\s*"(evry\.[a-z][A-Za-z]*)"/gm)].map((m) => m[1]).sort();
}

// What the package registers: every read adapter in READ_DOMAINS, every reviewed write in REVIEWED_WRITES and every
// exported "evry.…" string in catalog.ts. The package needs the react-server condition, so a child process reads it.
function registered() {
	const script = `
		const catalog = await import(${JSON.stringify(path("packages/evry/src/catalog/catalog.ts"))});
		const writes = await import(${JSON.stringify(path("packages/evry/src/proposals/store.ts"))});
		console.log(JSON.stringify({
			operations: [...Object.values(catalog.READ_DOMAINS).flat().map((a) => a.operation), ...Object.keys(writes.REVIEWED_WRITES)].sort(),
			tools: Object.values(catalog).filter((v) => typeof v === "string" && v.startsWith("evry.")).sort(),
		}));`;
	const out = execFileSync(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", script], {
		encoding: "utf8",
	});
	return JSON.parse(out);
}

function coveredOperations() {
	const dir = path("tests/evry/evals/");
	const covered = new Set();
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".cases.json"))) {
		const walk = (node) => {
			if (Array.isArray(node)) node.forEach(walk);
			else if (node && typeof node === "object") {
				if (typeof node.operation === "string") covered.add(node.operation);
				Object.values(node).forEach(walk);
			}
		};
		walk(JSON.parse(readFileSync(`${dir}${file}`, "utf8")));
	}
	return covered;
}

function coverageProblems(operations, covered, baseline) {
	const problems = [];
	const known = new Set(operations);
	for (const op of operations)
		if (!covered.has(op) && !baseline.includes(op))
			problems.push(`${op} has no eval case in tests/evry/evals/*.cases.json and is not in the baseline`);
	for (const op of baseline) {
		if (!known.has(op))
			problems.push(`${op} is in the baseline but no adapter exports it: remove it from the baseline`);
		else if (covered.has(op)) problems.push(`${op} now has an eval case: remove it from the baseline`);
	}
	return problems;
}

const baseline = JSON.parse(readFileSync(path("tests/workflow/evry-evals-baseline.json"), "utf8"));

test("INV-OPS102: discovery finds exactly the operations and catalog tools the package registers", () => {
	const { operations, tools } = registered();
	assert.deepEqual(discoverOperations(), operations);
	assert.deepEqual(discoverCatalogTools(), tools);
});

test("INV-OPS102: the baseline is sorted, unique and one name each", () => {
	assert.deepEqual(baseline, [...new Set(baseline)].sort());
});

test("INV-OPS102: every adapter operation and catalog tool has an eval case or sits in the shrinking baseline", () => {
	const names = [...discoverOperations(), ...discoverCatalogTools()];
	assert.deepEqual(coverageProblems(names, coveredOperations(), baseline), []);
});

test("INV-OPS102: an uncovered operation or catalog tool, a covered baseline entry and a vanished baseline entry each fail by name", () => {
	const ops = ["people.a", "people.b"];
	assert.deepEqual(coverageProblems(ops, new Set(["people.a"]), []), [
		"people.b has no eval case in tests/evry/evals/*.cases.json and is not in the baseline",
	]);
	assert.deepEqual(coverageProblems(["people.a", "evry.pickRows"], new Set(["people.a"]), []), [
		"evry.pickRows has no eval case in tests/evry/evals/*.cases.json and is not in the baseline",
	]);
	assert.deepEqual(coverageProblems(ops, new Set(["people.a", "people.b"]), ["people.b"]), [
		"people.b now has an eval case: remove it from the baseline",
	]);
	assert.deepEqual(coverageProblems(ops, new Set(ops), ["people.gone"]), [
		"people.gone is in the baseline but no adapter exports it: remove it from the baseline",
	]);
});
