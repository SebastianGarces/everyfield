import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";

import { fixture } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	readPipelineBoard,
	readPipelineGoals,
	readPipelinePersonRecord,
} from "../../../packages/domain/src/organizations/pipeline.ts";

const { addPerson, correctConversation, editPerson, logConversation, movePerson, retirePerson, saveGoal, saveStages } =
	pipelineWriter;

// Sending goals and leadership conversations (REQ-MUL-007, REQ-MUL-009) against a migrated database. Grace Austin
// (America/Chicago): Owner Dana, Admin Luis, Member Ana (responsible for Casey) and Member Ben (no pipeline duty).
// Hill Country Network is a separate organization in another time zone. Days are relative to today in each
// organization's own time zone, so the tests hold on any date.

const database = await fixture({ prefix: "goals", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Actor = { id: string; session: string };
type Goals = Extract<Awaited<ReturnType<typeof readPipelineGoals>>, { status: "ok" }>["value"];
let grace: { kind: "organization"; id: string };
let hill: { kind: "organization"; id: string };
let dana: Actor, luis: Actor, ana: Actor, ben: Actor, hillOwner: Actor;
let anaSeat: string, benSeat: string;

const authority = (a: Actor) => RequestActor.resolve(db, a.session as never);
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const refusedWith = (
	r: { status: string; refusal?: { code: string; field?: string } },
	code: string,
	field?: string,
) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.refusal?.code, code);
	if (field) assert.equal(r.refusal?.field, field);
};
const goals = async (a: Actor) => ok(await readPipelineGoals(db, await authority(a))) as Goals;
const board = async (a: Actor, query: object = {}) => ok(await readPipelineBoard(db, await authority(a), query));
const record = async (a: Actor, personId: string) => readPipelinePersonRecord(db, await authority(a), { personId });
const kinds = (g: Goals) => Object.fromEntries(g.kinds.map((k) => [k.kind, k.count]));
const months = (g: Goals) => Object.fromEntries(g.conversations.months.map((m) => [m.month, m.count]));
const quarters = (g: Goals) =>
	Object.fromEntries(g.conversations.quarters.map((q) => [`${q.year}-Q${q.quarter}`, q.count]));
const seatOf = async (account: string, organization: string) =>
	(
		await admin.execute(
			sql`SELECT id FROM seat WHERE account_id=${account}::uuid AND organization_id=${organization}::uuid`,
		)
	).rows[0]!.id as string;
/** A day relative to today in `zone`, as YYYY-MM-DD: `shift` is an SQL interval such as '-1 day'. */
const day = async (zone: string, expression: string) =>
	(
		await admin.execute(
			sql`SELECT (${sql.raw(expression.replaceAll("today", `(clock_timestamp() AT TIME ZONE '${zone}')::date`))})::date::text AS d`,
		)
	).rows[0]!.d as string;
const monthOf = (d: string) => d.slice(0, 7);
const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;

const casey = randomUUID();
const people: Record<string, string> = {};
let stageIds: Record<string, string> = {};

