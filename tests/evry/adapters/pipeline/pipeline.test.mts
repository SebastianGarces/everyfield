import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/src/query.ts";
import { dayText } from "../../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	programWriter,
	readEnrollment,
	readPipelineBoard,
	readPipelineGoals,
	readPipelinePersonRecord,
	readProgram,
	readVersionReview,
} from "../../../../packages/domain/src/organizations/index.ts";
import { invokeRead, readCatalog, type EvryActor } from "../../../../packages/evry/src/index.ts";
import {
	readConversationCounts,
	readGoals,
	readProgram as programRead,
} from "../../../../packages/evry/src/adapters/pipeline/reads/index.ts";
import { evalDatabase, GRACE_AUSTIN, seedHope } from "../../evals/golden-church.mts";
import {
	ANA_NOTE,
	linkResident,
	markMilestone,
	PEOPLE,
	seedPipeline,
	sessionOf,
	type PipelineName,
} from "../../evals/pipeline-church.mts";
import { completed, refusedAs, reviews } from "../review-support.mts";

const database = await evalDatabase({ prefix: "evrypipa", max: 10 });
const { admin } = database;
const db = database.pools.runtime;
const r = reviews(db);
let seeded: Awaited<ReturnType<typeof seedPipeline>>;
const who = {} as Record<PipelineName, EvryActor>;
before(async () => {
	await seedHope(admin, { seatNames: true });
	seeded = await seedPipeline(admin, db);
	for (const name of ["dana", "luis", "ana", "ben", "hill"] as const) who[name] = await r.actorOf(sessionOf(name));
});
after(() => database.close());

const authority = (name: PipelineName) => RequestActor.resolve(db, sessionOf(name) as never) as Promise<RequestActor>;
const ok = <T,>(reply: { status: string; value?: T }): T => {
	assert.equal(reply.status, "ok", JSON.stringify(reply));
	return reply.value as T;
};
const goals = async (name: PipelineName = "dana") => ok(await readPipelineGoals(db, await authority(name)));
const board = async () => ok(await readPipelineBoard(db, await authority("dana"), {}));
const program = async (name: PipelineName = "ana", programId = seeded.residency.programId) =>
	ok(await readProgram(db, await authority(name), { programId }));
const enrollment = async (name: PipelineName = "ana", enrollmentId: string = seeded.residency.enrollmentId) =>
	ok(await readEnrollment(db, await authority(name), { enrollmentId }));
const addDays = (day: string, n: number) =>
	new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const audits = async (action: string, subject: string) =>
	(
		await admin.execute(
			sql`SELECT actor_id,before_revision::int AS before,after_revision::int AS after,metadata FROM audit_event
				WHERE action=${action} AND subject_id=${subject}::uuid ORDER BY occurred_at`,
		)
	).rows;

test("INV-evry-goals: sending goals and conversation counts are the Pipeline page's own figures for every seat, with no name, note or who met whom", async () => {
	const start = await goals();
	ok(
		await pipelineWriter.saveGoal(db, await authority("dana"), {
			goalId: randomUUID(),
			expectedRevision: null,
			leaderTarget: 6,
			plantTarget: 2,
			targetYear: 2028,
			rationale: "Two churches want to plant.",
			countingFrom: addDays(start.asOf, -60),
			counts: [{ kind: "apprentice", label: "Apprentices activated" }],
		}),
	);
	for (const [personId, occurredOn, note] of [
		[PEOPLE.casey, start.asOf, "CONVERSATION-CANARY"],
		[PEOPLE.jordan, addDays(start.asOf, -1), null],
	] as const)
		ok(
			await pipelineWriter.logConversation(db, await authority("dana"), {
				conversationId: randomUUID(),
				personId,
				occurredOn,
				note,
			}),
		);
	for (const name of ["dana", "luis", "ana", "ben"] as const) {
		const page = await goals(name);
		const read = await invokeRead(db, who[name], readGoals as never, {});
		assert.deepEqual(
			read.rows.map((x) => [x.id, x.label, x.fields]),
			page.goals.map((g) => [
				g.id,
				"Develop 6 leaders to plant 2 churches by 2028",
				{
					leaderTarget: g.leaderTarget,
					plantTarget: g.plantTarget,
					targetYear: g.targetYear,
					rationale: g.rationale,
					countingFrom: g.countingFrom,
					counts: `Apprentices activated (Apprentice): ${g.counts[0]!.count}`,
				},
			]),
			name,
		);
		assert.equal(page.goals[0]!.counts[0]!.count, 1);
		assert.deepEqual(
			[read.facts?.asOf, read.facts?.canEdit, read.facts?.activeResidents, read.facts?.plantsSent],
			[page.asOf, page.canEdit, page.activeResidents, "Not available yet"],
		);
		const counts = await invokeRead(db, who[name], readConversationCounts as never, {});
		assert.deepEqual(
			counts.rows.map((x) => [x.fields.period, x.id, x.fields.count]),
			[
				...page.conversations.months.map((m) => ["month", m.month, m.count]),
				...page.conversations.quarters.map((q) => ["quarter", `${q.year}-Q${q.quarter}`, q.count]),
			],
		);
		const text = JSON.stringify([read, counts]);
		for (const absent of ["CONVERSATION-CANARY", ANA_NOTE.slice(0, 20), "Casey", "Jordan", "Dana"])
			assert.ok(!text.includes(absent), `${name} reads no ${absent}`);
	}
	assert.deepEqual((await invokeRead(db, who.hill, readGoals as never, {})).rows, [], "another organization's goals");
});

