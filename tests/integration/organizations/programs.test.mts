import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";

import { fixture } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	readPipelineBoard,
	readPipelineGoals,
	readPipelinePersonRecord,
} from "../../../packages/domain/src/organizations/pipeline.ts";
import {
	programWriter,
	readEnrollment,
	readProgram,
	readPrograms,
	searchReadings,
} from "../../../packages/domain/src/organizations/programs.ts";

const { createProgram, savePlan, publishVersion, enroll, recordMilestone, addFeedback } = programWriter;

// Development programs (REQ-MUL-010, -011, -012, and Active residents from REQ-MUL-007) against a migrated database.
// Grace Austin: Owner Dana, Admin Luis, Ana (Member) directs the residency, Dee (Member) is responsible for Casey Lee,
// Ben (Member) has no duty. Casey has no linked account. Hill Country Network is a separate organization.

const GLOBAL = "00000000-0000-0000-0000-000000000000";
const database = await fixture({ prefix: "programs", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Actor = { id: string; session: string };
let grace: { kind: "organization"; id: string };
let hill: { kind: "organization"; id: string };
let dana: Actor, luis: Actor, ana: Actor, dee: Actor, ben: Actor, hillOwner: Actor;
let anaSeat: string, deeSeat: string, hillSeat: string;

const authority = (a: Actor) => RequestActor.resolve(db, a.session as never);
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const refusedWith = (r: { status: string; refusal?: { code: string } }, code: string) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.refusal?.code, code);
};
const seatOf = async (account: string, organization: string) =>
	(
		await admin.execute(
			sql`SELECT id FROM seat WHERE account_id=${account}::uuid AND organization_id=${organization}::uuid`,
		)
	).rows[0]!.id as string;
const program = async (a: Actor, programId: string) => ok(await readProgram(db, await authority(a), { programId }));
const enrollment = async (a: Actor, enrollmentId: string) =>
	ok(await readEnrollment(db, await authority(a), { enrollmentId }));
/** Active residents as the Programs tab and the Pipeline goals card each show it; the two must agree. */
const residents = async (a: Actor) => {
	const tab = ok(await readPrograms(db, await authority(a))).activeResidents;
	assert.equal(ok(await readPipelineGoals(db, await authority(a))).activeResidents, tab);
	return tab;
};

const TEMPLATE_STAGES = [
	{ label: "Assimilating", minMonths: 2, maxMonths: 3 },
	{ label: "Training and planning", minMonths: 6, maxMonths: 9 },
	{ label: "Gathering", minMonths: 2, maxMonths: 3 },
	{ label: "Sending and planting", minMonths: 2, maxMonths: 3 },
];
const TEMPLATE_MILESTONES = [
	"Start a small group and raise a replacement",
	"Present your vision to the sending church leadership",
	"Write a church planting prospectus",
];
const templatePlan = () => ({
	rhythm: "monthly",
	expectedMonths: 15,
	stages: TEMPLATE_STAGES,
	milestones: TEMPLATE_MILESTONES.map((title) => ({ lineage: randomUUID(), title, description: null, handsOn: false })),
	readings: [] as { revisionId: string }[],
});
const blankPlan = { rhythm: "weekly", expectedMonths: 12, stages: [], milestones: [], readings: [] };

const casey = randomUUID();
const jordan = randomUUID();
const residency = randomUUID();
const apprenticeship = randomUUID();
const second = randomUUID();
// Wiki articles: two global ones and one with Grace Austin's own published version.
const section = randomUUID();
const articles = { prayer: randomUUID(), vision: randomUUID(), team: randomUUID() };
const revisions = { prayer: randomUUID(), vision: randomUUID(), team: randomUUID(), teamGrace: randomUUID() };