before(async () => {
	grace = (await database.organization("sending_church", {
		name: "Grace Austin",
		timezone: "America/Chicago",
	})) as never;
	hill = (await database.organization("sending_network", {
		name: "Hill Country Network",
		timezone: "Pacific/Kiritimati",
	})) as never;
	dana = await database.actor(grace as never, "owner", { user: { name: "Dana" } });
	luis = await database.actor(grace as never, "admin", { user: { name: "Luis" } });
	ana = await database.actor(grace as never, "member", { user: { name: "Ana" } });
	ben = await database.actor(grace as never, "member", { user: { name: "Ben" } });
	hillOwner = await database.actor(hill as never, "owner", { user: { name: "Hana" } });
	anaSeat = await seatOf(ana.id, grace.id);
	benSeat = await seatOf(ben.id, grace.id);

	// Rename Potential leader to "ICNU conversation had" and add "Intern", counted as Apprentice.
	const b = await board(dana);
	const intern = randomUUID();
	ok(
		await saveStages(db, await authority(dana), {
			stages: [
				...b.stages.map((s) => ({
					id: s.id,
					label: s.kind === "potential_leader" ? "ICNU conversation had" : s.label,
					kind: s.kind,
					expectedRevision: s.revision,
				})),
				{ id: intern, label: "Intern", kind: "apprentice", expectedRevision: null },
			],
			removed: [],
		}),
	);
	stageIds = Object.fromEntries((await board(dana)).stages.map((s) => [s.label, s.id]));
	const place = async (name: string, stage: string, id = randomUUID(), responsible: string | null = null) => {
		people[name] = id;
		ok(
			await addPerson(db, await authority(dana), {
				personId: id,
				displayName: name,
				email: null,
				responsibleSeatId: responsible,
				stageId: stageIds[stage],
			}),
		);
	};
	await place("Casey Lee", "ICNU conversation had", casey, anaSeat);
	await place("Riley Park", "ICNU conversation had");
	await place("Sam Ortiz", "ICNU conversation had");
	await place("Indy Shah", "Intern");
	await place("Avery Cole", "Apprentice");
	await place("Blake Moss", "Apprentice");
	await place("Rory Quinn", "Apprentice");
	await place("Morgan Hale", "Apprentice");
	await place("Kai Doran", "Commissioned");
	// Rory is retired; Morgan was merged into Blake. Neither counts.
	ok(await retirePerson(db, await authority(dana), { personId: people["Rory Quinn"], expectedRevision: "1" }));
	await admin.execute(sql`UPDATE person SET state='merged',merged_into_person_id=${people["Blake Moss"]}::uuid,
	 retired_at=clock_timestamp() WHERE id=${people["Morgan Hale"]}::uuid`);
	// Hill Country has its own pipeline person, in its own Apprentice stage.
	const hb = await board(hillOwner);
	people["Hill Person"] = randomUUID();
	ok(
		await addPerson(db, await authority(hillOwner), {
			personId: people["Hill Person"],
			displayName: "Hill Person",
			email: null,
			responsibleSeatId: null,
			stageId: hb.stages.find((s) => s.kind === "apprentice")!.id,
		}),
	);
});

test("with no goals, every seat sees live people counted once by stage kind, and plants sent unavailable", async () => {
	const today = await day("America/Chicago", "today");
	for (const who of [dana, luis, ana, ben]) {
		const g = await goals(who);
		assert.equal(g.asOf, today);
		assert.deepEqual(g.goals, []);
		assert.equal(g.canEdit, who === dana || who === luis);
		// 3 in the renamed stage; Intern (1) and Apprentice (2) are both Apprentice; retired, merged and Hill don't count.
		assert.deepEqual(kinds(g), {
			potential_leader: 3,
			apprentice: 3,
			resident: 0,
			commissioned: 1,
			not_continuing: 0,
		});
		// A Commissioned-kind person is never a plant sent, and the count is never zero (ADR-001 stage 3).
		assert.deepEqual(g.plantsSent, { status: "unavailable", reason: "deferred_stage_3" });
	}
	// Renaming a stage never changes a count: counts use the fixed kind.
	const b = await board(dana);
	ok(
		await saveStages(db, await authority(dana), {
			stages: b.stages.map((s) => ({
				id: s.id,
				label: s.label === "Intern" ? "Interns" : s.label,
				kind: s.kind,
				expectedRevision: s.revision,
			})),
			removed: [],
		}),
	);
	assert.equal(kinds(await goals(dana)).apprentice, 3);
	// Hill Country sees only its own person.
	assert.equal(kinds(await goals(hillOwner)).apprentice, 1);
});

