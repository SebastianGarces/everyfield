import test, { after } from "node:test";
import assert from "node:assert/strict";
import { captureFacts } from "../../../../../packages/domain/src/intelligence/facts.ts";
import { communicationWriter } from "../../../../../packages/domain/src/communication/index.ts";
import { createFollowUpWriter, followUpReader } from "../../../../../packages/domain/src/followups/index.ts";
import {
	attendanceReader,
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
} from "../../../../../packages/domain/src/meetings/index.ts";
import { readFeedPage } from "../../../../../packages/domain/src/notifications/index.ts";
import {
	commitments,
	executeBulkImport,
	peopleCsv,
	peopleMerge,
	peopleReader,
	peopleWriter,
	personFields,
	recordCorrections,
} from "../../../../../packages/domain/src/people/index.ts";
import { createTaskWriter, taskReader } from "../../../../../packages/domain/src/tasks/index.ts";
import {
	teamsReader,
	teamsWriter,
	trainingReader,
	trainingWriter,
} from "../../../../../packages/domain/src/teams/index.ts";
import { runDueImports } from "../../../../../apps/web/src/features/people/import-export/run-imports.ts";
import { personId as personIdValue } from "../../../../../packages/contracts/src/common/values.ts";
import { sql } from "../../../../../packages/db/src/query.ts";
import { ok, refused } from "../../../../support/fixture.mts";
import { caseOf, key, world, type Row } from "./support.mts";

const w = await world("wp091merge");
const { write, authority, P, ctx, tx, rows, one, insert, person, personRow, db } = w;
after(() => w.database.close());
const reminders = async () => undefined;
const attendance = createAttendanceWriter({ reminders });
const tasks = createTaskWriter({ reminders });
const followups = createFollowUpWriter({ reminders });
const meeting = (title: string, values: Row = {}) =>
	insert("meeting", {
		type: "vision_meeting",
		title,
		local_date: "2026-10-01",
		local_time: "18:00",
		timezone: "America/Chicago",
		starts_at: "2026-10-01T23:00:00Z",
		resolver_version: "1",
		status: "in_progress",
		attendance_revision: 1,
		...values,
	});
async function importOne(text: string) {
	const file = new TextEncoder().encode(text);
	const seen = ok(await tx((t) => peopleCsv.previewImport(t, ctx(), { file })));
	const requestKey = key();
	ok(
		await executeBulkImport(db, await authority(), {
			requestKey,
			file,
			fileDigest: seen.fileDigest,
			reviewDigest: seen.reviewDigest,
			choices: seen.rows.map((r) => ({ row: r.row, choice: "create" })),
		}),
	);
	await runDueImports(db, 10);
	const receipt = ok(await tx((t) => peopleCsv.getImportReceipt(t, ctx(), { requestKey })));
	assert.ok(receipt.status === "complete");
	const [row] = receipt.rows;
	assert.ok(row?.status === "created");
	return row.personId;
}
const invite = (meetingId: string, personId: string, inviterPersonId: string | null = null) =>
	write.meetings(guestsWriter.inviteGuest, { requestKey: key(), input: { meetingId, personId, inviterPersonId } });
const checkIn = (meetingId: string, personId: string) =>
	write.meetings(attendance.checkIn, { requestKey: key(), input: { meetingId, personId } });
const addNote = async (personId: string, body: string) =>
	ok(
		await write.people(peopleWriter.addNote, {
			requestKey: key(),
			expectedRevision: (await personRow(personId)).revision,
			input: { personId, body },
		}),
	).noteId;
const addSkill = async (personId: string, name: string) =>
	ok(await write.people(personFields.addSkill, { requestKey: key(), input: { personId, name, category: "tech" } }));
const createTag = async (name: string) =>
	ok(await write.people(personFields.createTag, { requestKey: key(), input: { name } })).tag.id;
const assignTag = async (personId: string, tagId: string) =>
	ok(await write.people(personFields.assignTag, { requestKey: key(), input: { personId, tagId } }));
const createTask = async (personId: string, title: string) =>
	ok(
		await write.tasks(tasks.create, {
			requestKey: key(),
			input: { title, category: "follow_up", relation: { kind: "person", id: personId } },
		}),
	).task.id;
const program = () => insert("training_program", { name: `Welcome ${key()}`, required: true });
const train = (programId: string, personId: string) =>
	insert("training_assignment", {
		program_id: programId,
		person_id: personId,
		version: 1,
		state: "active",
		effective_on: "2026-10-01",
	});
const attest = async (programId: string, personId: string) =>
	ok(
		await write.teams(trainingWriter.attestCompletion, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("training_program", programId),
			input: { kind: "program", personId, programId, earnedOn: "2026-10-05" },
		}),
	);
async function role(name: string) {
	const team = await insert("team", { name, state: "active", sort_order: 1 });
	return { team, id: await insert("team_role", { team_id: team, name: "Greeter", leadership: false, sort_order: 1 }) };
}
const assign = async (r: { team: string; id: string }, personId: string) =>
	ok(
		await write.teams(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("team_role", r.id),
			input: { roleId: r.id, teamId: r.team, personId },
		}),
	);
async function email(personId: string, subject: string) {
	const communication = key();
	await insert("communication", {
		id: communication,
		author_id: w.actors.owner.id,
		revision: 2,
		state: "scheduled",
		subject,
		body_html: "<p>Hi</p>",
		body_text: "Hi",
		audience: JSON.stringify({ groups: [], teamIds: [], personIds: [personId] }),
		scheduled_at: "2026-09-13T12:00:00Z",
		created_at: "2026-09-12T12:00:00Z",
	});
	const id = await insert("mail", {
		plant_id: undefined,
		tenant_id: P,
		purpose: "communication",
		communication_id: communication,
		recipient_person_id: personId,
		logical_key: `communication/${communication}/${personId}`,
		payload_hash: "p",
		audience_hash: "a",
		frozen_payload: JSON.stringify({ v: 1, sealed: "bytes" }),
		recipient_address_encrypted: "sealed-address",
		address_hash: key(),
		state: "sent",
		sent_at: "2026-09-13T12:00:00Z",
		created_at: "2026-09-13T12:00:00Z",
	});
	return { communication, id };
}
const mailRows = () => rows(sql`SELECT to_jsonb(m) AS row,m::text AS bytes FROM mail m ORDER BY m.id`);
const messages = async (personId: string) =>
	ok(await tx(async (t) => communicationWriter.listForPerson(t, await authority(), { personId })));
