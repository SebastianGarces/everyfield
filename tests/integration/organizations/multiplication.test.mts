import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { seeds, waitingOnLock } from "../../support/fixture.mts";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import {
	createOrganizationAdapter,
	pipelineWriter,
	programWriter,
	readEnrollment,
	readMyResidency,
	readPipelineBoard,
	readPipelineExport,
	readPipelineGoals,
	readPipelinePersonRecord,
	readProgram,
	readPrograms,
	readVersionReview,
	residentWriter,
} from "../../../packages/domain/src/organizations/index.ts";
import { evryActor, invokeRead } from "../../../packages/evry/src/index.ts";
import { listPeople } from "../../../packages/evry/src/adapters/pipeline/reads/index.ts";

let f: Awaited<ReturnType<typeof fixture>>;
type Actor = { id: string; session: string; email: string };
type Org = { kind: "organization"; id: string; organizationKind: "sending_church" | "sending_network" };
let grace: Org, hill: Org;
let harvest: { kind: "plant"; id: string };
let dana: Actor, luis: Actor, ana: Actor, dee: Actor, ben: Actor, hillOwner: Actor, planter: Actor, casey: Actor;
let anaSeat: string, deeSeat: string;
let networkLink: string;
const caseyPerson = randomUUID(),
	jordanPerson = randomUUID(),
	morganPerson = randomUUID();
const program = randomUUID(),
	caseyEnrollment = randomUUID(),
	jordanEnrollment = randomUUID();
const notes = { anaOnCasey: randomUUID(), deeOnJordan: randomUUID(), danaOnJordan: randomUUID() };
let caseyInvitation: { invitationId: string; proof: string };
let stages: Record<string, string>;

const SECRET = {
	anaNote: "Casey is ready to lead the east side group",
	deeNote: "Jordan asked about the youth group",
	danaNote: "Jordan's family moves in the spring",
	caseyTalk: "Talked with Casey about the east side",
	jordanTalk: "Talked with Jordan about timing",
	caseyFeedback: "Clear outline, Casey. Slow down in the second half.",
	jordanFeedback: "Jordan, tighten the opening story.",
	moveReason: "Finished the leadership course",
	goal: "Two new churches on the east side",
};
const VISION = "Present your vision to the sending church leadership";
const PROSPECTUS = "Write a church planting prospectus";
const PREACH = "Preach on a Sunday";

const authority = (a: { session: string }) => RequestActor.resolve(f.db, sessionId.parse(a.session));
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const unavailable = { status: "refused", refusal: { code: "unavailable" } };
const board = async (a: Actor) => ok(await readPipelineBoard(f.db, await authority(a), {}));
const names = (b: Awaited<ReturnType<typeof board>>) => b.stages.flatMap((s) => s.people.map((p) => p.name)).sort();
const record = async (a: Actor, personId: string) => readPipelinePersonRecord(f.db, await authority(a), { personId });
const enrollment = async (a: Actor, enrollmentId: string) => readEnrollment(f.db, await authority(a), { enrollmentId });
const milestoneOf = <T extends { title: string }>(list: T[], title: string) => list.find((m) => m.title === title)!;
async function evryRead(a: Actor) {
	const viewer = await readViewer(f.db, sessionId.parse(a.session));
	const actor = evryActor(viewer!.authority!);
	return JSON.stringify(await invokeRead(f.db, actor, listPeople as never, {}));
}
const today = async () =>
	(await f.admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text AS d`)).rows[0]!
		.d as string;
const count = async (query: SQL) => Number((await f.admin.execute(query)).rows[0]!.n);

const adapter = createOrganizationAdapter(
	{
		invitation: async () => {
			throw Error("no relationship invitation here");
		},
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded' WHERE subject_record_id=${sql.param(v.sourceId)} AND kind='digest' AND false`,
	},
	{ candidates: async () => [] },
);
async function caseyShares(choices: { shareFoundations: boolean; shareMilestones: boolean }) {
	const link = (
		await f.admin.execute(
			sql`SELECT id,revision::text AS revision,consent_revision::text AS consent FROM residency_link WHERE account_id=${casey.id}::uuid AND ended_at IS NULL`,
		)
	).rows[0] as { id: string; revision: string; consent: string };
	const owner = { kind: "account" as const, id: casey.id };
	await f.db.transaction(async (tx) => {
		if (!(await RequestActor.claimWrite(tx, sessionId.parse(casey.session), owner))) throw Error("unavailable");
		return adapter["residency.setSharing"](tx, sessionId.parse(casey.session), owner, {
			requestKey: randomUUID(),
			expectedRevision: link.revision,
			input: { linkId: link.id, expectedConsentRevision: link.consent, choices },
		} as never);
	});
}
async function invite(personId: string, email: string) {
	const r = ok(await record(luis, personId));
	const sent = await f.invitations.inviteResident(await authority(luis), {
		requestKey: randomUUID(),
		expectedRevision: r.organizationRevision,
		input: { organization: grace, personId, recipientEmail: email },
	});
	return { invitationId: sent.invitation.invitationId as string, proof: await f.proof(sent.invitation.invitationId) };
}
const accept = (i: { invitationId: string; proof: string }, shareMilestones = true) => ({
	requestKey: randomUUID(),
	expectedRevision: "1",
	input: {
		invitationId: i.invitationId,
		proof: i.proof,
		decision: "accept",
		choices: { shareFoundations: false, shareMilestones },
	},
});
const settle = (p: Promise<unknown>) =>
	p.then(
		(value) => value,
		(e: Error & { value?: { code?: string } }) => ({ refused: e.value?.code ?? e.message }),
	);
