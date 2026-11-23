import { testDatabase } from "../../support/test-database.mts";
import { seeds } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";

const TARGET = "20261123073229_drop_lifecycle_witness_seat_affiliation.sql";
const source = (name: string) => new URL("../../../packages/db/migrations/" + name, import.meta.url);

const database = await testDatabase({ prefix: "witness_cols_test", migrate: false, max: 2 });
const { admin, schema } = database;
const names = (await migrationArtifact()).map(({ name }) => name);
let directory = "";
after(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
	await database.close();
});

async function before() {
	directory = await mkdtemp(tmpdir() + "/evf-witness-columns-");
	const url = pathToFileURL(directory + "/");
	for (const name of names.filter((n) => n < TARGET)) await copyFile(source(name), new URL(name, url));
	return url;
}

const day = 86_400_000;
async function witness(columns: {
	kind: "account" | "plant";
	subject: string;
	account?: string;
	plant?: string;
	state: "pending_deletion" | "cancelled" | "purged";
}) {
	const requested = new Date("2026-10-01T12:00:00.000Z");
	const until = new Date(requested.getTime() + 30 * day);
	const purged = columns.state === "purged" ? new Date(until.getTime() + day) : null;
	await admin.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,account_id,plant_id,request_id,request_revision,state,
		requested_at,cancel_until,cancelled_at,live_purged_at,copy_expires_at,witness_checkpoint,cleanup_state)
		VALUES(${columns.kind},${columns.subject},${columns.account ?? null},${columns.plant ?? null},${randomUUID()},1,${columns.state},
		${requested},${until},${columns.state === "cancelled" ? new Date(requested.getTime() + day) : null},${purged},
		${purged ? new Date(purged.getTime() + day) : null},1,'not_started')`);
}
const rows = async () =>
	(
		await admin.execute(
			sql`SELECT to_jsonb(w) - 'seat_id' - 'affiliation_id' AS witness, to_jsonb(r) AS record
				FROM lifecycle_witness w JOIN record r ON r.id=w.id ORDER BY w.id`,
		)
	).rows;
const catalog = async () =>
	(
		await admin.execute(sql`SELECT
			(SELECT coalesce(array_agg(column_name::text ORDER BY column_name), '{}') FROM information_schema.columns
				WHERE table_schema=${schema} AND table_name='lifecycle_witness' AND column_name IN ('seat_id','affiliation_id')) AS columns,
			(SELECT coalesce(array_agg(conname::text ORDER BY conname), '{}') FROM pg_constraint
				WHERE conrelid=${`${schema}.lifecycle_witness`}::regclass
				AND conname IN ('lifecycle_witness_fk_3','lifecycle_witness_fk_4','lifecycle_witness_ck_5','lifecycle_witness_ck_7','lifecycle_witness_ck_8')) AS constraints,
			(SELECT coalesce(array_agg(indexname::text ORDER BY indexname), '{}') FROM pg_indexes
				WHERE schemaname=${schema} AND indexname IN ('lifecycle_witness_ref_3','lifecycle_witness_ref_4')) AS indexes`)
	).rows[0];

test("INV-witness-columns: the migration drops seat_id and affiliation_id and keeps every account and plant witness", async () => {
	await migrate(admin, schema, await before());
	assert.deepEqual(await catalog(), {
		columns: ["affiliation_id", "seat_id"],
		constraints: [
			"lifecycle_witness_ck_5",
			"lifecycle_witness_ck_7",
			"lifecycle_witness_ck_8",
			"lifecycle_witness_fk_3",
			"lifecycle_witness_fk_4",
		],
		indexes: ["lifecycle_witness_ref_3", "lifecycle_witness_ref_4"],
	});
	const seed = seeds(admin);
	const plant = await seed.plant();
	const account = await seed.actor(null);
	await witness({ kind: "account", subject: account.id, account: account.id, state: "pending_deletion" });
	await witness({ kind: "plant", subject: plant.id, plant: plant.id, state: "pending_deletion" });
	await witness({ kind: "account", subject: randomUUID(), state: "cancelled" });
	await witness({ kind: "plant", subject: randomUUID(), state: "purged" });
	const seeded = await rows();
	assert.equal(seeded.length, 4);

	assert.deepEqual(
		await migrate(admin, schema),
		names.filter((name) => name >= TARGET),
	);
	assert.deepEqual(await rows(), seeded);
	assert.deepEqual(await catalog(), { columns: [], constraints: [], indexes: [] });
});