test("an Owner adds and edits goals; a negative target is refused; saving a goal moves nobody", async () => {
	const moves = async () =>
		(
			await admin.execute(
				sql`SELECT count(*)::int AS n FROM pipeline_stage_move WHERE organization_id=${grace.id}::uuid`,
			)
		).rows[0]!.n;
	const snapshot = async () => ({
		board: (await board(dana)).stages.map((s) => [
			s.id,
			s.label,
			s.revision,
			s.people.map((p) => [p.personId, p.revision]),
		]),
		moves: await moves(),
		history: ok(await record(dana, casey)).history,
	});
	const before = await snapshot();
	const first = randomUUID();
	const goal = {
		goalId: first,
		expectedRevision: null,
		leaderTarget: 6,
		plantTarget: 2,
		targetYear: 2028,
		rationale: "Two new churches on the east side.",
		countingFrom: null,
		counts: [],
	};
	assert.deepEqual(ok(await saveGoal(db, await authority(dana), goal)), {
		goalId: first,
		revision: "1",
		outcome: "changed",
	});
	// A repeated add writes no second goal.
	assert.equal((ok(await saveGoal(db, await authority(dana), goal)) as { outcome: string }).outcome, "noop");
	const second = randomUUID();
	ok(
		await saveGoal(db, await authority(luis), {
			...goal,
			goalId: second,
			leaderTarget: 3,
			plantTarget: 0,
			targetYear: 2030,
			rationale: "Three residents ready to lead.",
		}),
	);
	const g = await goals(ben);
	assert.deepEqual(
		g.goals.map((x) => [x.leaderTarget, x.plantTarget, x.targetYear, x.rationale]),
		[
			[6, 2, 2028, "Two new churches on the east side."],
			[3, 0, 2030, "Three residents ready to lead."],
		],
	);
	// A negative target is refused, on add and on edit.
	refusedWith(
		await saveGoal(db, await authority(dana), { ...goal, goalId: randomUUID(), plantTarget: -1 }),
		"invalid_input",
		"plantTarget",
	);
	refusedWith(
		await saveGoal(db, await authority(dana), { ...goal, expectedRevision: "1", leaderTarget: -2 }),
		"invalid_input",
		"leaderTarget",
	);
	// Members cannot save a goal, even the person's responsible staff.
	for (const who of [ana, ben])
		refusedWith(await saveGoal(db, await authority(who), { ...goal, goalId: randomUUID() }), "unavailable");
	// An edit needs the current revision.
	assert.equal(
		(
			ok(await saveGoal(db, await authority(dana), { ...goal, expectedRevision: "1", leaderTarget: 7 })) as {
				revision: string;
			}
		).revision,
		"2",
	);
	refusedWith(
		await saveGoal(db, await authority(dana), { ...goal, expectedRevision: "1", leaderTarget: 8 }),
		"conflict",
	);
	assert.equal((await goals(dana)).goals[0]!.leaderTarget, 7);
	// Nobody moved, no stage changed and nobody's history gained an entry.
	assert.deepEqual(await snapshot(), before);
	// Hill Country sees none of Grace's goals; Grace sees none of Hill's.
	assert.deepEqual((await goals(hillOwner)).goals, []);
	ok(await saveGoal(db, await authority(hillOwner), { ...goal, goalId: randomUUID(), rationale: "Hill's own goal." }));
	assert.deepEqual(
		(await goals(hillOwner)).goals.map((x) => x.rationale),
		["Hill's own goal."],
	);
	assert.equal((await goals(dana)).goals.length, 2);
	// Hill's Owner cannot change a Grace goal by naming it.
	refusedWith(await saveGoal(db, await authority(hillOwner), { ...goal, expectedRevision: "2" }), "unavailable");
});

test("conversations count by month and quarter of their day; a future day is refused; a correction moves the count", async () => {
	const tz = "America/Chicago";
	const thisMonth = await day(tz, "date_trunc('month', today)");
	const lastQuarterEnd = await day(tz, "date_trunc('quarter', today) - interval '1 day'");
	const quarterStart = await day(tz, "date_trunc('quarter', today)");
	const tomorrow = await day(tz, "today + 1");
	const auth = await authority(ana);
	const met = randomUUID();
	ok(
		await logConversation(db, auth, {
			conversationId: met,
			personId: casey,
			occurredOn: thisMonth,
			note: "Asked Casey about leading the east side group.",
		}),
	);
	// A repeat logs nothing new.
	ok(await logConversation(db, auth, { conversationId: met, personId: casey, occurredOn: thisMonth, note: null }));
	const boundary = randomUUID();
	ok(
		await logConversation(db, await authority(dana), {
			conversationId: boundary,
			personId: people["Riley Park"]!,
			occurredOn: lastQuarterEnd,
			note: null,
		}),
	);
	refusedWith(
		await logConversation(db, auth, {
			conversationId: randomUUID(),
			personId: casey,
			occurredOn: tomorrow,
			note: null,
		}),
		"invalid_input",
		"occurredOn",
	);
	// Ana is not responsible for Riley; Ben is responsible for no one.
	refusedWith(
		await logConversation(db, auth, {
			conversationId: randomUUID(),
			personId: people["Riley Park"]!,
			occurredOn: thisMonth,
			note: null,
		}),
		"unavailable",
	);
	refusedWith(
		await logConversation(db, await authority(ben), {
			conversationId: randomUUID(),
			personId: casey,
			occurredOn: thisMonth,
			note: null,
		}),
		"unavailable",
	);
	const g = await goals(dana);
	assert.equal(g.conversations.months.length, 6);
	assert.equal(g.conversations.quarters.length, 4);
	assert.equal(g.conversations.months.at(-1)!.month, monthOf(g.asOf));
	const expected = (counts: Record<string, number>, at: Record<string, number>) => {
		const all = { ...Object.fromEntries(Object.keys(at).map((k) => [k, 0])), ...counts };
		assert.deepEqual(at, all);
	};
	const sameMonth = monthOf(thisMonth) === monthOf(lastQuarterEnd);
	assert.equal(sameMonth, false);
	expected({ [monthOf(thisMonth)]: 1, [monthOf(lastQuarterEnd)]: 1 }, months(g));
	expected(
		quarterOf(thisMonth) === quarterOf(lastQuarterEnd)
			? { [quarterOf(thisMonth)]: 2 }
			: { [quarterOf(thisMonth)]: 1, [quarterOf(lastQuarterEnd)]: 1 },
		quarters(g),
	);

	// Correcting the boundary conversation to the first day of this quarter moves it to that month and quarter.
	const riley = ok(await record(dana, people["Riley Park"]!));
	const c = riley.conversations[0]!;
	assert.equal(c.on, lastQuarterEnd);
	ok(
		await correctConversation(db, await authority(dana), {
			conversationId: boundary,
			expectedRevision: c.revision,
			occurredOn: quarterStart,
			note: null,
		}),
	);
	const moved = await goals(ben);
	assert.equal(months(moved)[monthOf(lastQuarterEnd)], 0);
	assert.equal(quarters(moved)[quarterOf(lastQuarterEnd)], 0);
	assert.equal(quarters(moved)[quarterOf(quarterStart)], 2);
	// A stale revision and a future day are refused.
	refusedWith(
		await correctConversation(db, await authority(dana), {
			conversationId: boundary,
			expectedRevision: c.revision,
			occurredOn: lastQuarterEnd,
			note: null,
		}),
		"conflict",
	);
	refusedWith(
		await correctConversation(db, await authority(dana), {
			conversationId: boundary,
			expectedRevision: String(Number(c.revision) + 1),
			occurredOn: tomorrow,
			note: null,
		}),
		"invalid_input",
		"occurredOn",
	);
});