const feed = async (personId: string) =>
	ok(
		await tx((t) =>
			peopleReader.getActivities(t, ctx(), { personId: personIdValue.parse(personId), limit: 100, page: 1 }),
		),
	).items;
const skills = async (personId: string) =>
	ok(await tx((t) => personFields.getPersonSkills(t, ctx(), { personId })))
		.skills.map((s) => s.name)
		.sort();
const tags = async (personId: string) =>
	ok(await tx((t) => personFields.getPersonTags(t, ctx(), { personId })))
		.tags.map((x) => x.id)
		.sort();
const PERSON_TABLES: [string, string][] = [
	["person_tag", "person_id"],
	["person_skill", "person_id"],
	["person_note", "person_id"],
	["participation", "person_id"],
	["participation", "inviter_person_id"],
	["task", "person_id"],
	["obligation", "person_id"],
	["contact_outcome", "person_id"],
	["team_tenure", "person_id"],
	["training_assignment", "person_id"],
	["training_credit", "person_id"],
	["commitment", "person_id"],
	["mail", "recipient_person_id"],
];
async function records(...people: string[]) {
	const out: Row = {};
	for (const id of people) {
		out[id] = (
			await one(
				sql`SELECT to_jsonb(p)-'revision'-'pipeline_position'-'retired_at'-'updated_at' AS row FROM person p WHERE p.id=${id}::uuid`,
			)
		).row;
		for (const [table, column] of PERSON_TABLES)
			out[`${id} ${table}.${column}`] = (
				await rows(sql`SELECT to_jsonb(x)-'revision' AS row FROM ${sql.identifier(table)} x
					WHERE x.${sql.identifier(column)}=${id}::uuid ORDER BY to_jsonb(x)::text`)
			).map((r) => r.row);
	}
	return out;
}

