import "../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { runDuePurges } from "../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { installGeographyRelease } from "../../../packages/domain/src/organizations/index.ts";
import { deletionOperations } from "../../../packages/domain/src/settings/index.ts";
import { ok, seeds, type Actor, type Workspace } from "../../support/fixture.mts";
import { testDatabase } from "../../support/test-database.mts";
import { freezeClock } from "../target/sql/knowledge/support.mts";

const REQUESTED = new Date("2026-10-13T16:00:00.000Z");
const database = await testDatabase({
	prefix: "geoappend",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: REQUESTED,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const storage = { bucket: "synthetic-only", client: { send: async () => ({}) } };
const api = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "purge/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});

async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}
const denied = (error: { cause?: { code?: string } }) => error.cause?.code === "42501";
const chain = async (plant: Workspace) =>
	(
		await admin.execute<{ id: string; city: string; supersedes_id: string | null }>(
			sql`SELECT id,city,supersedes_id FROM plant_geography WHERE plant_id=${plant.id} ORDER BY effective_at,id`,
		)
	).rows;

let p: Workspace & { kind: "plant" };
let owner: Actor;
before(async () => {
	mock.timers.enable({ apis: ["Date"], now: REQUESTED.getTime() });
	await at(REQUESTED);
	await installGeographyRelease(admin);
	p = await seed.plant({ name: "Harvest Point" });
	owner = await seed.actor(p, "owner");
	const place = (
		city: string,
	) => sql`SELECT ${p.id}::uuid,${city},'TX','US',i.id,v.id,clock_timestamp(),clock_timestamp()
		FROM reference_item i, reference_version v JOIN reference_item d ON d.id=v.item_id AND d.kind='geography_dataset'
		WHERE i.kind='geography_region' AND i.canonical_key='omb-23-01/19100'`;
	await admin.execute(sql`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,
		reference_version_id,committed_at,effective_at) ${place("Fort Worth")}`);
	await at(new Date(REQUESTED.getTime() + 1000));
	await admin.execute(sql`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,
		reference_version_id,committed_at,effective_at,supersedes_id)
		SELECT x.*,(SELECT id FROM plant_geography WHERE plant_id=${p.id}) FROM (${place("Dallas")}) x`);
});
after(async () => {
	mock.timers.reset();
	await database.close();
});

test("INV-location: the runtime cannot rewrite or remove a church's effective location, cleanup cannot rewrite it, and the church purge still removes the whole superseding chain", async (t) => {
	const history = await chain(p);
	assert.deepEqual(
		history.map((row) => [row.city, row.supersedes_id]),
		[
			["Fort Worth", null],
			["Dallas", history[0]!.id],
		],
	);

	await t.test("the runtime's UPDATE is refused and the row keeps its values", async () => {
		await assert.rejects(
			db.execute(sql`UPDATE plant_geography SET city='Austin',supersedes_id=NULL WHERE id=${history[1]!.id}`),
			denied,
		);
		assert.deepEqual(await chain(p), history);
	});

	await t.test("the runtime's DELETE is refused and both rows stay", async () => {
		await assert.rejects(db.execute(sql`DELETE FROM plant_geography WHERE plant_id=${p.id}`), denied);
		assert.deepEqual(await chain(p), history);
	});

	await t.test("cleanup's UPDATE is refused and the row keeps its values", async () => {
		await assert.rejects(
			cleanup.execute(sql`UPDATE plant_geography SET city='Austin' WHERE id=${history[0]!.id}`),
			denied,
		);
		assert.deepEqual(await chain(p), history);
	});

	await t.test("the church purge removes every location row of the church", async () => {
		const [plant] = (
			await admin.execute<{ revision: string }>(sql`SELECT revision::text AS revision FROM plant WHERE id=${p.id}`)
		).rows;
		ok(
			await gatedTransaction(db, (tx) =>
				api.requestWorkspaceDeletion(tx, { session: owner.session, selected: p as never }, {
					input: { plant: p, confirmed: true },
					expectedRevision: plant!.revision,
					requestKey: randomUUID(),
				} as never),
			),
		);
		const [witness] = (
			await admin.execute<{ cancel_until: string }>(
				sql`SELECT cancel_until FROM lifecycle_witness WHERE kind='plant' AND opaque_subject_id=${p.id}`,
			)
		).rows;
		await at(new Date(new Date(witness!.cancel_until).getTime() + 1000));
		assert.equal(await runDuePurges(db, cleanup, storage as never, 10), 1);
		const [after] = (
			await admin.execute<{ state: string }>(
				sql`SELECT state FROM lifecycle_witness WHERE kind='plant' AND opaque_subject_id=${p.id}`,
			)
		).rows;
		assert.equal(after!.state, "purged");
		assert.deepEqual(await chain(p), []);
	});
});