test("INV-evry-goals: a goal is added and changed through a review card that keeps unnamed fields and matches the page's save", async () => {
	const today = (await goals()).asOf;
	const added = await r.prepare(who.luis, "pipeline.saveGoal", {
		leaderTarget: 3,
		plantTarget: 1,
		targetYear: 2031,
		rationale: "A third service is full.",
	});
	assert.deepEqual(added.review.target?.label, "New sending goal");
	assert.deepEqual(
		added.review.changes.map((c) => [c.field, c.before, c.after]),
		[
			["leaderTarget", null, 3],
			["plantTarget", null, 1],
			["targetYear", null, "2031"],
			["rationale", null, "A third service is full."],
			["countingFrom", null, dayText(today)],
		],
	);
	assert.equal((await goals()).goals.length, 1, "nothing is saved before approval");
	completed(await r.approve(who.luis, added));
	assert.equal(await r.replayed(who.luis, added), true);
	const saved = (await goals()).goals.find((g) => g.targetYear === 2031)!;
	assert.equal((await goals()).goals.length, 2, "a replay adds nothing");
	assert.deepEqual(
		[saved.leaderTarget, saved.plantTarget, saved.countingFrom, saved.counts],
		[3, 1, today, []],
		"a new goal counts from today, as the page's form does",
	);

	const edit = await r.prepare(who.dana, "pipeline.saveGoal", {
		goalId: saved.id,
		plantTarget: 2,
		counts: [{ kind: "commissioned", label: "Leaders sent" }],
	});
	assert.deepEqual(edit.review.changes, [
		{ field: "plantTarget", before: 1, after: 2 },
		{ field: "goalCounts", before: [], after: ["Leaders sent, reached Commissioned"] },
	]);
	completed(await r.approve(who.dana, edit));
	const after = (await goals()).goals.find((g) => g.id === saved.id)!;
	assert.deepEqual(
		{ ...after, revision: saved.revision, counts: saved.counts },
		{ ...saved, plantTarget: 2 },
		"unnamed fields stay",
	);

	const stale = await r.prepare(who.dana, "pipeline.saveGoal", { goalId: saved.id, leaderTarget: 9 });
	ok(
		await pipelineWriter.saveGoal(db, await authority("luis"), {
			goalId: saved.id,
			expectedRevision: after.revision,
			leaderTarget: 4,
			plantTarget: 2,
			targetYear: 2031,
			rationale: after.rationale,
			countingFrom: after.countingFrom,
			counts: [],
		}),
	);
	refusedAs(await r.approve(who.dana, stale), "revision_conflict");
	assert.equal((await goals()).goals.find((g) => g.id === saved.id)!.leaderTarget, 4);

	await r.refusedCard(
		who.dana,
		"pipeline.saveGoal",
		{ goalId: saved.id, countingFrom: addDays(today, 1) },
		"The counting-from date can't be after today, so there is nothing to approve.",
	);
	await r.refusedCard(
		who.dana,
		"pipeline.saveGoal",
		{ goalId: saved.id, leaderTarget: 4 },
		"The goal already says this, so nothing would change.",
	);
	await r.refuses(
		who.dana,
		"pipeline.saveGoal",
		{ leaderTarget: 1, plantTarget: 1, targetYear: 2030 },
		"invalid_input",
	);
	for (const name of ["ana", "ben"] as const)
		await r.refuses(who[name], "pipeline.saveGoal", { goalId: saved.id, leaderTarget: 1 }, "access_denied");
	await r.refuses(who.hill, "pipeline.saveGoal", { goalId: saved.id, leaderTarget: 1 }, "not_found");
});