async function previewOf(s: { imported: string; walkIn: string }) {
	const merged = await w.merge(s.walkIn, s.imported);
	const { restores } = ok(await w.preview(merged.mergeId));
	ok(await w.unmerge(merged.mergeId));
	return restores;
}
async function importedAndWalkIn() {
	const imported = await importOne(
		"first_name,last_name,email,phone\r\nJordan,Rivera,jordan@example.test,555 010 1000\r\n",
	);
	const night = await meeting("Vision night");
	const walkIn = ok(
		await write.meetings(guestsWriter.createWalkInContact, {
			requestKey: key(),
			input: { meetingId: night, displayName: "Jordan R." },
		}),
	).guest.person.personId;
	ok(await invite(night, imported));
	ok(
		await write.meetings(guestsWriter.correctRsvp, {
			requestKey: key(),
			expectedRevision: await w.revisionOf(
				"participation",
				String(
					(await one(sql`SELECT id FROM participation WHERE meeting_id=${night}::uuid AND person_id=${imported}::uuid`))
						.id,
				),
			),
			input: { meetingId: night, personId: imported, rsvp: "confirmed" },
		}),
	);
	ok(await checkIn(night, imported));
	const finalized = ok(
		await write.meetings(attendance.finalizeAttendance, {
			requestKey: key(),
			expectedRevision: String(
				(await one(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${night}::uuid`)).r,
			),
			input: { meetingId: night, attendeeIds: [imported, walkIn] },
		}),
	);
	assert.equal(finalized.outcome, "changed");
	const lunch = await meeting("Newcomer lunch");
	ok(await invite(lunch, walkIn));
	const own = { imported: await createTag(`Core ${key()}`), shared: await createTag(`Guest ${key()}`) };
	await assignTag(imported, own.imported);
	for (const id of [imported, walkIn]) {
		await assignTag(id, own.shared);
		await addSkill(id, id === imported ? "Sound" : "sound");
	}
	await addSkill(walkIn, "Teaching");
	const home = ok(
		await write.people(personFields.createHouseholdWithHead, {
			requestKey: key(),
			expectedRevision: (await personRow(walkIn)).revision,
			input: { name: "Rivera home", headPersonId: walkIn },
		}),
	).result;
	assert.ok(home.status === "available");
	const greeter = await role(`Hospitality ${key()}`);
	await assign(greeter, walkIn);
	const course = await program();
	await train(course, imported);
	await train(course, walkIn);
	await attest(course, walkIn);
	return {
		imported,
		walkIn,
		night,
		lunch,
		tags: own,
		home: home.household.id,
		greeter,
		course,
		notes: [await addNote(imported, "From the spreadsheet"), await addNote(walkIn, "Met at the door")],
		task: await createTask(walkIn, "Call Jordan"),
	};
}

test("a CSV import and a walk-in who are one person merge into one record with everything from both and one attendance per meeting", async () => {
	const s = await importedAndWalkIn();
	const review = ok(await w.review(s.walkIn, s.imported));
	assert.deepEqual(review.blockers, { causes: [], leadership: [], invitations: [] });
	assert.deepEqual(
		review.attendance.map((a) => a.change),
		["rsvp_replaced", "combined", "follow_up_combined"],
	);
	assert.deepEqual(
		review.openFollowUps.map((f) => [f.personId, f.meeting]),
		[[s.imported, "Vision night"]],
		"one follow-up stays open and it is the one named before confirm",
	);
	assert.deepEqual(review.openTasks.map((t) => t.title).sort(), ["Call Jordan"]);
	assert.deepEqual(
		Object.fromEntries(review.references.flatMap((r) => (r.treatment === "keep" ? [] : [[r.kind, r.count]]))),
		Object.fromEntries((await previewOf(s)).map((r) => [r.kind, r.count])),
		"what moves is what goes back",
	);
	assert.deepEqual(
		review.references.filter((r) => r.treatment === "keep"),
		[
			{ kind: "skill", count: 1, treatment: "keep" },
			{ kind: "obligation", count: 1, treatment: "keep" },
			{ kind: "task", count: 1, treatment: "keep" },
		],
		"the skill and the follow-up they both have are named as staying, not as moving",
	);
	const before = await records(s.imported, s.walkIn);
	const merged = await w.merge(s.walkIn, s.imported, { household: "source" });

	const live = ok(await meetingsReader.listGuests(db, await authority(), { meetingId: s.night })).guests;
	assert.deepEqual(
		live.map((g) => [g.person.personId, g.rsvp, g.presence]),
		[[s.imported, "confirmed", "attended"]],
	);
	assert.deepEqual(
		ok(await meetingsReader.listGuests(db, await authority(), { meetingId: s.lunch })).guests.map(
			(g) => g.person.personId,
		),
		[s.imported],
	);
	assert.deepEqual(await skills(s.imported), ["Sound", "Teaching"]);
	assert.deepEqual(await tags(s.imported), Object.values(s.tags).sort());
	const items = await feed(s.imported);
	assert.deepEqual(items.flatMap((i) => (i.kind === "note" ? [i.body] : [])).sort(), [
		"From the spreadsheet",
		"Met at the door",
	]);
	assert.equal((await one(sql`SELECT household_id FROM person WHERE id=${s.imported}::uuid`)).household_id, s.home);
	const history = ok(await trainingReader.readTrainingHistory(db, await authority(), { personId: s.imported })).credits;
	assert.deepEqual(
		history.map((c) => [c.programId, c.earnedOn]),
		[[s.course, "2026-10-05"]],
	);
	const matrix = ok(
		await trainingReader.readRequiredTrainingParticipants(db, await authority(), { programId: s.course }),
	).people;
	assert.deepEqual(
		matrix.map((x) => [x.personId, x.complete]),
		[[s.imported, true]],
	);
	const assignments = ok(await teamsReader.listPersonAssignments(db, await authority(), { personId: s.imported }));
	assert.ok(JSON.stringify(assignments).includes(s.greeter.team));
	assert.deepEqual(
		(await rows(sql`SELECT person_id FROM task WHERE id=${s.task}::uuid`)).map((r) => r.person_id),
		[s.imported],
	);
	const duties = ok(
		await tx(async (t) => followUpReader.readObligations(t, await authority(), { personId: s.imported, limit: 10 })),
	).items;
	assert.equal(duties.length, 1, "one follow-up for the one meeting");
	assert.deepEqual(
		ok(
			await tx(async (t) => followUpReader.readObligations(t, await authority(), { meetingId: s.night, limit: 10 })),
		).items.flatMap((o) => (o.kind === "first_vision_follow_up" ? [[o.id, o.person?.id, o.state]] : [])),
		[[duties[0]?.id, s.imported, "open"]],
		"the meeting shows the same one follow-up",
	);
	assert.deepEqual(
		ok(await tx(async (t) => followUpReader.listFollowUpOwners(t, await authority(), { personId: s.imported })))
			.items.map((d) => d.title)
			.sort(),
		["Call Jordan", "Follow up with Jordan Rivera"],
	);

	const p = ok(await w.preview(merged.mergeId));
	assert.deepEqual([p.conflicts, p.stays, p.staysFields], [[], [], []]);
	assert.equal(ok(await w.unmerge(merged.mergeId)).outcome, "changed");
	assert.deepEqual(await records(s.imported, s.walkIn), before);
});

test("a link to a merged-away person resolves to the person who is left through a chain, and history says who merged them and when", async () => {
	const a = await person("Sam Ortiz"),
		b = await person("Sam O."),
		c = await person("Samuel Ortiz");
	const first = await w.merge(a, b),
		second = await w.merge(b, c);
	for (const id of [a, b])
		assert.deepEqual(ok(await w.destination(id)), {
			personId: id,
			status: "merged",
			destinationId: c,
			mergeId: id === a ? first.mergeId : second.mergeId,
		});
	const events = (await feed(c)).flatMap((i) => (i.kind === "activity" && i.action === "person_merged" ? [i] : []));
	assert.deepEqual(
		events.map((i) => [i.recordId, "accountId" in i.actor && i.actor.accountId]).sort(),
		[
			[first.mergeId, w.actors.admin.id],
			[second.mergeId, w.actors.admin.id],
		].sort(),
	);
	const stored = await rows(
		sql`SELECT id,merged_at FROM person_merge WHERE id IN (${first.mergeId}::uuid,${second.mergeId}::uuid)`,
	);
	for (const e of events) {
		const at = new Date(String(stored.find((s) => s.id === e.recordId)?.merged_at)).getTime();
		assert.ok(Math.abs(Date.parse(e.occurredAt) - at) < 5_000);
	}
});

test("AC:PERSONREF-COMMUNICATION-RECIPIENT-CONTACT-MERGE an email sent to the merged-away person stays as sent and shows in the survivor's history", async () => {
	const source = await person("Riley Fox", { email: "riley.old@example.test" }),
		survivor = await person("Riley Foxe", { email: "riley.new@example.test" });
	const sent = await email(source, "Welcome last month");
	const theirs = await email(survivor, "Welcome too");
	const detail = async () => {
		const all = ok(
			await tx(async (t) => communicationWriter.getDetail(t, await authority(), { id: sent.communication })),
		);
		return { ...all, currentPersonAddress: null, recipients: all.recipients };
	};
	const before = { mail: await mailRows(), detail: await detail(), sends: await w.effects() };
	assert.equal(before.detail.recipients[0]?.personId, source);
	const merged = await w.merge(source, survivor);
	assert.deepEqual(await mailRows(), before.mail);
	assert.deepEqual(await detail(), before.detail);
	assert.deepEqual(await w.effects(), before.sends);
	const subjects = async (id: string) => (await messages(id)).items.map((i) => i.subject).sort();
	assert.deepEqual(await subjects(survivor), ["Welcome last month", "Welcome too"]);
	const history = ok(
		await tx(async (t) => communicationWriter.listHistory(t, await authority(), { personId: survivor })),
	).items.map((i) => i.id);
	assert.deepEqual([...history].sort(), [sent.communication, theirs.communication].sort());
	ok(await w.unmerge(merged.mergeId));
	assert.deepEqual(await mailRows(), before.mail);
	assert.deepEqual([await subjects(source), await subjects(survivor)], [["Welcome last month"], ["Welcome too"]]);
});

test("after a merge the notification feed, signed cards and their corrections read as they did", async () => {
	const source = await person("Nia Cole"),
		survivor = await person("Nia C.");
	const about = await createTask(source, "Call Nia Cole");
	await insert("notice", {
		plant_id: undefined,
		tenant_id: P,
		recipient_id: w.actors.admin.id,
		category: "task",
		purpose: "task_due",
		logical_key: `${P}/task_due/${about}/1`,
		source_record_id: about,
		source_revision: 1,
		title: "Call Nia Cole is due",
		eligible_at: "2026-10-01T12:00:00Z",
		created_at: "2026-10-01T12:00:00Z",
	});
	const card = ok(
		await write.people(commitments.createCommitment, {
			requestKey: key(),
			input: { personId: source, kind: "core_group", occurredOn: "2026-09-20", notes: "Signed at lunch" },
		}),
	).commitment;
	const notices = async () => ok(await readFeedPage(db, await authority(), {}));
	const before = await notices();
	assert.ok(JSON.stringify(before).includes("Call Nia Cole is due"));
	await w.merge(source, survivor);
	assert.deepEqual(await notices(), before);
	const shown = ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId: survivor }))).items;
	assert.deepEqual(
		shown.map((k) => [k.id, k.occurredOn, k.notes, k.recordedAt, "accountId" in k.actor && k.actor.accountId]),
		[[card.id, "2026-09-20", "Signed at lunch", card.recordedAt, w.actors.admin.id]],
	);
	const opened = ok(await tx(async (t) => taskReader.get(t, await authority(), { taskId: about })));
	assert.ok(JSON.stringify(opened).includes(survivor), "the notice's task opens the survivor");
});

async function firstVisit(label: string, ...others: string[]) {
	const p = await pair(label);
	const night = await meeting(`${label} night`);
	const everyone = [p.source, p.survivor, ...others];
	for (const id of everyone) {
		ok(await invite(night, id));
		ok(await checkIn(night, id));
	}
	await attended(night, everyone);
	return { ...p, night };
}
const attended = async (meetingId: string, attendeeIds: string[], reason?: string) =>
	ok(
		await write.meetings(reason ? attendance.reconcileAttendance : attendance.finalizeAttendance, {
			requestKey: key(),
			expectedRevision: String(
				(await one(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${meetingId}::uuid`)).r,
			),
			input: { meetingId, attendeeIds, ...(reason ? { reason } : {}) },
		}),
	);
const followUpTask = async (meetingId: string, personId: string) =>
	String(
		(
			await one(sql`SELECT t.id FROM task t JOIN obligation o ON o.id=t.obligation_id
				WHERE o.meeting_id=${meetingId}::uuid AND o.person_id=${personId}::uuid`)
		).id,
	);
const contact = async (taskId: string, input: Row = {}) =>
	write.followUps(followups.recordOutcome, {
		requestKey: key(),
		input: {
			target: { kind: "task", taskId, expectedRevision: await w.revisionOf("task", taskId) },
			outcome: "contacted",
			channel: "phone",
			completeTask: true,
			occurredAt: "2026-10-02T12:00:00.000Z",
			...input,
		},
	});
const intelligence = async () => {
	const facts = await captureFacts(db, P, null);
	assert.ok(facts);
	return facts.followUps;
};
async function oneFollowUp(p: { survivor: string; night: string }) {
	const actor = await authority();
	const read = async (by: Row) =>
		ok(await tx((t) => followUpReader.readObligations(t, actor, { ...by, limit: 10 }))).items.filter(
			(o) => o.kind === "first_vision_follow_up",
		);
	const [mine, theirs] = [await read({ personId: p.survivor }), await read({ meetingId: p.night })];
	assert.deepEqual(mine, theirs, "the person and the meeting show the same follow-up");
	const [duty] = mine;
	assert.ok(duty?.task);
	assert.equal(mine.length, 1, "one follow-up for one visit");
	const found = ok(await tx((t) => taskReader.get(t, actor, { taskId: duty.task!.id })));
	assert.ok(found.status === "available");
	assert.deepEqual(
		[found.task.managed?.obligationId, found.task.relation?.id],
		[duty.id, p.survivor],
		"its call screen finds it by the task's person",
	);
	const open = ok(await tx((t) => followUpReader.listFollowUpOwners(t, actor, { personId: p.survivor }))).items;
	assert.deepEqual(
		open.map((d) => d.obligationId),
		duty.state === "open" ? [duty.id] : [],
	);
	const counts = ok(await attendanceReader.linkedTaskProgress(db, actor, { meetingId: p.night })).followUps;
	assert.equal(counts.total, 1, "the meeting counts one visitor once");
	return duty;
}
async function bothSides(p: { source: string; survivor: string }) {
	return {
		records: await records(p.source, p.survivor),
		contacts: await rows(sql`SELECT to_jsonb(x)-'revision' AS row FROM contact_outcome x
			WHERE x.person_id IN (${p.source}::uuid,${p.survivor}::uuid) ORDER BY x.id`),
	};
}
test("two open follow-ups from one meeting become one, its call is measured once, and Unmerge opens both again", async () => {
	const p = await firstVisit("Open");
	const facts = await intelligence();
	const before = await bothSides(p);
	const theirs = await followUpTask(p.night, p.source);
	const merged = await w.merge(p.source, p.survivor);
	assert.equal((await oneFollowUp(p)).state, "open");
	assert.equal((await intelligence()).total, facts.total - 1);
	assert.deepEqual(
		ok(await w.preview(merged.mergeId)).attendance.map((a) => a.change),
		["combined", "follow_up_combined"],
	);
	refused(
		await write.tasks(tasks.reopen, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("task", theirs),
			input: { taskId: theirs },
		}),
		"protected_source",
	);
	const history = await rows(
		sql`SELECT action,kind,reason FROM audit_event WHERE subject_id=${theirs}::uuid AND action='tasks.waived'`,
	);
	assert.deepEqual(history, [
		{
			action: "tasks.waived",
			kind: "waive",
			reason: "Combined with the other follow-up from this meeting in a merge",
		},
	]);
	ok(await w.unmerge(merged.mergeId));
	assert.deepEqual(await bothSides(p), before);
	assert.deepEqual(await intelligence(), facts);

	const again = await w.merge(p.source, p.survivor);
	ok(await contact((await oneFollowUp(p)).task!.id));
	const called = await oneFollowUp(p);
	assert.deepEqual(
		[called.state, called.contacted, called.completion?.outcome, called.measurement],
		["complete", true, "contacted", { eligible: true, success: true, reason: "measured" }],
	);
	const measured = await intelligence();
	assert.deepEqual(
		[measured.total, measured.measured, measured.onTime, measured.contacted],
		[facts.total - 1, facts.measured - 1, facts.onTime + 1, facts.contacted + 1],
	);
	ok(await w.unmerge(again.mergeId));
	const after = await rows(sql`SELECT o.person_id,t.status,(SELECT count(*)::int FROM contact_outcome x
		WHERE x.obligation_id=o.id AND x.person_id=o.person_id) AS calls FROM obligation o JOIN task t ON t.obligation_id=o.id
		WHERE o.meeting_id=${p.night}::uuid AND o.kind='follow_up' AND o.superseded_at IS NULL ORDER BY t.status`);
	assert.deepEqual(after, [
		{ person_id: p.survivor, status: "complete", calls: 1 },
		{ person_id: p.source, status: "not_started", calls: 0 },
	]);
});

