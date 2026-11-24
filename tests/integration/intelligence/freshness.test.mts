import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { instant } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	createPrivateCare,
	createSignals,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import {
	createAttendanceWriter,
	meetingsWriter,
	withMeetingsWrite,
	type MeetingsContext,
} from "../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	commitments,
	executeBulkImport,
	peopleCsv,
	peopleMerge,
	peopleReader,
	peopleWriter,
} from "../../../packages/domain/src/people/index.ts";
import { teamsWriter } from "../../../packages/domain/src/teams/index.ts";
import { runDueImports } from "../../../apps/web/src/features/people/import-export/run-imports.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok, refused } from "../../support/fixture.mts";
import { church, ZONE, type Church, type ChurchPlant } from "./assessment-church.mts";

const DAY = 86_400_000;
let c0: Church;
const job = createAssessmentJob();
const assessments = createAssessments();
const facts = createFacts();
const key = () => randomUUID();

before(async () => {
	c0 = await church("t625f");
	await c0.release("methodology-2026.11");
});
after(() => c0?.database.close());

const viewOf = async (p: ChurchPlant) => ok(await assessments.readAssessment(c0.db, p.actor, {}));
async function outOfDate(p: ChurchPlant, reader = facts) {
	const current = (await viewOf(p)).current;
	assert.ok(current, "the assessment stays readable");
	const { outOfDateRunId } = ok(await reader.readFactsSinceRun(c0.db, p.actor, {}));
	if (outOfDateRunId !== null) assert.equal(outOfDateRunId, current.runId);
	return outOfDateRunId !== null;
}
async function assess(p: ChurchPlant) {
	ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: key() }));
	await runAssessmentBatch(job, c0.db, scriptedAssessmentDrafter(), 5);
	const v = await viewOf(p);
	assert.ok(v.current && !v.newest);
	assert.equal(await outOfDate(p), false, "a new assessment is fresh");
	return v.current;
}
const later = (days: number) =>
	createFacts({ clock: { now: () => instant.parse(new Date(Date.now() + days * DAY).toISOString()) } });

type Person = { id: string };
const people = <T,>(p: ChurchPlant, op: (tx: WriteTx, ctx: never, raw: never) => Promise<T>, raw: unknown) =>
	gatedTransaction(c0.db, (tx) => op(tx, p.ctx as never, raw as never));