test("AC:ADR1-008 stages are renamed, added, reordered and removed through one card, matching the stage editor, and no person moves", async () => {
	const before = await board();
	const at = (label: string) => before.stages.find((s) => s.label === label)!;
	const keep = (label: string, rename?: string) => ({ stageId: at(label).id, label: rename ?? label });
	const placed = async () =>
		(await admin.execute(sql`SELECT person_id,stage_id FROM pipeline_person ORDER BY person_id`)).rows;
	const people = await placed();
	const all = ["Potential leader", "Apprentice", "Resident", "Commissioned", "Not continuing"];

	await r.refusedCard(
		who.dana,
		"pipeline.saveStages",
		{ stages: all.filter((l) => l !== "Apprentice").map((l) => keep(l)), remove: [at("Apprentice").id] },
		"Apprentice still has 1 person, so it can't be removed. Move or remove them first. Retired people count too.",
	);
	await r.refusedCard(
		who.dana,
		"pipeline.saveStages",
		{ stages: all.map((l) => (l === "Resident" ? { ...keep(l), kind: "other" } : keep(l))) },
		"Resident counts as Resident, and a stage's kind can't change. Add a new stage instead.",
	);
	await r.refusedCard(
		who.dana,
		"pipeline.saveStages",
		{ stages: all.map((l) => (l === "Resident" ? keep(l, "apprentice") : keep(l))) },
		"Two stages would be called apprentice. Each stage needs its own name.",
	);
	await r.refusedCard(
		who.dana,
		"pipeline.saveStages",
		{ stages: all.map((l) => keep(l)) },
		"The stages are already like this, so nothing would change.",
	);
	await r.refuses(who.dana, "pipeline.saveStages", { stages: all.slice(1).map((l) => keep(l)) }, "invalid_input");
	for (const name of ["ana", "ben"] as const)
		await r.refuses(who[name], "pipeline.saveStages", { stages: all.map((l) => keep(l)) }, "access_denied");
	await r.refuses(who.hill, "pipeline.saveStages", { stages: all.map((l) => keep(l)) }, "invalid_input");

	const card = await r.prepare(who.luis, "pipeline.saveStages", {
		stages: [
			keep("Potential leader"),
			keep("Resident", "Church planting resident"),
			keep("Apprentice"),
			{ label: "Assessed" },
			keep("Commissioned"),
		],
		remove: [at("Not continuing").id],
	});
	assert.deepEqual(card.review.changes, [
		{ field: "renamedStages", before: ["Resident"], after: ["Church planting resident"] },
		{ field: "addedStages", before: null, after: ["Assessed, counted as Other"] },
		{ field: "removedStages", before: ["Not continuing"], after: null },
		{
			field: "stageOrder",
			before: all,
			after: ["Potential leader", "Church planting resident", "Apprentice", "Assessed", "Commissioned"],
		},
	]);
	const stale = await r.prepare(who.dana, "pipeline.saveStages", {
		stages: all.map((l) => (l === "Resident" ? keep(l, "Intern") : keep(l))),
	});
	completed(await r.approve(who.luis, card));
	assert.equal(await r.replayed(who.luis, card), true);
	const after = await board();
	assert.deepEqual(
		after.stages.map((s) => [s.label, s.kind]),
		[
			["Potential leader", "potential_leader"],
			["Church planting resident", "resident"],
			["Apprentice", "apprentice"],
			["Assessed", "other"],
			["Commissioned", "commissioned"],
		],
	);
	assert.equal(after.stages[1]!.id, at("Resident").id);
	assert.deepEqual(await placed(), people, "no person moves");
	refusedAs(await r.approve(who.dana, stale), "revision_conflict");

	const raced = await r.prepare(who.dana, "pipeline.saveStages", {
		stages: after.stages.filter((s) => s.label !== "Assessed").map((s) => ({ stageId: s.id, label: s.label })),
		remove: [after.stages[3]!.id],
	});
	const jordan = ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.jordan }));
	const move = async (expectedRevision: string, stageId: string) =>
		ok(
			await pipelineWriter.movePerson(db, await authority("dana"), {
				personId: PEOPLE.jordan,
				expectedRevision,
				stageId,
				reason: "Assessed this week.",
			}),
		) as { revision: string };
	const moved = await move(jordan.revision, after.stages[3]!.id);
	refusedAs(await r.approve(who.dana, raced), "stage_occupied");
	assert.equal((await board()).stages.length, 5, "an occupied stage stays");
	await move(moved.revision, after.stages[0]!.id);
});

const START = "2026-02-02";
const END = "2027-08-31";
const enrolled = new Map<string, string>();

