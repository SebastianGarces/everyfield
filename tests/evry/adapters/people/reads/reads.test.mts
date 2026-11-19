import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { invokeRead, readCatalog } from "../../../../../packages/evry/src/index.ts";
import {
	checkForDuplicates,
	getPersonPhoto,
	listDuplicatePairs,
	verifyPeople,
} from "../../../../../packages/evry/src/adapters/people/reads/index.ts";
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
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";

before(setup);
after(teardown);

const counted = (start: number) =>
	queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;

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
		assert.equal(counted(start), 2);
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
		assert.ok(!JSON.stringify(result).includes(String(key)) && !/https?:|private\//.test(JSON.stringify(result)));
	}
	const owner = await actor("owner");
	assert.deepEqual((await invokeRead(db, owner, getPersonPhoto, { personId: people.casey })).rows[0]?.fields, {
		photo: "absent",
		versionId: null,
	});

	await photo(people.foreign, otherPlant);
	const retired = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
		VALUES(${retired},${plant},${plant},'Former','other',clock_timestamp(),'prospect','unknown','unknown',2000,'retired',clock_timestamp())`);
	await photo(retired);
	for (const personId of [people.foreign, randomUUID(), retired])
		assert.deepEqual(await invokeRead(db, owner, getPersonPhoto, { personId }), nothing);
	assert.deepEqual(
		await invokeRead(db, await actor("foreign"), getPersonPhoto, { personId: people.alexChen }),
		nothing,
	);
});

test("AC:SEC-02 INV-tenancy: the photo read, duplicate hints and the reference check take no lock a sign-out waits for, and see the sign-out in the same statement (C13, C27)", async () => {
	const owner = await actor("owner");
	await photo(people.alexRivera);
	const session = (await admin.execute(sql`SELECT * FROM auth_session WHERE id=${accounts.owner.session}`)).rows[0]!;
	try {
		await gatedTransaction(db, async (tx) => {
			assert.equal((await getPersonPhoto.invoke(tx, owner, { personId: people.alexRivera }, null)).status, "available");
			assert.equal((await verifyPeople(tx, owner, [people.alexRivera])).length, 1);
			assert.equal((await checkForDuplicates.invoke(tx, owner, { displayName: "Alex Rivera" }, null)).rows.length, 1);
			await admin.transaction(async (signOut) => {
				await signOut.execute(sql`SET LOCAL lock_timeout='2s'`);
				await signOut.execute(sql`SELECT 1 FROM auth_session WHERE id=${accounts.owner.session} FOR UPDATE NOWAIT`);
				await signOut.execute(sql`DELETE FROM auth_session WHERE id=${accounts.owner.session}`);
			});
			assert.deepEqual(await getPersonPhoto.invoke(tx, owner, { personId: people.alexRivera }, null), nothing);
			assert.deepEqual(await verifyPeople(tx, owner, [people.alexRivera]), []);
			await assert.rejects(
				() => checkForDuplicates.invoke(tx, owner, { displayName: "Alex Rivera" }, null),
				(e: { code?: string }) => e.code === "source_unavailable",
			);
		});
	} finally {
		await admin.execute(
			sql`INSERT INTO auth_session SELECT * FROM json_populate_record(null::auth_session, ${JSON.stringify(session)}::json) ON CONFLICT DO NOTHING`,
		);
	}
});

test("AC:AC-EVR-108--EVR-108 AC:AC-EVR-READ--EVR-108 duplicate hints match normalized email, phone and name in this church only; short or blank signals and wildcards match nothing; one statement", async () => {
	const add = async (tenant: string, name: string, email: string | null, phone: string | null, state = "live") => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,phone,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
			VALUES(${id},${tenant},${tenant},${name},${email},${phone},'other',clock_timestamp(),'prospect','unknown','unknown',3000,${state},${state === "retired" ? new Date() : null})`);
		return id;
	};
	const jordan = await add(plant, "Jordan Lake", "jordan@example.test", "312.555.0100");
	const sibling = await add(plant, "Sam Lake", "lakes@example.test", null);
	await add(plant, "Former Lake", "lakes@example.test", "3125550199", "retired");
	await add(otherPlant, "Jordan Lake", "jordan@example.test", "312.555.0100");
	const member = await actor("member");
	const hints = async (input: Record<string, string>) =>
		(await invokeRead(db, member, checkForDuplicates, input as never)).rows.map((r) => [
			r.label,
			r.fields.match,
			r.fields.signals,
		]);

	assert.deepEqual(await hints({ displayName: "J. Lake", email: "  JORDAN@Example.TEST " }), [
		["Jordan Lake", "exact", "email"],
	]);
	assert.deepEqual(await hints({ displayName: "jordan  lake", phone: "(312) 555-0100" }), [
		["Jordan Lake", "exact", "phone,name"],
	]);
	assert.deepEqual(await hints({ displayName: "Sam Lake" }), [["Sam Lake", "potential", "name"]]);
	assert.deepEqual(await hints({ email: "lakes@example.test" }), [["Sam Lake", "exact", "email"]]);
	const unmatched: Record<string, string>[] = [
		{},
		{ phone: "555" },
		{ email: "x" },
		{ displayName: "%" },
		{ displayName: "_ Lake" },
		{ email: "%@example.test" },
	];
	for (const input of unmatched) assert.deepEqual(await hints(input), [], JSON.stringify(input));
	assert.deepEqual(await hints({ email: "lakes@example.test", excludePersonId: sibling } as never), []);

	let start = queries.length;
	await invokeRead(db, member, checkForDuplicates, { email: "jordan@example.test" });
	assert.equal(counted(start), 2);
	start = queries.length;
	await gatedTransaction(db, (tx) =>
		checkForDuplicates.invoke(tx, member, { email: "jordan@example.test", displayName: "Jordan Lake" }, null),
	);
	assert.equal(counted(start), 1);
	assert.ok(jordan);
});