const meeting = <T,>(
	p: ChurchPlant,
	op: (tx: WriteTx, ctx: MeetingsContext, raw: unknown) => Promise<T>,
	raw: unknown,
) => withMeetingsWrite(c0.db, p.actor, (tx, ctx) => op(tx, ctx, raw) as never) as Promise<T>;
const unplanned = async (): Promise<never> => {
	throw Error("unexpected task reminder replan");
};
const attendance = createAttendanceWriter({ reminders: unplanned });
const revision = async (table: "person" | "commitment" | "team_role" | "meeting", id: string) =>
	(await c0.one<{ r: string }>(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`)).r;
const cardOf = async (who: Person) =>
	(await c0.one<{ id: string }>(sql`SELECT id FROM commitment WHERE person_id=${who.id}`)).id;
const commit = (p: ChurchPlant, who: Person, requestKey: string = key()) =>
	people(p, commitments.createCommitment, {
		requestKey,
		input: { personId: who.id, kind: "core_group", occurredOn: c0.day(-1) },
	});
async function changeStage(p: ChurchPlant, who: Person, stage: string) {
	return gatedTransaction(c0.db, async (tx) =>
		peopleWriter.changeStatus(
			tx,
			p.ctx as never,
			{
				requestKey: key(),
				expectedRevision: await revision("person", who.id),
				input: { personId: who.id, stage, reason: "Moved on the board", handoffs: [] },
			} as never,
			unplanned,
		),
	);
}
async function scheduled(p: ChurchPlant, inDays: number) {
	return ok(
		await meeting(p, meetingsWriter.schedule, {
			requestKey: key(),
			input: { type: "vision_meeting", date: c0.day(inDays), time: "09:00" },
		}),
	).meeting;
}
async function complete(p: ChurchPlant, meetingId: string) {
	for (const to of ["in_progress", "completed"])
		ok(
			await meeting(p, meetingsWriter.changeStatus, {
				requestKey: key(),
				expectedRevision: await revision("meeting", meetingId),
				input: { meetingId, to },
			}),
		);
}
async function church30(name: string) {
	const p = await c0.plant(name);
	const adults: Person[] = [];
	for (let i = 0; i < 30; i++)
		adults.push(await c0.committed(p, `${name} ${String(i + 1).padStart(2, "0")}`, i === 0 ? 5 : 60));
	return { p, adults };
}
async function importPeople(p: ChurchPlant, text: string) {
	const file = new TextEncoder().encode(text);
	const preview = ok(await people(p, peopleCsv.previewImport as never, { file })) as {
		fileDigest: string;
		reviewDigest: string;
		rows: { row: number }[];
	};
	const requestKey = key();
	ok(
		await executeBulkImport(c0.db, p.actor, {
			requestKey,
			file,
			fileDigest: preview.fileDigest,
			reviewDigest: preview.reviewDigest,
			choices: preview.rows.map((r) => ({ row: r.row, choice: "create" })),
		}),
	);
	await runDueImports(c0.db, 10);
	return (await c0.one<Person>(sql`SELECT e.subject_id AS id FROM audit_event e WHERE e.tenant_id=${p.id}
		AND e.metadata ? 'import' ORDER BY e.recorded_at DESC LIMIT 1`))!;
}

test("INV-freshness: an attendance mark, a commitment stage move, an imported person's commitment, a correction, a merge and a removal each mark the assessment out of date before any new run", async () => {
	const { p, adults } = await church30("Marked");
	const older = await c0.vision(p, 10, adults.slice(0, 8));
	const newcomer = await c0.person(p, "Stage Mover");
	const twin = await c0.committed(p, "Marked 02 twin", 30);

	const changes: [string, () => Promise<unknown>][] = [
		[
			"an attendance mark",
			async () =>
				ok(
					await meeting(p, attendance.checkIn, {
						requestKey: key(),
						input: { meetingId: older, personId: adults[9]!.id },
					}),
				),
		],
		[
			"a stage move that changes commitment",
			async () => {
				const signed = ok(await commit(p, newcomer));
				assert.equal((signed as { person: { stage: string } }).person.stage, "core_group");
			},
		],
		[
			"an import",
			async () => {
				const imported = await importPeople(p, "first_name,last_name\r\nImogen,Imported\r\n");
				assert.equal(await outOfDate(p), false, "an imported contact alone is no assessment input");
				ok(await commit(p, imported));
			},
		],
		[
			"a correction",
			async () => {
				const card = await cardOf(adults[4]!);
				ok(
					await people(p, commitments.correctCommitmentLifecycle, {
						requestKey: key(),
						expectedRevision: await revision("commitment", card),
						input: {
							commitmentId: card,
							correction: { action: "correct", occurredOn: c0.day(-50) },
							reason: "Wrong date on the card",
						},
					}),
				);
			},
		],
		[
			"a merge",
			async () => {
				const pair = { sourceId: twin.id, survivorId: adults[1]!.id };
				const review = ok(await people(p, peopleMerge.getMergeReview as never, pair)) as { reviewDigest: string };
				ok(
					await people(p, peopleMerge.mergePeople as never, {
						requestKey: key(),
						input: { ...pair, reviewDigest: review.reviewDigest, fieldChoices: {} },
					}),
				);
			},
		],
		[
			"a removal",
			async () => {
				const gone = adults[6]!;
				const { reviewRevision } = ok(
					await people(p, peopleReader.getStatusWarnings as never, { personId: gone.id }),
				) as { reviewRevision: string };
				ok(
					await gatedTransaction(c0.db, async (tx) =>
						peopleWriter.retirePerson(
							tx,
							p.ctx as never,
							{
								requestKey: key(),
								expectedRevision: await revision("person", gone.id),
								input: { personId: gone.id, reason: "Moved away", reviewRevision, handoffs: [] },
							} as never,
							unplanned,
						),
					),
				);
			},
		],
	];
	for (const [name, change] of changes) {
		const current = await assess(p);
		const runs = async () =>
			(await c0.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM assessment_run WHERE plant_id=${p.id}`)).n;
		const count = await runs();
		await change();
		assert.equal(await outOfDate(p), true, `${name} marks it out of date`);
		const after = (await viewOf(p)).current!;
		assert.deepEqual([after.runId, after.asOf], [current.runId, current.asOf], `${name}: the same result and as-of`);
		assert.equal(await runs(), count, `${name}: before any new run`);
	}
});