test("AC:ADR1-011 an Owner or Admin enrolls a live pipeline person through a review card, matching the Programs screen", async () => {
	const p = await program("dana");
	const read = await invokeRead(db, who.dana, programRead as never, { programId: p.id, enrolled: true });
	assert.deepEqual(
		read.rows.filter((x) => x.fields.part === "candidate").map((x) => [x.id, x.label]),
		p.people.map((x) => [x.personId, x.name]),
	);
	const input = {
		programId: p.id,
		personId: PEOPLE.sam,
		cohort: "Spring cohort",
		startedOn: START,
		expectedEndOn: END,
		nextMeetingAt: "2026-12-01T19:00:00",
	};
	const card = await r.prepare(who.luis, "development.enroll", input);
	assert.deepEqual([card.review.target?.kind, card.review.target?.label], ["person", "Sam Patel"]);
	assert.deepEqual(
		card.review.changes.map((c) => [c.field, c.after]),
		[
			["program", "Church planting residency, Version 1"],
			["cohort", "Spring cohort"],
			["startedOn", "Feb 2, 2026"],
			["expectedEndOn", "Aug 31, 2027"],
			["programStage", "Assimilating"],
			["nextMeeting", "Tue, Dec 1, 2026, 7:00 PM (America/Chicago)"],
		],
	);
	assert.equal((await program("dana")).enrollments.length, 1);
	const twin = await r.prepare(who.dana, "development.enroll", input);
	completed(await r.approve(who.luis, card));
	assert.equal(await r.replayed(who.luis, card), true);
	refusedAs(await r.approve(who.dana, twin), "already_enrolled");
	const now = await program("dana");
	assert.equal(now.enrollments.length, 2);
	const sam = now.enrollments.find((e) => e.personId === PEOPLE.sam)!;
	enrolled.set("sam", sam.id);
	const viaEvry = await enrollment("ana", sam.id);
	const nativeId = randomUUID();
	ok(
		await programWriter.enroll(db, await authority("dana"), {
			...input,
			personId: PEOPLE.jordan,
			enrollmentId: nativeId,
			stageId: now.published!.stages[0]!.id,
		}),
	);
	enrolled.set("jordan", nativeId);
	const viaScreen = await enrollment("ana", nativeId);
	assert.deepEqual(
		{ ...viaEvry, id: nativeId, person: viaScreen.person },
		viaScreen,
		"the same enrollment as the screen makes",
	);
	assert.deepEqual(
		(await audits("development.enrolled", sam.id)).map((a) => a.metadata),
		[{ programId: p.id }],
	);

	await r.refusedCard(
		who.dana,
		"development.enroll",
		input,
		"Sam Patel is already enrolled in Church planting residency. Each person can have one active enrollment per program.",
	);
	const draftId = randomUUID();
	ok(
		await programWriter.createProgram(db, await authority("dana"), {
			programId: draftId,
			kind: "apprenticeship",
			name: "Draft apprenticeship",
			directorSeatId: seeded.anaSeat,
			plan: { rhythm: "monthly", expectedMonths: 12, stages: [], milestones: [], readings: [] },
		}),
	);
	await r.refusedCard(
		who.dana,
		"development.enroll",
		{ ...input, programId: draftId },
		"Draft apprenticeship has no published version yet. Its director publishes it from Programs before anyone is enrolled.",
	);
	await r.refuses(who.dana, "development.enroll", { ...input, personId: PEOPLE.morgan }, "not_found");
	await r.refuses(who.hill, "development.enroll", { ...input, personId: PEOPLE.morgan }, "not_found");
	for (const name of ["ana", "ben"] as const) await r.refuses(who[name], "development.enroll", input, "access_denied");
});

test("INV-privacy: the enrollment read shows what the seat's Programs screen shows, never feedback, notes or progress a resident keeps private", async () => {
	const e = await enrollment();
	ok(
		await programWriter.recordMilestone(db, await authority("ana"), {
			enrollmentId: enrolled.get("jordan")!,
			milestoneId: e.milestones[1]!.id,
			completedOn: START,
		}),
	);
	for (const name of ["dana", "luis", "ana"] as const) {
		const page = await enrollment(name);
		const read = await invokeRead(db, who[name], programRead as never, { enrollmentId: page.id });
		assert.deepEqual(
			read.rows.map((x) => [x.fields.part, x.id, x.label]),
			[
				...page.stages.map((s) => ["stage", s.id, s.label]),
				...page.milestones.map((m) => ["milestone", m.id, m.title]),
			],
		);
		assert.deepEqual(
			[read.facts?.directedByYou, read.facts?.cohort, read.facts?.stage, read.facts?.account],
			[name === "ana", page.cohort, page.stage.label, "Not linked"],
		);
		const progress = read.rows.filter((x) => x.fields.part === "milestone").map((x) => x.fields.progress);
		assert.deepEqual(progress, [
			`Finished ${dayText(page.milestones[0]!.completion!.completedOn)}`,
			"Not finished",
			"Not finished",
		]);
	}
	const ben = await invokeRead(db, who.ben, programRead as never, { enrollmentId: e.id });
	assert.equal(ben.status, "not_found");
	const benList = await invokeRead(db, who.ben, programRead as never, {
		programId: seeded.residency.programId,
		enrolled: true,
	});
	assert.ok(!benList.rows.some((x) => ["enrollment", "candidate"].includes(String(x.fields.part))));
	const hill = await invokeRead(db, who.hill, programRead as never, { enrollmentId: e.id });
	assert.equal(hill.status, "not_found");
});