test("AC:TARGET-PPL-016 the import review pairs read lists this church's open pairs, oldest first, with exact completeness, for an Owner or Admin only", async () => {
	let at = 0;
	const add = async (tenant: string, name: string, state = "live") => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state,retired_at)
			VALUES(${id},${tenant},${tenant},${name},'other',clock_timestamp()+make_interval(secs=>${++at}),'prospect','unknown','unknown',4000,${state},${state === "retired" ? new Date() : null})`);
		return id;
	};
	const imported = async (tenant: string, name: string, reviewWith: string | null, state = "live") => {
		const id = await add(tenant, name, state);
		await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,after_revision,metadata)
			VALUES(${tenant},${accounts.owner.id},'people.created','create','person',${id},1,
				${JSON.stringify({ import: reviewWith ? { row: 1, reviewWith } : { row: 1 } })}::jsonb)`);
		return id;
	};
	const pat = await add(plant, "Pat Quill");
	const patImported = await imported(plant, "Pat Quil", pat);
	const robin = await add(plant, "Robin Vale");
	const robinImported = await imported(plant, "Robin Vail", robin);
	const lee = await add(plant, "Lee Marsh");
	const leeImported = await imported(plant, "Lee Marshe", lee);
	await admin.execute(
		sql`INSERT INTO person_duplicate_dismissal(plant_id,person_id,with_person_id) VALUES(${plant},${leeImported},${lee})`,
	);
	await imported(plant, "Nia Fresh", null);
	await imported(plant, "Pat Quille", pat, "retired");
	const quinn = await add(otherPlant, "Quinn Stone");
	await imported(otherPlant, "Quinn Stoan", quinn);

	const owner = await actor("owner");
	const start = queries.length;
	assert.deepEqual(await invokeRead(db, owner, listDuplicatePairs, {}), {
		operation: "people.listDuplicatePairs",
		status: "available",
		rows: [
			{
				kind: "person",
				id: patImported,
				label: "Pat Quil",
				fields: { mayDuplicateId: pat, mayDuplicate: "Pat Quill" },
			},
			{
				kind: "person",
				id: robinImported,
				label: "Robin Vail",
				fields: { mayDuplicateId: robin, mayDuplicate: "Robin Vale" },
			},
		],
		total: 2,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: ["pairs marked not a duplicate", "retired or merged people", "pairs no import flagged"],
	});
	assert.equal(counted(start), 2);

	const foreign = await invokeRead(db, await actor("foreign"), listDuplicatePairs, {});
	assert.deepEqual(
		foreign.rows.map((r) => [r.label, r.fields.mayDuplicate]),
		[["Quinn Stoan", "Quinn Stone"]],
	);

	const member = await actor("member");
	const offered = (a: typeof member) => readCatalog(a).domains.flatMap((d) => d.operations.map((o) => o.operation));
	assert.ok(offered(owner).includes("people.listDuplicatePairs"));
	assert.ok(!offered(member).includes("people.listDuplicatePairs"));
	const before = queries.length;
	await assert.rejects(
		() => invokeRead(db, member, listDuplicatePairs, {}),
		(e: { code?: string }) => e.code === "access_denied",
	);
	assert.equal(counted(before), 0);
});
