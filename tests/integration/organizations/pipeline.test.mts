import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";

import { fixture } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { peopleReader } from "../../../packages/domain/src/people/index.ts";
import {
	addPipelineNote,
	addPipelinePerson,
	editPipelineNote,
	editPipelinePerson,
	movePipelinePerson,
	readPipelineBoard,
	readPipelinePersonRecord,
	recordPipelineAssessment,
	removePipelineNote,
	restorePipelinePerson,
	retirePipelinePerson,
	savePipelineStages,
} from "../../../packages/domain/src/organizations/pipeline.ts";

// The organization pipeline (REQ-MUL-001, -002, -008, -009) against a migrated database: Grace Austin's Owner Dana,
// Admin Luis and Members Ana (responsible for Casey) and Ben (responsible for no one), and Hill Country Network as a
// separate organization.

const database = await fixture({ prefix: "pipeline", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Actor = { id: string; session: string };
let grace: { kind: "organization"; id: string };
let hill: { kind: "organization"; id: string };
let dana: Actor, luis: Actor, ana: Actor, ben: Actor, hillOwner: Actor;
let anaSeat: string, luisSeat: string;

const named = async (workspace: typeof grace, role: "owner" | "admin" | "member", name: string) =>
	database.actor(workspace as never, role, { user: { name } });
const authority = (a: Actor) => RequestActor.resolve(db, a.session as never);
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const refusedWith = (r: { status: string; refusal?: { code: string } }, code: string) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.refusal?.code, code);
};
const board = async (a: Actor, query: object = {}) => ok(await readPipelineBoard(db, await authority(a), query));
const record = async (a: Actor, personId: string) => readPipelinePersonRecord(db, await authority(a), { personId });
const seatOf = async (account: string, organization: string) =>
	(
		await admin.execute(
			sql`SELECT id FROM seat WHERE account_id=${account}::uuid AND organization_id=${organization}::uuid`,
		)
	).rows[0]!.id as string;
const stageId = (b: Awaited<ReturnType<typeof board>>, label: string) => b.stages.find((s) => s.label === label)!.id;
const names = (b: Awaited<ReturnType<typeof board>>) =>
	Object.fromEntries(b.stages.map((s) => [s.label, s.people.map((p) => p.name)]));

before(async () => {
	grace = (await database.organization("sending_church", {
		name: "Grace Austin",
		timezone: "America/Chicago",
	})) as never;
	hill = (await database.organization("sending_network", { name: "Hill Country Network" })) as never;
	dana = await named(grace, "owner", "Dana");
	luis = await named(grace, "admin", "Luis");
	ana = await named(grace, "member", "Ana");
	ben = await named(grace, "member", "Ben");
	hillOwner = await named(hill, "owner", "Hana");
	anaSeat = await seatOf(ana.id, grace.id);
	luisSeat = await seatOf(luis.id, grace.id);
});

const casey = randomUUID();
const jordan = randomUUID();

test("an empty pipeline shows the five starter stages in order and nobody in them", async () => {
	const b = await board(dana);
	assert.equal(b.audience, "administrator");
	assert.deepEqual(
		b.stages.map((s) => [s.label, s.kind, s.count, s.people.length]),
		[
			["Potential leader", "potential_leader", 0, 0],
			["Apprentice", "apprentice", 0, 0],
			["Resident", "resident", 0, 0],
			["Commissioned", "commissioned", 0, 0],
			["Not continuing", "not_continuing", 0, 0],
		],
	);
	// The responsible-staff picker offers the organization's current seats only.
	assert.deepEqual(b.staff.map((s) => s.name).sort(), ["Ana", "Ben", "Dana", "Luis"]);
});