async function revision(
	id: string,
	article: string,
	tenant: string,
	title: string,
	slug: string,
	release: string | null,
) {
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,
	 body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
	 VALUES(${id},${article},${tenant},${release},1,${title},${slug},${title},${tenant === GLOBAL ? "Body" : "[]"},
	  ${tenant === GLOBAL ? "safe_mdx" : "safe_nodes"},1,1,
	  ${randomBytes(32).toString("hex")},clock_timestamp(),true,1,${section})`);
}

before(async () => {
	grace = (await database.organization("sending_church", {
		name: "Grace Austin",
		timezone: "America/Chicago",
	})) as never;
	hill = (await database.organization("sending_network", { name: "Hill Country Network" })) as never;
	dana = await database.actor(grace as never, "owner", { user: { name: "Dana" } });
	luis = await database.actor(grace as never, "admin", { user: { name: "Luis" } });
	ana = await database.actor(grace as never, "member", { user: { name: "Ana" } });
	dee = await database.actor(grace as never, "member", { user: { name: "Dee" } });
	ben = await database.actor(grace as never, "member", { user: { name: "Ben" } });
	hillOwner = await database.actor(hill as never, "owner", { user: { name: "Hana" } });
	anaSeat = await seatOf(ana.id, grace.id);
	deeSeat = await seatOf(dee.id, grace.id);
	hillSeat = await seatOf(hillOwner.id, hill.id);

	const board = ok(await readPipelineBoard(db, await authority(dana), {}));
	const stage = (label: string) => board.stages.find((s) => s.label === label)!.id;
	for (const [personId, displayName, at] of [
		[casey, "Casey Lee", "Potential leader"],
		[jordan, "Jordan Price", "Resident"],
	] as const)
		ok(
			await pipelineWriter.addPerson(db, await authority(dana), {
				personId,
				displayName,
				email: null,
				responsibleSeatId: personId === casey ? deeSeat : null,
				stageId: stage(at),
			}),
		);
	ok(
		await pipelineWriter.addNote(db, await authority(dee), {
			personId: casey,
			noteId: randomUUID(),
			body: "Dee's private note on Casey",
		}),
	);

	const release = randomUUID();
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/start',${GLOBAL})`,
	);
	for (const [name, article] of Object.entries(articles))
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article',${"programs/" + name},${GLOBAL})`,
		);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,
	 approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
	 VALUES(${release},${"release-" + release},'memory://synthetic',${randomBytes(32).toString("hex")},'validated',clock_timestamp(),
	  clock_timestamp(),'memory://approval',${randomBytes(32).toString("hex")},'v','profile',1,${GLOBAL},0)`);
	await revision(revisions.prayer, articles.prayer, GLOBAL, "Praying for a city", "framework/prayer", release);
	await revision(revisions.vision, articles.vision, GLOBAL, "Casting vision", "framework/vision", release);
	await revision(revisions.team, articles.team, GLOBAL, "Building a launch team", "framework/team", release);
	await revision(
		revisions.teamGrace,
		articles.team,
		grace.id,
		"Building a launch team at Grace",
		"framework/team",
		null,
	);
	await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
	 VALUES(${randomUUID()},${grace.id},${articles.team},'published',${revisions.teamGrace},1)`);
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
	 VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
});

test("an organization with no programs lists none and counts no active residents", async () => {
	const list = ok(await readPrograms(db, await authority(dana)));
	assert.deepEqual(list.programs, []);
	assert.equal(list.activeResidents, 0);
	assert.equal(list.administrator, true);
	assert.deepEqual(list.staff.map((s) => s.name).sort(), ["Ana", "Ben", "Dana", "Dee", "Luis"]);
	// A Member sees the list but gets no director picker.
	assert.deepEqual(ok(await readPrograms(db, await authority(ben))).staff, []);
});