test("INV-freshness: a meeting held after the assessment marks it once its attendance is recorded, and a leader assigned on a later day marks it", async () => {
	const { p, adults } = await church30("Held Since");
	await c0.role(p, "worship", null);
	const role = await c0.one<{ id: string; team: string }>(
		sql`SELECT id,team_id AS team FROM team_role WHERE plant_id=${p.id}`,
	);
	const past = createAssessmentJob({
		clock: { now: () => instant.parse(new Date(Date.now() - 2 * DAY).toISOString()) },
	});
	async function assessedTwoDaysAgo() {
		const id = key();
		ok(await assessments.requestRefresh(c0.db, p.actor, { requestId: id }));
		await c0.admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '3 days'
			WHERE kind='assessment' AND producer_key=${"manual/" + id}`);
		assert.equal(await runAssessmentBatch(past, c0.db, scriptedAssessmentDrafter(), 1), 1);
		assert.equal(await outOfDate(p), false, "fresh two days on");
	}
	await assessedTwoDaysAgo();
	const held = await scheduled(p, -1);
	await complete(p, held.id);
	ok(
		await meeting(p, attendance.checkIn, { requestKey: key(), input: { meetingId: held.id, personId: adults[0]!.id } }),
	);
	assert.equal(await outOfDate(p), true, "held and attended since");
	ok(
		await meeting(p, attendance.clearAttendance, {
			requestKey: key(),
			input: { meetingId: held.id, personId: adults[0]!.id },
		}),
	);
	assert.equal(await outOfDate(p), false, "with no one there it is no input");

	ok(
		await people(p, teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await revision("team_role", role.id),
			input: { roleId: role.id, teamId: role.team, personId: adults[3]!.id },
		}),
	);
	assert.equal(await outOfDate(p), true, "the tenure starts after the assessment's day");
});

test("AC:ASMT-012 INV-freshness: a failed write, an exact retry, a no-op, an unread field, a stage label and a private check-in leave it fresh", async () => {
	const { p, adults } = await church30("Unmarked");
	const newcomer = await c0.person(p, "Retried Once");
	const requestKey = key();
	const signed = ok(await commit(p, newcomer, requestKey));
	await assess(p);

	refused(
		await people(p, commitments.createCommitment, {
			requestKey: key(),
			input: { personId: randomUUID(), kind: "core_group", occurredOn: c0.day(-1) },
		}),
		"unavailable",
	);
	assert.equal(await outOfDate(p), false, "a failed write");
	await assert.rejects(
		gatedTransaction(c0.db, async (tx) => {
			ok(
				await commitments.createCommitment(tx, p.ctx as never, {
					requestKey: key(),
					input: { personId: newcomer.id, kind: "launch_team", occurredOn: c0.day(-1) },
				}),
			);
			throw Error("injected after the write");
		}),
		/injected/,
	);
	assert.equal(await outOfDate(p), false, "a rolled-back write");
	assert.deepEqual(ok(await commit(p, newcomer, requestKey)), signed);
	assert.equal(await outOfDate(p), false, "an exact retry");

	const person = adults[2]!;
	const contact = await c0.person(p, "No Card Yet");
	const patch = async (fields: object) =>
		ok(
			await people(p, peopleWriter.updatePerson as never, {
				requestKey: key(),
				expectedRevision: await revision("person", contact.id),
				input: { personId: contact.id, patch: fields },
			}),
		);
	await patch({ city: "Waco" });
	assert.equal(await outOfDate(p), false, "a field the assessment does not read");
	await patch({ city: "Waco" });
	assert.equal(await outOfDate(p), false, "a real no-op");
	ok(
		await people(p, peopleWriter.addNote as never, {
			requestKey: key(),
			expectedRevision: await revision("person", person.id),
			input: { personId: person.id, body: "Moved to Waco" },
		}),
	);
	assert.equal(await outOfDate(p), false, "a note on a person it counts");
	ok(await changeStage(p, person, "launch_team"));
	assert.equal(await outOfDate(p), false, "a stage label alone");

	const care = createPrivateCare();
	const current = ok(await care.readCurrent(c0.db, p.actor, {}));
	ok(
		await care.save(c0.db, p.actor, {
			requestKey: key(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "steady", family: "strained", financial: "steady", pace: "strained" },
				note: "private",
			},
		}),
	);
	assert.equal(await outOfDate(p), false, "a private check-in");
});

test("INV-freshness: time alone never marks it: a quiet plant stays fresh as the attendance window moves, a scheduled meeting passes unheld and an early-completed one reaches its start", async () => {
	const { p, adults } = await church30("Quiet");
	await c0.vision(p, 26, adults.slice(0, 12));
	await c0.vision(p, 54, adults.slice(0, 12));
	await scheduled(p, 2);
	const early = await scheduled(p, 3);
	ok(
		await meeting(p, attendance.checkIn, {
			requestKey: key(),
			input: { meetingId: early.id, personId: adults[0]!.id },
		}),
	);
	await complete(p, early.id);
	await assess(p);
	const before = ok(await facts.readFacts(c0.db, p.actor, {}));
	for (const days of [1, 6, 40]) assert.equal(await outOfDate(p, later(days)), false, `${days} quiet days`);
	const moved = ok(await later(6).readFacts(c0.db, p.actor, {}));
	assert.notEqual(moved.sourceRevision, before.sourceRevision, "the records measured on a later day do differ");
	ok(await commit(p, await c0.person(p, "Joined At Last")));
	assert.equal(await outOfDate(p, later(6)), true, "a change on a later day still marks it");
});

test("INV-freshness: undoing a change clears the mark, Refresh publishes a fresh result, and only an Owner or Admin reads it", async () => {
	const { p } = await church30("Undone");
	const first = await assess(p);
	const signals = createSignals();
	const answer = async (value: "yes" | "not_yet") => {
		const row = await c0.rows<{ r: string }>(sql`SELECT revision::text AS r FROM attestation WHERE plant_id=${p.id}`);
		return row[0]
			? signals.correct(c0.db, p.actor, {
					requestKey: key(),
					expectedRevision: row[0].r,
					input: { key: "systems_tested", action: "set", value, reason: "Checked again" },
				})
			: signals.attest(c0.db, p.actor, {
					requestKey: key(),
					expectedRevision: "0",
					input: { key: "systems_tested", value },
				});
	};
	ok(await answer("yes"));
	assert.equal(await outOfDate(p), true);
	const second = await assess(p);
	assert.notEqual(second.runId, first.runId);
	assert.ok(Date.parse(second.asOf) > Date.parse(first.asOf), "Refresh shows the new as-of");

	const member = await c0.database.actor(p, "member", { account: { personal_timezone: ZONE } });
	const asMember = (await RequestActor.resolve(c0.db, member.session as never)) as RequestActor;
	refused(await facts.readFactsSinceRun(c0.db, asMember, {}), "access_denied");
	const other = await c0.plant("Never Assessed");
	assert.equal(ok(await facts.readFactsSinceRun(c0.db, other.actor, {})).outOfDateRunId, null);
});
