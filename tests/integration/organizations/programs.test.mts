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
	readVersionReview,
	readVersionReviews,
	searchReadings,
} from "../../../packages/domain/src/organizations/programs.ts";

const { createProgram, savePlan, publishVersion, enroll, recordMilestone, addFeedback, applyVersion } = programWriter;

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

// Applying a newer version to one enrollment (REQ-MUL-011). Casey is on Version 1, with "Start a small group and raise
// a replacement" finished Oct 12 and feedback on "Preach on a Sunday". Version 2 renames "Present your vision to the
// sending church leadership" and adds "Lead a prayer walk".

const review = async (a: Actor) =>
	ok(await readVersionReview(db, await authority(a), { enrollmentId: caseyResidency }));
const applied = async () =>
	(
		await admin.execute(
			sql`SELECT metadata FROM audit_event WHERE action='development.version_applied' AND subject_id=${caseyResidency}
			 ORDER BY occurred_at`,
		)
	).rows.map((r) => r.metadata);
const completions = async () =>
	(
		await admin.execute(sql`SELECT id,milestone_id,version_id,completed_on::text AS completed_on,recorder_id,confirmer_id,
		 confirmed_at,source FROM enrollment_milestone WHERE enrollment_id=${caseyResidency} ORDER BY id`)
	).rows;
/** The next plan from the current published version, with `edit` applied to its milestones and stages. */
const nextPlan = (
	v: NonNullable<Awaited<ReturnType<typeof program>>["published"]>,
	edit: {
		milestones?: (ms: typeof v.milestones) => typeof v.milestones;
		stages?: (s: typeof v.stages) => typeof v.stages;
	},
) => ({
	rhythm: v.rhythm,
	expectedMonths: v.expectedMonths,
	stages: (edit.stages ?? ((x) => x))(v.stages).map((s) => ({
		label: s.label,
		minMonths: s.minMonths,
		maxMonths: s.maxMonths,
	})),
	milestones: (edit.milestones ?? ((x) => x))(v.milestones).map((m) => ({
		lineage: m.lineage,
		title: m.title,
		description: m.description,
		handsOn: m.handsOn,
	})),
	readings: v.readings.map((r) => ({ revisionId: r.revisionId })),
});
async function publishNext(edit: Parameters<typeof nextPlan>[1]) {
	const p = await program(ana, residency);
	const saved = ok(
		await savePlan(db, await authority(ana), {
			programId: residency,
			expectedRevision: p.revision,
			plan: nextPlan(p.published!, edit),
		}),
	);
	ok(await publishVersion(db, await authority(ana), { programId: residency, expectedRevision: saved.revision }));
	return (await program(ana, residency)).published!;
}

test("Casey's enrollment names Version 2; only the director reads the review, and reading it saves nothing", async () => {
	const e = await enrollment(ana, caseyResidency);
	const v2 = (await program(ana, residency)).published!;
	assert.equal(e.versionNumber, 1);
	assert.deepEqual(e.newerVersion, { id: v2.id, number: 2 });
	for (const who of [dana, luis, dee, ben, hillOwner])
		refusedWith(await readVersionReview(db, await authority(who), { enrollmentId: caseyResidency }), "unavailable");
	const r = await review(ana);
	assert.deepEqual([r.fromNumber, r.toNumber, r.versionId], [1, 2, v2.id]);
	assert.deepEqual(r.added, [{ title: "Lead a prayer walk", description: null, handsOn: false, finished: false }]);
	assert.deepEqual(r.removed, []);
	// Only the renamed milestone is listed as changed, with both wordings; the unchanged ones are not.
	assert.deepEqual(r.changed, [
		{
			before: {
				title: "Present your vision to the sending church leadership",
				description: null,
				handsOn: false,
				finished: false,
			},
			after: { title: "Present your vision to the elders", description: null, handsOn: false, finished: false },
		},
	]);
	assert.deepEqual(r.carried, ["Start a small group and raise a replacement"]);
	// Casey is at Assimilating on Version 1, and Version 2's stage with the same label is preselected.
	assert.equal(r.stage, "Assimilating");
	assert.equal(r.stageId, v2.stages.find((s) => s.label === "Assimilating")!.id);
	assert.deepEqual(
		r.stages.map((s) => s.label),
		v2.stages.map((s) => s.label),
	);
	assert.equal((await enrollment(ana, caseyResidency)).versionNumber, 1);
	assert.deepEqual(await applied(), []);
	// An enrollment already on the current version has nothing to apply.
	const other = ok(await readProgram(db, await authority(dana), { programId: second })).enrollments[0]!;
	assert.equal((await enrollment(ana, other.id)).newerVersion, null);
	refusedWith(await readVersionReview(db, await authority(ana), { enrollmentId: other.id }), "unavailable");
});