test("AC:ADR1-011 the current director updates an enrollment: unnamed fields, the version, completions and the pipeline stage stay", async () => {
	const before = await enrollment();
	const stage = before.stages[1]!;
	const op = "development.updateEnrollment";
	const card = await r.prepare(who.ana, op, {
		enrollmentId: before.id,
		changes: { cohort: "Winter cohort", stageId: stage.id, nextMeetingAt: "2026-12-03T09:30:00" },
	});
	assert.deepEqual(card.review.changes, [
		{ field: "cohort", before: "Fall cohort", after: "Winter cohort" },
		{ field: "programStage", before: "Assimilating", after: "Training and planning" },
		{ field: "nextMeeting", before: null, after: "Thu, Dec 3, 2026, 9:30 AM (America/Chicago)" },
	]);
	const stale = await r.prepare(who.ana, op, { enrollmentId: before.id, changes: { cohort: "Stale cohort" } });
	const pipelineStage = async () =>
		ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: PEOPLE.casey })).stage;
	const placed = await pipelineStage();
	completed(await r.approve(who.ana, card));
	assert.equal(await r.replayed(who.ana, card), true);
	const after = await enrollment();
	assert.deepEqual(after, {
		...before,
		revision: String(Number(before.revision) + 1),
		cohort: "Winter cohort",
		stage: { id: stage.id, label: stage.label },
		nextMeeting: { at: "2026-12-03T09:30:00", timezone: "America/Chicago" },
	});
	assert.deepEqual(await pipelineStage(), placed);
	const [audit] = await audits("development.enrollment_updated", before.id);
	assert.deepEqual(audit, {
		actor_id: who.ana.accountId,
		before: Number(before.revision),
		after: Number(after.revision),
		metadata: { fields: ["cohort", "stage", "nextMeeting"] },
	});
	refusedAs(await r.approve(who.ana, stale), "revision_conflict");
	assert.equal((await enrollment()).cohort, "Winter cohort");

	const cleared = await r.prepare(who.ana, op, {
		enrollmentId: before.id,
		changes: { nextMeetingAt: null, expectedEndOn: addDays(before.expectedEndOn, 30) },
	});
	completed(await r.approve(who.ana, cleared));
	const last = await enrollment();
	assert.deepEqual([last.nextMeeting, last.expectedEndOn], [null, addDays(before.expectedEndOn, 30)]);

	await r.refusedCard(
		who.ana,
		op,
		{ enrollmentId: before.id, changes: { expectedEndOn: addDays(before.startedOn, -1) } },
		`The expected end can't be before the start, ${dayText(before.startedOn)}.`,
	);
	await r.refusedCard(
		who.ana,
		op,
		{ enrollmentId: before.id, changes: { cohort: "Winter cohort" } },
		"The enrollment already says this, so nothing would change.",
	);
	await r.refuses(who.ana, op, { enrollmentId: before.id, changes: { stageId: randomUUID() } }, "invalid_input");
	const input = { enrollmentId: before.id, changes: { cohort: "Other" } };
	for (const [name, code] of [
		["dana", "access_denied"],
		["luis", "access_denied"],
		["ben", "not_found"],
		["hill", "not_found"],
	] as const)
		await r.refuses(who[name], op, input, code);

	const handed = await r.prepare(who.ana, op, input);
	await admin.execute(sql`UPDATE development_program SET director_seat_id=(SELECT id FROM seat
		WHERE organization_id=${GRACE_AUSTIN} AND role='admin' AND ended_at IS NULL LIMIT 1) WHERE id=${seeded.residency.programId}`);
	refusedAs(await r.approve(who.ana, handed), "access_denied");
	await admin.execute(
		sql`UPDATE development_program SET director_seat_id=${seeded.anaSeat} WHERE id=${seeded.residency.programId}`,
	);
	assert.equal((await enrollment()).cohort, "Winter cohort");
});

test("AC:ADR1-012 the director records a milestone finished for someone with no linked account, with the finish date", async () => {
	const op = "development.completeMilestone";
	const e = await enrollment();
	const [, second, third] = e.milestones;
	const input = { enrollmentId: e.id, milestoneId: second!.id, completedOn: START };
	const card = await r.prepare(who.ana, op, input);
	assert.deepEqual(card.review.changes, [
		{ field: "milestone", before: null, after: second!.title },
		{ field: "milestoneProgress", before: "Not finished", after: "Finished Feb 2, 2026" },
	]);
	const late = await r.prepare(who.ana, op, { ...input, milestoneId: third!.id });
	completed(await r.approve(who.ana, card));
	const viaEvry = (await enrollment()).milestones[1]!.completion;
	const viaScreen = (await enrollment("ana", enrolled.get("jordan")!)).milestones[1]!.completion;
	assert.deepEqual(viaEvry, viaScreen, "the same completion as the screen records");
	await r.refusedCard(who.ana, op, input, "This milestone is already recorded as finished.");
	await r.refusedCard(
		who.ana,
		op,
		{ ...input, milestoneId: third!.id, completedOn: addDays(e.today, 1) },
		"The finish date can't be after today.",
	);
	for (const [name, code] of [
		["dana", "access_denied"],
		["ben", "not_found"],
		["hill", "not_found"],
	] as const)
		await r.refuses(who[name], op, input, code);
	await r.refuses(who.ana, op, { ...input, milestoneId: randomUUID() }, "not_found");

	caseyAccount = await linkResident(admin, PEOPLE.casey, "Casey Lee");
	refusedAs(await r.approve(who.ana, late), "linked_resident");
	assert.equal((await enrollment()).milestones[2]!.completion, null);
	await r.refusedCard(
		who.ana,
		op,
		{ ...input, milestoneId: third!.id },
		"Casey Lee has a linked account, so they mark this milestone themselves on My residency.",
	);
});

