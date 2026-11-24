import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, ok, refused, type Actor } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	commitments,
	PeopleReadContext,
	peopleMerge,
	peopleReader,
	peopleWriter,
	withPeopleWrite,
} from "../../../packages/domain/src/people/index.ts";
import { listPeopleRequest } from "../../../packages/contracts/src/people/index.ts";

const NOW = new Date("2026-11-09T15:00:00Z");
const database = await fixture({ prefix: "people_filters", max: 4, clock: NOW });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Plant = Awaited<ReturnType<typeof database.plant>>;
type Reader = { actor: Actor; plant: Plant };
async function church(): Promise<Reader> {
	const plant = await database.plant({ timezone: "America/Chicago" });
	return { plant, actor: await database.actor(plant, "owner") };
}
async function authority(a: Actor) {
	const r = await RequestActor.resolve(db, a.session);
	assert.ok(r instanceof RequestActor);
	return r;
}
async function list(reader: { actor: Actor }, filter: object) {
	const context = new PeopleReadContext(await authority(reader.actor));
	return gatedTransaction(db, (tx) =>
		peopleReader.listPeople(tx, context, listPeopleRequest.parse({ page: 1, limit: 100, ...filter })),
	);
}
const names = async (reader: { actor: Actor }, filter: object) =>
	ok(await list(reader, filter)).items.map((p) => p.displayName);
const write = async <T,>(reader: Reader, body: Parameters<typeof withPeopleWrite<T>>[2]) =>
	ok(await withPeopleWrite(db, await authority(reader.actor), body)) as T;
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

let order = 0;
async function person(reader: Reader, name: string, columns: Record<string, unknown> = {}) {
	const id = randomUUID();
	const row = {
		stage: "prospect",
		adult: "unknown",
		birth: null,
		state: "live",
		household: null,
		role: null,
		photo: null,
		account: null,
		...columns,
	};
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,birth_date,
		commitment_state,pipeline_position,state,retired_at,created_at,household_id,household_role,photo_object_id,linked_account_id)
		VALUES(${id},${reader.plant.id},${reader.plant.id},${name},'other',${row.stage},${row.adult},${row.birth}::date,'unknown',
		${++order},${row.state},${row.state === "live" ? null : "2026-11-01T12:00:00Z"},
		${new Date(Date.UTC(2026, 5, 1) + order * 60_000).toISOString()},${row.household},${row.role},${row.photo},${row.account})`);
	return id;
}
async function household(reader: Reader, name: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO household(id,plant_id,name) VALUES(${id},${reader.plant.id},${name})`);
	return id;
}
async function moved(reader: Reader, id: string, from: string | null, to: string, at: string, kind = "edit") {
	await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,before_value,
		after_value,occurred_at) VALUES(${reader.plant.id},${reader.actor.id},'people.stage_changed',${kind},'person',${id},
		${JSON.stringify(from ? { stage: from } : {})}::jsonb,${JSON.stringify({ stage: to })}::jsonb,${at})`);
}
const matches = async (reader: Reader, filter: object) => {
	const page = ok(await list(reader, filter));
	const label = new Map(page.items.map((p) => [p.id, p.displayName]));
	return (page.matches ?? []).map(({ personId, ...m }) => [label.get(personId), m]);
};

test("a list with no new filter keeps its answer, and a request that asks for nothing under a filter is refused", async () => {
	const w = await church();
	await person(w, "Alex");
	const page = ok(await list(w, {}));
	assert.deepEqual([page.total, "matches" in page], [1, false]);
	const context = new PeopleReadContext(await authority(w.actor));
	for (const bad of [
		{ skillCategories: [] },
		{ skillNames: [" "] },
		{ movedInto: { stage: "core_group", from: "2026-11-02", through: "2026-11-01" } },
	])
		refused(
			await gatedTransaction(db, (tx) =>
				peopleReader.listPeople(tx, context, { ...listPeopleRequest.parse({ page: 1, limit: 10 }), ...bad } as never),
			),
			"invalid_input",
		);
});

test("the skill filter matches a recorded category or name, never a note, and returns only the matching skills without notes", async () => {
	const w = await church();
	const other = await church();
	const skill = async (reader: Reader, id: string, name: string, category: string, notes: string | null = null) =>
		admin.execute(sql`INSERT INTO person_skill(plant_id,person_id,name,category,proficiency,notes)
			VALUES(${reader.plant.id},${id},${name},${category},'advanced',${notes})`);
	const mark = await person(w, "Mark");
	await skill(w, mark, "Sound engineering", "tech", "secret sound note");
	await skill(w, mark, "Vocals", "worship");
	const jen = await person(w, "Jen");
	await skill(w, jen, "Vocals", "worship", "also runs sound and tech");
	const lee = await person(w, "Lee");
	await skill(w, lee, "Live SOUND mixing", "other");
	await skill(w, await person(w, "Gone", { state: "retired" }), "Sound", "tech");
	await skill(other, await person(other, "Elsewhere"), "Sound", "tech");
	assert.deepEqual(await matches(w, { skillCategories: ["tech"], skillNames: ["sound"] }), [
		["Mark", { skills: [{ name: "Sound engineering", category: "tech", proficiency: "advanced" }] }],
		["Lee", { skills: [{ name: "Live SOUND mixing", category: "other", proficiency: "advanced" }] }],
	]);
	assert.deepEqual(await names(w, { skillCategories: ["tech"] }), ["Mark"]);
	assert.deepEqual(await names(w, { skillNames: ["%"] }), []);
});

test("the photo filter is what the People list shows, an account photo included, and its pages share no person", async () => {
	const w = await church();
	const file = async (tenant: string, purpose: string) => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,
			state,upload_key,claim_generation) VALUES(${id},${tenant},${purpose},${`private/${tenant}/${id}`},'image/png',1,1,
			${"0".repeat(64)},'ready',${id},0)`);
		return id;
	};
	const holder = await database.actor(w.plant, "member");
	await admin.execute(
		sql`UPDATE account SET avatar_object_id=${await file(holder.id, "avatar")} WHERE id=${holder.id}`,
	);
	await person(w, "Own photo", { photo: await file(w.plant.id, "person_photo") });
	await person(w, "Account photo", { account: holder.id });
	for (const name of ["One", "Two", "Three"]) await person(w, name);
	await person(w, "Removed", { state: "retired" });
	assert.deepEqual(await names(w, { hasPhoto: true }), ["Own photo", "Account photo"]);
	const first = ok(await list(w, { hasPhoto: false, limit: 2 }));
	const second = ok(await list(w, { hasPhoto: false, limit: 2, page: 2 }));
	assert.deepEqual(
		[first, second].map((p) => [p.total, p.next, p.items.map((x) => x.displayName)]),
		[
			[3, 2, ["One", "Two"]],
			[3, null, ["Three"]],
		],
	);
	assert.deepEqual(ok(await list(w, {})).photos.length, ok(await list(w, { hasPhoto: true })).total);
});