test("a review that went out of date is refused and changes nothing; the fresh one shows the change", async () => {
	const stale = await review(ana);
	// Another session records the milestone Version 2 renames.
	const vision = (await enrollment(ana, caseyResidency)).milestones.find((m) =>
		m.title.startsWith("Present your vision"),
	)!;
	ok(
		await recordMilestone(db, await authority(ana), {
			enrollmentId: caseyResidency,
			milestoneId: vision.id,
			completedOn: "2026-10-14",
		}),
	);
	const rows = await completions();
	refusedWith(
		await applyVersion(db, await authority(ana), {
			enrollmentId: caseyResidency,
			versionId: stale.versionId,
			stageId: stale.stageId,
			basis: stale.basis,
		}),
		"stale_review",
	);
	assert.equal((await enrollment(ana, caseyResidency)).versionNumber, 1);
	assert.deepEqual(await completions(), rows);
	assert.deepEqual(await applied(), []);
	const fresh = await review(ana);
	assert.notEqual(fresh.basis, stale.basis);
	assert.equal(fresh.changed[0]!.before.finished, true);
	assert.deepEqual(fresh.carried, ["Start a small group and raise a replacement", "Present your vision to the elders"]);
});

test("only the program's current director applies, only the current version, only in their organization", async () => {
	const r = await review(ana);
	const v1Stage = (await enrollment(ana, caseyResidency)).stage.id;
	const input = { enrollmentId: caseyResidency, versionId: r.versionId, stageId: r.stageId, basis: r.basis };
	for (const who of [dana, luis, dee, ben, hillOwner])
		refusedWith(await applyVersion(db, await authority(who), input), "unavailable");
	// A former director: the program is now directed by Dee.
	await admin.execute(sql`UPDATE development_program SET director_seat_id=${deeSeat} WHERE id=${residency}`);
	refusedWith(await applyVersion(db, await authority(ana), input), "unavailable");
	refusedWith(await readVersionReview(db, await authority(ana), { enrollmentId: caseyResidency }), "unavailable");
	await admin.execute(sql`UPDATE development_program SET director_seat_id=${anaSeat} WHERE id=${residency}`);
	// Version 1, which Casey is on and which is not the current version, is refused.
	const version1 = (await admin.execute(sql`SELECT version_id FROM development_enrollment WHERE id=${caseyResidency}`))
		.rows[0]!.version_id as string;
	refusedWith(await applyVersion(db, await authority(ana), { ...input, versionId: version1 }), "stale_review");
	// Casey's stage on Version 1 is not a stage of Version 2.
	refusedWith(await applyVersion(db, await authority(ana), { ...input, stageId: v1Stage }), "invalid_input");
	assert.equal((await enrollment(ana, caseyResidency)).versionNumber, 1);
	assert.deepEqual(await applied(), []);
});