let caseyAccount = "";
const shareMilestones = (shares: boolean) =>
	admin.execute(sql`UPDATE residency_link SET share_milestones=${shares} WHERE person_id=${PEOPLE.casey}`);

test("AC:ADR1-012 the director confirms a milestone only when the linked resident marked it and shares it", async () => {
	const op = "development.confirmMilestone";
	const third = (await enrollment()).milestones[2]!;
	const input = { enrollmentId: seeded.residency.enrollmentId, milestoneId: third.id };
	await r.refusedCard(
		who.ana,
		op,
		input,
		"Casey Lee hasn't marked this milestone done yet. They mark it on My residency.",
	);
	await markMilestone(admin, input.enrollmentId, third.title, caseyAccount, START);
	await shareMilestones(false);
	await r.refusedCard(
		who.ana,
		op,
		input,
		"Casey Lee doesn't share milestone progress, so there is nothing to confirm here.",
	);
	const hidden = await invokeRead(db, who.ana, programRead as never, { enrollmentId: input.enrollmentId });
	const rowOf = (read: typeof hidden) => read.rows.find((x) => x.id === third.id)!.fields.progress;
	assert.equal(rowOf(hidden), "Progress not shared");
	await shareMilestones(true);
	const shown = await invokeRead(db, who.ana, programRead as never, { enrollmentId: input.enrollmentId });
	assert.match(String(rowOf(shown)), /^Waiting for confirmation, Casey Lee marked it done Feb 2, 2026$/);

	const card = await r.prepare(who.ana, op, input);
	assert.deepEqual(card.review.changes, [
		{ field: "milestone", before: null, after: third.title },
		{ field: "milestoneProgress", before: "Marked done Feb 2, 2026", after: "Confirmed by you" },
	]);
	await shareMilestones(false);
	refusedAs(await r.approve(who.ana, card), "access_denied");
	await shareMilestones(true);
	const again = await r.prepare(who.ana, op, input);
	completed(await r.approve(who.ana, again));
	const done = (await enrollment()).milestones[2]!.completion!;
	assert.deepEqual(
		[done.source, done.recorder, done.confirmer, done.completedOn],
		["resident", "Casey Lee", "Ana Ruiz", START],
	);
	assert.equal(
		(await audits("development.milestone_confirmed", input.enrollmentId)).length,
		1,
		"one confirmation, as the screen's Confirm writes",
	);
	await r.refusedCard(who.ana, op, input, "This milestone is already confirmed.");
	await r.refusedCard(
		who.ana,
		op,
		{ enrollmentId: enrolled.get("sam")!, milestoneId: third.id },
		"Sam Patel has no linked account, so there is nothing to confirm. Record the milestone as finished instead.",
	);
	for (const [name, code] of [
		["dana", "access_denied"],
		["ben", "not_found"],
		["hill", "not_found"],
	] as const)
		await r.refuses(who[name], op, input, code);
});