test("an Owner adds a person with an email and responsible staff; nobody outside the organization sees them", async () => {
	const b = await board(dana);
	const added = ok(
		await addPipelinePerson(db, await authority(dana), {
			personId: casey,
			displayName: "Casey Lee",
			email: "Casey@Example.test",
			responsibleSeatId: anaSeat,
			stageId: stageId(b, "Potential leader"),
		}),
	);
	assert.deepEqual(added, { personId: casey, revision: "1", outcome: "changed" });
	// A repeated request adds nobody else.
	const again = ok(
		await addPipelinePerson(db, await authority(dana), {
			personId: casey,
			displayName: "Casey Lee",
			email: "casey@example.test",
			responsibleSeatId: anaSeat,
			stageId: stageId(b, "Potential leader"),
		}),
	);
	assert.equal((again as { outcome: string }).outcome, "noop");
	const after = await board(dana);
	const potential = after.stages.find((s) => s.label === "Potential leader")!;
	assert.equal(potential.count, 1);
	assert.deepEqual(
		potential.people.map((p) => [p.name, p.email, p.responsible?.name]),
		[["Casey Lee", "casey@example.test", "Ana"]],
	);
	// A seat of another organization cannot be named responsible.
	const hillSeat = await seatOf(hillOwner.id, hill.id);
	refusedWith(
		await addPipelinePerson(db, await authority(dana), {
			personId: randomUUID(),
			displayName: "Someone",
			email: null,
			responsibleSeatId: hillSeat,
			stageId: stageId(b, "Apprentice"),
		}),
		"invalid_input",
	);
	// Hill Country Network has its own pipeline, without Casey, and cannot open Casey.
	const other = await board(hillOwner);
	assert.deepEqual(
		other.stages.map((s) => s.count),
		[0, 0, 0, 0, 0],
	);
	refusedWith(await record(hillOwner, casey), "unavailable");
	// Casey is in no plant's People.
	const plantOwner = database.actors.owner;
	const plant = await db.transaction((t) =>
		peopleReader.listPeople(t, { session: plantOwner.session as never, selected: database.tenant as never }, {
			search: "Casey",
		}),
	);
	assert.equal(plant.status, "ok");
	assert.equal((plant as { value: { items: unknown[] } }).value.items.length, 0);
});

test("an Owner edits a person's name, email and responsible staff", async () => {
	const before = ok(await record(dana, casey));
	const edited = ok(
		await editPipelinePerson(db, await authority(dana), {
			personId: casey,
			expectedRevision: before.revision,
			displayName: "Casey Lee-Park",
			email: null,
			responsibleSeatId: luisSeat,
		}),
	);
	const r = ok(await record(dana, casey));
	assert.deepEqual([r.name, r.email, r.responsible?.name, r.revision], ["Casey Lee-Park", null, "Luis", edited.revision]);
	// A stale revision is refused.
	refusedWith(
		await editPipelinePerson(db, await authority(dana), {
			personId: casey,
			expectedRevision: before.revision,
			displayName: "Casey Lee",
			email: "casey@example.test",
			responsibleSeatId: anaSeat,
		}),
		"conflict",
	);
	ok(
		await editPipelinePerson(db, await authority(dana), {
			personId: casey,
			expectedRevision: r.revision,
			displayName: "Casey Lee",
			email: "casey@example.test",
			responsibleSeatId: anaSeat,
		}),
	);
});