test("Ana applies Version 2 at a stage she picks; finished work keeps its attribution and feedback its readers", async () => {
	const before = await enrollment(dana, caseyResidency);
	const rows = await completions();
	const r = await review(ana);
	const gathering = r.stages.find((s) => s.label === "Gathering")!.id;
	const input = { enrollmentId: caseyResidency, versionId: r.versionId, stageId: gathering, basis: r.basis };
	assert.equal(ok(await applyVersion(db, await authority(ana), input)).outcome, "changed");
	const e = await enrollment(dana, caseyResidency);
	const v2 = (await program(ana, residency)).published!;
	assert.equal(e.versionNumber, 2);
	assert.equal(e.newerVersion, null);
	assert.deepEqual(
		e.milestones.map((m) => m.title),
		v2.milestones.map((m) => m.title),
	);
	assert.deepEqual(e.earlier, []);
	// Cohort, dates, status and next meeting are unchanged; the stage is the one Ana picked.
	assert.deepEqual(
		[e.cohort, e.startedOn, e.expectedEndOn, e.status, e.nextMeeting, e.stage.label],
		[before.cohort, before.startedOn, before.expectedEndOn, before.status, before.nextMeeting, "Gathering"],
	);
	const group = e.milestones.find((m) => m.title === "Start a small group and raise a replacement")!;
	assert.deepEqual(group.completion, {
		completedOn: "2026-10-12",
		confirmedOn: e.today,
		recorder: "Ana",
		confirmer: "Ana",
		source: "program_leader",
	});
	// The renamed milestone Casey finished stays finished with its original record.
	assert.deepEqual(e.milestones.find((m) => m.title === "Present your vision to the elders")!.completion, {
		completedOn: "2026-10-14",
		confirmedOn: e.today,
		recorder: "Ana",
		confirmer: "Ana",
		source: "program_leader",
	});
	assert.equal(e.milestones.find((m) => m.title === "Lead a prayer walk")!.completion, null);
	// The stored records are the same rows, on Version 1, with the same recorder, confirmer and times.
	assert.deepEqual(await completions(), rows);
	// Feedback written on Version 1 reads the same to the director, Owner and Admin, and to nobody else.
	const v1Feedback = before.milestones.find((m) => m.title === "Preach on a Sunday")!.feedback;
	assert.equal(v1Feedback?.length, 1);
	for (const who of [ana, dana, luis])
		assert.deepEqual(
			(await enrollment(who, caseyResidency)).milestones.find((m) => m.title === "Preach on a Sunday")!.feedback,
			v1Feedback,
		);
	for (const who of [dee, ben]) {
		const read = await enrollment(who, caseyResidency);
		assert.ok(read.milestones.every((m) => m.feedback === null));
		assert.ok(!JSON.stringify(read).includes("slow down"));
	}
	const listed = (await program(dana, residency)).enrollments.find((x) => x.id === caseyResidency)!;
	assert.deepEqual([listed.versionNumber, listed.stage], [2, "Gathering"]);
	const record = ok(await readPipelinePersonRecord(db, await authority(dana), { personId: casey }));
	assert.equal(record.stage.label, "Potential leader");
	// One body-free audit row; the repeated request changes nothing and adds none.
	assert.deepEqual(await applied(), [{ fromVersion: 1, toVersion: 2 }]);
	assert.equal(ok(await applyVersion(db, await authority(ana), input)).outcome, "noop");
	assert.deepEqual(await applied(), [{ fromVersion: 1, toVersion: 2 }]);
	assert.deepEqual(await completions(), rows);
	// A milestone carried over finished is not recorded a second time on Version 2.
	assert.equal(
		ok(
			await recordMilestone(db, await authority(ana), {
				enrollmentId: caseyResidency,
				milestoneId: group.id,
				completedOn: "2026-11-01",
			}),
		).outcome,
		"noop",
	);
	assert.deepEqual(await completions(), rows);
});

test("a version that drops Casey's finished milestone keeps its record under Version 1; a renamed stage falls back", async () => {
	const group = "Start a small group and raise a replacement";
	const v3 = await publishNext({
		milestones: (ms) => ms.filter((m) => m.title !== group),
		stages: (ss) => ss.map((s) => (s.label === "Gathering" ? { ...s, label: "Gathering a core team" } : s)),
	});
	const open = await review(ana);
	assert.equal(open.toNumber, 3);
	assert.deepEqual(open.removed, [{ title: group, description: null, handsOn: false, finished: true }]);
	assert.deepEqual([open.added, open.changed], [[], []]);
	// Casey's stage Gathering has no match on Version 3, so the first stage is preselected.
	assert.equal(open.stage, "Gathering");
	assert.equal(open.stageId, v3.stages[0]!.id);
	// A newer version published while the review is open makes it stale.
	const v4 = await publishNext({
		milestones: (ms) => [...ms, { ...ms[0]!, id: randomUUID(), lineage: randomUUID(), title: "Visit a church plant" }],
	});
	refusedWith(
		await applyVersion(db, await authority(ana), {
			enrollmentId: caseyResidency,
			versionId: open.versionId,
			stageId: open.stageId,
			basis: open.basis,
		}),
		"stale_review",
	);
	assert.equal((await enrollment(ana, caseyResidency)).versionNumber, 2);
	const r = await review(ana);
	assert.equal(r.toNumber, 4);
	assert.deepEqual(r.removed, [{ title: group, description: null, handsOn: false, finished: true }]);
	assert.deepEqual(
		r.added.map((m) => m.title),
		["Visit a church plant"],
	);
	const rows = await completions();
	ok(
		await applyVersion(db, await authority(ana), {
			enrollmentId: caseyResidency,
			versionId: r.versionId,
			stageId: r.stageId,
			basis: r.basis,
		}),
	);
	const e = await enrollment(ana, caseyResidency);
	assert.deepEqual([e.versionNumber, e.stage.label], [4, v4.stages[0]!.label]);
	assert.ok(!e.milestones.some((m) => m.title === group));
	assert.deepEqual(
		e.earlier.map((m) => [m.title, m.versionNumber, m.completion]),
		[
			[
				group,
				1,
				{
					completedOn: "2026-10-12",
					confirmedOn: e.today,
					recorder: "Ana",
					confirmer: "Ana",
					source: "program_leader",
				},
			],
		],
	);
	assert.deepEqual(await completions(), rows);
	assert.deepEqual(await applied(), [
		{ fromVersion: 1, toVersion: 2 },
		{ fromVersion: 2, toVersion: 4 },
	]);
});

