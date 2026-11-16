import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reviewProof } from "../review-proof.ts";
import { fixture, put } from "./feature-map-fixture.ts";

const ROUTE = "apps/web/src/app/(product)/things/page.tsx";
const FEATURE_FILE = "apps/web/src/features/things/routes.tsx";
const PACKAGE_FILE = "packages/core/src/things.ts";

const png = (width: number) => {
	const bytes = Buffer.alloc(33);
	Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
	bytes.writeUInt32BE(width, 16);
	bytes.writeUInt32BE(900, 20);
	return bytes;
};

function run(changed: string[], proved: string[], shots: Record<string, Buffer | string> = {}) {
	const root = fixture();
	const evidence = mkdtempSync(join(tmpdir(), "review-proof-"));
	try {
		for (const [file, content] of Object.entries(shots)) put(evidence, file, content);
		return reviewProof(root, changed, evidence, proved);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(evidence, { recursive: true, force: true });
	}
}

const BOTH = { "proof/things.list/phone.png": png(390), "proof/things.list/desktop.png": png(1440) };
const missing = (width: number) => (problem: string) =>
	problem.startsWith(`things.list: has no ${width} px screenshot and no recording in `);

test("INV-review-proof: a diff of only tooling, docs, tests or agent instructions passes and says no app proof is needed", () => {
	const result = run(
		[
			"tools/ci/feature-maps.ts",
			"docs/feature-maps/README.md",
			".agents/roles/verifier.md",
			"tests/integration/things.test.mts",
			"packages/core/src/things.test.ts",
			"apps/web/feature-maps.pending.json",
		],
		[],
	);
	assert.deepEqual(result.problems, []);
	assert.equal(result.needed, false);
	assert.equal(
		result.report,
		"No app proof needed: the diff changes only tooling, docs, tests or agent instructions (6 file(s)).\n",
	);
});

test("INV-review-proof: a changed mapped route requires its surface at both widths, and a filled folder passes", () => {
	const empty = run([ROUTE], []);
	assert.equal(empty.needed, true);
	assert.equal(empty.problems.length, 2);
	assert.ok(empty.problems.some(missing(390)) && empty.problems.some(missing(1440)), empty.problems.join("\n"));
	assert.deepEqual(run([ROUTE], ["things.list"], BOTH).problems, []);
});

test("INV-review-proof: a folder missing one width fails naming the surface and width; a recording alone is enough", () => {
	const phoneOnly = run([ROUTE], ["things.list"], { "proof/things.list/phone.png": png(390) });
	assert.equal(phoneOnly.problems.length, 1);
	assert.ok(missing(1440)(phoneOnly.problems[0]!), phoneOnly.problems[0]);
	assert.deepEqual(run([ROUTE], ["things.list"], { "proof/things.list/flow.webm": "webm" }).problems, []);
});

test("INV-review-proof: a changed mapped feature needs at least one of its surfaces proved", () => {
	assert.deepEqual(run([FEATURE_FILE], []).problems, [
		`things: the diff changes ${FEATURE_FILE}; prove at least one of its surfaces: things.list`,
	]);
	assert.deepEqual(run([FEATURE_FILE], ["things.list"], BOTH).problems, []);
});

test("INV-review-proof: other product code needs at least one proved surface", () => {
	assert.deepEqual(run([PACKAGE_FILE, "apps/web/next.config.ts"], []).problems, [
		`the diff changes product code that no mapped surface owns (${PACKAGE_FILE}, apps/web/next.config.ts); prove at least one surface it affects`,
	]);
	assert.deepEqual(run([PACKAGE_FILE], ["things.list"], BOTH).problems, []);
});

test("INV-review-proof: a PNG that is not the true 390 or 1440 px viewport, a non-PNG and an unknown surface id are refused", () => {
	const result = run([ROUTE], ["things.list", "things.made-up"], {
		...BOTH,
		"proof/things.list/scrollbar.png": png(1200),
		"proof/things.list/fake.png": "not a png",
	});
	assert.deepEqual(result.problems, [
		"things.made-up: is no surface in any feature map; surfaces: things.list",
		"proof/things.list/fake.png: is not a PNG",
		"proof/things.list/scrollbar.png: is 1200 px wide; a proof shot is the true 390 or 1440 px viewport",
	]);
});

test("INV-review-proof: each proved surface prints its map entry and the files found as a Proof table row", () => {
	const { report } = run([ROUTE], ["things.list"], BOTH);
	assert.equal(
		report,
		[
			"| Surface | Feature | How users reach it | What proves it | Screenshots or recording |",
			"|---|---|---|---|---|",
			'| things.list | things | `owner`, `admin`: rail "Things"<br>access: `owner` write, `admin` read, `visitor` none | **#open**: test `tests/integration/things.test.mts`: AC:CASE-THING-1 an Owner opens a thing; cases CASE-THING-1; browser behavior proof from state populated | [desktop.png](proof/things.list/desktop.png) (1440 px)<br>[phone.png](proof/things.list/phone.png) (390 px) |',
			"",
		].join("\n"),
	);
});
