import test from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { CASES, BASE_FILES } from "../typecheck-corpus.ts";
import { parseTime } from "../typecheck-compare.ts";

test("T-53: the corpus seeds at least 30 errors in all 7 packages, with the required kinds", () => {
	const expected = CASES.flatMap((c) => c.expect);
	assert.ok(expected.length >= 30, `${expected.length} seeded errors`);
	assert.deepEqual([...new Set(expected.map((e) => e.pkg))].sort(), [
		"apps/web",
		"packages/contracts",
		"packages/db",
		"packages/domain",
		"packages/evry",
		"packages/reference",
		"packages/ui",
	]);
	const kinds = CASES.map((c) => c.kind).join("\n");
	for (const kind of [
		/JSX/,
		/noUncheckedIndexedAccess/,
		/unused @ts-expect-error/,
		/missing .*module/,
		/workspace export/,
	])
		assert.match(kinds, kind);
	assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, "case ids are unique");
	// Every write is a path inside the temporary copy.
	for (const file of [...Object.keys(BASE_FILES), ...CASES.flatMap((c) => Object.keys(c.files))])
		assert.ok(!isAbsolute(file) && !file.split("/").includes(".."), file);
});

test("T-53: the comparison reads CPU and peak memory from BSD and GNU /usr/bin/time", () => {
	assert.deepEqual(
		parseTime(
			"        0.14 real         0.24 user         0.23 sys\n           162955264  maximum resident set size\n",
		),
		{ cpu_s: 0.47, peak_mb: 162955264 / 2 ** 20 },
	);
	const gnu = parseTime(
		"\tUser time (seconds): 1.50\n\tSystem time (seconds): 0.25\n\tMaximum resident set size (kbytes): 2048\n",
	);
	assert.equal(gnu.peak_mb, 2);
	assert.ok(Math.abs(gnu.cpu_s - 1.75) < 1e-9);
});