test("the household filter splits live people by whether they are in one", async () => {
	const w = await church();
	const home = await household(w, "Rivera household");
	await person(w, "Alex", { household: home, role: "head" });
	await person(w, "Sam");
	await person(w, "Removed", { state: "retired" });
	assert.deepEqual(await names(w, { inHousehold: false }), ["Sam"]);
	assert.deepEqual(await matches(w, { inHousehold: true }), [
		["Alex", { household: { id: home, name: "Rivera household" } }],
	]);
});

test("recorded children come with their household: a role, surname or note never counts, a child's birth date does", async () => {
	const w = await church();
	const rivera = await household(w, "Rivera household"),
		nguyen = await household(w, "Nguyen household"),
		allen = await household(w, "Allen household");
	await person(w, "Mateo Rivera", { adult: "child", household: rivera, role: "child" });
	await person(w, "Bao Nguyen", { birth: "2015-03-04", household: nguyen, role: "other" });
	await person(w, "Thao Nguyen", { household: allen, role: "child" });
	const noted = await person(w, "Kid Rivera");
	await admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${w.plant.id},${w.plant.id},${noted},${w.actor.id},'is a child',clock_timestamp(),clock_timestamp())`);
	await person(w, "Grown Nguyen", { adult: "child", birth: "1990-03-04", household: allen, role: "child" });
	await person(w, "Lone Child", { adult: "child" });
	await person(w, "Removed Child", { adult: "child", state: "retired", household: allen, role: "child" });
	assert.deepEqual(await matches(w, { adultClassification: "child" }), [
		["Mateo Rivera", { household: { id: rivera, name: "Rivera household" } }],
		["Bao Nguyen", { household: { id: nguyen, name: "Nguyen household" } }],
		["Lone Child", {}],
	]);
	assert.deepEqual(await matches(w, { adultClassification: "child", inHousehold: true }), [
		["Mateo Rivera", { household: { id: rivera, name: "Rivera household" } }],
		["Bao Nguyen", { household: { id: nguyen, name: "Nguyen household" } }],
	]);
});

test("moves into a stage use the church's calendar month and dates, count each person once and count no other stage", async () => {
	const w = await church();
	const add = (name: string, stage = "core_group") => person(w, name, { stage });
	await moved(w, await add("Last minute"), "interviewed", "core_group", "2026-11-01T04:30:00Z");
	await moved(w, await add("First minute"), "interviewed", "core_group", "2026-11-01T05:30:00Z");
	const twice = await add("Twice");
	await moved(w, twice, "interviewed", "core_group", "2026-11-02T18:00:00Z", "stage_change");
	await moved(w, twice, "core_group", "attendee", "2026-11-03T18:00:00Z");
	await moved(w, twice, "attendee", "core_group", "2026-11-06T03:00:00Z");
	const onward = await add("Onward", "launch_team");
	await moved(w, onward, "interviewed", "core_group", "2026-10-20T18:00:00Z");
	await moved(w, onward, "core_group", "launch_team", "2026-11-04T18:00:00Z");
	await moved(w, await add("Same stage"), "core_group", "core_group", "2026-11-04T18:00:00Z");
	const removed = await person(w, "Removed", { state: "retired" });
	await moved(w, removed, "interviewed", "core_group", "2026-11-04T18:00:00Z");
	const created = await write(w, (tx, ctx) =>
		peopleWriter.createPerson(tx, ctx, {
			requestKey: randomUUID(),
			input: { displayName: "Created there", stage: "core_group" } as never,
		}),
	);
	assert.equal(created.person.stage, "core_group");
	const imported = await person(w, "Imported there", { stage: "core_group" });
	await admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,after_value,occurred_at,metadata)
		VALUES(${w.plant.id},${w.actor.id},'people.created','create','person',${imported},'{"stage":"core_group"}','2026-11-05T18:00:00Z','{"import":{"row":1}}')`);

	assert.deepEqual(await matches(w, { movedInto: { stage: "core_group" } }), [
		["First minute", { movedOn: "2026-11-01" }],
		["Twice", { movedOn: "2026-11-05" }],
	]);
	assert.deepEqual(await names(w, { movedInto: { stage: "core_group", from: "2026-10-01", through: "2026-10-31" } }), [
		"Last minute",
		"Onward",
	]);
	assert.deepEqual(await names(w, { movedInto: { stage: "core_group", from: "2026-11-02" } }), ["Twice"]);
	assert.deepEqual(await names(w, { movedInto: { stage: "launch_team" } }), ["Onward"]);
});