// Applying a newer version to several enrollments at once (REQ-MUL-011, D-1328 to D-1330). A second residency, directed
// by Ana: Casey and Jordan are on Version 1, Casey with "Start a small group and raise a replacement" finished Oct 12
// and Jordan with "Write a church planting prospectus" finished Oct 20. Riley joined on Version 2; Sam withdrew.

const cohort = randomUUID();
const riley = randomUUID();
const sam = randomUUID();
const batch = { casey: randomUUID(), jordan: randomUUID(), riley: randomUUID(), sam: randomUUID() };
const GROUP = "Start a small group and raise a replacement";
const PROSPECTUS = "Write a church planting prospectus";
const { applyVersions } = programWriter;

const reviews = async (a: Actor, enrollmentIds: string[], programId = cohort) =>
	readVersionReviews(db, await authority(a), { programId, enrollmentIds });
const storedRows = async (ids: string[]) =>
	(
		await admin.execute(sql`SELECT c.id,c.enrollment_id,c.milestone_id,c.version_id,c.completed_on::text AS completed_on,
		 c.recorder_id,c.confirmer_id,c.confirmed_at,c.source FROM enrollment_milestone c
		 WHERE c.enrollment_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) ORDER BY c.id`)
	).rows;
const appliedTo = async (ids: string[]) =>
	(
		await admin.execute(sql`SELECT subject_id,metadata FROM audit_event WHERE action='development.version_applied'
		 AND subject_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) ORDER BY subject_id`)
	).rows.map((r) => [r.subject_id, r.metadata]);
const confirmAll = (rs: { enrollmentId: string; stageId: string; basis: string; versionId: string }[]) => ({
	programId: cohort,
	versionId: rs[0]!.versionId,
	enrollments: rs.map((r) => ({ enrollmentId: r.enrollmentId, stageId: r.stageId, basis: r.basis })),
});

/** Adds a pipeline person and enrolls them in `programId`'s current version at the stage labeled `stage`. */
async function enrollNew(programId: string, personId: string, enrollmentId: string, name: string, stage: string) {
	const board = ok(await readPipelineBoard(db, await authority(dana), {}));
	const known = await admin.execute(sql`SELECT FROM pipeline_person WHERE person_id=${personId}::uuid`);
	if (!known.rows.length)
		ok(
			await pipelineWriter.addPerson(db, await authority(dana), {
				personId,
				displayName: name,
				email: null,
				responsibleSeatId: null,
				stageId: board.stages[0]!.id,
			}),
		);
	const p = await program(dana, programId);
	ok(
		await enroll(db, await authority(dana), {
			enrollmentId,
			programId,
			personId,
			cohort: "Spring 2027",
			startedOn: "2026-09-01",
			expectedEndOn: "2027-12-31",
			stageId: p.published!.stages.find((s) => s.label === stage)!.id,
			nextMeetingAt: "2026-11-20T18:30:00",
		}),
	);
}

