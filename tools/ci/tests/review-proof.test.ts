import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { machines } from "../../../packages/contracts/src/machines/index.ts";
import { checkMachines } from "../machines.ts";
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

const MACHINE_TABLE = "packages/contracts/src/machines/meeting-status.ts";
const WRITER = "packages/domain/src/meetings/meetings.ts";
const SCHEMA = "packages/db/src/schema/tables.ts";
const STATES = '["planning", "ready", "in_progress", "completed", "cancelled"]';
const schema = (states: string) =>
	`export const meeting = pgTable("meeting", { status: text("status", { enum: ${states} }) });\n`;
const COMPLETE =
	"meeting-status: edges 26/26, stays 1/1, refusals 55/55, no-ops 20/20, states 5/5\nother: edges 0/1\n  missing: edge x\n";

function run(
	changed: string[],
	proved: string[],
	shots: Record<string, Buffer | string> = {},
	branch: (root: string) => void = () => {},
) {
	const root = fixture();
	const evidence = mkdtempSync(join(tmpdir(), "review-proof-"));
	try {
		for (const m of machines) put(root, m.proof, "");
		put(root, WRITER, "const insert = sql`INSERT INTO meeting (id, status) VALUES (${id}::uuid, 'planning')`;\n");
		put(root, SCHEMA, schema(STATES));
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q");
		git("add", "-A");
		assert.deepEqual(checkMachines(root, true), []);
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-qm", "base");
		branch(root);
		for (const [file, content] of Object.entries(shots)) put(evidence, file, content);
		return reviewProof(root, changed, evidence, proved, "HEAD");
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

const machineRow = (coverage: string) =>
	`| meeting-status | \`meeting.status\` | [${MACHINE_TABLE}](${MACHINE_TABLE}) | [docs/machines/meeting-status.md](docs/machines/meeting-status.md) | ${coverage} |`;
const MACHINES_TABLE = (coverage: string) =>
	[
		"### Machines",
		"",
		"| Machine | Column | Table | Chart | Coverage |",
		"|---|---|---|---|---|",
		machineRow(coverage),
		"",
	].join("\n");
const COVERED =
	"[meeting-status-coverage.txt](meeting-status-coverage.txt): edges 26/26, stays 1/1, refusals 55/55, no-ops 20/20, states 5/5";

test("INV-review-proof: a changed machine table, writer or machine column prints the Machines table with its table, chart and coverage", () => {
	const coverage = { "meeting-status-coverage.txt": COMPLETE };
	const table = run([MACHINE_TABLE, "tools/ci/machines.ts"], ["things.list"], { ...BOTH, ...coverage });
	assert.deepEqual(table.problems, []);
	assert.ok(table.report.endsWith(`|\n\n${MACHINES_TABLE(COVERED)}`), table.report);

	const writer = run([WRITER], ["things.list"], { ...BOTH, ...coverage });
	assert.deepEqual(writer.problems, []);
	assert.ok(writer.report.endsWith(`|\n\n${MACHINES_TABLE(COVERED)}`), writer.report);

	const column = run([SCHEMA], ["things.list"], { ...BOTH, ...coverage }, (root) =>
		put(root, SCHEMA, schema('["planning", "ready", "in_progress", "completed", "cancelled", "postponed"]')),
	);
	assert.deepEqual(column.problems, []);
	assert.ok(column.report.endsWith(MACHINES_TABLE(COVERED)), column.report);

	const otherColumn = run([SCHEMA], ["things.list"], BOTH, (root) =>
		put(
			root,
			SCHEMA,
			schema(STATES) + 'export const task = pgTable("task", { status: text("status", { enum: ["a"] }) });\n',
		),
	);
	assert.deepEqual(otherColumn.problems, []);
	assert.doesNotMatch(otherColumn.report, /Machines/);
});

test("INV-review-proof: a touched machine fails on a stale or missing chart, a missing coverage file and a missing: line", () => {
	assert.deepEqual(
		run([MACHINE_TABLE], ["things.list"], BOTH, (root) =>
			unlinkSync(join(root, "docs/machines/meeting-status.md")),
		).problems.map((p) =>
			p.replace(/ \/\S+\/meeting-status-coverage\.txt/g, " <evidence>/meeting-status-coverage.txt"),
		),
		[
			"meeting-status: docs/machines/meeting-status.md is missing or differs from its table; run node tools/ci/machines.ts --write.",
			"meeting-status: <evidence>/meeting-status-coverage.txt is missing; run tests/integration/meetings/status-machine.test.mts with EVF_MACHINE_COVERAGE set, then node tools/ci/machines.ts coverage <file> > <evidence>/meeting-status-coverage.txt.",
		],
	);
	const stale = run([WRITER], ["things.list"], { ...BOTH, "meeting-status-coverage.txt": COMPLETE }, (root) =>
		put(root, "docs/machines/meeting-status.md", "edited by hand\n"),
	);
	assert.deepEqual(stale.problems, [
		"meeting-status: docs/machines/meeting-status.md is missing or differs from its table; run node tools/ci/machines.ts --write.",
	]);

	const partial = run([MACHINE_TABLE], ["things.list"], {
		...BOTH,
		"meeting-status-coverage.txt":
			"meeting-status: edges 25/26, stays 1/1, refusals 55/55, no-ops 20/20, states 5/5\n  missing: edge meetings.changeStatus planning ready\n",
	});
	assert.equal(partial.problems.length, 1);
	assert.match(
		partial.problems[0]!,
		/^meeting-status: \S+meeting-status-coverage\.txt does not show every edge, stay, refusal and state: meeting-status: edges 25\/26, .*; missing: edge meetings\.changeStatus planning ready$/,
	);
	assert.match(partial.report, /\| meeting-status \| `meeting\.status` \| .* \| none \|$/m);
});

test("INV-review-proof: a diff that touches no machine prints no Machines table and needs no coverage file", () => {
	const result = run(["tools/ci/feature-maps.ts"], []);
	assert.deepEqual(result.problems, []);
	assert.match(run([MACHINE_TABLE], []).report, /### Machines/, "control: a machine diff prints the table");
	assert.equal(
		result.report,
		"No app proof needed: the diff changes only tooling, docs, tests or agent instructions (1 file(s)).\n",
	);
});
