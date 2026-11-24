import test, { after } from "node:test";
import assert from "node:assert/strict";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../../../packages/domain/src/communication/index.ts";
import { createFollowUpWriter, followUpReader } from "../../../../../packages/domain/src/followups/index.ts";
import {
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
import { ok, refused, type Actor } from "../../../../support/fixture.mts";
import { caseOf, key, world, type Row } from "./support.mts";

const w = await world("wp091merge");
const { P, ctx, tx, rows, one, insert, person, personRow, db } = w;
after(() => w.database.close());
const reminders = async () => undefined;
const attendance = createAttendanceWriter({ reminders });
const tasks = createTaskWriter({ reminders });
const followups = createFollowUpWriter({ reminders });
const authority = async (actor: Pick<Actor, "session"> = w.actors.admin) => {
	const found = await RequestActor.resolve(db, actor.session);
	assert.ok(found instanceof RequestActor);
	return found;
};
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
	tx((t) => guestsWriter.inviteGuest(t, ctx(), { requestKey: key(), input: { meetingId, personId, inviterPersonId } }));
const checkIn = (meetingId: string, personId: string) =>
	tx((t) => attendance.checkIn(t, ctx(), { requestKey: key(), input: { meetingId, personId } }));
const addNote = async (personId: string, body: string) =>
	ok(
		await tx(async (t) =>
			peopleWriter.addNote(t, ctx(), {
				requestKey: key(),
				expectedRevision: (await personRow(personId)).revision,
				input: { personId, body },
			}),
		),
	).noteId;
const addSkill = async (personId: string, name: string) =>
	ok(
		await tx((t) =>
			personFields.addSkill(t, ctx(), { requestKey: key(), input: { personId, name, category: "tech" } }),
		),
	);
const createTag = async (name: string) =>
	ok(await tx((t) => personFields.createTag(t, ctx(), { requestKey: key(), input: { name } }))).tag.id;
const assignTag = async (personId: string, tagId: string) =>
	ok(await tx((t) => personFields.assignTag(t, ctx(), { requestKey: key(), input: { personId, tagId } })));
const createTask = async (personId: string, title: string) =>
	ok(
		await tx((t) =>
			tasks.create(t, ctx(), {
				requestKey: key(),
				input: { title, category: "follow_up", relation: { kind: "person", id: personId } },
			}),
		),
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
		await tx(async (t) =>
			trainingWriter.attestCompletion(t, ctx(), {
				requestKey: key(),
				expectedRevision: await w.revisionOf("training_program", programId),
				input: { kind: "program", personId, programId, earnedOn: "2026-10-05" },
			}),
		),
	);
async function role(name: string) {
	const team = await insert("team", { name, state: "active", sort_order: 1 });
	return { team, id: await insert("team_role", { team_id: team, name: "Greeter", leadership: false, sort_order: 1 }) };
}
const assign = async (r: { team: string; id: string }, personId: string) =>
	ok(
		await tx(async (t) =>
			teamsWriter.assignRole(t, ctx(), {
				requestKey: key(),
				expectedRevision: await w.revisionOf("team_role", r.id),
				input: { roleId: r.id, teamId: r.team, personId },
			}),
		),
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

async function importedAndWalkIn() {
	const imported = await importOne(
		"first_name,last_name,email,phone\r\nJordan,Rivera,jordan@example.test,555 010 1000\r\n",
	);
	const night = await meeting("Vision night");
	const walkIn = ok(
		await tx((t) =>
			guestsWriter.createWalkInContact(t, ctx(), {
				requestKey: key(),
				input: { meetingId: night, displayName: "Jordan R." },
			}),
		),
	).guest.person.personId;
	ok(await invite(night, imported));
	ok(
		await tx(async (t) =>
			guestsWriter.correctRsvp(t, ctx(), {
				requestKey: key(),
				expectedRevision: await w.revisionOf(
					"participation",
					String(
						(
							await one(
								sql`SELECT id FROM participation WHERE meeting_id=${night}::uuid AND person_id=${imported}::uuid`,
							)
						).id,
					),
				),
				input: { meetingId: night, personId: imported, rsvp: "confirmed" },
			}),
		),
	);
	ok(await checkIn(night, imported));
	const finalized = ok(
		await tx(async (t) =>
			attendance.finalizeAttendance(t, ctx(), {
				requestKey: key(),
				expectedRevision: String(
					(await one(sql`SELECT attendance_revision::text AS r FROM meeting WHERE id=${night}::uuid`)).r,
				),
				input: { meetingId: night, attendeeIds: [imported, walkIn] },
			}),
		),
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
		await tx(async (t) =>
			personFields.createHouseholdWithHead(t, ctx(), {
				requestKey: key(),
				expectedRevision: (await personRow(walkIn)).revision,
				input: { name: "Rivera home", headPersonId: walkIn },
			}),
		),
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
		["rsvp_replaced", "combined"],
	);
	assert.equal(review.openFollowUps.length, 2, "both follow-ups are named before confirm");
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
	assert.equal(
		ok(
			await tx(async (t) => followUpReader.readObligations(t, await authority(), { meetingId: s.night, limit: 10 })),
		).items.filter((o) => o.kind === "first_vision_follow_up").length,
		2,
		"the other stays with the walk-in as history",
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
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId: source, kind: "core_group", occurredOn: "2026-09-20", notes: "Signed at lunch" },
			}),
		),
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
		await tx(async (t) =>
			guestsWriter.correctRsvp(t, ctx(), {
				requestKey: key(),
				expectedRevision: await w.revisionOf("participation", id),
				input: { meetingId: gathering, personId: guest, rsvp: "confirmed" },
			}),
		),
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
					await tx((t) =>
						commitments.createCommitment(t, ctx(), {
							requestKey: key(),
							input: { personId: p.source, kind: "core_group", occurredOn: "2026-10-01" },
						}),
					),
				).commitment;
				const merged = await w.merge(p.source, p.survivor);
				ok(
					await tx(async (t) =>
						recordCorrections.correctPersonRecord(t, ctx(), {
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
					),
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
					await tx((t) =>
						attendance.setAttendance(t, ctx(), {
							requestKey: key(),
							input: { meetingId: p.night, personId: p.survivor, presence: "excused" },
						}),
					),
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
					await tx(async (t) =>
						followups.recordOutcome(t, ctx(), {
							requestKey: key(),
							input: {
								target: { kind: "task", taskId: duty, expectedRevision: await w.revisionOf("task", duty) },
								outcome: "attempted_no_contact",
								channel: "phone",
								completeTask: false,
							},
						}),
					),
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
				ok(
					await tx((t) =>
						personFields.removeTag(t, ctx(), { requestKey: key(), input: { personId: p.survivor, tagId } }),
					),
				);
				return merged;
			},
		},
		household_deleted: {
			causes: ["household_deleted"],
			changed: [],
			run: async () => {
				const p = await pair("Household");
				const home = ok(
					await tx(async (t) =>
						personFields.createHouseholdWithHead(t, ctx(), {
							requestKey: key(),
							expectedRevision: (await personRow(p.source)).revision,
							input: { name: "Gone", headPersonId: p.source },
						}),
					),
				).result;
				assert.ok(home.status === "available");
				const householdId = home.household.id;
				const merged = await w.merge(p.source, p.survivor);
				ok(
					await tx(async (t) =>
						personFields.deleteHousehold(t, ctx(), {
							requestKey: key(),
							expectedRevision: await w.revisionOf("household", householdId),
							input: { householdId },
						}),
					),
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