test("an Owner starts a residency from the template with Ana as director; a Member cannot create one", async () => {
	refusedWith(
		await createProgram(db, await authority(ana), {
			programId: randomUUID(),
			kind: "residency",
			name: "Nope",
			directorSeatId: anaSeat,
			plan: templatePlan(),
		}),
		"unavailable",
	);
	ok(
		await createProgram(db, await authority(dana), {
			programId: residency,
			kind: "residency",
			name: "Grace Residency",
			directorSeatId: anaSeat,
			plan: templatePlan(),
		}),
	);
	const p = await program(dana, residency);
	assert.equal(p.kind, "residency");
	assert.equal(p.director.name, "Ana");
	assert.equal(p.published, null);
	assert.deepEqual(
		p.draft?.stages.map((s) => [s.label, s.minMonths, s.maxMonths]),
		[
			["Assimilating", 2, 3],
			["Training and planning", 6, 9],
			["Gathering", 2, 3],
			["Sending and planting", 2, 3],
		],
	);
	assert.deepEqual(
		p.draft?.milestones.map((m) => m.title),
		TEMPLATE_MILESTONES,
	);
	assert.equal(p.draft?.rhythm, "monthly");
	assert.equal(p.draft?.expectedMonths, 15);
	assert.equal(p.draft?.number, 1);
	assert.equal(p.draft?.publishedOn, null);
	// A seat of another organization cannot direct it.
	refusedWith(
		await createProgram(db, await authority(dana), {
			programId: randomUUID(),
			kind: "residency",
			name: "Foreign director",
			directorSeatId: hillSeat,
			plan: blankPlan,
		}),
		"invalid_input",
	);
});

test("a blank apprenticeship, and each organization sees only its own programs", async () => {
	ok(
		await createProgram(db, await authority(dana), {
			programId: apprenticeship,
			kind: "apprenticeship",
			name: "Grace Apprenticeship",
			directorSeatId: anaSeat,
			plan: blankPlan,
		}),
	);
	const blank = await program(dana, apprenticeship);
	assert.deepEqual([blank.draft?.stages, blank.draft?.milestones, blank.draft?.readings], [[], [], []]);
	const hillProgram = randomUUID();
	ok(
		await createProgram(db, await authority(hillOwner), {
			programId: hillProgram,
			kind: "residency",
			name: "Hill Residency",
			directorSeatId: hillSeat,
			plan: templatePlan(),
		}),
	);
	assert.deepEqual(
		ok(await readPrograms(db, await authority(hillOwner))).programs.map((p) => p.name),
		["Hill Residency"],
	);
	assert.deepEqual(
		ok(await readPrograms(db, await authority(dana))).programs.map((p) => p.name),
		["Grace Apprenticeship", "Grace Residency"],
	);
	refusedWith(await readProgram(db, await authority(hillOwner), { programId: residency }), "unavailable");
	refusedWith(await readProgram(db, await authority(dana), { programId: hillProgram }), "unavailable");
});