test("the director reviews several enrollments: one section per person, with their own changes and stage", async () => {
	const p = ok(
		await createProgram(db, await authority(dana), {
			programId: cohort,
			kind: "residency",
			name: "Grace Residency 2027",
			directorSeatId: anaSeat,
			plan: templatePlan(),
		}),
	);
	ok(await publishVersion(db, await authority(ana), { programId: cohort, expectedRevision: p.revision }));
	await enrollNew(cohort, casey, batch.casey, "Casey Lee", "Training and planning");
	await enrollNew(cohort, jordan, batch.jordan, "Jordan Price", "Assimilating");
	await enrollNew(cohort, sam, batch.sam, "Sam Ortiz", "Assimilating");
	await admin.execute(sql`UPDATE development_enrollment SET status='withdrawn' WHERE id=${batch.sam}`);
	for (const [id, title, on] of [
		[batch.casey, GROUP, "2026-10-12"],
		[batch.jordan, PROSPECTUS, "2026-10-20"],
	] as const) {
		const m = (await enrollment(ana, id)).milestones.find((x) => x.title === title)!;
		ok(await recordMilestone(db, await authority(ana), { enrollmentId: id, milestoneId: m.id, completedOn: on }));
	}
	// Version 2 adds "Preach on a Sunday" and rewords the prospectus.
	const v1 = (await program(ana, cohort)).published!;
	const draft = ok(
		await savePlan(db, await authority(ana), {
			programId: cohort,
			expectedRevision: (await program(ana, cohort)).revision,
			plan: nextPlan(v1, {
				milestones: (ms) => [
					...ms.map((m) =>
						m.title === PROSPECTUS ? { ...m, description: "Vision, values, strategy and a first-year budget" } : m,
					),
					{ ...ms[0]!, lineage: randomUUID(), title: "Preach on a Sunday" },
				],
			}),
		}),
	);
	ok(await publishVersion(db, await authority(ana), { programId: cohort, expectedRevision: draft.revision }));
	await enrollNew(cohort, riley, batch.riley, "Riley Shaw", "Assimilating");
	const v2 = (await program(ana, cohort)).published!;
	assert.deepEqual(
		(await program(ana, cohort)).enrollments.map((e) => [e.name, e.versionNumber, e.status]),
		[
			["Casey Lee", 1, "active"],
			["Jordan Price", 1, "active"],
			["Riley Shaw", 2, "active"],
			["Sam Ortiz", 1, "withdrawn"],
		],
	);

	const [c, j] = ok(await reviews(ana, [batch.jordan, batch.casey]));
	assert.deepEqual(
		[c!.name, c!.enrollmentId, j!.name, j!.enrollmentId],
		["Casey Lee", batch.casey, "Jordan Price", batch.jordan],
	);
	for (const r of [c!, j!]) assert.deepEqual([r.fromNumber, r.toNumber, r.versionId], [1, 2, v2.id]);
	const preach = { title: "Preach on a Sunday", description: null, handsOn: false, finished: false };
	const wording = (finished: boolean) => ({
		before: { title: PROSPECTUS, description: null, handsOn: false, finished },
		after: {
			title: PROSPECTUS,
			description: "Vision, values, strategy and a first-year budget",
			handsOn: false,
			finished,
		},
	});
	assert.deepEqual([c!.added, c!.removed, c!.changed, c!.carried], [[preach], [], [wording(false)], [GROUP]]);
	assert.deepEqual([j!.added, j!.removed, j!.changed, j!.carried], [[preach], [], [wording(true)], [PROSPECTUS]]);
	// Each is preselected to their own stage's label on Version 2.
	assert.deepEqual(
		[c!.stage, c!.stageId, j!.stage, j!.stageId],
		[
			"Training and planning",
			v2.stages.find((s) => s.label === "Training and planning")!.id,
			"Assimilating",
			v2.stages.find((s) => s.label === "Assimilating")!.id,
		],
	);
	// Reading saves nothing.
	assert.deepEqual(await appliedTo([batch.casey, batch.jordan]), []);
	// Riley is already on Version 2 and Sam withdrew, so neither can be reviewed; nor can a mix that includes them.
	for (const id of [batch.riley, batch.sam]) refusedWith(await reviews(ana, [batch.casey, id]), "unavailable");
	// Only the current director reads the reviews, and only for the program they name.
	for (const who of [dana, luis, dee, ben, hillOwner])
		refusedWith(await reviews(who, [batch.casey, batch.jordan]), "unavailable");
	refusedWith(await reviews(ana, [batch.casey, caseyResidency]), "unavailable");
	refusedWith(await reviews(ana, [batch.casey, batch.casey]), "invalid_input");
	refusedWith(await reviews(ana, []), "invalid_input");
});

