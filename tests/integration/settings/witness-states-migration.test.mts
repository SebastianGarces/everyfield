import { testDatabase } from "../../support/test-database.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";

const TARGET = "20261123012532_lifecycle_witness_deletion_states.sql";
const source = (name: string) => new URL("../../../packages/db/migrations/" + name, import.meta.url);

const database = await testDatabase({ prefix: "t580_test", migrate: false, max: 2 });
const { admin, schema } = database;
const names = (await migrationArtifact()).map(({ name }) => name);
let directory = "";
after(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	await database.close();
});

async function before() {
	directory = await mkdtemp(tmpdir() + "/evf-witness-states-");
	const url = pathToFileURL(directory + "/");
	for (const name of names.filter((n) => n < TARGET)) await copyFile(source(name), new URL(name, url));
	return url;
}

const witness = (kind: string, state: string) =>
	admin.execute(sql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,request_revision,state,witness_checkpoint,cleanup_state)
		VALUES(${randomUUID()},${kind},${randomUUID()},0,${state},1,'not_started') RETURNING id`);
const refusedBy = (name: string) => (error: { cause?: { constraint?: string } }) => error.cause?.constraint === name;
const rows = async () =>
	(
		await admin.execute(
			sql`SELECT w.id::text AS id, w.kind AS kind, w.state AS state, w.request_id::text AS request, w.cancel_until AS until,
				(SELECT count(*)::int FROM record r WHERE r.id=w.id) AS records FROM lifecycle_witness w ORDER BY w.id`,
		)
	).rows;

test("INV-witness-states: the migration deletes witnesses in removed states or kinds and keeps every other row", async () => {
	await migrate(admin, schema, await before());
	const removed = [];
	for (const [kind, state] of [
		["account", "active"],
		["seat", "revoked"],
		["affiliation", "active"],
	])
		removed.push(String((await witness(kind, state)).rows[0].id));
	const requested = new Date("2026-11-01T12:00:00.000Z");
	await admin.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
		VALUES('account',${randomUUID()},${randomUUID()},1,'pending_deletion',${requested},${new Date(requested.getTime() + 30 * 86_400_000)},1,'not_started')`);
	const kept = (await rows()).filter((r) => !removed.includes(String(r.id)));
	assert.equal(kept.length, 1);
	assert.equal(kept[0].state, "pending_deletion");

	assert.deepEqual(
		await migrate(admin, schema),
		names.filter((name) => name >= TARGET),
	);
	assert.deepEqual(await rows(), kept);
	const records = await admin.execute(
		sql`SELECT count(*)::int AS n FROM record WHERE id = ANY(${`{${removed.join(",")}}`}::uuid[])`,
	);
	assert.equal(records.rows[0].n, 0);

	for (const state of ["active", "revoked"])
		await assert.rejects(witness("account", state), refusedBy("lifecycle_witness_ck_4"), state);
	for (const kind of ["seat", "affiliation"])
		await assert.rejects(
			admin.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
				VALUES(${kind},${randomUUID()},${randomUUID()},1,'pending_deletion',${requested},${new Date(requested.getTime() + 30 * 86_400_000)},1,'not_started')`),
			refusedBy("lifecycle_witness_ck_3"),
			kind,
		);
});