test("AC:ADR1-011 the director applies the current version to one person from a card that shows the added, removed and changed work", async () => {
	const op = "development.applyVersion";
	const p = await program();
	const v1 = p.published!;
	await r.refusedCard(
		who.ana,
		op,
		{ enrollmentId: seeded.residency.enrollmentId },
		"Casey Lee is already on Version 1, the current one.",
	);
	ok(
		await programWriter.savePlan(db, await authority("ana"), {
			programId: p.id,
			expectedRevision: p.revision,
			plan: {
				rhythm: v1.rhythm,
				expectedMonths: v1.expectedMonths,
				stages: v1.stages.map((s) => ({ label: s.label, minMonths: s.minMonths, maxMonths: s.maxMonths })),
				milestones: [
					{ ...pick(v1.milestones[0]!), title: "Start a small group and send it" },
					pick(v1.milestones[2]!),
					{ lineage: randomUUID(), title: "Lead a vision night", description: null, handsOn: false },
				],
				readings: v1.readings.map((x) => ({ revisionId: x.revisionId })),
			},
		}),
	);
	ok(
		await programWriter.publishVersion(db, await authority("ana"), {
			programId: p.id,
			expectedRevision: (await program()).revision,
		}),
	);
	const enrollmentId = enrolled.get("sam")!;
	const before = await enrollment("ana", enrollmentId);
	const native = ok(await readVersionReview(db, await authority("ana"), { enrollmentId }));
	const stale = await r.prepare(who.ana, op, { enrollmentId });
	assert.deepEqual(stale.review.changes, [
		{ field: "programVersion", before: "Version 1", after: "Version 2" },
		{ field: "programStage", before: native.stage, after: "Assimilating" },
		{ field: "addedMilestones", before: null, after: native.added.map((m) => m.title) },
		{
			field: "changedMilestones",
			before: native.changed.map((c) => c.before.title),
			after: native.changed.map((c) => c.after.title),
		},
		{ field: "removedMilestones", before: native.removed.map((m) => m.title), after: null },
	]);
	ok(
		await programWriter.recordMilestone(db, await authority("ana"), {
			enrollmentId,
			milestoneId: before.milestones[0]!.id,
			completedOn: START,
		}),
	);
	refusedAs(await r.approve(who.ana, stale), "stale_review");
	assert.equal((await enrollment("ana", enrollmentId)).versionNumber, 1);

	const card = await r.prepare(who.ana, op, { enrollmentId, stageId: native.stages[1]!.id });
	assert.ok(card.review.notes!.some((n) => n === "Finished work kept: Start a small group and send it."));
	completed(await r.approve(who.ana, card));
	assert.equal(await r.replayed(who.ana, card), true);
	const jordan = enrolled.get("jordan")!;
	const jordanReview = ok(await readVersionReview(db, await authority("ana"), { enrollmentId: jordan }));
	ok(
		await programWriter.applyVersion(db, await authority("ana"), {
			enrollmentId: jordan,
			versionId: jordanReview.versionId,
			stageId: jordanReview.stages[1]!.id,
			basis: jordanReview.basis,
		}),
	);
	const after = await enrollment("ana", enrollmentId);
	const screen = await enrollment("ana", jordan);
	assert.deepEqual(
		[after.versionNumber, after.stage, after.milestones.map((m) => m.title)],
		[screen.versionNumber, screen.stage, screen.milestones.map((m) => m.title)],
		"the same version and stage the screen applies",
	);
	assert.deepEqual(after.milestones[0]!.completion?.completedOn, START, "finished work carries over");
	assert.equal((await audits("development.version_applied", enrollmentId)).length, 1);
	assert.equal((await enrollment()).versionNumber, 1, "only the one person moves");
	await r.refuses(
		who.ana,
		op,
		{ enrollmentId: seeded.residency.enrollmentId, stageId: v1.stages[0]!.id },
		"invalid_input",
	);
	for (const [name, code] of [
		["dana", "access_denied"],
		["ben", "not_found"],
		["hill", "not_found"],
	] as const)
		await r.refuses(who[name], op, { enrollmentId: seeded.residency.enrollmentId }, code);
});
const pick = (m: { lineage: string; title: string; description: string | null; handsOn: boolean }) => ({
	lineage: m.lineage,
	title: m.title,
	description: m.description,
	handsOn: m.handsOn,
});

async function newlyEnrolled(displayName: string) {
	const [personId, enrollmentId] = [randomUUID(), randomUUID()];
	const stageId = (await board()).stages[0]!.id;
	ok(
		await pipelineWriter.addPerson(db, await authority("dana"), {
			personId,
			displayName,
			email: null,
			responsibleSeatId: null,
			stageId,
		}),
	);
	const p = await program("dana");
	ok(
		await programWriter.enroll(db, await authority("dana"), {
			enrollmentId,
			programId: p.id,
			personId,
			cohort: "Ending cohort",
			startedOn: "2026-10-01",
			expectedEndOn: "2028-10-01",
			stageId: p.published!.stages[0]!.id,
			nextMeetingAt: "2026-12-03T09:30:00",
		}),
	);
	return { personId, before: await enrollment("ana", enrollmentId) };
}