test("a batch apply is refused whole for anyone but the director and for any bad input", async () => {
	const rs = ok(await reviews(ana, [batch.casey, batch.jordan]));
	const input = confirmAll(rs);
	const before = await storedRows([batch.casey, batch.jordan]);
	for (const who of [dana, luis, dee, ben, hillOwner])
		refusedWith(await applyVersions(db, await authority(who), input), "unavailable");
	// A former director.
	await admin.execute(sql`UPDATE development_program SET director_seat_id=${deeSeat} WHERE id=${cohort}`);
	refusedWith(await applyVersions(db, await authority(ana), input), "unavailable");
	await admin.execute(sql`UPDATE development_program SET director_seat_id=${anaSeat} WHERE id=${cohort}`);
	// Version 1 is not the current published version.
	const v1 = (await admin.execute(sql`SELECT version_id FROM development_enrollment WHERE id=${batch.casey}`)).rows[0]!
		.version_id as string;
	const stale = await applyVersions(db, await authority(ana), { ...input, versionId: v1 });
	refusedWith(stale, "stale_review");
	assert.deepEqual((stale as { refusal: { enrollmentIds: string[] } }).refusal.enrollmentIds, [
		batch.casey,
		batch.jordan,
	]);
	// An enrollment of another program, of another organization, or one already on Version 2 or withdrawn.
	const hillProgram = (await admin.execute(sql`SELECT id FROM development_program WHERE organization_id=${hill.id}`))
		.rows[0]!.id as string;
	const hillRevision = ok(await readProgram(db, await authority(hillOwner), { programId: hillProgram })).revision;
	ok(await publishVersion(db, await authority(hillOwner), { programId: hillProgram, expectedRevision: hillRevision }));
	const hillPerson = randomUUID();
	const hillBoard = ok(await readPipelineBoard(db, await authority(hillOwner), {}));
	ok(
		await pipelineWriter.addPerson(db, await authority(hillOwner), {
			personId: hillPerson,
			displayName: "Hill Resident",
			email: null,
			responsibleSeatId: null,
			stageId: hillBoard.stages[0]!.id,
		}),
	);
	const hillEnrollment = randomUUID();
	ok(
		await enroll(db, await authority(hillOwner), {
			enrollmentId: hillEnrollment,
			programId: hillProgram,
			personId: hillPerson,
			cohort: "Hill 2027",
			startedOn: "2026-09-01",
			expectedEndOn: "2027-12-31",
			stageId: ok(await readProgram(db, await authority(hillOwner), { programId: hillProgram })).published!.stages[0]!
				.id,
			nextMeetingAt: null,
		}),
	);
	for (const other of [caseyResidency, batch.riley, batch.sam, hillEnrollment, randomUUID()])
		refusedWith(
			await applyVersions(db, await authority(ana), {
				...input,
				enrollments: [...input.enrollments, { ...input.enrollments[0]!, enrollmentId: other }],
			}),
			other === batch.riley ? "stale_review" : "unavailable",
		);
	// A repeated enrollment, more than 50 people, or nobody.
	refusedWith(
		await applyVersions(db, await authority(ana), {
			...input,
			enrollments: [...input.enrollments, input.enrollments[0]!],
		}),
		"invalid_input",
	);
	const many = Array.from({ length: 51 }, () => ({ ...input.enrollments[0]!, enrollmentId: randomUUID() }));
	refusedWith(await applyVersions(db, await authority(ana), { ...input, enrollments: many }), "invalid_input");
	refusedWith(await applyVersions(db, await authority(ana), { ...input, enrollments: [] }), "invalid_input");
	// A stage of Version 1 for one person.
	const v1Stage = (await enrollment(ana, batch.jordan)).stage.id;
	refusedWith(
		await applyVersions(db, await authority(ana), {
			...input,
			enrollments: [input.enrollments[0]!, { ...input.enrollments[1]!, stageId: v1Stage }],
		}),
		"invalid_input",
	);
	for (const id of [batch.casey, batch.jordan]) assert.equal((await enrollment(ana, id)).versionNumber, 1);
	assert.deepEqual(await storedRows([batch.casey, batch.jordan]), before);
	assert.deepEqual(await appliedTo([batch.casey, batch.jordan, batch.riley]), []);
});