test("the director edits the draft and its reading list; nobody else edits it and nobody enrolls in a draft", async () => {
	const p = await program(ana, residency);
	assert.equal(p.viewer.director, true);
	const found = ok(await searchReadings(db, await authority(ana), { q: "launch team" }));
	// Grace Austin's own version is offered first, then the global article.
	assert.deepEqual(
		found.map((f) => [f.title, f.source]),
		[
			["Building a launch team at Grace", "organization"],
			["Building a launch team", "global"],
		],
	);
	const plan = {
		rhythm: "every_two_weeks",
		expectedMonths: 16,
		stages: [...TEMPLATE_STAGES.slice(0, 3), { label: "Sending", minMonths: 1, maxMonths: 3 }],
		milestones: [
			...p.draft!.milestones.map((m) => ({
				lineage: m.lineage,
				title: m.title,
				description: m.description,
				handsOn: m.handsOn,
			})),
			{
				lineage: randomUUID(),
				title: "Preach on a Sunday",
				description: "Preach one Sunday sermon at Grace.",
				handsOn: true,
			},
		],
		readings: [{ revisionId: revisions.prayer }, { revisionId: revisions.vision }, { revisionId: revisions.teamGrace }],
	};
	for (const who of [dana, luis, ben])
		refusedWith(
			await savePlan(db, await authority(who), { programId: residency, expectedRevision: p.revision, plan }),
			"unavailable",
		);
	// A hands-on assignment needs a description.
	refusedWith(
		await savePlan(db, await authority(ana), {
			programId: residency,
			expectedRevision: p.revision,
			plan: { ...plan, milestones: [{ lineage: randomUUID(), title: "Bare", description: null, handsOn: true }] },
		}),
		"invalid_input",
	);
	// Another organization's version of an article cannot be pinned.
	const hillRevision = randomUUID();
	await revision(hillRevision, articles.vision, hill.id, "Hill vision", "framework/vision", null);
	refusedWith(
		await savePlan(db, await authority(ana), {
			programId: residency,
			expectedRevision: p.revision,
			plan: { ...plan, readings: [{ revisionId: hillRevision }] },
		}),
		"invalid_input",
	);
	const saved = ok(
		await savePlan(db, await authority(ana), { programId: residency, expectedRevision: p.revision, plan }),
	);
	const after = await program(ana, residency);
	assert.equal(after.revision, saved.revision);
	assert.equal(after.draft?.number, 1);
	assert.equal(after.draft?.rhythm, "every_two_weeks");
	assert.equal(after.draft?.expectedMonths, 16);
	assert.deepEqual(
		after.draft?.stages.map((s) => s.label),
		["Assimilating", "Training and planning", "Gathering", "Sending"],
	);
	assert.deepEqual(
		after.draft?.milestones.map((m) => [m.title, m.handsOn]),
		[...TEMPLATE_MILESTONES.map((t) => [t, false]), ["Preach on a Sunday", true]],
	);
	assert.deepEqual(
		after.draft?.readings.map((r) => [r.title, r.source, r.slug]),
		[
			["Praying for a city", "global", "framework/prayer"],
			["Casting vision", "global", "framework/vision"],
			["Building a launch team at Grace", "organization", "framework/team"],
		],
	);
	// A stale revision is refused.
	refusedWith(
		await savePlan(db, await authority(ana), { programId: residency, expectedRevision: p.revision, plan }),
		"conflict",
	);
	refusedWith(
		await enroll(db, await authority(dana), {
			enrollmentId: randomUUID(),
			programId: residency,
			personId: casey,
			cohort: "Fall 2026",
			startedOn: "2026-10-01",
			expectedEndOn: "2027-12-31",
			stageId: after.draft!.stages[0]!.id,
			nextMeetingAt: null,
		}),
		"not_published",
	);
});

test("only the current director publishes; Version 1 is published today", async () => {
	const p = await program(ana, residency);
	for (const who of [dana, luis, ben])
		refusedWith(
			await publishVersion(db, await authority(who), { programId: residency, expectedRevision: p.revision }),
			"unavailable",
		);
	const published = ok(
		await publishVersion(db, await authority(ana), { programId: residency, expectedRevision: p.revision }),
	);
	assert.equal(published.number, 1);
	const after = await program(dana, residency);
	assert.equal(after.draft, null);
	assert.equal(after.published?.number, 1);
	assert.equal(after.published?.publishedOn, after.today);
	const list = ok(await readPrograms(db, await authority(ben)));
	const row = list.programs.find((x) => x.id === residency)!;
	assert.deepEqual([row.publishedNumber, row.publishedOn, row.draft], [1, after.today, false]);
	// A blank draft has no stage to enroll at, so it cannot be published yet.
	const blank = await program(ana, apprenticeship);
	refusedWith(
		await publishVersion(db, await authority(ana), { programId: apprenticeship, expectedRevision: blank.revision }),
		"no_stages",
	);
});

test("an unpublished church version reads as unavailable with its title; the other links stay", async () => {
	await admin.execute(sql`UPDATE article_editor_state SET state='hide',revision=revision+1
	 WHERE organization_id=${grace.id} AND article_id=${articles.team}`);
	const p = await program(ben, residency);
	assert.deepEqual(
		p.published?.readings.map((r) => [r.title, r.slug]),
		[
			["Praying for a city", "framework/prayer"],
			["Casting vision", "framework/vision"],
			["Building a launch team at Grace", null],
		],
	);
	await admin.execute(sql`UPDATE article_editor_state SET state='published',revision=revision+1
	 WHERE organization_id=${grace.id} AND article_id=${articles.team}`);
});