test("a finished follow-up wins over an open one from the same meeting, whichever person had it, and both outcomes stay", async (t) => {
	for (const done of ["source", "survivor"] as const)
		await t.test(done, async () => {
			const p = await firstVisit(`Done ${done}`);
			const other = done === "source" ? "survivor" : "source";
			ok(
				await contact(await followUpTask(p.night, p[other]), { outcome: "attempted_no_contact", completeTask: false }),
			);
			ok(await contact(await followUpTask(p.night, p[done])));
			const facts = await intelligence();
			const before = await bothSides(p);
			const review = ok(await w.review(p.source, p.survivor));
			assert.deepEqual(review.openFollowUps, []);
			assert.deepEqual(review.openTasks, []);
			assert.deepEqual(review.attendance.at(-1), {
				change: "follow_up_combined",
				meeting: `Done ${done} night`,
				state: "complete",
			});
			const merged = await w.merge(p.source, p.survivor);
			const duty = await oneFollowUp(p);
			assert.deepEqual([duty.state, duty.contacted, duty.measurement?.success], ["complete", true, true]);
			const contacts = ok(
				await tx(async (x) =>
					followUpReader.listContactHistory(x, await authority(), { personId: p.survivor, limit: 10 }),
				),
			).items;
			assert.deepEqual(contacts.map((c) => c.outcome).sort(), ["attempted_no_contact", "contacted"]);
			const now = await intelligence();
			assert.deepEqual(
				[now.total, now.measured, now.onTime, now.contacted],
				[facts.total - 1, facts.measured - 1, facts.onTime, facts.contacted],
			);
			ok(await w.unmerge(merged.mergeId));
			assert.deepEqual(await bothSides(p), before);
			assert.deepEqual(await intelligence(), facts);
		});
});