test("one person's review going out of date refuses the whole apply, names them, and moves nobody", async () => {
	const rs = ok(await reviews(ana, [batch.casey, batch.jordan]));
	// Another session records a milestone for Jordan.
	const vision = (await enrollment(ana, batch.jordan)).milestones.find((m) =>
		m.title.startsWith("Present your vision"),
	)!;
	ok(
		await recordMilestone(db, await authority(ana), {
			enrollmentId: batch.jordan,
			milestoneId: vision.id,
			completedOn: "2026-10-22",
		}),
	);
	const before = await storedRows([batch.casey, batch.jordan]);
	const answer = await applyVersions(db, await authority(ana), confirmAll(rs));
	refusedWith(answer, "stale_review");
	assert.deepEqual((answer as { refusal: { enrollmentIds: string[] } }).refusal.enrollmentIds, [batch.jordan]);
	for (const id of [batch.casey, batch.jordan]) assert.equal((await enrollment(ana, id)).versionNumber, 1);
	assert.deepEqual(await storedRows([batch.casey, batch.jordan]), before);
	assert.deepEqual(await appliedTo([batch.casey, batch.jordan]), []);
	// The fresh reviews show Jordan's new record; Casey's is as it was.
	const [c, j] = ok(await reviews(ana, [batch.casey, batch.jordan]));
	assert.equal(c!.basis, rs[0]!.basis);
	assert.notEqual(j!.basis, rs[1]!.basis);
	assert.deepEqual(j!.carried, ["Present your vision to the sending church leadership", PROSPECTUS]);
});

test("Ana applies Version 2 to Casey and Jordan, each at their own stage; finished work keeps its attribution", async () => {
	const ids = [batch.casey, batch.jordan];
	const before = { casey: await enrollment(dana, batch.casey), jordan: await enrollment(dana, batch.jordan) };
	const rows = await storedRows(ids);
	const records = async () =>
		(
			await admin.execute(sql`SELECT revision FROM pipeline_person
	 WHERE person_id IN (${casey}::uuid,${jordan}::uuid) ORDER BY person_id`)
		).rows;
	const pipeline = await records();
	const [c, j] = ok(await reviews(ana, ids));
	// Only Jordan's stage changes from the preselection.
	const gathering = j!.stages.find((s) => s.label === "Gathering")!.id;
	const input = {
		...confirmAll([c!, j!]),
		enrollments: [
			{ enrollmentId: c!.enrollmentId, stageId: c!.stageId, basis: c!.basis },
			{ enrollmentId: j!.enrollmentId, stageId: gathering, basis: j!.basis },
		],
	};
	assert.equal(ok(await applyVersions(db, await authority(ana), input)).outcome, "changed");
	const v2 = (await program(ana, cohort)).published!;
	const after = { casey: await enrollment(dana, batch.casey), jordan: await enrollment(dana, batch.jordan) };
	for (const who of ["casey", "jordan"] as const) {
		const [b, e] = [before[who], after[who]];
		assert.deepEqual([e.versionNumber, e.newerVersion, e.earlier], [2, null, []]);
		assert.deepEqual(
			e.milestones.map((m) => m.title),
			v2.milestones.map((m) => m.title),
		);
		assert.deepEqual(
			[e.cohort, e.startedOn, e.expectedEndOn, e.status, e.nextMeeting],
			[b.cohort, b.startedOn, b.expectedEndOn, b.status, b.nextMeeting],
		);
	}
	assert.deepEqual([after.casey.stage.label, after.jordan.stage.label], ["Training and planning", "Gathering"]);
	const record = (completedOn: string) => ({
		completedOn,
		confirmedOn: after.casey.today,
		recorder: "Ana",
		confirmer: "Ana",
		source: "program_leader",
	});
	assert.deepEqual(after.casey.milestones.find((m) => m.title === GROUP)!.completion, record("2026-10-12"));
	// Jordan's changed milestone stays finished with its original record.
	assert.deepEqual(after.jordan.milestones.find((m) => m.title === PROSPECTUS)!.completion, record("2026-10-20"));
	assert.equal(after.casey.milestones.find((m) => m.title === PROSPECTUS)!.completion, null);
	// The stored records are the same rows: nobody is named as a new recorder or confirmer.
	assert.deepEqual(await storedRows(ids), rows);
	// Pipeline records are untouched, and the program lists both on Version 2 with Riley and Sam as they were.
	assert.deepEqual(await records(), pipeline);
	assert.deepEqual(
		(await program(ana, cohort)).enrollments.map((e) => [e.name, e.versionNumber, e.stage]),
		[
			["Casey Lee", 2, "Training and planning"],
			["Jordan Price", 2, "Gathering"],
			["Riley Shaw", 2, "Assimilating"],
			["Sam Ortiz", 1, "Assimilating"],
		],
	);
	// One body-free audit row per person; repeating the confirmed batch changes nothing and adds none.
	const audit = [
		[batch.casey, { fromVersion: 1, toVersion: 2 }],
		[batch.jordan, { fromVersion: 1, toVersion: 2 }],
	].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	assert.deepEqual(await appliedTo([...ids, batch.riley, batch.sam]), audit);
	assert.equal(ok(await applyVersions(db, await authority(ana), input)).outcome, "noop");
	assert.deepEqual(await appliedTo(ids), audit);
	assert.deepEqual(await storedRows(ids), rows);
	assert.deepEqual([(await enrollment(ana, batch.jordan)).stage.label], ["Gathering"]);
});