for (const [outcome, label, words] of [
	["completed", "Completed", "has ended as Completed"],
	["withdrawn", "Withdrawn", "has ended as Withdrawn"],
] as const)
	test(`AC:ADR1-011 the current director's approved card ends an enrollment as ${outcome} as the page does, once`, async () => {
		const op = "development.updateEnrollment";
		const asked = await newlyEnrolled(`Evry ${label}`);
		const page = await newlyEnrolled(`Page ${label}`);
		const id = asked.before.id;
		const place = async () =>
			ok(await readPipelinePersonRecord(db, await authority("dana"), { personId: asked.personId })).stage;
		const placed = await place();
		const card = await r.prepare(who.ana, op, { enrollmentId: id, outcome });
		assert.deepEqual(card.review, {
			target: {
				kind: "person",
				id: asked.personId,
				label: `Evry ${label}`,
				href: `/organization/pipeline/programs/enrollments/${id}`,
			},
			changes: [{ field: "status", before: "Active", after: label }],
			notes: [
				`${asked.before.program.name}, Version ${asked.before.versionNumber}.`,
				"An ended enrollment cannot be changed or reopened.",
				"Its milestones and feedback stay in the record.",
				"Their pipeline stage does not change.",
			],
		});
		assert.deepEqual(await enrollment("ana", id), asked.before);
		const late = await r.prepare(who.ana, op, { enrollmentId: id, outcome });
		completed(await r.approve(who.ana, card));
		assert.equal(await r.replayed(who.ana, card), true);
		ok(
			await programWriter.endEnrollment(db, await authority("ana"), {
				enrollmentId: page.before.id,
				expectedRevision: page.before.revision,
				outcome,
			}),
		);
		const own = <T extends { id: string; person: unknown }>({ id: _id, person: _person, ...rest }: T) => rest;
		const after = await enrollment("ana", id);
		assert.deepEqual(after, {
			...asked.before,
			status: outcome,
			revision: String(Number(asked.before.revision) + 1),
		});
		assert.deepEqual(own(after), own(await enrollment("ana", page.before.id)));
		assert.deepEqual(await place(), placed);
		const audit = await audits("development.enrollment_updated", id);
		assert.equal(audit.length, 1);
		assert.deepEqual(audit, await audits("development.enrollment_updated", page.before.id));
		assert.deepEqual(audit[0]?.metadata, { fields: ["status"], outcome });

		refusedAs(await r.approve(who.ana, late), "enrollment_ended");
		const ended = `Evry ${label}'s enrollment in ${after.program.name} ${words}, so it can't change.`;
		await r.refusedCard(who.ana, op, { enrollmentId: id, outcome }, ended);
		await r.refusedCard(who.ana, op, { enrollmentId: id, changes: { cohort: "Late" } }, ended);
		await r.refusedCard(who.ana, "development.applyVersion", { enrollmentId: id }, ended);
		const milestoneId = after.milestones[0]!.id;
		await r.refusedCard(who.ana, "development.confirmMilestone", { enrollmentId: id, milestoneId }, ended);
		await r.refusedCard(
			who.ana,
			"development.completeMilestone",
			{ enrollmentId: id, milestoneId, completedOn: "2026-10-02" },
			ended,
		);
		const read = await invokeRead(db, who.ana, programRead as never, { enrollmentId: id });
		assert.equal(read.facts?.status, label);
		assert.equal((await audits("development.enrollment_updated", id)).length, 1);
	});

test("AC:ADR1-011 Evry prepares no end for anyone but the current director, and a change or a new director after the card refuses it", async () => {
	const op = "development.updateEnrollment";
	const { before } = await newlyEnrolled("Evry Refused");
	const input = { enrollmentId: before.id, outcome: "withdrawn" };
	for (const [name, code] of [
		["dana", "access_denied"],
		["luis", "access_denied"],
		["ben", "not_found"],
		["hill", "not_found"],
	] as const)
		await r.refuses(who[name], op, input, code);
	const seen = await invokeRead(db, who.dana, programRead as never, { enrollmentId: before.id });
	assert.deepEqual([seen.facts?.directedByYou, seen.facts?.director], [false, "Ana Ruiz"]);
	for (const bad of [
		{ enrollmentId: before.id },
		{ ...input, changes: { cohort: "Both" } },
		{ ...input, outcome: "active" },
		{ ...input, outcome: "paused" },
	])
		await r.refuses(who.ana, op, bad, "invalid_input");

	const handed = await r.prepare(who.ana, op, input);
	await admin.execute(sql`UPDATE development_program SET director_seat_id=(SELECT id FROM seat
		WHERE organization_id=${GRACE_AUSTIN} AND role='admin' AND ended_at IS NULL LIMIT 1) WHERE id=${seeded.residency.programId}`);
	refusedAs(await r.approve(who.ana, handed), "access_denied");
	await admin.execute(
		sql`UPDATE development_program SET director_seat_id=${seeded.anaSeat} WHERE id=${seeded.residency.programId}`,
	);

	const stale = await r.prepare(who.ana, op, input);
	ok(
		await programWriter.updateEnrollment(db, await authority("ana"), {
			enrollmentId: before.id,
			expectedRevision: before.revision,
			changes: { cohort: "Changed first" },
		}),
	);
	refusedAs(await r.approve(who.ana, stale), "revision_conflict");
	assert.equal((await enrollment("ana", before.id)).status, "active");
});

test("INV-evry-pipeline-tools: each seat kind is offered the pipeline and program writes its pages give it, and never publishing a version", async () => {
	const directed = [
		"development.draftNextVersion",
		"development.updateEnrollment",
		"development.applyVersion",
		"development.confirmMilestone",
		"development.completeMilestone",
	];
	for (const name of ["dana", "luis"] as const) {
		const offered = readCatalog(who[name]).reviewedWrites.map((w) => w.operation);
		for (const op of [...directed, "pipeline.saveGoal", "pipeline.saveStages", "development.enroll"])
			assert.ok(offered.includes(op as never), `${name} ${op}`);
		assert.ok(!offered.includes("development.publishVersion" as never));
	}
	for (const name of ["ana", "ben"] as const)
		assert.deepEqual(
			readCatalog(who[name]).reviewedWrites.map((w) => w.operation),
			["settings.saveSection", "account.removeAvatar", ...directed],
		);
});