const caseyResidency = randomUUID();
test("an Owner enrolls Casey; the pipeline stage stays; a second active enrollment in the same program is refused", async () => {
	const p = await program(dana, residency);
	const assimilating = p.published!.stages[0]!.id;
	const input = {
		enrollmentId: caseyResidency,
		programId: residency,
		personId: casey,
		cohort: "Fall 2026",
		startedOn: "2026-10-01",
		expectedEndOn: "2027-12-31",
		stageId: assimilating,
		nextMeetingAt: "2026-10-20T19:00:00",
	};
	for (const who of [ana, ben]) refusedWith(await enroll(db, await authority(who), input), "unavailable");
	assert.equal(ok(await enroll(db, await authority(dana), input)).outcome, "changed");
	// A repeated request enrolls nobody twice.
	assert.equal(ok(await enroll(db, await authority(dana), input)).outcome, "noop");
	const e = await enrollment(dana, caseyResidency);
	assert.deepEqual(
		[e.person.name, e.cohort, e.startedOn, e.expectedEndOn, e.stage.label, e.versionNumber, e.status],
		["Casey Lee", "Fall 2026", "2026-10-01", "2027-12-31", "Assimilating", 1, "active"],
	);
	assert.deepEqual(e.nextMeeting, { at: "2026-10-20T19:00:00", timezone: "America/Chicago" });
	const stored = await admin.execute(
		sql`SELECT next_meeting_at AT TIME ZONE 'UTC' AS utc FROM development_enrollment WHERE id=${caseyResidency}`,
	);
	assert.equal(new Date(String(stored.rows[0]!.utc) + "Z").toISOString(), "2026-10-21T00:00:00.000Z");
	const record = ok(await readPipelinePersonRecord(db, await authority(dana), { personId: casey }));
	assert.equal(record.stage.label, "Potential leader");
	refusedWith(await enroll(db, await authority(dana), { ...input, enrollmentId: randomUUID() }), "already_enrolled");
	// A stage of another version, or a person outside the pipeline, is refused.
	refusedWith(
		await enroll(db, await authority(dana), { ...input, enrollmentId: randomUUID(), personId: randomUUID() }),
		"invalid_input",
	);
	assert.equal(await residents(dana), 1);
});

test("Active residents counts distinct people in residencies, never an apprenticeship or the pipeline label", async () => {
	// The apprenticeship gets a stage and is published, then Casey and Jordan (pipeline stage Resident) join it.
	const a = await program(ana, apprenticeship);
	const saved = ok(
		await savePlan(db, await authority(ana), {
			programId: apprenticeship,
			expectedRevision: a.revision,
			plan: { ...blankPlan, stages: [{ label: "Learning", minMonths: 0, maxMonths: 6 }] },
		}),
	);
	ok(await publishVersion(db, await authority(ana), { programId: apprenticeship, expectedRevision: saved.revision }));
	const stage = (await program(dana, apprenticeship)).published!.stages[0]!.id;
	for (const personId of [casey, jordan])
		ok(
			await enroll(db, await authority(luis), {
				enrollmentId: randomUUID(),
				programId: apprenticeship,
				personId,
				cohort: "2026",
				startedOn: "2026-09-01",
				expectedEndOn: "2027-06-30",
				stageId: stage,
				nextMeetingAt: null,
			}),
		);
	assert.equal(await residents(dana), 1);
	// A second residency with Casey in it still counts Casey once.
	ok(
		await createProgram(db, await authority(dana), {
			programId: second,
			kind: "residency",
			name: "Grace Urban Residency",
			directorSeatId: anaSeat,
			plan: templatePlan(),
		}),
	);
	const s = await program(ana, second);
	ok(await publishVersion(db, await authority(ana), { programId: second, expectedRevision: s.revision }));
	ok(
		await enroll(db, await authority(dana), {
			enrollmentId: randomUUID(),
			programId: second,
			personId: casey,
			cohort: "Fall 2026",
			startedOn: "2026-10-01",
			expectedEndOn: "2027-12-31",
			stageId: (await program(dana, second)).published!.stages[0]!.id,
			nextMeetingAt: null,
		}),
	);
	assert.equal(await residents(dana), 1);
	assert.equal(await residents(ben), 1);
	const list = ok(await readPrograms(db, await authority(dana)));
	assert.equal(list.programs.find((p) => p.id === apprenticeship)!.activeEnrollments, 2);
});