test("a move needs a reason, and the history shows who moved the person, when and why", async () => {
	const b = await board(luis);
	const r = ok(await record(luis, casey));
	refusedWith(
		await movePipelinePerson(db, await authority(luis), {
			personId: casey,
			expectedRevision: r.revision,
			stageId: stageId(b, "Apprentice"),
			reason: "   ",
		}),
		"invalid_input",
	);
	ok(
		await movePipelinePerson(db, await authority(luis), {
			personId: casey,
			expectedRevision: r.revision,
			stageId: stageId(b, "Apprentice"),
			reason: "Started leading a small group",
		}),
	);
	assert.deepEqual(names(await board(luis)).Apprentice, ["Casey Lee"]);
	const moved = ok(await record(dana, casey));
	const [latest] = moved.history;
	assert.deepEqual(latest, {
		id: latest!.id,
		kind: "moved",
		on: moved.asOf,
		actor: "Luis",
		from: "Potential leader",
		to: "Apprentice",
		reason: "Started leading a small group",
	});
	assert.deepEqual(moved.history.at(-1)!.kind, "placed");
	// Central audit holds no reason (REQ-MUL-002).
	const audit = await admin.execute(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${grace.id}::uuid
		 AND (coalesce(reason,'') ILIKE '%small group%' OR metadata::text ILIKE '%small group%'
		  OR coalesce(before_value::text,'') ILIKE '%small group%' OR coalesce(after_value::text,'') ILIKE '%small group%')`,
	);
	assert.equal(audit.rows[0]!.n, 0);
});

test("stage edits rename, add and reorder; history keeps the label of the time; occupied stages are not removed", async () => {
	const b = await board(dana);
	const stages = b.stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind, expectedRevision: s.revision }));
	const intern = randomUUID();
	const renamed = stages.map((s) => (s.label === "Potential leader" ? { ...s, label: "ICNU conversation had" } : s));
	// Intern, an Apprentice kind, goes first; the rest keep their order.
	const next = [{ id: intern, label: "Intern", kind: "apprentice", expectedRevision: null }, ...renamed];
	// Only an Owner or Admin edits stages.
	refusedWith(await savePipelineStages(db, await authority(ana), { stages: next, removed: [] }), "unavailable");
	ok(await savePipelineStages(db, await authority(dana), { stages: next, removed: [] }));
	const saved = await board(dana);
	assert.deepEqual(
		saved.stages.map((s) => s.label),
		["Intern", "ICNU conversation had", "Apprentice", "Resident", "Commissioned", "Not continuing"],
	);
	const history = ok(await record(dana, casey)).history;
	assert.deepEqual(
		history.filter((h) => h.kind === "moved").map((h) => [h.from, h.to]),
		[["Potential leader", "Apprentice"]],
	);
	// Apprentice holds Casey: removing it is refused and nothing changes.
	const current = saved.stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind, expectedRevision: s.revision }));
	const apprentice = current.find((s) => s.label === "Apprentice")!;
	const refused = await savePipelineStages(db, await authority(dana), {
		stages: current.filter((s) => s.id !== apprentice.id),
		removed: [{ id: apprentice.id, expectedRevision: apprentice.expectedRevision }],
	});
	assert.deepEqual(refused, {
		status: "refused",
		refusal: { code: "stage_occupied", stageId: apprentice.id, people: 1 },
	});
	assert.deepEqual(
		(await board(dana)).stages.map((s) => s.label),
		saved.stages.map((s) => s.label),
	);
	// An empty stage can go.
	const internNow = current.find((s) => s.label === "Intern")!;
	ok(
		await savePipelineStages(db, await authority(dana), {
			stages: current.filter((s) => s.id !== intern),
			removed: [{ id: intern, expectedRevision: internNow.expectedRevision }],
		}),
	);
	assert.equal((await board(dana)).stages.some((s) => s.label === "Intern"), false);
});

test("Not continuing is an ordinary move", async () => {
	const b = await board(dana);
	const person = randomUUID();
	ok(
		await addPipelinePerson(db, await authority(dana), {
			personId: person,
			displayName: "Riley Fox",
			email: null,
			responsibleSeatId: null,
			stageId: stageId(b, "Resident"),
		}),
	);
	ok(
		await movePipelinePerson(db, await authority(luis), {
			personId: person,
			expectedRevision: "1",
			stageId: stageId(b, "Not continuing"),
			reason: "Called to stay in his current role",
		}),
	);
	assert.deepEqual(names(await board(dana))["Not continuing"], ["Riley Fox"]);
});

test("an outside assessment records only that it happened, when and by whom", async () => {
	const r = ok(await record(luis, casey));
	// No result, score or rating field exists.
	refusedWith(
		await recordPipelineAssessment(db, await authority(luis), {
			personId: casey,
			expectedRevision: r.revision,
			assessedOn: "2026-10-02",
			assessor: "Send Network assessment retreat",
			outcome: "recommended",
		}),
		"invalid_input",
	);
	// Not a day after today.
	refusedWith(
		await recordPipelineAssessment(db, await authority(luis), {
			personId: casey,
			expectedRevision: r.revision,
			assessedOn: "2999-01-01",
			assessor: "Send Network assessment retreat",
		}),
		"invalid_input",
	);
	ok(
		await recordPipelineAssessment(db, await authority(luis), {
			personId: casey,
			expectedRevision: r.revision,
			assessedOn: "2026-10-02",
			assessor: "Send Network assessment retreat",
		}),
	);
	assert.deepEqual(ok(await record(dana, casey)).assessment, {
		on: "2026-10-02",
		by: "Send Network assessment retreat",
	});
});

test("the six-month filter finds people with no stage move since, as of today", async () => {
	const b = await board(dana);
	ok(
		await addPipelinePerson(db, await authority(dana), {
			personId: jordan,
			displayName: "Jordan Reyes",
			email: null,
			responsibleSeatId: luisSeat,
			stageId: stageId(b, "Resident"),
		}),
	);
	// Jordan's placement happened more than six months ago; Casey's last move two weeks ago.
	await admin.execute(sql`UPDATE audit_event a SET occurred_at=clock_timestamp()-interval '190 days' FROM pipeline_stage_move m
	 JOIN pipeline_person pp ON pp.id=m.pipeline_person_id WHERE a.id=m.id AND pp.person_id=${jordan}::uuid`);
	await admin.execute(sql`UPDATE audit_event a SET occurred_at=clock_timestamp()-interval '16 days' FROM pipeline_stage_move m
	 JOIN pipeline_person pp ON pp.id=m.pipeline_person_id WHERE a.id=m.id AND pp.person_id=${casey}::uuid`);
	const stale = await board(dana, { stale: true });
	const people = stale.stages.flatMap((s) => s.people.map((p) => p.name));
	assert.deepEqual(people, ["Jordan Reyes"]);
	const today = (
		await admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text AS d`)
	).rows[0]!.d;
	assert.equal(stale.asOf, today);
});