test("a contact that did not finish the replaced follow-up still counts on the one that stays, and two finished ones keep the earlier call", async () => {
	const p = await firstVisit("Spoken");
	ok(await contact(await followUpTask(p.night, p.source), { completeTask: false }));
	await w.merge(p.source, p.survivor);
	const open = await oneFollowUp(p);
	assert.deepEqual([open.state, open.contacted], ["open", true]);

	const q = await firstVisit("Twice");
	ok(await contact(await followUpTask(q.night, q.survivor), { occurredAt: "2026-10-09T12:00:00.000Z" }));
	ok(await contact(await followUpTask(q.night, q.source)));
	await w.merge(q.source, q.survivor);
	const done = await oneFollowUp(q);
	assert.deepEqual([done.completion?.occurredAt, done.measurement?.success], ["2026-10-02T12:00:00.000Z", true]);
});

test("the owner of the replaced follow-up also owns the one that stays until Unmerge", async () => {
	const p = await firstVisit("Owned");
	const theirs = await followUpTask(p.night, p.source);
	await w.admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${P}::uuid,${theirs}::uuid,${w.actors.owner.id})`,
	);
	const owners = () =>
		rows(sql`SELECT a.task_id,a.account_id FROM task_assignee a JOIN task t ON t.id=a.task_id
			WHERE t.person_id IN (${p.source}::uuid,${p.survivor}::uuid) ORDER BY a.task_id`);
	const before = { sides: await bothSides(p), owners: await owners() };
	const merged = await w.merge(p.source, p.survivor);
	const duty = await oneFollowUp(p);
	assert.deepEqual(
		duty.owners.map((o) => o.accountId),
		[w.actors.owner.id],
	);
	ok(await w.unmerge(merged.mergeId));
	assert.deepEqual({ sides: await bothSides(p), owners: await owners() }, before);
});

test("an open follow-up reopens the one the kept person no longer needed or deleted, and Unmerge closes it again", async (t) => {
	for (const how of ["waive", "delete"] as const)
		await t.test(how, async () => {
			const p = await firstVisit(`Closed ${how}`);
			const own = await followUpTask(p.night, p.survivor);
			const request = { requestKey: key(), expectedRevision: await w.revisionOf("task", own) };
			if (how === "waive")
				ok(await write.tasks(tasks.waive, { ...request, input: { taskId: own, reason: "Moved away" } }));
			else ok(await write.tasks(tasks.delete, { ...request, input: { taskId: own } }));
			const before = await bothSides(p);
			const merged = await w.merge(p.source, p.survivor);
			const duty = await oneFollowUp(p);
			assert.deepEqual([duty.state, duty.task?.id, duty.waiver], ["open", own, null]);
			ok(await w.unmerge(merged.mergeId));
			assert.deepEqual(await bothSides(p), before);
		});
});

test("correcting the merged person to absent closes their one follow-up and opens none", async () => {
	const p = await firstVisit("Corrected");
	await w.merge(p.source, p.survivor);
	await attended(p.night, [], "They were not there");
	assert.equal((await oneFollowUp(p)).state, "no_longer_needed");
	assert.equal(
		(
			await one(sql`SELECT count(*)::int AS n FROM task t JOIN obligation o ON o.id=t.obligation_id
				WHERE o.meeting_id=${p.night}::uuid AND o.kind='follow_up' AND t.status NOT IN ('complete','no_longer_needed')`)
		).n,
		0,
	);
	await attended(p.night, [p.survivor], "They were there after all");
	assert.equal(
		(await one(sql`SELECT count(*)::int AS n FROM obligation WHERE meeting_id=${p.night}::uuid AND kind='follow_up'`))
			.n,
		2,
		"no third follow-up is made",
	);
});

test("follow-ups combined through a chain of merges come back one merge at a time", async () => {
	const third = await person("Chained third");
	const p = await firstVisit("Chained", third);
	const before = await bothSides(p);
	const first = await w.merge(p.source, p.survivor);
	const between = await records(p.survivor, third);
	const second = await w.merge(p.survivor, third);
	await oneFollowUp({ survivor: third, night: p.night });
	assert.deepEqual(ok(await w.preview(first.mergeId)).conflicts, ["chained_merge"]);
	ok(await w.unmerge(second.mergeId));
	assert.deepEqual(await records(p.survivor, third), between);
	assert.deepEqual(ok(await w.preview(first.mergeId)).conflicts, []);
	ok(await w.unmerge(first.mergeId));
	assert.deepEqual(await bothSides(p), before);
});

test("an edited replaced follow-up stops the Unmerge and names it", async () => {
	const p = await firstVisit("Edited");
	const theirs = await followUpTask(p.night, p.source);
	ok(await contact(theirs));
	const own = await followUpTask(p.night, p.survivor);
	const merged = await w.merge(p.source, p.survivor);
	ok(
		await write.tasks(tasks.edit, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("task", own),
			input: { taskId: own, patch: { title: "Renamed" } },
		}),
	);
	const preview = ok(await w.preview(merged.mergeId));
	assert.deepEqual([preview.conflicts, preview.changed], [["references_changed"], ["task"]]);
});

async function pair(label: string) {
	const source = await person(`${label} Duplicate`, { phone: "555 010 2000" }),
		survivor = await person(`${label} Keeper`, { phone: "555 010 1000" });
	return { source, survivor };
}
test("AC:TARGET-PPL-025 everything added after a merge stays with the person it was added to, and the preview says so", async (t) => {
	const { source, survivor } = await pair("Added");
	const moved = { task: await createTask(source, "Before"), note: await addNote(source, "Before") };
	const before = await records(source);
	const merged = await w.merge(source, survivor, { phone: "source" });
	const gathering = await meeting("After the merge");
	const course = await program();
	ok(await invite(gathering, survivor));
	await train(course, survivor);
	await attest(course, survivor);
	const tag = await createTag(`After ${key()}`);
	await assignTag(survivor, tag);
	await addSkill(survivor, "Drums");
	const added = {
		task: await createTask(survivor, "After"),
		note: await addNote(survivor, "After"),
		email: await email(survivor, "After"),
	};
	const greeter = await role(`After ${key()}`);
	await assign(greeter, survivor);
	await w.update(survivor, { city: "Naperville" });
	const sends = await w.effects(),
		mail = await mailRows();
	const p = ok(await w.preview(merged.mergeId));
	assert.deepEqual([p.state, p.conflicts, p.changedFields, p.fields], ["merged", [], [], ["phone"]]);
	assert.deepEqual(Object.fromEntries(p.stays.map((s) => [s.kind, s.count])), {
		tag: 1,
		skill: 1,
		note: 1,
		mail: 1,
		participation: 1,
		task: 1,
		team_tenure: 1,
		training_assignment: 1,
	});
	assert.deepEqual(p.staysFields, ["address"]);
	assert.equal(ok(await w.unmerge(merged.mergeId)).outcome, "changed");
	assert.deepEqual(await records(source), before);
	await t.test("the survivor keeps the additions", async () => {
		const row = await one(sql`SELECT phone,city FROM person WHERE id=${survivor}::uuid`);
		assert.deepEqual(row, { phone: "555 010 1000", city: "Naperville" });
		assert.deepEqual(await skills(survivor), ["Drums"]);
		assert.deepEqual(await tags(survivor), [tag]);
		const owned = async (table: string, id: string, column = "person_id") =>
			(await one(sql`SELECT ${sql.identifier(column)} AS p FROM ${sql.identifier(table)} WHERE id=${id}::uuid`)).p;
		assert.equal(await owned("task", added.task), survivor);
		assert.equal(await owned("person_note", added.note), survivor);
		assert.equal(await owned("mail", added.email.id, "recipient_person_id"), survivor);
		assert.equal(await owned("task", moved.task), source);
		assert.equal(await owned("person_note", moved.note), source);
		assert.deepEqual(
			ok(await meetingsReader.listGuests(db, await authority(), { meetingId: gathering })).guests.map(
				(g) => g.person.personId,
			),
			[survivor],
		);
		assert.equal(
			ok(await trainingReader.readTrainingHistory(db, await authority(), { personId: survivor })).credits.length,
			1,
		);
	});
	assert.deepEqual(await mailRows(), mail);
	assert.deepEqual(await w.effects(), sends);
	const settled = await w.everything();
	assert.equal(ok(await w.unmergeWith(merged.mergeId, (await personRow(survivor)).revision)).outcome, "noop");
	assert.deepEqual(
		(await w.changed(settled)).filter((name) => name !== "audit_event" && name !== "record"),
		[],
	);
});

test("a guest the source invited keeps an RSVP given after the merge when Unmerge returns the inviter", async () => {
	const { source, survivor } = await pair("Inviter");
	const gathering = await meeting("Invited night");
	const guest = await person("Invited guest");
	ok(await invite(gathering, guest, source));
	const merged = await w.merge(source, survivor);
	const id = String(
		(await one(sql`SELECT id FROM participation WHERE meeting_id=${gathering}::uuid AND person_id=${guest}::uuid`)).id,
	);
	ok(
		await write.meetings(guestsWriter.correctRsvp, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("participation", id),
			input: { meetingId: gathering, personId: guest, rsvp: "confirmed" },
		}),
	);
	assert.equal(ok(await w.unmerge(merged.mergeId)).outcome, "changed");
	assert.deepEqual(await one(sql`SELECT inviter_person_id,rsvp FROM participation WHERE id=${id}::uuid`), {
		inviter_person_id: source,
		rsvp: "confirmed",
	});
});

test("AC:TARGET-PPL-025 AC:PERSONREF-MEETING-INVITATION-RSVP-ATTENDANCE-CARD-UNMERGE a later change Unmerge cannot split refuses, names it and changes nothing", async () => {
	const c = caseOf("people", "TARGET-PPL-025");
	const inputs = c.given["case-input"] as { later_conflicts: string[]; later_additions: string[] };
	type Scene = { causes: string[]; changed: string[]; fields?: string[]; run: () => Promise<{ mergeId: string }> };
	const shared = async (label: string) => {
		const p = await pair(label);
		const night = await meeting(`${label} night`);
		for (const id of [p.source, p.survivor]) {
			ok(await invite(night, id));
			ok(await checkIn(night, id));
		}
		return { ...p, night };
	};
	const scenes: Record<string, Scene> = {
		merged_field_edit: {
			causes: ["survivor_changed"],
			changed: [],
			fields: ["phone"],
			run: async () => {
				const p = await pair("Field");
				const merged = await w.merge(p.source, p.survivor, { phone: "source" });
				await w.update(p.survivor, { phone: "555 010 3000" });
				return merged;
			},
		},
		moved_record_edit: {
			causes: ["references_changed"],
			changed: ["commitment"],
			run: async () => {
				const p = await pair("Commitment");
				const card = ok(
					await write.people(commitments.createCommitment, {
						requestKey: key(),
						input: { personId: p.source, kind: "core_group", occurredOn: "2026-10-01" },
					}),
				).commitment;
				const merged = await w.merge(p.source, p.survivor);
				ok(
					await write.people(recordCorrections.correctPersonRecord, {
						requestKey: key(),
						expectedRevision: await w.revisionOf("commitment", card.id),
						input: {
							recordType: "commitment",
							personId: p.survivor,
							recordId: card.id,
							reason: "Typo",
							changes: { notes: "Corrected" },
						},
					}),
				);
				return merged;
			},
		},
		combined_attendance_edit: {
			causes: ["references_changed"],
			changed: ["participation"],
			run: async () => {
				const p = await shared("Combined");
				const merged = await w.merge(p.source, p.survivor);
				ok(
					await write.meetings(attendance.setAttendance, {
						requestKey: key(),
						input: { meetingId: p.night, personId: p.survivor, presence: "excused" },
					}),
				);
				return merged;
			},
		},
		outcome_on_moved_follow_up: {
			causes: ["references_changed"],
			changed: ["contact_outcome"],
			run: async () => {
				const p = await pair("Outcome");
				const duty = await createTask(p.source, "Call them");
				const merged = await w.merge(p.source, p.survivor);
				ok(
					await write.followUps(followups.recordOutcome, {
						requestKey: key(),
						input: {
							target: { kind: "task", taskId: duty, expectedRevision: await w.revisionOf("task", duty) },
							outcome: "attempted_no_contact",
							channel: "phone",
							completeTask: false,
						},
					}),
				);
				return merged;
			},
		},
		moved_tag_removed: {
			causes: ["references_changed"],
			changed: ["tag"],
			run: async () => {
				const p = await pair("Tag");
				const tagId = await createTag(`Tag ${key()}`);
				await assignTag(p.source, tagId);
				const merged = await w.merge(p.source, p.survivor);
				ok(await write.people(personFields.removeTag, { requestKey: key(), input: { personId: p.survivor, tagId } }));
				return merged;
			},
		},
		household_deleted: {
			causes: ["household_deleted"],
			changed: [],
			run: async () => {
				const p = await pair("Household");
				const home = ok(
					await write.people(personFields.createHouseholdWithHead, {
						requestKey: key(),
						expectedRevision: (await personRow(p.source)).revision,
						input: { name: "Gone", headPersonId: p.source },
					}),
				).result;
				assert.ok(home.status === "available");
				const householdId = home.household.id;
				const merged = await w.merge(p.source, p.survivor);
				ok(
					await write.people(personFields.deleteHousehold, {
						requestKey: key(),
						expectedRevision: await w.revisionOf("household", householdId),
						input: { householdId },
					}),
				);
				return merged;
			},
		},
		chain_merge: {
			causes: ["chained_merge"],
			changed: [],
			run: async () => {
				const p = await pair("Chain");
				const merged = await w.merge(p.source, p.survivor);
				await w.merge(p.survivor, await person("Chain end"));
				return merged;
			},
		},
	};
	const writes: Record<string, number> = {};
	for (const [name, scene] of Object.entries(scenes)) {
		const { mergeId } = await scene.run();
		const p = ok(await w.preview(mergeId));
		assert.deepEqual(
			[p.conflicts, p.changed, p.changedFields],
			[scene.causes, scene.changed, scene.fields ?? []],
			name,
		);
		const before = await w.everything();
		const { survivorId } = p;
		for (let n = 0; n < 2; n++) {
			const error = refused(await w.unmergeWith(mergeId, (await personRow(survivorId)).revision), "inverse_conflict");
			assert.deepEqual(
				error.details,
				{ causes: scene.causes, changed: scene.changed, changedFields: scene.fields ?? [] },
				name,
			);
		}
		writes[name] = (await w.changed(before)).length;
	}
	assert.deepEqual(new Set(Object.values(writes)), new Set([0]));

	const additions: Record<string, (survivor: string) => Promise<unknown>> = {
		survivor_edit: (id) => w.update(id, { city: "Elgin" }),
		training_insert: async (id) => train(await program(), id),
		RSVP_insert: async (id) => invite(await meeting("Later"), id),
		provider_dispatch: (id) => email(id, "Later"),
	};
	const account = await w.database.actor(w.database.tenant, "member");
	const allowed: boolean[] = [];
	let history = true,
		kept = true,
		authorityChanged = false;
	const grants = () => rows(sql`SELECT to_jsonb(s) AS seat FROM seat s ORDER BY s.id`);
	for (const name of ["unchanged", ...inputs.later_additions]) {
		const { source, survivor } = await pair(`Split ${name}`);
		await w.admin.execute(sql`UPDATE person SET linked_account_id=${account.id} WHERE id=${survivor}::uuid`);
		const seats = await grants();
		const reviewDigest = await w.digestOf(source, survivor);
		const requestKey = key();
		const merged = ok(await w.mergeWith({ sourceId: source, survivorId: survivor, reviewDigest }, { requestKey }));
		assert.deepEqual(
			ok(await w.mergeWith({ sourceId: source, survivorId: survivor, reviewDigest }, { requestKey })),
			merged,
		);
		await additions[name]?.(survivor);
		const later = await records(survivor);
		allowed.push(ok(await w.unmerge(merged.mergeId)).outcome === "changed");
		const now = await records(survivor);
		kept &&= JSON.stringify(now) === JSON.stringify(later);
		const events = await rows(sql`SELECT action FROM audit_event WHERE subject_id=${survivor}::uuid
			AND action IN ('people.merged','people.unmerged') ORDER BY occurred_at,id`);
		history &&= events.map((e) => e.action).join() === "people.merged,people.unmerged";
		authorityChanged ||=
			JSON.stringify(await grants()) !== JSON.stringify(seats) ||
			(await one(sql`SELECT linked_account_id AS a FROM person WHERE id=${survivor}::uuid`)).a !== account.id;
		await w.admin.execute(sql`UPDATE person SET linked_account_id=NULL WHERE id=${survivor}::uuid`);
	}
	const [unchanged, ...split] = allowed;
	assert.deepEqual(
		{
			unchanged_inverse_allowed: unchanged,
			split_inverse_allowed: split,
			conflicted_inverse_writes: inputs.later_conflicts.map((name) => writes[name]),
			original_history_retained: history,
			later_facts_retained: kept,
			authority_changed: authorityChanged,
		},
		c.expected.result,
	);
});

test("two people with their own logins refuse and say why; with one login that person stays and keeps it", async () => {
	const [first, second] = [
		await w.database.actor(w.database.tenant, "member"),
		await w.database.actor(w.database.tenant, "admin"),
	];
	const a = await person("Avery Stone"),
		b = await person("Avery S."),
		plain = await person("A. Stone");
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${first.id} WHERE id=${a}::uuid`);
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${second.id} WHERE id=${b}::uuid`);
	const grants = () =>
		rows(sql`SELECT (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM seat s) AS seats,
			(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.id) FROM account x) AS accounts,
			(SELECT jsonb_agg(jsonb_build_object('id',p.id,'account',p.linked_account_id) ORDER BY p.id) FROM person p
				WHERE p.linked_account_id IS NOT NULL) AS links`);
	const before = await w.everything();
	for (const [source, survivor, cause] of [
		[a, b, "linked_account_collision"],
		[b, a, "linked_account_collision"],
		[a, plain, "linked_source"],
	] as const) {
		assert.deepEqual(ok(await w.review(source, survivor)).blockers.causes, [cause]);
		const reviewDigest = await w.digestOf(source, survivor);
		const error = refused(await w.mergeWith({ sourceId: source, survivorId: survivor, reviewDigest }), "merge_blocked");
		assert.deepEqual(error.details.causes, [cause]);
	}
	assert.deepEqual(await w.changed(before), []);
	const kept = await grants();
	await w.merge(plain, a);
	assert.deepEqual(await grants(), kept);
});

test("a retired person's meetings, tasks, teams and follow-ups still name them and open", async () => {
	const name = "Casey Retired";
	const id = await person(name);
	const night = await meeting("Retired night");
	ok(await invite(night, id));
	ok(await checkIn(night, id));
	const about = await createTask(id, "Call Casey");
	const greeter = await role(`Retired team ${key()}`);
	await assign(greeter, id);
	await w.retire(id);
	const actor = await authority();
	const reads: Record<string, unknown> = {
		meeting: ok(await meetingsReader.listGuests(db, actor, { meetingId: night })),
		task: ok(await tx((t) => taskReader.get(t, actor, { taskId: about }))),
		team: ok(await teamsReader.listHistory(db, actor, { teamId: greeter.team })),
		followUps: ok(await tx((t) => followUpReader.listContactHistory(t, actor, { personId: id, limit: 10 }))),
		person: ok(await tx((t) => peopleReader.getPerson(t, ctx(), { personId: personIdValue.parse(id) }))),
	};
	for (const [surface, value] of Object.entries(reads))
		if (surface !== "followUps") assert.ok(JSON.stringify(value).includes(name), `${surface} names them`);
	assert.deepEqual(
		ok(await tx((t) => peopleMerge.mergedPersonDestination(t, ctx(), { personId: id }))).status,
		"retired",
	);
});

test("undoing the later merge lets the earlier one unmerge, with every record back where it was", async () => {
	const [c, b, a] = [await person("Chain C"), await person("Chain B"), await person("Chain A")];
	const night = await meeting("Chain night");
	for (const id of [c, b, a]) {
		ok(await invite(night, id));
		ok(await checkIn(night, id));
		await createTask(id, "Call");
		await addNote(id, "Note");
	}
	await invite(await meeting("Chain lunch"), c);
	const before = await records(c, b, a);
	const first = await w.merge(c, b),
		second = await w.merge(b, a);
	assert.deepEqual(ok(await w.preview(first.mergeId)).conflicts, ["chained_merge"]);
	assert.equal(ok(await w.unmerge(second.mergeId)).outcome, "changed");
	assert.deepEqual(ok(await w.preview(first.mergeId)).conflicts, []);
	assert.equal(ok(await w.unmerge(first.mergeId)).outcome, "changed");
	assert.deepEqual(await records(c, b, a), before);
});