test("Version 2 leaves Casey on Version 1 with its milestones; Version 1 never changes", async () => {
	const p = await program(ana, residency);
	const v1 = p.published!;
	const plan = {
		rhythm: v1.rhythm,
		expectedMonths: v1.expectedMonths,
		stages: v1.stages.map((s) => ({ label: s.label, minMonths: s.minMonths, maxMonths: s.maxMonths })),
		milestones: [
			...v1.milestones.map((m, i) => ({
				lineage: m.lineage,
				title: i === 1 ? "Present your vision to the elders" : m.title,
				description: m.description,
				handsOn: m.handsOn,
			})),
			{ lineage: randomUUID(), title: "Lead a prayer walk", description: null, handsOn: false },
		],
		readings: v1.readings.map((r) => ({ revisionId: r.revisionId })),
	};
	const saved = ok(
		await savePlan(db, await authority(ana), { programId: residency, expectedRevision: p.revision, plan }),
	);
	const drafted = await program(ana, residency);
	assert.equal(drafted.draft?.number, 2);
	assert.deepEqual(drafted.published, v1);
	ok(await publishVersion(db, await authority(ana), { programId: residency, expectedRevision: saved.revision }));
	const after = await program(ana, residency);
	assert.equal(after.published?.number, 2);
	assert.equal(after.published?.milestones.length, 5);
	const e = await enrollment(ana, caseyResidency);
	assert.equal(e.versionNumber, 1);
	assert.deepEqual(
		e.milestones.map((m) => m.title),
		v1.milestones.map((m) => m.title),
	);
	assert.equal(after.enrollments.find((x) => x.id === caseyResidency)?.versionNumber, 1);
});

test("the director records and confirms Casey's milestone in one step; nothing else changes", async () => {
	const before = await enrollment(ana, caseyResidency);
	const group = before.milestones.find((m) => m.title === "Start a small group and raise a replacement")!;
	const input = { enrollmentId: caseyResidency, milestoneId: group.id, completedOn: "2026-10-12" };
	for (const who of [dana, luis, dee, ben])
		refusedWith(await recordMilestone(db, await authority(who), input), "unavailable");
	refusedWith(
		await recordMilestone(db, await authority(ana), { ...input, completedOn: "2099-01-01" }),
		"invalid_input",
	);
	const plants = async () => Number((await admin.execute(sql`SELECT count(*)::int AS n FROM plant`)).rows[0]!.n);
	const plantCount = await plants();
	assert.equal(ok(await recordMilestone(db, await authority(ana), input)).outcome, "changed");
	assert.equal(
		ok(await recordMilestone(db, await authority(ana), { ...input, completedOn: "2026-10-13" })).outcome,
		"noop",
	);
	const e = await enrollment(dana, caseyResidency);
	const done = e.milestones.find((m) => m.id === group.id)!;
	assert.deepEqual(done.completion, {
		completedOn: "2026-10-12",
		confirmedOn: e.today,
		recorder: "Ana",
		confirmer: "Ana",
		source: "program_leader",
	});
	assert.equal(e.status, "active");
	assert.equal(await plants(), plantCount);
	const record = ok(await readPipelinePersonRecord(db, await authority(dana), { personId: casey }));
	assert.equal(record.stage.label, "Potential leader");
});