test("a Member with no pipeline duty sees counts only and cannot change anything", async () => {
	const b = await board(ben, { q: "Casey", stale: true });
	assert.equal(b.audience, "counts");
	assert.equal(
		b.stages.every((s) => s.people.length === 0 && s.matching === 0),
		true,
	);
	assert.deepEqual(b.query, { view: "board", stale: false, q: "", page: 1 });
	assert.equal(b.stages.reduce((n, s) => n + s.count, 0), 3);
	assert.deepEqual(b.staff, []);
	refusedWith(await record(ben, casey), "unavailable");
	const auth = await authority(ben);
	refusedWith(
		await addPipelinePerson(db, auth, {
			personId: randomUUID(),
			displayName: "X",
			email: null,
			responsibleSeatId: null,
			stageId: stageId(b, "Resident"),
		}),
		"unavailable",
	);
	refusedWith(
		await movePipelinePerson(db, auth, {
			personId: casey,
			expectedRevision: "1",
			stageId: stageId(b, "Resident"),
			reason: "x",
		}),
		"unavailable",
	);
	refusedWith(await retirePipelinePerson(db, auth, { personId: casey, expectedRevision: "1" }), "unavailable");
	refusedWith(
		await addPipelineNote(db, auth, { personId: casey, noteId: randomUUID(), body: "Should not save" }),
		"unavailable",
	);
});

