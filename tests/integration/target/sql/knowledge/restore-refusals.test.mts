import "../../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "../../../../../packages/db/src/query.ts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../../ops/maintenance/restore.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { seeds } from "../../../../support/fixture.mts";
import { dropTarget, freezeClock, objectStore, operator, schemaExists, snapshot, type Store } from "./support.mts";

// The rehearsal's refusals: only a verified restricted recovery operator for this operation, in the isolated test
// environment, with an isolated target, gets past the first check, and nothing is read or written before it. A
// missing, stale or unreadable current witness refuses with the subject still hidden: the image's own lifecycle rows
// never stand in for it. Church P has admin A pending deletion since 2026-10-13T16:00:00Z.
const NOW = new Date("2026-10-14T16:00:00.000Z");
const database = await testDatabase({ prefix: "wp092ref", clock: NOW });
const { admin, schema } = database;
const seed = seeds(admin);
const targets: string[] = [];
let copy, stale, a;

before(async () => {
	await freezeClock(admin, schema, NOW);
	const plant = await seed.plant({ name: "Harvest Point" });
	a = await seed.actor(plant, "admin");
	await admin.execute(sql`INSERT INTO lifecycle_witness (kind, opaque_subject_id, account_id, request_id, requester_id,
		requester_opaque_id, request_revision, state, requested_at, cancel_until, witness_checkpoint, cleanup_state)
		VALUES ('account', ${a.id}::uuid, ${a.id}::uuid, ${randomUUID()}::uuid, ${a.id}::uuid, ${a.id}::uuid, 1,
		'pending_deletion', '2026-10-13T16:00:00Z', '2026-11-12T16:00:00Z', 1, 'not_started')`);
	// A journal copy taken before the witness moved on: older than the snapshot below.
	stale = await readCurrentManifest(admin);
	await admin.execute(
		sql`UPDATE lifecycle_witness SET witness_checkpoint=witness_checkpoint+1 WHERE opaque_subject_id=${a.id}::uuid`,
	);
	copy = await snapshot(admin, new Map(), { createdAt: NOW });
});
after(async () => {
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});

/** One rehearsal with `overrides`, counting reads of the current manifest. */
async function rehearse(overrides: Record<string, unknown> = {}, targetSchema?: string) {
	const target = targetSchema ?? `${schema}_r${targets.length}`;
	targets.push(target);
	const store: Store = new Map();
	let reads = 0;
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => NOW },
		{
			capability: operator,
			target: "isolated",
			snapshot: copy,
			current: () => {
				reads++;
				return readCurrentManifest(admin);
			},
			...overrides,
		},
	);
	return { result, reads, target, created: await schemaExists(admin, target), store };
}

test("only a verified recovery operator capability with an isolated target gets past the first check", async (step) => {
	const denied = "operator_unavailable",
		shared = "target_not_isolated";
	const cases: [string, string, Record<string, unknown>, string?][] = [
		["a missing capability", denied, { capability: undefined }],
		["an unverified capability", denied, { capability: { ...operator, verified: false } }],
		["another operation's capability", denied, { capability: { ...operator, operation_ids: ["maintenance.migrate"] } }],
		["the shared development environment", denied, { capability: { ...operator, environment: "development" } }],
		["a non-isolated target", shared, { target: "source" }],
		["the source schema as target", shared, {}, schema],
	];
	for (const [name, code, overrides, target] of cases)
		await step.test(`${name}: refused before anything is read or written`, async () => {
			const { result, reads, created, store } = await rehearse(overrides, target);
			assert.equal(result.restore_success, false);
			assert.equal(result.refusal, code);
			assert.equal(result.service_opened, false);
			assert.equal(reads, 0);
			assert.equal(store.size, 0);
			if (target !== schema) assert.equal(created, false);
		});
	// The source schema is untouched: its witness is still the live pending one.
	const { rows } = await admin.execute(sql`SELECT state FROM lifecycle_witness WHERE opaque_subject_id=${a.id}::uuid`);
	assert.equal(rows[0]!.state, "pending_deletion");
});

test("an uncertain current witness refuses, the subject stays hidden and service stays closed", async (step) => {
	const live = (await readCurrentManifest(admin)) as Record<string, any>;
	const states: [string, () => Promise<unknown>, string][] = [
		["no current manifest", async () => null, "witness_missing"],
		["no current witness for a subject the image holds", async () => ({ ...live, witnesses: [] }), "witness_missing"],
		["a journal older than the manifest's witness checkpoint", async () => stale, "witness_stale"],
		[
			"a journal that cannot be read",
			async () => {
				throw new Error("journal_timeout");
			},
			"witness_unreadable",
		],
		["a journal in an unknown shape", async () => ({ version: 2, witnesses: "?" }), "witness_unreadable"],
	];
	for (const [name, current, code] of states)
		await step.test(name, async () => {
			const { result, created, store } = await rehearse({ current });
			assert.equal(result.refusal, code);
			assert.equal(result.restore_success, false);
			assert.equal(result.service_opened, false);
			assert.equal(result.customer_data_gate, "blocked");
			// Nothing was restored, so nothing of A can be read from a target.
			assert.equal(created, false);
			assert.equal(store.size, 0);
		});
});

test("the restricted CLI refuses a rehearsal without its control with the generic line only", async () => {
	const cli = fileURLToPath(new URL("../../../../../ops/maintenance/cli.mts", import.meta.url));
	const dir = await mkdtemp(join(tmpdir(), "wp092-cli-"));
	try {
		// A control file anyone may read is refused like a missing one.
		const open = join(dir, "control.json");
		await writeFile(open, JSON.stringify({ version: 1 }), { mode: 0o644 });
		for (const args of [
			["restore-rehearsal", "--control", join(dir, "missing.json"), "--snapshot", dir],
			["restore-rehearsal", "--control", open, "--snapshot", dir],
			["restore-rehearsal", "--snapshot", dir],
		]) {
			const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
				(resolve) =>
					execFile(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH } }, (error, stdout, stderr) =>
						resolve({ code: error ? (error.code as number) : 0, stdout, stderr }),
					),
			);
			assert.equal(code, 1);
			assert.equal(stdout, "");
			assert.equal(stderr, "Operations command refused or failed. No credentials or raw errors were logged.\n");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
