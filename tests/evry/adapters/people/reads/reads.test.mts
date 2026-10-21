import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { invokeRead } from "../../../../../packages/evry/src/index.ts";
import { getPersonPhoto, verifyPeople } from "../../../../../packages/evry/src/adapters/people/reads/index.ts";
import {
	accounts,
	actor,
	admin,
	db,
	otherPlant,
	people,
	plant,
	queries,
	setup,
	sql,
	teardown,
} from "../../../runtime/support.mts";

before(setup);
after(teardown);

const counted = (start: number) =>
	queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;

/** A verified private photo object in this church, made the person's current photo. */
async function photo(personId: string, tenant = plant) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation,expires_at)
		VALUES(${id},${tenant},'person_photo',${"private/" + tenant + "/" + randomUUID()},'image/png',100,100,${"0".repeat(64)},'ready',${id},0,clock_timestamp()+interval '15 minutes')`);
	await admin.execute(sql`UPDATE person SET photo_object_id=${id} WHERE id=${personId}`);
	return id;
}
const nothing = {
	operation: "people.getPersonPhoto",
	status: "not_found",
	rows: [],
	total: 0,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
};

test("AC:PROVIDER48-002 AC:PROVIDER48-003 a photo read names only the current private version, for any seat in the church, and nothing for foreign, retired or guessed people", async () => {
	const version = await photo(people.alexChen);
	const key = (await admin.execute(sql`SELECT opaque_key FROM file_object WHERE id=${version}`)).rows[0]!.opaque_key;
	for (const who of ["owner", "member"] as const) {
		const reader = await actor(who);
		const start = queries.length;
		const result = await invokeRead(db, reader, getPersonPhoto, { personId: people.alexChen });
		// The live check, the read timeout and one native statement.
		assert.equal(counted(start), 3);
		assert.deepEqual(result, {
			operation: "people.getPersonPhoto",
			status: "available",
			rows: [
				{
					kind: "person",
					id: people.alexChen,
					label: "Person photo",
					fields: { photo: "available", versionId: version },
				},
			],
			total: 1,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["photo bytes"],
		});
		// Never a storage key or a link: the app's own route serves the bytes after its own access check.
		assert.ok(!JSON.stringify(result).includes(String(key)) && !/https?:|private\//.test(JSON.stringify(result)));
	}
	const owner = await actor("owner");
	assert.deepEqual((await invokeRead(db, owner, getPersonPhoto, { personId: people.casey })).rows[0]?.fields, {
		photo: "absent",
		versionId: null,
	});

	// A foreign person with a photo, a guessed id and a retired person all read the same: nothing.
	await photo(people.foreign, otherPlant);
	const retired = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
		VALUES(${retired},${plant},${plant},'Former','other',clock_timestamp(),'prospect','unknown','unknown',2000,'retired',clock_timestamp())`);
	await photo(retired);
	for (const personId of [people.foreign, randomUUID(), retired])
		assert.deepEqual(await invokeRead(db, owner, getPersonPhoto, { personId }), nothing);
	// The foreign church's own member is refused in that context too.
	assert.deepEqual(
		await invokeRead(db, await actor("foreign"), getPersonPhoto, { personId: people.alexChen }),
		nothing,
	);
});

test("AC:SEC-02 INV-tenancy: the photo read and the reference check take no lock a sign-out waits for, and see the sign-out in the same statement (C13, C27)", async () => {
	const owner = await actor("owner");
	await photo(people.alexRivera);
	const session = (await admin.execute(sql`SELECT * FROM auth_session WHERE id=${accounts.owner.session}`)).rows[0]!;
	try {
		await db.transaction(async (tx) => {
			assert.equal((await getPersonPhoto.invoke(tx, owner, { personId: people.alexRivera })).status, "available");
			assert.equal((await verifyPeople(tx, owner, [people.alexRivera])).length, 1);
			// The read transaction is still open. A sign-out does not wait for it: a lock left by either read would
			// make this delete time out.
			const started = performance.now();
			await admin.transaction(async (signOut) => {
				await signOut.execute(sql`SET LOCAL lock_timeout='2s'`);
				await signOut.execute(sql`DELETE FROM auth_session WHERE id=${accounts.owner.session}`);
			});
			assert.ok(performance.now() - started < 2_000, "sign-out does not wait for the read");
			// The next statement of the same read sees the sign-out and returns nothing.
			assert.deepEqual(await getPersonPhoto.invoke(tx, owner, { personId: people.alexRivera }), nothing);
			assert.deepEqual(await verifyPeople(tx, owner, [people.alexRivera]), []);
		});
	} finally {
		await admin.execute(
			sql`INSERT INTO auth_session SELECT * FROM json_populate_record(null::auth_session, ${JSON.stringify(session)}::json) ON CONFLICT DO NOTHING`,
		);
	}
});