test("feedback on a hands-on assignment: the director, Owner and Admin read it; Dee and Ben never do", async () => {
	// Casey is on Version 1, whose plan has "Preach on a Sunday" as a hands-on assignment.
	const e = await enrollment(ana, caseyResidency);
	const preach = e.milestones.find((m) => m.title === "Preach on a Sunday")!;
	assert.deepEqual([preach.handsOn, preach.description], [true, "Preach one Sunday sermon at Grace."]);
	const plain = e.milestones.find((m) => !m.handsOn)!;
	const input = {
		feedbackId: randomUUID(),
		enrollmentId: caseyResidency,
		milestoneId: preach.id,
		body: "Clear outline; slow down in the application.",
	};
	for (const who of [dana, luis, dee, ben])
		refusedWith(await addFeedback(db, await authority(who), input), "unavailable");
	refusedWith(await addFeedback(db, await authority(ana), { ...input, milestoneId: plain.id }), "invalid_input");
	ok(await addFeedback(db, await authority(ana), input));
	ok(await addFeedback(db, await authority(ana), input));
	for (const who of [ana, dana, luis]) {
		const read = (await enrollment(who, caseyResidency)).milestones.find((m) => m.id === preach.id)!;
		assert.deepEqual(
			read.feedback?.map((f) => [f.writer, f.body, f.writtenOn]),
			[["Ana", input.body, e.today]],
		);
	}
	for (const who of [dee, ben]) {
		const read = await enrollment(who, caseyResidency);
		assert.ok(read.milestones.every((m) => m.feedback === null));
		assert.ok(!JSON.stringify(read).includes("slow down"));
	}
	// Central audit holds no feedback body.
	const audit = await admin.execute(
		sql`SELECT metadata::text AS m FROM audit_event WHERE action='development.feedback_recorded' AND tenant_id=${grace.id}`,
	);
	assert.equal(audit.rows.length, 1);
	assert.ok(!String(audit.rows[0]!.m).includes("slow down"));
});

test("directing a program does not let Ana read Dee's pipeline notes on Casey", async () => {
	refusedWith(await readPipelinePersonRecord(db, await authority(ana), { personId: casey }), "unavailable");
	const deeView = ok(await readPipelinePersonRecord(db, await authority(dee), { personId: casey }));
	assert.equal(deeView.notes.length, 1);
});

test("Ben reads programs and enrollments and every write he sends is refused", async () => {
	const p = await program(ben, residency);
	assert.deepEqual(p.viewer, { administrator: false, director: false });
	assert.deepEqual(p.people, []);
	const e = await enrollment(ben, caseyResidency);
	assert.deepEqual(e.viewer, { administrator: false, director: false });
	const auth = await authority(ben);
	refusedWith(
		await createProgram(db, auth, {
			programId: randomUUID(),
			kind: "apprenticeship",
			name: "X",
			directorSeatId: anaSeat,
			plan: blankPlan,
		}),
		"unavailable",
	);
	refusedWith(
		await savePlan(db, auth, { programId: residency, expectedRevision: p.revision, plan: blankPlan }),
		"unavailable",
	);
	refusedWith(await publishVersion(db, auth, { programId: residency, expectedRevision: p.revision }), "unavailable");
	refusedWith(
		await enroll(db, auth, {
			enrollmentId: randomUUID(),
			programId: residency,
			personId: jordan,
			cohort: "X",
			startedOn: "2026-10-01",
			expectedEndOn: "2026-12-01",
			stageId: p.published!.stages[0]!.id,
			nextMeetingAt: null,
		}),
		"unavailable",
	);
	refusedWith(
		await recordMilestone(db, auth, {
			enrollmentId: caseyResidency,
			milestoneId: e.milestones[1]!.id,
			completedOn: "2026-10-12",
		}),
		"unavailable",
	);
	refusedWith(
		await addFeedback(db, auth, {
			feedbackId: randomUUID(),
			enrollmentId: caseyResidency,
			milestoneId: e.milestones[3]!.id,
			body: "x",
		}),
		"unavailable",
	);
});
