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
import { programWriter, readProgram } from "../../../packages/domain/src/organizations/programs.ts";
import { pipelineDataWriter, readPipelineExport } from "../../../packages/domain/src/organizations/data.ts";
import { peopleMerge } from "../../../packages/domain/src/people/merge/index.ts";
import { peopleUnmerge } from "../../../packages/domain/src/people/unmerge/index.ts";
import { listOrganizationDuplicatePairs } from "../../../packages/domain/src/people/duplicates.ts";

// Pipeline export, removal on request and duplicate merge (REQ-MUL-005, REQ-MUL-017) against a migrated database.
// Grace Austin, America/Chicago: Dana is the Owner, Ana (Member) directs the residency, Ben (Member) has no duty.
// Casey Lee is a linked resident who shares milestone progress only; Jordan Reyes is unlinked; "Casey L." is a second
// record with Casey's email.

const database = await fixture({ prefix: "pipelinedata", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Actor = { id: string; session: string };
let grace: { kind: "organization"; id: string; organizationKind: "sending_church" };
let dana: Actor, ana: Actor, ben: Actor, caseyAccount: Actor, other: Actor;
let anaSeat: string;
let today: string;
let link: string;
let milestones: { id: string; title: string }[];

const casey = randomUUID(),
	jordan = randomUUID(),
	caseyL = randomUUID();
const residency = randomUUID(),
	apprenticeship = randomUUID();
const enrollments = { casey: randomUUID(), jordan: randomUUID(), jordanApprentice: randomUUID(), caseyL: randomUUID() };

const authority = (a: Actor) => RequestActor.resolve(db, a.session as never);
const ctx = (a: Actor) => ({ session: a.session, selected: grace });
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown; error?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const refusedWith = (r: { status: string; refusal?: { code: string }; error?: { code: string } }, code: string) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal((r.refusal ?? r.error)?.code, code);
};
const rows = async (q: ReturnType<typeof sql>) => (await admin.execute(q)).rows as Record<string, unknown>[];
const exported = async (a: Actor = dana) => ok(await readPipelineExport(db, await authority(a)));
const record = async (personId: string) => ok(await readPipelinePersonRecord(db, await authority(dana), { personId }));
const tx = <T,>(body: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(body);
/** The CSV's data rows after its header, as records of column to value. */
function table(text: string) {
	const lines = text.replace(/^﻿/, "").split("\r\n");
	const start = lines.findIndex((l) => l.startsWith("record,person_id,"));
	const header = lines[start]!.split(",");
	return lines
		.slice(start + 1)
		.filter(Boolean)
		.map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
}

before(async () => {
	grace = (await database.organization("sending_church", {
		name: "Grace Austin",
		timezone: "America/Chicago",
	})) as never;
	dana = await database.actor(grace as never, "owner", { user: { name: "Dana" } });
	ana = await database.actor(grace as never, "member", { user: { name: "Ana" } });
	ben = await database.actor(grace as never, "member", { user: { name: "Ben" } });
	caseyAccount = await database.actor(null, "owner", {
		email: "casey.own.account@example.test",
		user: { name: "Casey Own Account" },
	});
	other = await database.actor(null, "owner", { user: { name: "Someone Else" } });
	anaSeat = (
		await rows(sql`SELECT id FROM seat WHERE account_id=${ana.id}::uuid AND organization_id=${grace.id}::uuid`)
	)[0]!.id as string;

	const board = ok(await readPipelineBoard(db, await authority(dana), {}));
	const stage = (label: string) => board.stages.find((s) => s.label === label)!.id;
	for (const [personId, displayName, email, at] of [
		[casey, "Casey Lee", "casey@example.test", "Resident"],
		[jordan, "Jordan Reyes", "jordan@example.test", "Potential leader"],
		[caseyL, "Casey L.", "CASEY@example.test", "Potential leader"],
	] as const)
		ok(
			await pipelineWriter.addPerson(db, await authority(dana), {
				personId,
				displayName,
				email,
				responsibleSeatId: null,
				stageId: stage(at),
			}),
		);
	today = ok(await readPipelineGoals(db, await authority(dana))).asOf;
	const caseyRevision = (await record(casey)).revision;
	ok(
		await pipelineWriter.movePerson(db, await authority(dana), {
			personId: casey,
			expectedRevision: caseyRevision,
			stageId: stage("Apprentice"),
			reason: "REASON-SECRET ready for more",
		}),
	);
	ok(
		await pipelineWriter.addNote(db, await authority(dana), {
			personId: casey,
			noteId: randomUUID(),
			body: "NOTE-SECRET",
		}),
	);
	for (const personId of [jordan, caseyL])
		ok(
			await pipelineWriter.logConversation(db, await authority(dana), {
				conversationId: randomUUID(),
				personId,
				occurredOn: today,
				note: "CONVERSATION-SECRET",
			}),
		);

	// Two programs Ana directs, published, with Casey and Jordan in the residency and Jordan also an apprentice.
	const plan = (handsOn: boolean) => ({
		rhythm: "monthly",
		expectedMonths: 12,
		stages: [{ label: "Assimilating", minMonths: 1, maxMonths: 3 }],
		milestones: [
			{ lineage: randomUUID(), title: "Write a church planting prospectus", description: null, handsOn: false },
			...(handsOn
				? [{ lineage: randomUUID(), title: "Lead a small group", description: "Lead for a season", handsOn: true }]
				: []),
		],
		readings: [],
	});
	for (const [programId, kind, name] of [
		[residency, "residency", "Grace Residency"],
		[apprenticeship, "apprenticeship", "Grace Apprenticeship"],
	] as const) {
		ok(
			await programWriter.createProgram(db, await authority(dana), {
				programId,
				kind,
				name,
				directorSeatId: anaSeat,
				plan: plan(programId === residency),
			}),
		);
		const p = ok(await readProgram(db, await authority(dana), { programId }));
		ok(await programWriter.publishVersion(db, await authority(ana), { programId, expectedRevision: p.revision }));
	}
	const enroll = async (enrollmentId: string, programId: string, personId: string) => {
		const p = ok(await readProgram(db, await authority(dana), { programId }));
		ok(
			await programWriter.enroll(db, await authority(dana), {
				enrollmentId,
				programId,
				personId,
				cohort: "Fall 2026",
				startedOn: "2026-10-01",
				expectedEndOn: "2027-12-31",
				stageId: p.published!.stages[0]!.id,
				nextMeetingAt: null,
			}),
		);
		return p.published!.milestones;
	};
	milestones = await enroll(enrollments.casey, residency, casey);
	await enroll(enrollments.jordan, residency, jordan);
	await enroll(enrollments.jordanApprentice, apprenticeship, jordan);
	await enroll(enrollments.caseyL, apprenticeship, caseyL);
	for (const enrollmentId of [enrollments.casey, enrollments.jordan])
		ok(
			await programWriter.recordMilestone(db, await authority(ana), {
				enrollmentId,
				milestoneId: milestones[0]!.id,
				completedOn: today,
			}),
		);
	ok(
		await programWriter.addFeedback(db, await authority(ana), {
			feedbackId: randomUUID(),
			enrollmentId: enrollments.casey,
			milestoneId: milestones[1]!.id,
			body: "FEEDBACK-SECRET",
		}),
	);
	// Then Casey's link: she accepted a residency invitation and shares milestone progress, not foundations progress.
	const affiliation = randomUUID(),
		invitation = randomUUID();
	link = randomUUID();
	await admin.execute(sql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,
	 share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
	 VALUES(${affiliation},${caseyAccount.id},${grace.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	await admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,
	 accepted_account_id,resident_person_id) VALUES(${invitation},${grace.id},'residency_link','casey@example.test',
	 ${randomUUID()},'accepted',clock_timestamp(),${caseyAccount.id},${casey})`);
	await admin.execute(sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,
	 accepted_at,consent_revision,revision,share_foundations,share_milestones)
	 VALUES(${link},${grace.id},${casey},${caseyAccount.id},${affiliation},${invitation},clock_timestamp(),1,1,false,true)`);
	await admin.execute(sql`UPDATE person SET linked_account_id=${caseyAccount.id} WHERE id=${casey}`);
});

test("AC:ADR1-005 INV-privacy: the export holds contact, stage history, programs, enrollments and completions, and says what and when", async () => {
	const file = await exported();
	assert.equal(file.filename, `pipeline-${today}.csv`);
	assert.equal(file.people, 3);
	const lines = file.text.replace(/^﻿/, "").split("\r\n");
	assert.equal(lines[0], "Grace Austin pipeline export");
	assert.match(lines[1]!, new RegExp(`^Made,${today} \\d{2}:\\d{2} America/Chicago$`));
	assert.match(lines[2]!, /^Contains,"Each pipeline person's contact details, stage history, programs/);
	assert.match(lines[3]!, /^Leaves out,"Notes, stage move reasons, conversations, feedback/);
	const t = table(file.text);
	const of = (record: string, id?: string) => t.filter((r) => r.record === record && (!id || r.person_id === id));
	assert.deepEqual(
		of("person").map((r) => [r.name, r.email, r.stage, r.status]),
		[
			["Casey L.", "casey@example.test", "Potential leader", "live"],
			["Casey Lee", "casey@example.test", "Apprentice", "live"],
			["Jordan Reyes", "jordan@example.test", "Potential leader", "live"],
		],
	);
	assert.deepEqual(
		of("stage_move", casey).map((r) => [r.date, r.from_stage, r.to_stage]),
		[
			[today, "", "Resident"],
			[today, "Resident", "Apprentice"],
		],
	);
	assert.deepEqual(
		of("program").map((r) => [r.program, r.program_kind]),
		[
			["Grace Apprenticeship", "apprenticeship"],
			["Grace Residency", "residency"],
		],
	);
	assert.deepEqual(
		of("enrollment", jordan).map((r) => [r.program, r.status, r.cohort, r.started_on, r.program_stage]),
		[
			["Grace Apprenticeship", "active", "Fall 2026", "2026-10-01", "Assimilating"],
			["Grace Residency", "active", "Fall 2026", "2026-10-01", "Assimilating"],
		],
	);
	assert.deepEqual(
		of("milestone_completed").map((r) => [r.name, r.milestone, r.date]),
		[
			["Casey Lee", "Write a church planting prospectus", today],
			["Jordan Reyes", "Write a church planting prospectus", today],
		],
	);
	// No note, move reason, conversation note or feedback body, and nothing from Casey's own account.
	for (const secret of [
		"NOTE-SECRET",
		"REASON-SECRET",
		"CONVERSATION-SECRET",
		"FEEDBACK-SECRET",
		"Casey Own Account",
		caseyAccount.email,
	])
		assert.equal(file.text.includes(secret!), false, secret);
});

test("AC:ADR1-005 INV-privacy: after Casey stops sharing milestone progress the next export drops her marks and keeps the church's facts", async () => {
	const before = table((await exported()).text);
	await admin.execute(sql`UPDATE residency_link SET share_milestones=false,consent_revision=consent_revision+1,
	 revision=revision+1 WHERE id=${link}`);
	const now = table((await exported()).text);
	const marks = (t: typeof now) => t.filter((r) => r.record === "milestone_completed").map((r) => r.name);
	assert.deepEqual([marks(before), marks(now)], [["Casey Lee", "Jordan Reyes"], ["Jordan Reyes"]]);
	// Everything else Grace Austin recorded about Casey is still there.
	const caseyRows = (t: typeof now) => t.filter((r) => r.person_id === casey && r.record !== "milestone_completed");
	assert.deepEqual(caseyRows(now), caseyRows(before));
	await admin.execute(sql`UPDATE residency_link SET share_milestones=true,revision=revision+1 WHERE id=${link}`);
});

test("INV-tenancy: a Member with no duty and a program director are refused export, removal, merge and duplicate pairs", async () => {
	for (const who of [ben, ana]) {
		refusedWith(await readPipelineExport(db, await authority(who)), "unavailable");
		refusedWith(
			await pipelineDataWriter.removePerson(db, await authority(who), { personId: jordan, expectedRevision: "1" }),
			"unavailable",
		);
		assert.equal((await tx((t) => listOrganizationDuplicatePairs(t, ctx(who) as never))).status, "refused");
		assert.equal(
			(await tx((t) => peopleMerge.getMergeReview(t, ctx(who) as never, { sourceId: caseyL, survivorId: casey })))
				.status,
			"refused",
		);
		const review = ok(
			await tx((t) => peopleMerge.getMergeReview(t, ctx(dana) as never, { sourceId: caseyL, survivorId: casey })),
		);
		assert.equal(
			(
				await tx((t) =>
					peopleMerge.mergePeople(t, ctx(who) as never, {
						requestKey: randomUUID(),
						input: { sourceId: caseyL, survivorId: casey, reviewDigest: review.reviewDigest, fieldChoices: {} },
					}),
				)
			).status,
			"refused",
		);
	}
	assert.equal((await rows(sql`SELECT state FROM person WHERE id=${caseyL}`))[0]!.state, "live");
});

test("INV-tenancy: another organization's Owner exports, lists pairs and removes none of Grace Austin's people", async () => {
	const hope = await database.organization("sending_church", { name: "Hope Dallas", timezone: "America/Chicago" });
	const owner = await database.actor(hope as never, "owner", { user: { name: "Hope Owner" } });
	const text = ok(await readPipelineExport(db, await authority(owner))).text;
	for (const value of [casey, jordan, caseyL, "Casey", "Jordan", "Grace Austin"])
		assert.ok(!text.includes(value), value);
	const own = { session: owner.session, selected: hope };
	assert.deepEqual(ok(await tx((t) => listOrganizationDuplicatePairs(t, own as never))).items, []);
	// Naming Grace Austin as the selected organization does not lend Hope's Owner a seat there.
	assert.equal((await tx((t) => listOrganizationDuplicatePairs(t, ctx(owner) as never))).status, "refused");
	refusedWith(
		await pipelineDataWriter.removePerson(db, await authority(owner), { personId: jordan, expectedRevision: "1" }),
		"unavailable",
	);
	assert.equal((await rows(sql`SELECT state FROM person WHERE id=${jordan}`))[0]!.state, "live");
});

/** Both records as their record pages, the person rows and the enrollment owners show them. */
async function snapshot() {
	const pages = await Promise.all([casey, caseyL].map(record));
	const people = await rows(sql`SELECT id,display_name,email,state,merged_into_person_id,linked_account_id FROM person
	 WHERE id IN (${casey},${caseyL}) ORDER BY display_name`);
	const owners = await rows(sql`SELECT id,person_id FROM development_enrollment WHERE id IN (${enrollments.casey},
	 ${enrollments.caseyL}) ORDER BY id`);
	return {
		pages: pages.map((p) => ({
			name: p.name,
			email: p.email,
			stage: p.stage.label,
			history: p.history,
			conversations: p.conversations.map((c) => c.id),
			notes: p.notes.map((n) => n.id),
		})),
		people,
		owners,
	};
}

test("AC:ADR1-017 Casey Lee and Casey L. are suggested by email; collisions refuse; merge joins them and undo restores both", async () => {
	const pairs = ok(await tx((t) => listOrganizationDuplicatePairs(t, ctx(dana) as never)));
	assert.deepEqual(
		pairs.items.map((p) => [[p.person.displayName, p.with.displayName].sort(), p.shared]),
		[[["Casey L.", "Casey Lee"], ["email"]]],
	);
	const original = await snapshot();
	const review = async () =>
		ok(await tx((t) => peopleMerge.getMergeReview(t, ctx(dana) as never, { sourceId: caseyL, survivorId: casey })));
	const merge = async (reviewDigest: string, fieldChoices = {}) =>
		tx((t) =>
			peopleMerge.mergePeople(t, ctx(dana) as never, {
				requestKey: randomUUID(),
				input: { sourceId: caseyL, survivorId: casey, reviewDigest, fieldChoices },
			}),
		);

	// Linked to a different account: the pair can't be merged, and nothing changes.
	await admin.execute(sql`UPDATE person SET linked_account_id=${other.id} WHERE id=${caseyL}`);
	let r = await review();
	assert.deepEqual(r.blockers.causes, ["linked_account_collision"]);
	refusedWith(await merge(r.reviewDigest), "merge_blocked");
	await admin.execute(sql`UPDATE person SET linked_account_id=NULL WHERE id=${caseyL}`);
	// Both enrolled in the same program: refused too.
	await admin.execute(sql`UPDATE development_enrollment SET program_id=${residency},version_id=(SELECT version_id FROM
	 development_enrollment WHERE id=${enrollments.casey}),current_stage_id=(SELECT current_stage_id FROM development_enrollment
	 WHERE id=${enrollments.casey}) WHERE id=${enrollments.caseyL}`);
	r = await review();
	assert.deepEqual(r.blockers.causes, ["enrollment_collision"]);
	refusedWith(await merge(r.reviewDigest), "merge_blocked");
	await admin.execute(sql`UPDATE development_enrollment SET program_id=${apprenticeship},version_id=(SELECT version_id FROM
	 development_enrollment WHERE id=${enrollments.jordanApprentice}),current_stage_id=(SELECT current_stage_id FROM
	 development_enrollment WHERE id=${enrollments.jordanApprentice}) WHERE id=${enrollments.caseyL}`);
	assert.deepEqual(await snapshot(), original);

	// Dana keeps Casey Lee and her own email; Casey L.'s history, enrollment and conversation join Casey Lee's record.
	r = await review();
	assert.deepEqual(r.blockers.causes, []);
	assert.deepEqual(
		r.fields.map((f) => f.field),
		["displayName"],
	);
	const merged = ok(await merge(r.reviewDigest, { displayName: "survivor" }));
	const page = await record(casey);
	assert.deepEqual(
		page.conversations.map((c) => c.id),
		original.pages.find((p) => p.name === "Casey L.")!.conversations,
	);
	assert.equal(page.history.filter((h) => h.kind === "placed").length, 2);
	assert.deepEqual(
		(await rows(sql`SELECT person_id FROM development_enrollment WHERE id=${enrollments.caseyL}`))[0]!.person_id,
		casey,
	);
	assert.equal((await readPipelineBoard(db, await authority(dana), { q: "Casey L." })).status, "ok");
	assert.equal(
		ok(await readPipelineBoard(db, await authority(dana), { q: "Casey L." })).stages.flatMap((s) => s.people).length,
		0,
	);

	// Undo before anything else changes: both records come back exactly as they were.
	const preview = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(dana) as never, { mergeId: merged.mergeId })));
	ok(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(dana) as never, {
				requestKey: randomUUID(),
				expectedRevision: preview.reviewRevision,
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	assert.deepEqual(await snapshot(), original);
});

test("AC:ADR1-005 INV-privacy: removing Jordan on request keeps only what Grace Austin needs and takes him out of every read", async () => {
	const goals = ok(await readPipelineGoals(db, await authority(dana)));
	const kind = (g: typeof goals, k: string) => g.kinds.find((x) => x.kind === k)?.count ?? 0;
	const talks = (g: typeof goals) => g.conversations.months.reduce((n, m) => n + m.count, 0);
	// His apprenticeship finished: that completion is a fact the church keeps, without his name.
	await admin.execute(
		sql`UPDATE development_enrollment SET status='completed' WHERE id=${enrollments.jordanApprentice}`,
	);
	const revision = (await record(jordan)).revision;
	refusedWith(
		await pipelineDataWriter.removePerson(db, await authority(dana), { personId: jordan, expectedRevision: "99" }),
		"conflict",
	);
	assert.equal((await record(jordan)).name, "Jordan Reyes");

	const report = ok(
		await pipelineDataWriter.removePerson(db, await authority(dana), { personId: jordan, expectedRevision: revision }),
	);
	assert.deepEqual(report, {
		personId: jordan,
		removed: {
			stageMoves: 1,
			notes: 0,
			conversations: 1,
			enrollments: 1,
			milestoneMarks: 1,
			feedback: 0,
			residencyLinkEnded: false,
			invitationsRevoked: 0,
			mergedRecords: 0,
		},
		kept: [
			{ category: "program_completion_count", count: 1 },
			{ category: "activity_record", count: null },
			{ category: "removal_record", count: null },
		],
		attribution: "Former participant",
	});
	// Gone from the board, search, his record, the enrollment picker, the goal counts and the next export.
	const board = ok(await readPipelineBoard(db, await authority(dana), {}));
	assert.equal(
		board.stages.flatMap((s) => s.people).some((p) => p.personId === jordan),
		false,
	);
	assert.equal(
		ok(await readPipelineBoard(db, await authority(dana), { q: "jordan" })).stages.flatMap((s) => s.people).length,
		0,
	);
	refusedWith(await readPipelinePersonRecord(db, await authority(dana), { personId: jordan }), "unavailable");
	const program = ok(await readProgram(db, await authority(dana), { programId: residency }));
	assert.equal(
		program.people.some((p) => p.personId === jordan),
		false,
	);
	assert.equal(
		program.enrollments.some((e) => e.personId === jordan),
		false,
	);
	const after = ok(await readPipelineGoals(db, await authority(dana)));
	assert.deepEqual(
		[kind(after, "potential_leader"), talks(after)],
		[kind(goals, "potential_leader") - 1, talks(goals) - 1],
	);
	const file = await exported();
	assert.equal(file.text.includes("Jordan"), false);
	assert.equal(file.text.includes(jordan), false);
	assert.equal(file.people, 2);
	// What stays: the scrubbed person row, the completed enrollment, a body-free audit trail and the removal record.
	assert.deepEqual(await rows(sql`SELECT display_name,email,state,linked_account_id FROM person WHERE id=${jordan}`), [
		{ display_name: "Former participant", email: null, state: "retired", linked_account_id: null },
	]);
	assert.deepEqual(await rows(sql`SELECT status FROM development_enrollment WHERE person_id=${jordan}`), [
		{ status: "completed" },
	]);
	assert.deepEqual(
		await rows(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${jordan} AND action<>'people.removed'
		 AND (actor_id IS NOT NULL OR before_value IS NOT NULL OR after_value IS NOT NULL OR reason IS NOT NULL)`),
		[{ n: 0 }],
	);
	assert.deepEqual(
		await rows(sql`SELECT requested_by FROM organization_person_removal WHERE person_record_id=${jordan}`),
		[{ requested_by: dana.id }],
	);
	// A second request finds no one to remove.
	refusedWith(
		await pipelineDataWriter.removePerson(db, await authority(dana), { personId: jordan, expectedRevision: revision }),
		"unavailable",
	);
});

test("AC:ADR1-005 INV-privacy: removing linked Casey ends her link at once and leaves her own account untouched", async () => {
	const account = async () =>
		rows(sql`SELECT a.registration_state,u.name,u.email FROM account a JOIN auth_user u ON u.id=a.auth_user_id
		 WHERE a.id=${caseyAccount.id}`);
	const before = await account();
	const residency = () => rows(sql`SELECT id FROM residency_link WHERE account_id=${caseyAccount.id}`);
	assert.deepEqual(await residency(), [{ id: link }]);
	const report = ok(
		await pipelineDataWriter.removePerson(db, await authority(dana), {
			personId: casey,
			expectedRevision: (await record(casey)).revision,
		}),
	);
	assert.deepEqual([report.removed.residencyLinkEnded, report.removed.notes, report.removed.feedback], [true, 1, 1]);
	// My residency reads links by account: Casey has none now. Her account, sign-in and name are as they were.
	assert.deepEqual(await residency(), []);
	assert.deepEqual(
		await rows(
			sql`SELECT ended_at IS NOT NULL AS ended,share_foundations,share_milestones FROM residency_link WHERE id=${link}`,
		),
		[{ ended: true, share_foundations: false, share_milestones: false }],
	);
	assert.deepEqual(await account(), before);
	assert.equal(
		(await rows(sql`SELECT count(*)::int AS n FROM auth_session WHERE id=${caseyAccount.session}`))[0]!.n,
		1,
	);
	assert.deepEqual(await rows(sql`SELECT body FROM person_note WHERE person_id=${casey}`), []);
	assert.deepEqual(await rows(sql`SELECT body FROM assignment_feedback WHERE enrollment_id=${enrollments.casey}`), []);
});

test("AC:ADR1-005 AC:ADR1-017 INV-privacy: removing a person also removes the duplicate merged into them", async () => {
	const board = ok(await readPipelineBoard(db, await authority(dana), {}));
	const stage = board.stages.find((s) => s.label === "Potential leader")!.id;
	const riley = randomUUID(),
		rileyP = randomUUID();
	for (const [personId, displayName] of [
		[riley, "Riley Park"],
		[rileyP, "Riley P."],
	] as const)
		ok(
			await pipelineWriter.addPerson(db, await authority(dana), {
				personId,
				displayName,
				email: "riley@example.test",
				responsibleSeatId: null,
				stageId: stage,
			}),
		);
	ok(
		await pipelineWriter.logConversation(db, await authority(dana), {
			conversationId: randomUUID(),
			personId: rileyP,
			occurredOn: today,
			note: "MERGED-CONVERSATION-SECRET",
		}),
	);
	const review = ok(
		await tx((t) => peopleMerge.getMergeReview(t, ctx(dana) as never, { sourceId: rileyP, survivorId: riley })),
	);
	ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(dana) as never, {
				requestKey: randomUUID(),
				input: {
					sourceId: rileyP,
					survivorId: riley,
					reviewDigest: review.reviewDigest,
					fieldChoices: { displayName: "survivor" },
				},
			}),
		),
	);
	assert.equal((await record(riley)).conversations.length, 1);
	const talks = async () =>
		ok(await readPipelineGoals(db, await authority(dana))).conversations.months.reduce((n, m) => n + m.count, 0);
	const talksBefore = await talks();

	const report = ok(
		await pipelineDataWriter.removePerson(db, await authority(dana), {
			personId: riley,
			expectedRevision: (await record(riley)).revision,
		}),
	);
	assert.deepEqual([report.removed.mergedRecords, report.removed.conversations, report.removed.stageMoves], [1, 1, 2]);
	// Both records are scrubbed and witnessed; nothing of either is left on the pipeline, in a merge or in the audit trail.
	assert.deepEqual(
		await rows(sql`SELECT display_name,email,state,merged_into_person_id FROM person WHERE id IN (${riley},${rileyP})`),
		[0, 1].map(() => ({
			display_name: "Former participant",
			email: null,
			state: "retired",
			merged_into_person_id: null,
		})),
	);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int AS n FROM organization_person_removal WHERE person_record_id IN (${riley},${rileyP})`,
		),
		[{ n: 2 }],
	);
	for (const q of [
		sql`SELECT count(*)::int AS n FROM pipeline_person WHERE person_id IN (${riley},${rileyP})`,
		sql`SELECT count(*)::int AS n FROM leadership_conversation WHERE note LIKE '%MERGED-CONVERSATION-SECRET%'`,
		sql`SELECT count(*)::int AS n FROM person_merge WHERE source_id IN (${riley},${rileyP}) OR survivor_id IN (${riley},${rileyP})`,
		sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id IN (${riley},${rileyP}) AND action<>'people.removed'
		 AND (actor_id IS NOT NULL OR before_value IS NOT NULL OR after_value IS NOT NULL OR reason IS NOT NULL)`,
	])
		assert.deepEqual(await rows(q), [{ n: 0 }]);
	// Out of the goal counts, the board, the duplicates list and the export.
	assert.equal(await talks(), talksBefore - 1);
	assert.equal(
		ok(await readPipelineBoard(db, await authority(dana), { q: "riley" })).stages.flatMap((s) => s.people).length,
		0,
	);
	const pairs = ok(await tx((t) => listOrganizationDuplicatePairs(t, ctx(dana) as never)));
	assert.equal(
		pairs.items.some((p) => [p.person.id, p.with.id].some((id) => id === riley || id === rileyP)),
		false,
	);
	assert.equal((await exported()).text.includes("Riley"), false);
});