test("today, months and quarters follow the organization's time zone", async () => {
	// Kiritimati is UTC+14, so its today is often a day after UTC's: a conversation on its today is not in the future.
	const today = await day("Pacific/Kiritimati", "today");
	const g = await goals(hillOwner);
	assert.equal(g.asOf, today);
	assert.equal(g.conversations.months.at(-1)!.month, monthOf(today));
	ok(
		await logConversation(db, await authority(hillOwner), {
			conversationId: randomUUID(),
			personId: people["Hill Person"]!,
			occurredOn: today,
			note: null,
		}),
	);
	assert.equal(months(await goals(hillOwner))[monthOf(today)], 1);
	refusedWith(
		await logConversation(db, await authority(hillOwner), {
			conversationId: randomUUID(),
			personId: people["Hill Person"]!,
			occurredOn: await day("Pacific/Kiritimati", "today + 1"),
			note: null,
		}),
		"invalid_input",
		"occurredOn",
	);
});

test("only the Owner, Admins and current responsible staff read a note; a correction keeps the old and new day", async () => {
	const word = "east side group";
	const noteOf = async (a: Actor) => {
		const r = await record(a, casey);
		return r.status === "ok" ? (r.value as { conversations: { note: string | null }[] }).conversations[0]?.note : null;
	};
	for (const who of [dana, luis, ana]) assert.match((await noteOf(who)) ?? "", /east side group/);
	// Ben gets counts only: no record, and nothing in his goals read or a board search mentions the note.
	refusedWith(await record(ben, casey), "unavailable");
	assert.equal(JSON.stringify(await goals(ben)).includes(word), false);
	const searched = await board(ben, { q: "east" });
	assert.equal(searched.audience, "counts");
	assert.equal(searched.query.q, "");
	assert.equal(JSON.stringify(searched).includes("east"), false);

	// Ana corrects her conversation's day back by one; the history shows the old and new day, Ana and today.
	const c = (ok(await record(ana, casey)) as { conversations: { id: string; revision: string; on: string }[] })
		.conversations[0]!;
	const earlier = await day("America/Chicago", `'${c.on}'::date - 1`);
	ok(
		await correctConversation(db, await authority(ana), {
			conversationId: c.id,
			expectedRevision: c.revision,
			occurredOn: earlier,
			note: "Asked Casey about leading the east side group.",
		}),
	);
	const fixed = ok(await record(dana, casey));
	const entry = fixed.conversations[0]!;
	assert.equal(entry.on, earlier);
	assert.equal(entry.metBy, "Ana");
	assert.deepEqual(
		entry.corrections.map((x) => [x.actor, x.on, x.dateFrom, x.dateTo, x.noteChanged]),
		[["Ana", await day("America/Chicago", "today"), c.on, earlier, false]],
	);
	// Central audit holds no note text.
	const audit = await admin.execute(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${grace.id}::uuid AND metadata::text ILIKE '%east side%'`,
	);
	assert.equal(audit.rows[0]!.n, 0);

	// Dana makes Ben responsible for Casey in Ana's place: Ben reads the note, Ana no longer can.
	const person = ok(await record(dana, casey));
	ok(
		await editPerson(db, await authority(dana), {
			personId: casey,
			expectedRevision: person.revision,
			displayName: "Casey Lee",
			email: null,
			responsibleSeatId: benSeat,
		}),
	);
	assert.match((await noteOf(ben)) ?? "", /east side group/);
	refusedWith(await record(ana, casey), "unavailable");
	refusedWith(
		await correctConversation(db, await authority(ana), {
			conversationId: c.id,
			expectedRevision: entry.revision,
			occurredOn: c.on,
			note: null,
		}),
		"unavailable",
	);
});

test("sharing pipeline totals with a network shows the network none of Grace's goals, counts or conversations", async () => {
	// Grace turns on "Share pipeline totals" for Hill Country.
	const link = randomUUID();
	await admin.execute(sql`INSERT INTO affiliation (id,sending_church_id,organization_id,accepted_at,share_people,share_meetings,
	 share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
	 VALUES (${link}::uuid,${grace.id}::uuid,${hill.id}::uuid,clock_timestamp(),false,false,false,false,false,false,false)`);
	await admin.execute(sql`INSERT INTO pipeline_sharing (id,organization_id,relationship_id,network_id,share_pipeline_totals,revision)
	 VALUES (gen_random_uuid(),${grace.id}::uuid,${link}::uuid,${hill.id}::uuid,true,1)`);
	const g = await goals(hillOwner);
	assert.deepEqual(
		g.goals.map((x) => x.rationale),
		["Hill's own goal."],
	);
	// Only Hill's one person and one conversation.
	assert.equal(kinds(g).apprentice, 1);
	assert.equal(kinds(g).potential_leader, 0);
	assert.equal(
		g.conversations.quarters.reduce((n, q) => n + q.count, 0),
		1,
	);
	const text = JSON.stringify([g, await board(hillOwner)]);
	for (const secret of ["Casey", "east side", "Two new churches"]) assert.equal(text.includes(secret), false, secret);
	refusedWith(await record(hillOwner, casey), "unavailable");
	// Grace's counts never include Hill's conversation.
	assert.equal(
		(await goals(dana)).conversations.quarters.reduce((n, q) => n + q.count, 0),
		2,
	);
});

test("a goal's chosen counts count each live person who reached the kind since its start, once, even after moving on", async () => {
	// Hill Country Network (America/Chicago): Owner Hana, Admin Hugo, Member Mia. Grace Austin is a separate church.
	const net = await database.organization("sending_network", {
		name: "Hill Country Network",
		timezone: "America/Chicago",
	});
	const church = await database.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" });
	const hana = await database.actor(net as never, "owner", { user: { name: "Hana" } });
	const hugo = await database.actor(net as never, "admin", { user: { name: "Hugo" } });
	const mia = await database.actor(net as never, "member", { user: { name: "Mia" } });
	const gracie = await database.actor(church as never, "owner", { user: { name: "Gina" } });
	// Grace Austin shares pipeline totals with Hill Country; Hill Country's counts still hold only its own people.
	const link = randomUUID();
	await admin.execute(sql`INSERT INTO affiliation (id,sending_church_id,organization_id,accepted_at,share_people,share_meetings,
	 share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
	 VALUES (${link}::uuid,${church.id}::uuid,${net.id}::uuid,clock_timestamp(),false,false,false,false,false,false,false)`);
	await admin.execute(sql`INSERT INTO pipeline_sharing (id,organization_id,relationship_id,network_id,share_pipeline_totals,revision)
	 VALUES (gen_random_uuid(),${church.id}::uuid,${link}::uuid,${net.id}::uuid,true,1)`);
	// A second Apprentice-kind stage, "Residency track".
	const starters = await board(hana);
	const residencyTrack = randomUUID();
	ok(
		await saveStages(db, await authority(hana), {
			stages: [
				...starters.stages.map((s) => ({ id: s.id, label: s.label, kind: s.kind, expectedRevision: s.revision })),
				{ id: residencyTrack, label: "Residency track", kind: "apprentice", expectedRevision: null },
			],
			removed: [],
		}),
	);
	const stageOf = async (a: Actor, kind: string) => (await board(a)).stages.find((s) => s.kind === kind)!.id;
	const potential = await stageOf(hana, "potential_leader");
	const apprentice = (await board(hana)).stages.find((s) => s.label === "Apprentice")!.id;
	const commissioned = await stageOf(hana, "commissioned");
	const who: Record<string, string> = {};
	/** Adds a person at `stage`, with the placement dated `at` (an instant) when given. */
	const place = async (owner: Actor, name: string, stage: string, at?: string) => {
		who[name] = randomUUID();
		ok(
			await addPerson(db, await authority(owner), {
				personId: who[name],
				displayName: name,
				email: null,
				responsibleSeatId: null,
				stageId: stage,
			}),
		);
		if (at) await backdate(name, stage, at);
	};
	/** Dates the person's latest move into `stage` at `at`: the move's audit row is its day. */
	const backdate = async (name: string, stage: string, at: string) =>
		await admin.execute(sql`UPDATE audit_event SET occurred_at=${at}::timestamptz WHERE id=(SELECT m.id
		 FROM pipeline_stage_move m JOIN pipeline_person pp ON pp.id=m.pipeline_person_id JOIN audit_event a ON a.id=m.id
		 WHERE pp.person_id=${who[name]}::uuid AND m.to_stage_id=${stage}::uuid ORDER BY a.occurred_at DESC LIMIT 1)`);
	const move = async (owner: Actor, name: string, stage: string, at: string) => {
		const person = ok(await record(owner, who[name]!));
		ok(
			await movePerson(db, await authority(owner), {
				personId: who[name],
				expectedRevision: person.revision,
				stageId: stage,
				reason: "Ready for the next step.",
			}),
		);
		await backdate(name, stage, at);
	};
	const early = "2025-11-01T18:00:00Z";
	// Jo: Apprentice on Feb 3, then on to Commissioned on Sep 9. Counts in both.
	await place(hana, "Jo", potential, early);
	await move(hana, "Jo", apprentice, "2026-02-03T18:00:00Z");
	await move(hana, "Jo", commissioned, "2026-09-09T18:00:00Z");
	// Pat: into Apprentice twice. Counts once.
	await place(hana, "Pat", potential, early);
	await move(hana, "Pat", apprentice, "2026-03-01T18:00:00Z");
	await move(hana, "Pat", potential, "2026-04-01T18:00:00Z");
	await move(hana, "Pat", apprentice, "2026-06-01T18:00:00Z");
	// Dee: only Apprentice move is Dec 20, 2025. Does not count.
	await place(hana, "Dee", potential, early);
	await move(hana, "Dee", apprentice, "2025-12-20T18:00:00Z");
	// Lee: placed straight into Commissioned when added on Mar 1. Counts as a leader sent.
	await place(hana, "Lee", commissioned, "2026-03-01T18:00:00Z");
	// Ari moved at 00:30 on Jan 1 in Chicago (06:30 UTC): the start day, counts. Sid moved at 23:30 on Dec 31 in
	// Chicago, already Jan 1 in UTC: does not count.
	await place(hana, "Ari", potential, early);
	await move(hana, "Ari", apprentice, "2026-01-01T06:30:00Z");
	await place(hana, "Sid", potential, early);
	await move(hana, "Sid", apprentice, "2026-01-01T05:30:00Z");
	// Ivy moved into the second Apprentice-kind stage. Counts.
	await place(hana, "Ivy", potential, early);
	await move(hana, "Ivy", residencyTrack, "2026-05-01T18:00:00Z");
	// Rae (retired), Max (merged) and a Grace Austin person all reached Apprentice since Jan 1. None counts here.
	await place(hana, "Rae", apprentice, "2026-04-01T18:00:00Z");
	ok(await retirePerson(db, await authority(hana), { personId: who.Rae, expectedRevision: "1" }));
	await place(hana, "Max", apprentice, "2026-04-01T18:00:00Z");
	await admin.execute(sql`UPDATE person SET state='merged',merged_into_person_id=${who.Jo}::uuid,retired_at=clock_timestamp()
	 WHERE id=${who.Max}::uuid`);
	await place(gracie, "Gus", await stageOf(gracie, "apprentice"), "2026-04-01T18:00:00Z");

	const goalId = randomUUID();
	const base = {
		goalId,
		leaderTarget: 6,
		plantTarget: 2,
		targetYear: 2028,
		rationale: "Develop leaders across the hill country.",
	};
	const chosen = [
		{ kind: "apprentice", label: "Apprentices activated" },
		{ kind: "commissioned", label: "Leaders sent" },
	];
	ok(
		await saveGoal(db, await authority(hana), {
			...base,
			expectedRevision: null,
			countingFrom: "2026-01-01",
			counts: [],
		}),
	);
	const counted = async (a: Actor) => (await goals(a)).goals.find((g) => g.id === goalId)!;
	assert.deepEqual((await counted(hana)).counts, []);
	ok(
		await saveGoal(db, await authority(hana), {
			...base,
			expectedRevision: "1",
			countingFrom: "2026-01-01",
			counts: chosen,
		}),
	);
	const expected = [
		{ kind: "apprentice", label: "Apprentices activated", count: 4 },
		{ kind: "commissioned", label: "Leaders sent", count: 2 },
	];
	const g = await counted(hana);
	assert.equal(g.countingFrom, "2026-01-01");
	assert.deepEqual(g.counts, expected);
	// Plants sent stays unavailable with Commissioned people present: Leaders sent never stands in for it.
	assert.deepEqual((await goals(hana)).plantsSent, { status: "unavailable", reason: "deferred_stage_3" });

	// Renaming Apprentice to "Intern" changes no count and no count label.
	const b = await board(hana);
	ok(
		await saveStages(db, await authority(hana), {
			stages: b.stages.map((s) => ({
				id: s.id,
				label: s.label === "Apprentice" ? "Intern" : s.label,
				kind: s.kind,
				expectedRevision: s.revision,
			})),
			removed: [],
		}),
	);
	assert.deepEqual((await counted(hana)).counts, expected);

	// Every seat reads the counts, without names. A Member cannot change them.
	const asMia = await goals(mia);
	assert.equal(asMia.canEdit, false);
	assert.deepEqual(asMia.goals.find((x) => x.id === goalId)!.counts, expected);
	const text = JSON.stringify(asMia);
	for (const name of ["Jo", "Pat", "Lee", "Ari", "Ivy", "Gus"]) assert.equal(text.includes(`"${name}"`), false, name);
	refusedWith(
		await saveGoal(db, await authority(mia), {
			...base,
			expectedRevision: "2",
			countingFrom: "2026-03-01",
			counts: [],
		}),
		"unavailable",
	);

	// Starting from Mar 1 recounts: Jo's and Ari's Apprentice moves fall before it; Lee's start-day placement counts.
	ok(
		await saveGoal(db, await authority(hugo), {
			...base,
			expectedRevision: "2",
			countingFrom: "2026-03-01",
			counts: chosen,
		}),
	);
	const later = await counted(hana);
	assert.equal(later.countingFrom, "2026-03-01");
	assert.deepEqual(
		later.counts.map((c) => c.count),
		[2, 2],
	);

	// Grace Austin's own goal counts only Grace Austin's person; neither organization reads the other's goals.
	const graceGoal = randomUUID();
	ok(
		await saveGoal(db, await authority(gracie), {
			...base,
			goalId: graceGoal,
			expectedRevision: null,
			countingFrom: "2026-01-01",
			counts: [{ kind: "apprentice", label: "Apprentices activated" }],
		}),
	);
	const graceGoals = await goals(gracie);
	assert.deepEqual(
		graceGoals.goals.map((x) => [x.id, x.counts.map((c) => c.count)]),
		[[graceGoal, [1]]],
	);
	assert.deepEqual(
		(await goals(hana)).goals.map((x) => x.id),
		[goalId],
	);
	// Grace Austin's Owner cannot change Hill Country's goal or its counts by naming it.
	refusedWith(
		await saveGoal(db, await authority(gracie), {
			...base,
			expectedRevision: "3",
			countingFrom: "2026-01-01",
			counts: [],
		}),
		"unavailable",
	);
	assert.deepEqual(
		(await counted(hana)).counts.map((c) => c.label),
		["Apprentices activated", "Leaders sent"],
	);
});

test("saving counts and a start date refuses bad input, moves nobody, is audited body-free and fences stale edits", async () => {
	const tz = "America/Chicago";
	const auth = await authority(dana);
	const moves = async () =>
		(
			await admin.execute(
				sql`SELECT count(*)::int AS n FROM pipeline_stage_move WHERE organization_id=${grace.id}::uuid`,
			)
		).rows[0]!.n;
	const snapshot = async () => ({
		board: (await board(dana)).stages.map((s) => [
			s.id,
			s.label,
			s.revision,
			s.people.map((p) => [p.personId, p.revision]),
		]),
		moves: await moves(),
		history: ok(await record(dana, casey)).history,
	});
	const before = await snapshot();
	const goalId = randomUUID();
	const base = {
		goalId,
		leaderTarget: 4,
		plantTarget: 1,
		targetYear: 2029,
		rationale: "A private reason only staff read.",
		counts: [{ kind: "apprentice", label: "Apprentices activated" }],
	};
	// Added without a date, a goal counts from the day it was added.
	ok(await saveGoal(db, auth, { ...base, expectedRevision: null, countingFrom: null }));
	const saved = async () => (await goals(dana)).goals.find((g) => g.id === goalId)!;
	assert.equal((await saved()).countingFrom, await day(tz, "today"));
	const edit = (change: object) =>
		saveGoal(db, auth, { ...base, expectedRevision: "1", countingFrom: "2026-01-01", ...change });
	// A day after today, a fifth count, a repeated kind, and an empty or long label are refused; nothing saves.
	refusedWith(await edit({ countingFrom: await day(tz, "today + 1") }), "invalid_input", "countingFrom");
	refusedWith(
		await saveGoal(db, auth, {
			...base,
			goalId: randomUUID(),
			expectedRevision: null,
			countingFrom: await day(tz, "today + 1"),
		}),
		"invalid_input",
		"countingFrom",
	);
	const kinds5 = ["potential_leader", "apprentice", "resident", "commissioned", "other"];
	refusedWith(await edit({ counts: kinds5.map((kind) => ({ kind, label: kind })) }), "invalid_input", "counts");
	refusedWith(
		await edit({
			counts: [
				{ kind: "apprentice", label: "Apprentices activated" },
				{ kind: "apprentice", label: "Apprentices again" },
			],
		}),
		"invalid_input",
		"counts.1.kind",
	);
	refusedWith(await edit({ counts: [{ kind: "apprentice", label: "  " }] }), "invalid_input", "counts.0.label");
	refusedWith(
		await edit({ counts: [{ kind: "apprentice", label: "x".repeat(61) }] }),
		"invalid_input",
		"counts.0.label",
	);
	const unchanged = await saved();
	assert.equal(unchanged.revision, "1");
	assert.deepEqual(
		unchanged.counts.map((c) => c.label),
		["Apprentices activated"],
	);

	// Four counts save; one is renamed and one removed, and the rest stay intact.
	const four = [
		{ kind: "potential_leader", label: "Potential leaders named" },
		{ kind: "apprentice", label: "Apprentices activated" },
		{ kind: "resident", label: "Residents" },
		{ kind: "commissioned", label: "Leaders sent" },
	];
	ok(await edit({ counts: four }));
	assert.deepEqual(
		(await saved()).counts.map((c) => c.label),
		four.map((c) => c.label),
	);
	ok(
		await saveGoal(db, auth, {
			...base,
			expectedRevision: "2",
			countingFrom: "2026-01-01",
			counts: [four[0], { kind: "apprentice", label: "Apprentices started" }, four[3]],
		}),
	);
	const after = await saved();
	assert.equal(after.rationale, base.rationale);
	assert.deepEqual(
		after.counts.map((c) => [c.kind, c.label]),
		[
			["potential_leader", "Potential leaders named"],
			["apprentice", "Apprentices started"],
			["commissioned", "Leaders sent"],
		],
	);
	// A stale edit is refused.
	refusedWith(await edit({ counts: [] }), "conflict");
	assert.equal((await saved()).counts.length, 3);

	// Nobody moved, no stage changed and nobody's history gained an entry.
	assert.deepEqual(await snapshot(), before);
	// The audit rows hold ids, the day and the kinds, never a label or the reason.
	const audit = (
		await admin.execute(sql`SELECT kind,actor_id::text AS actor,metadata FROM audit_event WHERE tenant_id=${grace.id}::uuid
		 AND metadata->>'goalId'=${goalId} ORDER BY occurred_at,id`)
	).rows as { kind: string; actor: string; metadata: Record<string, unknown> }[];
	assert.deepEqual(
		audit.map((a) => [a.kind, a.actor, a.metadata]),
		[
			[
				"create",
				dana.id,
				{ category: "sending_goal", goalId, countingFrom: await day(tz, "today"), kinds: ["apprentice"] },
			],
			[
				"edit",
				dana.id,
				{
					category: "sending_goal",
					goalId,
					countingFrom: "2026-01-01",
					kinds: four.map((c) => c.kind),
					fields: ["countingFrom", "counts"],
				},
			],
			[
				"edit",
				dana.id,
				{
					category: "sending_goal",
					goalId,
					countingFrom: "2026-01-01",
					kinds: ["potential_leader", "apprentice", "commissioned"],
					fields: ["counts"],
				},
			],
		],
	);
	const text = JSON.stringify(audit);
	for (const secret of ["Apprentices", "Leaders sent", "private reason"])
		assert.equal(text.includes(secret), false, secret);
});