async function atOnce<T>(lock: SQL, writes: (() => Promise<T>)[]): Promise<T[]> {
	let held!: () => void, release!: () => void;
	const locked = new Promise<void>((r) => (held = r));
	const released = new Promise<void>((r) => (release = r));
	const holder = f.admin.transaction(async (tx) => {
		await tx.execute(lock);
		held();
		await released;
	});
	await locked;
	const runs = writes.map((w) => w());
	assert.equal(await waitingOnLock(f.db, { count: writes.length }), true, "every write must wait on the lock");
	release();
	await holder;
	return Promise.all(runs);
}

before(async () => {
	f = await fixture();
	const seed = seeds(f.admin);
	grace = (await seed.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" })) as never;
	hill = (await seed.organization("sending_network", {
		name: "Hill Country Network",
		timezone: "America/Chicago",
	})) as never;
	harvest = (await seed.plant({ name: "Harvest Point" })) as never;
	const actor = async (where: unknown, role: "owner" | "admin" | "member", name: string, email?: string) => {
		const a = await seed.actor(where as never, role, { user: { name }, ...(email ? { email } : {}) });
		return { id: a.id, session: a.session, email: a.email };
	};
	dana = await actor(grace, "owner", "Dana");
	luis = await actor(grace, "admin", "Luis");
	ana = await actor(grace, "member", "Ana");
	dee = await actor(grace, "member", "Dee");
	ben = await actor(grace, "member", "Ben");
	hillOwner = await actor(hill, "owner", "Ruth");
	planter = await actor(harvest, "owner", "Daniel");
	casey = await actor(null, "owner", "Casey Lee", "casey@example.test");
	const seatOf = async (a: Actor) =>
		(
			await f.admin.execute(
				sql`SELECT id FROM seat WHERE account_id=${a.id}::uuid AND organization_id=${grace.id}::uuid`,
			)
		).rows[0]!.id as string;
	anaSeat = await seatOf(ana);
	deeSeat = await seatOf(dee);

	for (const org of [grace, hill])
		await f.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		 share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		 VALUES(${harvest.id},${org.id},clock_timestamp(),true,true,true,true,true,true,true)`);
	networkLink = randomUUID();
	await f.admin.execute(sql`INSERT INTO affiliation(id,sending_church_id,organization_id,accepted_at,share_people,
	 share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
	 VALUES(${networkLink},${grace.id},${hill.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	await f.admin.execute(sql`INSERT INTO pipeline_sharing(id,organization_id,relationship_id,network_id,
	 share_pipeline_totals,revision) VALUES(gen_random_uuid(),${grace.id},${networkLink},${hill.id},true,1)`);

	const b = await board(dana);
	stages = Object.fromEntries(b.stages.map((s) => [s.label, s.id]));
	for (const [personId, displayName, email, seat] of [
		[caseyPerson, "Casey Lee", "casey@example.test", anaSeat],
		[jordanPerson, "Jordan Reyes", null, deeSeat],
	] as const)
		ok(
			await pipelineWriter.addPerson(f.db, await authority(dana), {
				personId,
				displayName,
				email,
				responsibleSeatId: seat,
				stageId: stages["Potential leader"],
			}),
		);
	const hillStages = (await board(hillOwner)).stages;
	ok(
		await pipelineWriter.addPerson(f.db, await authority(hillOwner), {
			personId: morganPerson,
			displayName: "Morgan Diaz",
			email: null,
			responsibleSeatId: null,
			stageId: hillStages[0]!.id,
		}),
	);
	const moved = ok(await record(dana, caseyPerson));
	ok(
		await pipelineWriter.movePerson(f.db, await authority(dana), {
			personId: caseyPerson,
			expectedRevision: moved.revision,
			stageId: stages.Apprentice,
			reason: SECRET.moveReason,
		}),
	);
	for (const [who, noteId, personId, body] of [
		[ana, notes.anaOnCasey, caseyPerson, SECRET.anaNote],
		[dee, notes.deeOnJordan, jordanPerson, SECRET.deeNote],
		[dana, notes.danaOnJordan, jordanPerson, SECRET.danaNote],
	] as const)
		ok(await pipelineWriter.addNote(f.db, await authority(who), { personId, noteId, body }));
	const day = await today();
	for (const [who, personId, note] of [
		[ana, caseyPerson, SECRET.caseyTalk],
		[dee, jordanPerson, SECRET.jordanTalk],
	] as const)
		ok(
			await pipelineWriter.logConversation(f.db, await authority(who), {
				conversationId: randomUUID(),
				personId,
				occurredOn: day,
				note,
			}),
		);
	ok(
		await pipelineWriter.saveGoal(f.db, await authority(dana), {
			goalId: randomUUID(),
			expectedRevision: null,
			leaderTarget: 6,
			plantTarget: 2,
			targetYear: 2028,
			rationale: SECRET.goal,
			countingFrom: null,
			counts: [],
		}),
	);

	ok(
		await programWriter.createProgram(f.db, await authority(dana), {
			programId: program,
			kind: "residency",
			name: "Grace Residency",
			directorSeatId: anaSeat,
			plan: {
				rhythm: "monthly",
				expectedMonths: 15,
				stages: [
					{ label: "Assimilating", minMonths: 2, maxMonths: 3 },
					{ label: "Training and planning", minMonths: 6, maxMonths: 9 },
				],
				milestones: [
					[VISION, null],
					[PROSPECTUS, null],
					[PREACH, "Preach at a Sunday gathering and debrief with Ana."],
				].map(([title, description]) => ({ lineage: randomUUID(), title, description, handsOn: description !== null })),
				readings: [],
			},
		}),
	);
	const draft = (
		await f.admin.execute(sql`SELECT revision::text AS r FROM development_program WHERE id=${program}::uuid`)
	).rows[0]!.r as string;
	ok(await programWriter.publishVersion(f.db, await authority(ana), { programId: program, expectedRevision: draft }));
	const v1 = ok(await readProgram(f.db, await authority(ana), { programId: program })).published!;
	for (const [enrollmentId, personId] of [
		[caseyEnrollment, caseyPerson],
		[jordanEnrollment, jordanPerson],
	])
		ok(
			await programWriter.enroll(f.db, await authority(dana), {
				enrollmentId,
				programId: program,
				personId,
				cohort: "2026",
				startedOn: "2026-10-01",
				expectedEndOn: "2027-12-31",
				stageId: v1.stages[0]!.id,
				nextMeetingAt: "2026-10-20T19:00:00",
			}),
		);
	const milestone = (title: string) => milestoneOf(v1.milestones, title).id;
	for (const [enrollmentId, title] of [
		[caseyEnrollment, PREACH],
		[jordanEnrollment, PROSPECTUS],
	])
		ok(
			await programWriter.recordMilestone(f.db, await authority(ana), {
				enrollmentId,
				milestoneId: milestone(title),
				completedOn: "2026-10-12",
			}),
		);
	for (const [enrollmentId, body] of [
		[caseyEnrollment, SECRET.caseyFeedback],
		[jordanEnrollment, SECRET.jordanFeedback],
	])
		ok(
			await programWriter.addFeedback(f.db, await authority(ana), {
				feedbackId: randomUUID(),
				enrollmentId,
				milestoneId: milestone(PREACH),
				body,
			}),
		);

	caseyInvitation = await invite(caseyPerson, casey.email);
	await f.invitations.respondResident(casey.session, accept(caseyInvitation));
	const mark = { enrollmentId: caseyEnrollment, milestoneId: milestone(VISION) };
	ok(await residentWriter.markMilestone(f.db, await authority(casey), mark));
	ok(await programWriter.confirmMilestone(f.db, await authority(ana), mark));
});
after(() => f?.close());

async function everything(a: Actor) {
	const who = await authority(a);
	return JSON.stringify([
		await readPipelineBoard(f.db, who, {}),
		await readPipelineGoals(f.db, who),
		await readPrograms(f.db, who),
		await readProgram(f.db, who, { programId: program }),
		await readPipelinePersonRecord(f.db, who, { personId: caseyPerson }),
		await readPipelinePersonRecord(f.db, who, { personId: jordanPerson }),
		await readEnrollment(f.db, who, { enrollmentId: caseyEnrollment }),
		await readEnrollment(f.db, who, { enrollmentId: jordanEnrollment }),
		await readPipelineExport(f.db, who),
	]);
}

test("AC:ADR1-002 AC:ADR1-009 AC:ADR1-012 Dana and Luis see every pipeline person, note, feedback and shared mark", async () => {
	for (const who of [dana, luis]) {
		assert.deepEqual(names(await board(who)), ["Casey Lee", "Jordan Reyes"]);
		const c = ok(await record(who, caseyPerson));
		assert.deepEqual(
			c.notes.map((n) => n.body),
			[SECRET.anaNote],
		);
		assert.deepEqual(
			c.conversations.map((x) => x.note),
			[SECRET.caseyTalk],
		);
		const j = ok(await record(who, jordanPerson));
		assert.deepEqual(j.notes.map((n) => n.body).sort(), [SECRET.danaNote, SECRET.deeNote].sort());
		const e = ok(await enrollment(who, caseyEnrollment));
		assert.deepEqual(
			e.milestones.map((m) => [m.title, m.completion?.source ?? null, m.feedback?.map((x) => x.body) ?? null]),
			[
				[VISION, "resident", []],
				[PROSPECTUS, null, []],
				[PREACH, "program_leader", [SECRET.caseyFeedback]],
			],
		);
		const jordan = ok(await enrollment(who, jordanEnrollment));
		assert.deepEqual(
			milestoneOf(jordan.milestones, PREACH).feedback?.map((x) => x.body),
			[SECRET.jordanFeedback],
		);
		assert.deepEqual(
			ok(await readProgram(f.db, await authority(who), { programId: program })).enrollments.map((x) => x.name),
			["Casey Lee", "Jordan Reyes"],
		);
	}
});

test("AC:ADR1-002 AC:ADR1-012 AC:ADR1-014 Ana sees Casey, the notes on her, the feedback she wrote and Casey's shared milestones, and nothing else", async () => {
	assert.deepEqual(names(await board(ana)), ["Casey Lee"]);
	const c = ok(await record(ana, caseyPerson));
	assert.deepEqual(
		c.notes.map((n) => [n.author, n.body]),
		[["Ana", SECRET.anaNote]],
	);
	assert.deepEqual(await record(ana, jordanPerson), unavailable);
	const e = ok(await enrollment(ana, caseyEnrollment));
	assert.deepEqual(milestoneOf(e.milestones, VISION).completion?.source, "resident");
	assert.deepEqual(
		milestoneOf(e.milestones, PREACH).feedback?.map((x) => [x.writer, x.body]),
		[["Ana", SECRET.caseyFeedback]],
	);
	assert.deepEqual(e.resident, { status: "linked", milestones: "shared", foundations: { status: "not_shared" } });
	const text = await everything(ana);
	for (const secret of [SECRET.deeNote, SECRET.danaNote, SECRET.jordanTalk])
		assert.equal(text.includes(secret), false, secret);
	assert.deepEqual(await readPipelineExport(f.db, await authority(ana)), unavailable);
});

test("AC:ADR1-002 Dee sees Jordan and Jordan's notes, and no other person's notes, feedback or progress", async () => {
	assert.deepEqual(names(await board(dee)), ["Jordan Reyes"]);
	const j = ok(await record(dee, jordanPerson));
	assert.deepEqual(j.notes.map((n) => n.body).sort(), [SECRET.danaNote, SECRET.deeNote].sort());
	assert.deepEqual(await record(dee, caseyPerson), unavailable);
	assert.deepEqual(await enrollment(dee, caseyEnrollment), unavailable);
	const e = ok(await enrollment(dee, jordanEnrollment));
	assert.ok(e.milestones.every((m) => m.feedback === null));
	assert.deepEqual(
		ok(await readProgram(f.db, await authority(dee), { programId: program })).enrollments.map((x) => x.name),
		["Jordan Reyes"],
	);
	const text = await everything(dee);
	for (const secret of [
		"Casey",
		SECRET.anaNote,
		SECRET.caseyTalk,
		SECRET.caseyFeedback,
		SECRET.jordanFeedback,
		SECRET.moveReason,
	])
		assert.equal(text.includes(secret), false, secret);
});

test("AC:ADR1-002 AC:ADR1-007 AC:ADR1-009 Ben sees stage counts and conversation counts only, and every write he sends is refused", async () => {
	const b = await board(ben);
	assert.equal(b.audience, "counts");
	assert.deepEqual(names(b), []);
	assert.deepEqual(Object.fromEntries(b.stages.map((s) => [s.label, s.count])), {
		"Potential leader": 1,
		Apprentice: 1,
		Resident: 0,
		Commissioned: 0,
		"Not continuing": 0,
	});
	const g = ok(await readPipelineGoals(f.db, await authority(ben)));
	assert.equal(
		g.conversations.quarters.reduce((n, q) => n + q.count, 0),
		2,
	);
	assert.deepEqual(ok(await readProgram(f.db, await authority(ben), { programId: program })).enrollments, []);
	const text = await everything(ben);
	for (const secret of [
		"Casey",
		"Jordan",
		SECRET.anaNote,
		SECRET.deeNote,
		SECRET.danaNote,
		SECRET.caseyTalk,
		SECRET.jordanTalk,
		SECRET.caseyFeedback,
		SECRET.moveReason,
	])
		assert.equal(text.includes(secret), false, secret);

	const auth = await authority(ben);
	const v1 = ok(await readProgram(f.db, await authority(dana), { programId: program })).published!;
	const writes = [
		pipelineWriter.addPerson(f.db, auth, {
			personId: randomUUID(),
			displayName: "X",
			email: null,
			responsibleSeatId: null,
			stageId: stages.Resident,
		}),
		pipelineWriter.editPerson(f.db, auth, {
			personId: caseyPerson,
			expectedRevision: "1",
			displayName: "X",
			email: null,
			responsibleSeatId: null,
		}),
		pipelineWriter.movePerson(f.db, auth, {
			personId: caseyPerson,
			expectedRevision: "2",
			stageId: stages.Resident,
			reason: "x",
		}),
		pipelineWriter.retirePerson(f.db, auth, { personId: jordanPerson, expectedRevision: "1" }),
		pipelineWriter.addNote(f.db, auth, { personId: caseyPerson, noteId: randomUUID(), body: "x" }),
		pipelineWriter.editNote(f.db, auth, { noteId: notes.anaOnCasey, expectedRevision: "1", body: "x" }),
		pipelineWriter.logConversation(f.db, auth, {
			conversationId: randomUUID(),
			personId: caseyPerson,
			occurredOn: "2026-10-01",
			note: null,
		}),
		pipelineWriter.saveGoal(f.db, auth, {
			goalId: randomUUID(),
			expectedRevision: null,
			leaderTarget: 1,
			plantTarget: 1,
			targetYear: 2028,
			rationale: "x",
			countingFrom: null,
			counts: [],
		}),
		programWriter.enroll(f.db, auth, {
			enrollmentId: randomUUID(),
			programId: program,
			personId: jordanPerson,
			cohort: "X",
			startedOn: "2026-10-01",
			expectedEndOn: "2026-12-01",
			stageId: v1.stages[0]!.id,
			nextMeetingAt: null,
		}),
		programWriter.confirmMilestone(f.db, auth, {
			enrollmentId: caseyEnrollment,
			milestoneId: milestoneOf(v1.milestones, VISION).id,
		}),
		programWriter.addFeedback(f.db, auth, {
			feedbackId: randomUUID(),
			enrollmentId: caseyEnrollment,
			milestoneId: milestoneOf(v1.milestones, PREACH).id,
			body: "x",
		}),
	];
	for (const reply of await Promise.all(writes)) assert.deepEqual(reply, unavailable);
});

test("AC:ADR1-002 AC:ADR1-013 Casey sees My residency only: no Pipeline page, staff notes, other person or seat", async () => {
	const mine = ok(await readMyResidency(f.db, await authority(casey)));
	assert.equal(mine.status, "linked");
	const text = JSON.stringify(mine);
	for (const secret of [
		"Jordan",
		SECRET.anaNote,
		SECRET.caseyTalk,
		SECRET.moveReason,
		SECRET.jordanFeedback,
		"Apprentice",
		"Potential leader",
	])
		assert.equal(text.includes(secret), false, secret);
	assert.ok(text.includes(SECRET.caseyFeedback));
	const refusals = JSON.parse(await everything(casey)) as unknown[];
	assert.deepEqual(refusals, Array(refusals.length).fill(unavailable));
	assert.equal(await count(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${casey.id}::uuid`), 0);
	assert.equal(await evryRead(casey).catch(() => "refused"), "refused");
});

test("AC:ADR1-007 AC:ADR1-016 Hill Country's Owner sees no Grace Austin person, count, goal or conversation, sharing on or off", async () => {
	for (const shared of [true, false]) {
		await f.admin.execute(
			sql`UPDATE pipeline_sharing SET share_pipeline_totals=${shared},revision=revision+1 WHERE relationship_id=${networkLink}`,
		);
		const b = await board(hillOwner);
		assert.deepEqual(names(b), ["Morgan Diaz"]);
		assert.equal(
			b.stages.reduce((n, s) => n + s.count, 0),
			1,
		);
		const g = ok(await readPipelineGoals(f.db, await authority(hillOwner)));
		assert.deepEqual(g.goals, []);
		assert.equal(
			g.conversations.quarters.reduce((n, q) => n + q.count, 0),
			0,
		);
		const text = (await everything(hillOwner)) + (await evryRead(hillOwner));
		for (const secret of ["Casey", "Jordan", "Grace", SECRET.goal, SECRET.caseyTalk, SECRET.anaNote])
			assert.equal(text.includes(secret), false, `${secret} with sharing ${shared}`);
		for (const reply of [
			await record(hillOwner, caseyPerson),
			await enrollment(hillOwner, caseyEnrollment),
			await readProgram(f.db, await authority(hillOwner), { programId: program }),
		])
			assert.deepEqual(reply, unavailable);
	}
});

test("AC:ADR1-002 Harvest Point's planter reads nothing from either organization's pipeline or residency", async () => {
	const refusals = JSON.parse(await everything(planter)) as unknown[];
	assert.deepEqual(refusals, Array(refusals.length).fill(unavailable));
	const mine = await readMyResidency(f.db, await authority(planter));
	assert.equal(JSON.stringify(mine).includes("Grace"), false);
	assert.equal(await evryRead(planter).catch(() => "refused"), "refused");
	const shared = await f.admin.execute(
		sql`SELECT count(*)::int AS n FROM person WHERE tenant_id=${harvest.id}::uuid AND display_name IN ('Casey Lee','Jordan Reyes','Morgan Diaz')`,
	);
	assert.equal(shared.rows[0]!.n, 0);
});

test("AC:ADR1-002 AC:ADR1-004 an address someone can't see answers exactly like one that does not exist", async () => {
	const missing = randomUUID();
	const same = async (label: string, hidden: () => Promise<unknown>, absent: () => Promise<unknown>) =>
		assert.deepEqual(await hidden(), await absent(), label);
	const people: [Actor, string][] = [
		[ben, caseyPerson],
		[dee, caseyPerson],
		[ana, jordanPerson],
		[casey, caseyPerson],
		[hillOwner, caseyPerson],
	];
	for (const [who, person] of people) {
		await same(
			`person for ${who.email}`,
			() => record(who, person),
			() => record(who, missing),
		);
		const auth = await authority(who);
		const note = person === jordanPerson ? notes.deeOnJordan : notes.anaOnCasey;
		await same(
			`note for ${who.email}`,
			() => pipelineWriter.editNote(f.db, auth, { noteId: note, expectedRevision: "1", body: "x" }),
			() => pipelineWriter.editNote(f.db, auth, { noteId: missing, expectedRevision: "1", body: "x" }),
		);
	}
	for (const who of [ben, dee, casey, hillOwner])
		await same(
			`enrollment for ${who.email}`,
			() => enrollment(who, caseyEnrollment),
			() => enrollment(who, missing),
		);
	for (const who of [casey, hillOwner, planter])
		await same(
			`program for ${who.email}`,
			async () => readProgram(f.db, await authority(who), { programId: program }),
			async () => readProgram(f.db, await authority(who), { programId: missing }),
		);
	assert.deepEqual(
		await f.invitations.describe({ proof: caseyInvitation.proof }),
		await f.invitations.describe({ proof: randomBytes(32).toString("base64url") }),
	);
});

test("AC:ADR1-008 Dana and Luis moving Casey at the same moment: one move saves, the other is told she changed", async () => {
	const seen = ok(await record(dana, caseyPerson));
	const moves = () =>
		count(sql`SELECT count(*)::int AS n FROM pipeline_stage_move m JOIN pipeline_person pp
	 ON pp.id=m.pipeline_person_id WHERE pp.person_id=${caseyPerson}::uuid`);
	const before = await moves();
	const [byDana, byLuis] = await atOnce(
		sql`SELECT 1 FROM pipeline_person WHERE person_id=${caseyPerson}::uuid FOR UPDATE`,
		[
			[dana, stages.Resident, "Dana's window"],
			[luis, stages.Commissioned, "Luis's window"],
		].map(
			([who, stageId, reason]) =>
				async () =>
					pipelineWriter.movePerson(f.db, await authority(who as Actor), {
						personId: caseyPerson,
						expectedRevision: seen.revision,
						stageId,
						reason,
					}),
		),
	);
	const replies = [byDana, byLuis].map((r) => (r.status === "ok" ? "saved" : r.refusal.code));
	assert.deepEqual([...replies].sort(), ["conflict", "saved"]);
	const winner = replies[0] === "saved" ? "Resident" : "Commissioned";
	const now = ok(await record(replies[0] === "saved" ? luis : dana, caseyPerson));
	assert.equal(now.stage.label, winner);
	assert.equal(await moves(), before + 1);
	assert.deepEqual(
		now.history
			.filter((h) => h.kind === "moved")
			.slice(0, 1)
			.map((h) => h.to),
		[winner],
	);
});

test("AC:ADR1-010 two windows saving the same program draft at the same moment: one saves, the other is told it changed", async () => {
	const p = ok(await readProgram(f.db, await authority(ana), { programId: program }));
	const plan = (extra: string) => ({
		rhythm: "monthly" as const,
		expectedMonths: 15,
		stages: p.published!.stages.map((s) => ({ label: s.label, minMonths: s.minMonths, maxMonths: s.maxMonths })),
		milestones: p
			.published!.milestones.filter((m) => m.title !== VISION)
			.map((m) => ({ lineage: m.lineage, title: m.title, description: m.description, handsOn: m.handsOn }))
			.concat([{ lineage: randomUUID(), title: extra, description: null, handsOn: false }]),
		readings: [],
	});
	const saves = () => count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action='development.plan_saved'`);
	const before = await saves();
	const replies = await atOnce(
		sql`SELECT 1 FROM development_program WHERE id=${program}::uuid FOR UPDATE`,
		["Lead a small group", "Raise a replacement"].map(
			(extra) => async () =>
				programWriter.savePlan(f.db, await authority(ana), {
					programId: program,
					expectedRevision: p.revision,
					plan: plan(extra),
				}),
		),
	);
	assert.deepEqual(replies.map((r) => (r.status === "ok" ? "saved" : r.refusal.code)).sort(), ["conflict", "saved"]);
	assert.equal(await saves(), before + 1);
	const draft = ok(await readProgram(f.db, await authority(ana), { programId: program })).draft!;
	assert.equal(draft.milestones.filter((m) => /small group|replacement/.test(m.title)).length, 1);
	const fresh = ok(await readProgram(f.db, await authority(ana), { programId: program }));
	ok(
		await programWriter.publishVersion(f.db, await authority(ana), {
			programId: program,
			expectedRevision: fresh.revision,
		}),
	);
});

test("AC:ADR1-011 applying the new version to the same person at the same moment applies it once", async () => {
	const review = ok(await readVersionReview(f.db, await authority(ana), { enrollmentId: jordanEnrollment }));
	const input = {
		enrollmentId: jordanEnrollment,
		versionId: review.versionId,
		stageId: review.stages[0]!.id,
		basis: review.basis,
	};
	const applied = () =>
		count(
			sql`SELECT count(*)::int AS n FROM audit_event WHERE action='development.version_applied' AND subject_id=${jordanEnrollment}::uuid`,
		);
	const replies = await atOnce(
		sql`SELECT 1 FROM development_enrollment WHERE id=${jordanEnrollment}::uuid FOR UPDATE`,
		[
			async () => programWriter.applyVersion(f.db, await authority(ana), input),
			async () => programWriter.applyVersion(f.db, await authority(ana), input),
		],
	);
	assert.deepEqual(replies.map((r) => (r.status === "ok" ? r.value.outcome : r.refusal.code)).sort(), [
		"changed",
		"noop",
	]);
	assert.equal(await applied(), 1);
	assert.equal(ok(await enrollment(ana, jordanEnrollment)).versionNumber, 2);
});

test("AC:ADR1-012 confirming the same milestone at the same moment confirms it once", async () => {
	const e = ok(await enrollment(ana, caseyEnrollment));
	const mark = { enrollmentId: caseyEnrollment, milestoneId: milestoneOf(e.milestones, PROSPECTUS).id };
	ok(await residentWriter.markMilestone(f.db, await authority(casey), mark));
	const confirmed = () =>
		count(
			sql`SELECT count(*)::int AS n FROM enrollment_milestone WHERE enrollment_id=${caseyEnrollment}::uuid AND milestone_id=${mark.milestoneId}::uuid AND confirmed_at IS NOT NULL`,
		);
	const audits = () =>
		count(sql`SELECT count(*)::int AS n FROM audit_event WHERE action='development.milestone_confirmed'`);
	const before = await audits();
	const replies = await atOnce(sql`SELECT 1 FROM development_enrollment WHERE id=${caseyEnrollment}::uuid FOR UPDATE`, [
		async () => programWriter.confirmMilestone(f.db, await authority(ana), mark),
		async () => programWriter.confirmMilestone(f.db, await authority(ana), mark),
	]);
	assert.deepEqual(replies.map((r) => ok(r).outcome).sort(), ["changed", "noop"]);
	assert.equal(await confirmed(), 1);
	assert.equal(await audits(), before + 1);
});

async function resident(name: string) {
	const email = `${name.toLowerCase()}-${randomUUID()}@example.test`;
	const seed = seeds(f.admin);
	const a = await seed.actor(null, "owner", { email, user: { name } });
	const personId = randomUUID();
	ok(
		await pipelineWriter.addPerson(f.db, await authority(dana), {
			personId,
			displayName: name,
			email,
			responsibleSeatId: null,
			stageId: stages["Potential leader"],
		}),
	);
	const who = { id: a.id, session: a.session, email };
	return { who, personId, invitation: await invite(personId, email) };
}
const links = (personId: string) =>
	count(sql`SELECT count(*)::int AS n FROM residency_link WHERE person_id=${personId}::uuid`);
const invitationLock = (id: string) => sql`SELECT 1 FROM invitation WHERE id=${id}::uuid FOR UPDATE`;

test("AC:ADR1-004 accepting the same invitation in two tabs at once makes one link; the other tab is told it is already linked", async () => {
	const r = await resident("Riley");
	const [one, two] = await atOnce(invitationLock(r.invitation.invitationId), [
		() => settle(f.invitations.respondResident(r.who.session, accept(r.invitation))),
		() => settle(f.invitations.respondResident(r.who.session, accept(r.invitation))),
	]);
	const outcomes = [one, two].map((x) =>
		x && typeof x === "object" && "refused" in x
			? (x as { refused: string }).refused
			: (x as { status: string }).status,
	);
	assert.deepEqual(outcomes.sort(), ["accepted", "already_linked"]);
	assert.equal(await links(r.personId), 1);
	assert.deepEqual(ok(await record(dana, r.personId)).residency, { status: "linked" });
	assert.deepEqual(await f.invitations.describe({ proof: r.invitation.proof }), { status: "unavailable" });
});

test("AC:ADR1-004 Luis revoking while Casey's invitation is being accepted leaves at most one link and one winner", async () => {
	const r = await resident("Quinn");
	const pending = ok(await record(luis, r.personId)).residency as { revision: string };
	const [accepted, revoked] = await atOnce(invitationLock(r.invitation.invitationId), [
		() => settle(f.invitations.respondResident(r.who.session, accept(r.invitation))),
		async () =>
			settle(
				f.invitations.revoke(await authority(luis), {
					requestKey: randomUUID(),
					expectedRevision: pending.revision,
					input: { invitationId: r.invitation.invitationId },
				}),
			),
	]);
	const refused = (x: unknown) => !!x && typeof x === "object" && "refused" in x;
	assert.notEqual(refused(accepted), refused(revoked));
	assert.deepEqual([accepted, revoked].filter(refused), [{ refused: "invitation_unavailable" }]);
	const state = (await f.admin.execute(sql`SELECT state FROM invitation WHERE id=${r.invitation.invitationId}::uuid`))
		.rows[0]!.state;
	if (refused(accepted)) {
		assert.equal(state, "revoked");
		assert.equal(await links(r.personId), 0);
		assert.deepEqual(ok(await record(luis, r.personId)).residency, { status: "not_linked" });
	} else {
		assert.equal(state, "accepted");
		assert.equal(await links(r.personId), 1);
	}
});

function exportedMarks(text: string, personId: string) {
	const lines = text.replace(/^\uFEFF/, "").split("\r\n");
	const start = lines.findIndex((l) => l.startsWith("record,person_id,"));
	const header = lines[start]!.split(",");
	return lines
		.slice(start + 1)
		.filter(Boolean)
		.map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])))
		.filter((r) => r.record === "milestone_completed" && r.person_id === personId)
		.map((r) => r.milestone!)
		.sort();
}

test("AC:ADR1-003 AC:ADR1-005 AC:ADR1-014 AC:ADR1-015 Casey stops sharing milestones: Ana's screen, Dana's export, Evry and the enrollment history drop her marks at once", async () => {
	const review = ok(await readVersionReview(f.db, await authority(ana), { enrollmentId: caseyEnrollment }));
	ok(
		await programWriter.applyVersion(f.db, await authority(ana), {
			enrollmentId: caseyEnrollment,
			versionId: review.versionId,
			stageId: review.stages[0]!.id,
			basis: review.basis,
		}),
	);
	const marks = async () => {
		const e = ok(await enrollment(ana, caseyEnrollment));
		const exported = ok(await readPipelineExport(f.db, await authority(dana))).text;
		return {
			screen: e.milestones
				.filter((m) => m.completion)
				.map((m) => `${m.title}: ${m.completion!.source}`)
				.sort(),
			history: e.earlier.map((m) => `${m.title}: ${m.completion?.source ?? null}`),
			exported: exportedMarks(exported, caseyPerson),
			evry: await evryRead(dana),
		};
	};
	const shared = await marks();
	assert.deepEqual(shared.screen, [`${PREACH}: program_leader`, `${PROSPECTUS}: resident`]);
	assert.deepEqual(shared.history, [`${VISION}: resident`]);
	assert.deepEqual(shared.exported, [PREACH, VISION, PROSPECTUS]);

	await caseyShares({ shareFoundations: false, shareMilestones: false });
	const withdrawn = await marks();
	assert.deepEqual(withdrawn.screen, [`${PREACH}: program_leader`]);
	assert.deepEqual(withdrawn.history, []);
	assert.deepEqual(withdrawn.exported, [PREACH]);
	assert.deepEqual(ok(await enrollment(ana, caseyEnrollment)).resident, {
		status: "linked",
		milestones: "not_shared",
		foundations: { status: "not_shared" },
	});
	for (const read of [shared.evry, withdrawn.evry])
		for (const title of [VISION, PROSPECTUS, PREACH]) assert.equal(read.includes(title), false, title);
	const mine = ok(await readMyResidency(f.db, await authority(casey)));
	assert.ok(JSON.stringify(mine).includes(PROSPECTUS));
});
