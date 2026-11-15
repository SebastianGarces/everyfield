import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "../../../../../packages/db/src/query.ts";
import { readiness } from "../../../../../ops/maintenance/readiness.mts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../../ops/maintenance/restore.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { seeds } from "../../../../support/fixture.mts";
import { dropTarget, freezeClock, objectStore, operator, snapshot } from "./support.mts";

// BKT60-004: before any customer data (no customer rows, backup not configured, cost not approved), a verified scoped
// operator asks ops.readiness at 2026-10-13T16:00:00Z. Church P with admin A on session-A is synthetic setup only.
const NOW = new Date("2026-10-13T16:00:00.000Z");
const scoped = {
	authority: "explicit_scoped_operator",
	verified: true,
	operation_ids: ["ops.readiness"],
	environment: "isolated-test",
} as const;
/** Evidence of each kind in the shape ops.readiness counts. */
const supplied = {
	cost_approval: { approved: true, approved_at: "2026-10-12T16:00:00Z", monthly_usd: { low: 5, expected: 10, high: 20 } },
	host_schedule: { host: "restricted-host-1", schedule: "daily 03:00 UTC", verified_at: "2026-10-12T16:00:00Z" },
	key_exclusion: { denied: { app: true, build: true, preview: true }, verified_at: "2026-10-12T16:00:00Z" },
	coherent_restore: { live_recovery_proven: true, verified_at: "2026-10-12T16:00:00Z" },
};
const ITEMS = ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"] as const;

const database = await testDatabase({ prefix: "wp092rdy", clock: NOW });
const { admin, schema } = database;
const seed = seeds(admin);
let plant, a;

before(async () => {
	await freezeClock(admin, schema, NOW);
	plant = await seed.plant({ name: "Harvest Point" });
	a = await seed.actor(plant, "admin");
});
after(() => database.close());

test("only a verified explicit scoped operator capability for ops.readiness gets a report", () => {
	const cases: [string, unknown][] = [
		["a missing capability", undefined],
		["an unverified capability", { ...scoped, verified: false }],
		["another operation's capability", { ...scoped, operation_ids: ["maintenance.createEncryptedCopy"] }],
		["the restricted recovery capability", operator],
		["the shared development environment", { ...scoped, environment: "development" }],
		["A's Admin session in P", { account: a.id, session: a.session, context: plant.id, role: "Admin" }],
		["A's Admin role as the authority", { ...scoped, authority: "plant_admin" }],
	];
	for (const [name, capability] of cases)
		assert.deepEqual(readiness({ capability, evidence: supplied, now: NOW }), { refusal: "operator_unavailable" }, name);
});

test("AC:BKT60-004 the before-customer-data gate stays blocked while cost, host schedule, key exclusion or coherent restore evidence is missing", async (step) => {
	// No customer rows: the synthetic church holds no people.
	const { rows } = await admin.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM person`);
	assert.equal(rows[0]!.n, 0);

	await step.test("no evidence: blocked, the build gate never rests on backup, and all four items are named", () => {
		const report = readiness({ capability: scoped, evidence: {}, now: NOW });
		assert.deepEqual(report, {
			refusal: null,
			customer_data_gate: "blocked",
			build_gate_from_backup: false,
			missing: ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"],
			live_evidence_verified: false,
			checked_at: "2026-10-13T16:00:00Z",
		});
	});

	for (const absent of ITEMS)
		await step.test(`three of four supplied, ${absent} missing: still blocked, naming only ${absent}`, () => {
			const evidence = Object.fromEntries(Object.entries(supplied).filter(([item]) => item !== absent));
			const report = readiness({ capability: scoped, evidence, now: NOW });
			assert.equal(report.refusal, null);
			if (report.refusal !== null) return;
			assert.equal(report.customer_data_gate, "blocked");
			assert.equal(report.build_gate_from_backup, false);
			assert.deepEqual(report.missing, [absent]);
		});

	await step.test("every item supplied: the gate still never reads ready in this slice", () => {
		const report = readiness({ capability: scoped, evidence: supplied, now: NOW });
		assert.deepEqual(
			report.refusal === null && [report.customer_data_gate, report.build_gate_from_backup, report.missing],
			["blocked", false, []],
		);
	});

	await step.test("a restore rehearsal result is not coherent-restore evidence", async () => {
		const target = `${schema}_rdy`;
		try {
			const rehearsal = await restoreWithCurrentManifest(
				{ admin, source: schema, targetSchema: target, objects: objectStore(new Map()), clock: () => NOW },
				{
					capability: operator,
					target: "isolated",
					snapshot: await snapshot(admin, new Map(), { createdAt: NOW }),
					current: () => readCurrentManifest(admin),
				},
			);
			assert.equal(rehearsal.restore_success, true, JSON.stringify(rehearsal));
			const evidence = { ...supplied, coherent_restore: { ...rehearsal, verified_at: "2026-10-13T16:00:00Z" } };
			const report = readiness({ capability: scoped, evidence, now: NOW });
			assert.equal(report.refusal === null && report.customer_data_gate, "blocked");
			assert.deepEqual(report.refusal === null && report.missing, ["coherent_restore"]);
			// The offline candidate check's own verdict does not count either.
			const offline = { ...supplied, coherent_restore: { liveRecoveryProven: false, verified_at: "2026-10-13T16:00:00Z" } };
			const again = readiness({ capability: scoped, evidence: offline, now: NOW });
			assert.deepEqual(again.refusal === null && again.missing, ["coherent_restore"]);
		} finally {
			await dropTarget(admin, target);
		}
	});

	await step.test("the report holds no evidence body, secret or connection string", () => {
		const evidence = { ...supplied, host_schedule: { ...supplied.host_schedule, token: "secret-token-value" } };
		const text = JSON.stringify(readiness({ capability: scoped, evidence, now: NOW }));
		assert.doesNotMatch(text, /secret-token-value|restricted-host-1|postgres:|approved_at/);
	});
});

test("the restricted CLI refuses copy and readiness without their control with the generic line only", async () => {
	const cli = fileURLToPath(new URL("../../../../../ops/maintenance/cli.mts", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "wp092-cli-"));
	try {
		const open = join(dir, "control.json");
		await writeFile(open, JSON.stringify({ version: 1 }), { mode: 0o644 });
		const key = join(dir, "backup.key");
		await writeFile(key, Buffer.alloc(32, 7), { mode: 0o600 });
		for (const args of [
			["backup-copy", "--control", join(dir, "missing.json"), "--key", key, "--out", dir, "--snapshot", dir],
			["backup-copy", "--control", open, "--key", key, "--out", dir, "--snapshot", dir],
			["backup-copy", "--key", key, "--out", dir, "--snapshot", dir],
			["readiness", "--control", join(dir, "missing.json")],
			["readiness", "--control", open],
			["readiness"],
		]) {
			const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
				(resolve) =>
					execFile(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH } }, (error, stdout, stderr) =>
						resolve({ code: error ? (error.code as number) : 0, stdout, stderr }),
					),
			);
			assert.equal(code, 1, args.join(" "));
			assert.equal(stdout, "");
			assert.equal(stderr, "Operations command refused or failed. No credentials or raw errors were logged.\n");
			assert.equal(stderr.includes(Buffer.alloc(32, 7).toString("hex")), false);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