test("native stage moves count: a status change, a signed commitment, and the moves of a record merged into the person", async () => {
	const w = await church();
	const ready = await person(w, "Status", { stage: "interviewed" });
	await write(w, (tx, ctx) =>
		peopleWriter.changeStatus(
			tx,
			ctx,
			{
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { personId: ready, stage: "core_group", reason: "Joined", handoffs: [] },
			} as never,
			noReminders as never,
		),
	);
	const signed = await person(w, "Signed", { stage: "interviewed" });
	await write(w, (tx, ctx) =>
		commitments.createCommitment(tx, ctx, {
			requestKey: randomUUID(),
			input: { personId: signed, kind: "core_group", occurredOn: "2026-11-08" },
		}),
	);
	const source = await person(w, "Source", { stage: "core_group" }),
		survivor = await person(w, "Survivor", { stage: "leader" });
	await moved(w, source, "interviewed", "core_group", "2026-11-03T18:00:00Z");
	const pair = { sourceId: source, survivorId: survivor };
	const context = new PeopleReadContext(await authority(w.actor));
	const review = ok(await gatedTransaction(db, (tx) => peopleMerge.getMergeReview(tx, context, pair)));
	await write(w, (tx, ctx) =>
		peopleMerge.mergePeople(tx, ctx, {
			requestKey: randomUUID(),
			input: { ...pair, reviewDigest: review.reviewDigest },
		}),
	);
	assert.deepEqual(await matches(w, { movedInto: { stage: "core_group" } }), [
		["Status", { movedOn: "2026-11-09" }],
		["Signed", { movedOn: "2026-11-09" }],
		["Survivor", { movedOn: "2026-11-03" }],
	]);
});

test("an organization seat and an ended seat get no People list under any filter", async () => {
	const w = await church();
	await person(w, "Alex");
	const organization = await database.actor(await database.organization("sending_church"), "owner");
	const leaving = await database.actor(w.plant, "member");
	assert.deepEqual(await names({ actor: leaving }, { hasPhoto: false }), ["Alex"]);
	const filters = [
		{ skillCategories: ["tech"] },
		{ hasPhoto: false },
		{ inHousehold: false },
		{ adultClassification: "child" },
		{ movedInto: { stage: "core_group" } },
	];
	for (const filter of filters) refused(await list({ actor: organization }, filter));
	const ended = new PeopleReadContext(await authority(leaving));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${leaving.id}`);
	for (const filter of filters)
		refused(
			await gatedTransaction(db, (tx) =>
				peopleReader.listPeople(tx, ended, listPeopleRequest.parse({ page: 1, limit: 10, ...filter })),
			),
		);
});