test("a version that drops a finished milestone keeps each person's record; a person removed from the batch stays", async () => {
	const ids = [batch.casey, batch.jordan, batch.riley];
	const v3 = await (async () => {
		const p = await program(ana, cohort);
		const saved = ok(
			await savePlan(db, await authority(ana), {
				programId: cohort,
				expectedRevision: p.revision,
				plan: nextPlan(p.published!, { milestones: (ms) => ms.filter((m) => m.title !== GROUP) }),
			}),
		);
		ok(await publishVersion(db, await authority(ana), { programId: cohort, expectedRevision: saved.revision }));
		return (await program(ana, cohort)).published!;
	})();
	const [c, j, r] = ok(await reviews(ana, ids));
	assert.deepEqual(
		[c!.removed, j!.removed, r!.removed],
		[
			[{ title: GROUP, description: null, handsOn: false, finished: true }],
			[{ title: GROUP, description: null, handsOn: false, finished: false }],
			[{ title: GROUP, description: null, handsOn: false, finished: false }],
		],
	);
	// Ana removes Riley from the review: only Casey and Jordan move.
	const rows = await storedRows(ids);
	ok(await applyVersions(db, await authority(ana), confirmAll([c!, j!])));
	assert.deepEqual(await Promise.all(ids.map(async (id) => (await enrollment(ana, id)).versionNumber)), [3, 3, 2]);
	const e = await enrollment(dana, batch.casey);
	assert.ok(!e.milestones.some((m) => m.title === GROUP));
	assert.deepEqual(
		e.earlier.map((m) => [m.title, m.versionNumber, m.completion?.completedOn, m.completion?.recorder]),
		[[GROUP, 1, "2026-10-12", "Ana"]],
	);
	assert.deepEqual((await enrollment(dana, batch.jordan)).earlier, []);
	assert.deepEqual(await storedRows(ids), rows);
	assert.equal(v3.number, 3);
});

test("ten people move in one apply, the same single statement as two", async () => {
	const tenProgram = randomUUID();
	const p = ok(
		await createProgram(db, await authority(dana), {
			programId: tenProgram,
			kind: "apprenticeship",
			name: "Grace Interns",
			directorSeatId: anaSeat,
			plan: templatePlan(),
		}),
	);
	ok(await publishVersion(db, await authority(ana), { programId: tenProgram, expectedRevision: p.revision }));
	const people = Array.from({ length: 10 }, (_, i) => ({
		person: randomUUID(),
		id: randomUUID(),
		name: `Intern ${i}`,
	}));
	for (const x of people) await enrollNew(tenProgram, x.person, x.id, x.name, "Assimilating");
	const v1 = (await program(ana, tenProgram)).published!;
	const saved = ok(
		await savePlan(db, await authority(ana), {
			programId: tenProgram,
			expectedRevision: (await program(ana, tenProgram)).revision,
			plan: nextPlan(v1, { milestones: (ms) => ms.slice(1) }),
		}),
	);
	ok(await publishVersion(db, await authority(ana), { programId: tenProgram, expectedRevision: saved.revision }));
	const rs = ok(
		await reviews(
			ana,
			people.map((x) => x.id),
			tenProgram,
		),
	);
	assert.equal(rs.length, 10);
	assert.equal(
		ok(await applyVersions(db, await authority(ana), { ...confirmAll(rs), programId: tenProgram })).outcome,
		"changed",
	);
	assert.ok((await program(ana, tenProgram)).enrollments.every((e) => e.versionNumber === 2));
	assert.equal((await appliedTo(people.map((x) => x.id))).length, 10);
});