test("responsible staff see their own people and notes, and nothing of anyone else's", async () => {
	const b = await board(ana);
	assert.equal(b.audience, "responsible");
	assert.deepEqual(
		b.stages.flatMap((s) => s.people.map((p) => p.name)),
		["Casey Lee"],
	);
	await addPipelineNote(db, await authority(luis), {
		personId: jordan,
		noteId: randomUUID(),
		body: "Jordan is weighing a move to Dallas",
	});
	refusedWith(await record(ana, jordan), "unavailable");
	// Ana's search finds nothing from a note she cannot read.
	assert.deepEqual(
		(await board(ana, { q: "Dallas" })).stages.flatMap((s) => s.people),
		[],
	);
	refusedWith(
		await addPipelineNote(db, await authority(ana), { personId: jordan, noteId: randomUUID(), body: "No" }),
		"unavailable",
	);
});

test("a note is read by Owner, Admin and responsible staff only, and only its author edits or removes it", async () => {
	const noteId = randomUUID();
	ok(await addPipelineNote(db, await authority(ana), { personId: casey, noteId, body: "Casey asked about Austin seminary" }));
	for (const reader of [dana, luis, ana]) {
		const notes = ok(await record(reader, casey)).notes;
		assert.deepEqual(
			notes.map((n) => (n.state === "current" ? [n.body, n.author, n.mine] : null)),
			[["Casey asked about Austin seminary", "Ana", reader === ana]],
		);
	}
	// Search finds the note's word for a reader and nothing for Ben.
	assert.deepEqual(
		(await board(dana, { q: "seminary" })).stages.flatMap((s) => s.people.map((p) => p.name)),
		["Casey Lee"],
	);
	assert.deepEqual(
		(await board(ben, { q: "seminary" })).stages.flatMap((s) => s.people),
		[],
	);
	refusedWith(
		await editPipelineNote(db, await authority(dana), { noteId, expectedRevision: "1", body: "Changed by Dana" }),
		"unavailable",
	);
	refusedWith(await removePipelineNote(db, await authority(luis), { noteId, expectedRevision: "1" }), "unavailable");
	const edited = ok(
		await editPipelineNote(db, await authority(ana), { noteId, expectedRevision: "1", body: "Casey asked about seminary" }),
	);
	ok(await removePipelineNote(db, await authority(ana), { noteId, expectedRevision: edited.revision }));
	const r = ok(await record(dana, casey));
	assert.deepEqual(r.notes, [{ state: "removed", id: noteId, author: "Ana", removedOn: r.asOf }]);
	assert.deepEqual(
		(await board(dana, { q: "seminary" })).stages.flatMap((s) => s.people),
		[],
	);
	// The body never reached central audit.
	const audit = await admin.execute(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${grace.id}::uuid AND metadata::text ILIKE '%seminary%'`,
	);
	assert.equal(audit.rows[0]!.n, 0);
});

test("retiring takes a person off the board and counts; restoring puts them back in the same stage", async () => {
	const before = await board(dana);
	const resident = before.stages.find((s) => s.label === "Resident")!;
	const j = ok(await record(dana, jordan));
	ok(await retirePipelinePerson(db, await authority(dana), { personId: jordan, expectedRevision: j.revision }));
	const retired = await board(dana);
	assert.equal(retired.stages.find((s) => s.label === "Resident")!.count, resident.count - 1);
	assert.equal(
		retired.stages.some((s) => s.people.some((p) => p.name === "Jordan Reyes")),
		false,
	);
	assert.equal(retired.retiredCount, 1);
	const list = await board(dana, { view: "retired" });
	assert.deepEqual(
		list.stages.flatMap((s) => s.people.map((p) => [s.label, p.name])),
		[["Resident", "Jordan Reyes"]],
	);
	const kept = ok(await record(dana, jordan));
	assert.equal(kept.retired, true);
	assert.deepEqual(kept.history[0]!.kind, "retired");
	// Luis, Jordan's responsible staff and an Admin, still reads him; a retired person is never in a Member's view.
	ok(await restorePipelinePerson(db, await authority(dana), { personId: jordan, expectedRevision: kept.revision }));
	const restored = await board(dana);
	assert.equal(restored.stages.find((s) => s.label === "Resident")!.count, resident.count);
	assert.deepEqual(names(restored).Resident, ["Jordan Reyes"]);
});
