import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { frozenClock, instant } from "../../../../../packages/contracts/src/common/index.ts";
import { communicationWriter } from "../../../../../packages/domain/src/communication/index.ts";
import { createFollowUpWriter, followUpReader } from "../../../../../packages/domain/src/followups/index.ts";
import { createSignals } from "../../../../../packages/domain/src/intelligence/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../../../packages/domain/src/launch/index.ts";
import {
	createAttendanceWriter,
	guestsWriter,
	meetingsWriter,
	rosterWriter,
} from "../../../../../packages/domain/src/meetings/index.ts";
import {
	assessments,
	checkForDuplicates,
	commitments,
	interviews,
	peopleReader,
	peopleWriter,
	personFields,
} from "../../../../../packages/domain/src/people/index.ts";
import { createTaskWriter, taskReader } from "../../../../../packages/domain/src/tasks/index.ts";
import {
	teamsReader,
	teamsWriter,
	trainingReader,
	trainingWriter,
} from "../../../../../packages/domain/src/teams/index.ts";
import { sql } from "../../../../../packages/db/src/query.ts";
import {
	createConversation,
	EvryRefusal,
	evryActor,
	invokeRead,
	prepareProposal,
	submitTurn,
	type MailPort,
} from "../../../../../packages/evry/src/index.ts";
import { READ_DOMAINS } from "../../../../../packages/evry/src/catalog/catalog.ts";
import type { ReadAdapter } from "../../../../../packages/evry/src/catalog/types.ts";
import { claimDue } from "../../../../../packages/domain/src/jobs/queue.ts";
import { ok } from "../../../../support/fixture.mts";
import { key, world, type Row } from "./support.mts";

const w = await world("wp091use");
const { write, authority, P, ctx, tx, insert, person, personRow, db } = w;
after(() => w.database.close());
const reminders = async () => undefined;
const attendance = createAttendanceWriter({ reminders });
const tasks = createTaskWriter({ reminders });
const followups = createFollowUpWriter({ reminders });
const signals = createSignals();
const clock = frozenClock(instant.parse("2026-10-13T16:00:00.000Z"));
const launches = createLaunchWriter({ notices: async () => undefined as never, clock });
const NAME = "Zed Leaving";
const meeting = await insert("meeting", {
	type: "vision_meeting",
	title: "Night",
	local_date: "2026-10-01",
	local_time: "18:00",
	timezone: "America/Chicago",
	starts_at: "2026-10-01T23:00:00Z",
	resolver_version: "1",
	status: "in_progress",
	attendance_revision: 1,
});
const kit = await insert("meeting_kit_item", {
	meeting_id: meeting,
	item_key: "cards",
	position: 1,
	category: "materials",
	text: "Welcome cards",
});
const team = await insert("team", { name: "Hospitality", state: "active", sort_order: 1 });
const teamMeeting = await insert("meeting", {
	type: "team_meeting",
	title: "Team night",
	team_id: team,
	local_date: "2026-10-01",
	local_time: "18:00",
	timezone: "America/Chicago",
	starts_at: "2026-10-01T23:00:00Z",
	resolver_version: "1",
	status: "planning",
	attendance_revision: 1,
});
const role = await insert("team_role", { team_id: team, name: "Greeter", leadership: false, sort_order: 1 });
const program = await insert("training_program", { name: "Welcome", required: true });
const tag = await insert("tag", { name: "Volunteer", normalized_name: "volunteer" });
const household = await insert("household", { name: "Home" });
const other = await person("Other person");
const onMeeting = await person("On the meeting");
ok(
	await write.meetings(guestsWriter.inviteGuest, {
		requestKey: key(),
		input: { meetingId: meeting, personId: onMeeting },
	}),
);
const otherTask = ok(
	await write.tasks(tasks.create, { requestKey: key(), input: { title: "Call", category: "general" } }),
).task;
await w.admin.execute(sql`INSERT INTO launch(plant_id,status,target_date,actual_date,outcome_recorded_at)
	VALUES(${P},'completed','2026-10-11','2026-10-11','2026-10-12T12:00:00Z')`);
const lens = { score: 3, notes: null };
const criterion = { rating: "pass", notes: null };
const request = (input: Row) => ({ requestKey: key(), input });
const revised = async (table: string, id: string, input: Row) => ({
	requestKey: key(),
	expectedRevision: await w.revisionOf(table, id),
	input,
});
const onPerson = async (id: string, input: Row) => revised("person", id, { personId: id, ...input });

type Write = (id: string) => Promise<{ status: string }>;
const writes: Record<string, Write> = {
	"meeting invitation": (id) => write.meetings(guestsWriter.inviteGuest, request({ meetingId: meeting, personId: id })),
	"meeting guest list": (id) => write.meetings(guestsWriter.addGuests, request({ meetingId: meeting, people: [id] })),
	"meeting inviter": (id) =>
		write.meetings(guestsWriter.inviteGuest, request({ meetingId: meeting, personId: other, inviterPersonId: id })),
	"meeting check-in": (id) => write.meetings(attendance.checkIn, request({ meetingId: meeting, personId: id })),
	"meeting attendance": (id) =>
		write.meetings(
			attendance.captureAttendanceBatch,
			request({ meetingId: meeting, entries: [{ personId: id, presence: "attended" }] }),
		),
	"meeting kit item": async (id) => {
		const body = await revised("meeting_kit_item", kit, {
			meetingId: meeting,
			itemId: kit,
			patch: { assigneePersonId: id },
		});
		return write.meetings(meetingsWriter.updateKitItem, body);
	},
	"team meeting roster": (id) =>
		write.meetings(rosterWriter.copyTeamRoster, request({ meetingId: teamMeeting, add: [id], remove: [] })),
	"task about a person": (id) =>
		write.tasks(tasks.create, request({ title: "Call", category: "general", relation: { kind: "person", id } })),
	"task relation edit": async (id) => {
		const body = await revised("task", otherTask.id, {
			taskId: otherTask.id,
			patch: { relation: { kind: "person", id } },
		});
		return write.tasks(tasks.edit, body);
	},
	"follow-up": (id) => write.followUps(followups.createFollowUp, request({ personId: id })),
	"follow-up outcome": (id) =>
		write.followUps(
			followups.recordOutcome,
			request({ target: { kind: "person", personId: id }, outcome: "attempted_no_contact", completeTask: false }),
		),
	"team role": async (id) => {
		const body = await revised("team_role", role, { roleId: role, teamId: team, personId: id });
		return write.teams(teamsWriter.assignRole, body);
	},
	"team leader": async (id) => {
		const body = await revised("team", team, { teamId: team, personId: id });
		return write.teams(teamsWriter.appointLeader, body);
	},
	"training roster": async (id) =>
		write.teams(trainingWriter.setRequiredTrainingParticipants, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("training_program", program),
			input: { programId: program, personIds: [id], rosterDigest: "0".repeat(64) },
		}),
	"training completion": async (id) => {
		const body = await revised("training_program", program, {
			kind: "program",
			personId: id,
			programId: program,
			earnedOn: "2026-10-01",
		});
		return write.teams(trainingWriter.attestCompletion, body);
	},
	"launch guest": async (id) => launches.addGuestAttendance(db, await authority(), request({ personId: id })),
	tag: (id) => write.people(personFields.assignTag, request({ personId: id, tagId: tag })),
	skill: (id) => write.people(personFields.addSkill, request({ personId: id, name: "Sound", category: "tech" })),
	household: async (id) => {
		const body = await revised("person", id, { householdId: household, personId: id, role: "other" });
		return write.people(personFields.addToHousehold, body);
	},
	"new household": async (id) => {
		const body = await revised("person", id, { name: "New home", headPersonId: id });
		return write.people(personFields.createHouseholdWithHead, body);
	},
	guardian: async (id) => {
		const body = await onPerson(id, { guardianPersonId: other, contact: true });
		return write.people(personFields.setGuardianContact, body);
	},
	note: async (id) => {
		const body = await onPerson(id, { body: "Late note" });
		return write.people(peopleWriter.addNote, body);
	},
	details: async (id) => {
		const body = await onPerson(id, { patch: { city: "Elgin" } });
		return write.people(peopleWriter.updatePerson, body);
	},
	assessment: (id) =>
		write.people(
			assessments.createAssessment,
			request({
				personId: id,
				occurredOn: "2026-10-01",
				committed: lens,
				compelled: lens,
				contagious: lens,
				courageous: lens,
			}),
		),
	interview: (id) =>
		write.people(
			interviews.createInterview,
			request({
				personId: id,
				occurredOn: "2026-10-01",
				maturity: criterion,
				gifted: criterion,
				chemistry: criterion,
				rightReasons: criterion,
				season: criterion,
				result: "qualified",
			}),
		),
	commitment: (id) =>
		write.people(commitments.createCommitment, request({ personId: id, kind: "core_group", occurredOn: "2026-10-01" })),
	"commitment witness": (id) =>
		write.people(
			commitments.createCommitment,
			request({ personId: other, kind: "core_group", occurredOn: "2026-10-01", witness: { personId: id } }),
		),
	"leadership candidate": async (id) =>
		signals.attestCandidate(db, await authority(), {
			requestKey: key(),
			expectedRevision: "0",
			input: { personId: id, periodStart: "2026-07-01", periodEnd: "2026-10-01", attended: true, volunteered: true },
		}),
	merge: async (id) => w.mergeWith({ sourceId: id, survivorId: other, reviewDigest: "0".repeat(64) }),
};
async function leave(how: "retired" | "merged") {
	const id = await person(NAME, { adultClassification: "adult" });
	if (how === "retired") await w.retire(id);
	else await w.merge(id, await person("Survivor"));
	assert.equal((await personRow(id)).state, how);
	return id;
}

for (const how of ["retired", "merged"] as const)
	test(`no native write names a ${how} person`, async (t) => {
		const id = await leave(how);
		for (const [name, write] of Object.entries(writes))
			await t.test(name, async () => {
				const before = await w.everything();
				const reply = await write(id);
				assert.equal(reply.status, "refused", `${name}: ${JSON.stringify(reply)}`);
				assert.deepEqual(await w.changed(before), [], name);
			});
	});

test("the same writes work for a current person, so a refusal is about the person who left", async (t) => {
	for (const [name, write] of Object.entries(writes)) {
		if (["merge", "team meeting roster", "training roster", "training completion", "guardian"].includes(name)) continue;
		await t.test(name, async () => {
			const id = await person("Current person");
			ok(await write(id));
		});
	}
});

test("no picker offers a retired or merged person", async () => {
	const ids = [await leave("retired"), await leave("merged")];
	const current = await person("Zed Leavington");
	const actor = await authority();
	const reader = createLaunchReader(clock);
	const pickers: Record<string, () => Promise<unknown>> = {
		people: () => tx((t) => peopleReader.listPeople(t, ctx(), { search: "Zed Leav", view: "list" } as never)),
		duplicates: () => tx((t) => checkForDuplicates(t, ctx(), { displayName: NAME })),
		"task relations": () => tx((t) => taskReader.relationOptions(t, actor, { kind: "person", search: "Zed Leav" })),
		"team members": () => teamsReader.searchMembers(db, actor, { q: "Zed Leav" }),
		"team leaders": () => teamsReader.listLeaderCandidates(db, actor, { q: "Zed Leav" }),
		"training preview": () =>
			trainingReader.readRequiredTrainingPreview(db, actor, { programId: program, personIds: ids }),
		"follow-up coverage": () => tx((t) => followUpReader.followUpCoverage(t, actor, {})),
		messages: () => tx((t) => communicationWriter.readRecipients(t, actor, { query: "Zed Leav" })),
		"leadership candidates": async () =>
			(ok(await signals.readAttestations(db, actor, {})) as { people: unknown }).people,
		"launch guests": () => reader.suggestGuests(db, actor, "Zed Leav"),
	};
	const offered: string[] = [];
	for (const [name, read] of Object.entries(pickers)) {
		const text = JSON.stringify(await read());
		for (const id of ids) assert.equal(text.includes(id), false, `${name} offers a person who left`);
		if (text.includes(current)) offered.push(name);
	}
	assert.ok(offered.includes("people") && offered.includes("messages"), offered.join());
});

const readsOf = new Map(
	Object.values(READ_DOMAINS).flatMap((all) =>
		(all as readonly ReadAdapter<unknown>[]).map((a) => [a.operation, a] as const),
	),
);
const evryRead = async (operation: string, input: unknown) =>
	invokeRead(db, evryActor(await authority()), readsOf.get(operation)!, input);
const mail: MailPort = {
	keys: {
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: Buffer.alloc(32, 9),
		from: "church@example.test",
		origin: "https://app.example.test",
	},
	transport: {
		paused: false,
		send: async () => ({ outcome: "refused" }),
		cancel: async () => [],
		reschedule: async () => [],
	},
};
async function evryTurn() {
	const actor = evryActor(await authority(w.actors.owner));
	const c = await createConversation(db, actor, { requestKey: randomUUID() });
	await submitTurn(db, actor, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return (operation: string, input: unknown) =>
		prepareProposal(db, actor, lease, c.id, { operation, input }, mail).then(
			(p) => (p === null ? "nothing prepared" : (p.review.refusal ?? "prepared")),
			(error: unknown) => {
				if (error instanceof EvryRefusal) return error.code;
				throw error;
			},
		);
}
const openRole = await insert("team_role", { team_id: team, name: "Host", leadership: false, sort_order: 3 });
const given = { rating: "pass", notes: "Given" };
const scored = { score: 3, notes: "Given" };
const drafts: Record<string, (id: string) => [string, unknown]> = {
	"meeting invitation": (id) => ["meetings.inviteGuest", { meetingId: meeting, personId: id }],
	"meeting inviter": (id) => ["meetings.setInviter", { meetingId: meeting, personId: onMeeting, inviterPersonId: id }],
	"meeting check-in": (id) => ["meetings.checkIn", { meetingId: meeting, personId: id }],
	"meeting attendance": (id) => [
		"meetings.captureAttendanceBatch",
		{ meetingId: meeting, entries: [{ personId: id, presence: "attended" }] },
	],
	"meeting kit item": (id) => ["meetings.updateKitItem", { meetingId: meeting, itemId: kit, assigneePersonId: id }],
	"new meeting guests": (id) => [
		"meetings.schedule",
		{ type: "vision_meeting", date: "2026-10-20", time: "18:00", guestIds: [id] },
	],
	"follow-up": (id) => ["tasks.createFollowUp", { personId: id }],
	"follow-up outcome": (id) => [
		"followups.recordOutcome",
		{ personId: id, outcome: "attempted_no_contact", occurred: "now", completeTask: false },
	],
	"team role": (id) => ["teams.assignRole", { roleId: openRole, personId: id }],
	"team member": (id) => ["teams.assignMember", { teamId: team, roleId: openRole, personId: id }],
	"team leader": (id) => ["teams.appointLeader", { teamId: team, personId: id }],
	"training completion": (id) => [
		"teams.attestCompletion",
		{ personId: id, programId: program, earnedOn: "2026-10-01" },
	],
	"training roster": (id) => ["teams.setRequiredTrainingParticipants", { programId: program, personIds: [id] }],
	"launch guest": (id) => ["launch.addGuestAttendance", { personId: id }],
	tag: (id) => ["people.assignTag", { personIds: [id], tagId: tag }],
	skill: (id) => ["people.addSkill", { personId: id, name: "Sound", category: "tech" }],
	household: (id) => ["people.addToHousehold", { householdId: household, personId: id, role: "other" }],
	"new household": (id) => ["people.createHouseholdWithHead", { headPersonId: id, name: "New home" }],
	note: (id) => ["people.addNote", { personId: id, body: "Late note" }],
	details: (id) => ["people.updatePerson", { personId: id, patch: { city: "Elgin" } }],
	assessment: (id) => [
		"people.createAssessment",
		{
			personId: id,
			occurredOn: "2026-10-01",
			committed: scored,
			compelled: scored,
			contagious: scored,
			courageous: scored,
		},
	],
	interview: (id) => [
		"people.createInterview",
		{
			personId: id,
			occurredOn: "2026-10-01",
			maturity: given,
			gifted: given,
			chemistry: given,
			rightReasons: given,
			season: given,
			result: "qualified",
		},
	],
	commitment: (id) => ["people.createCommitment", { personId: id, kind: "core_group", occurredOn: "2026-10-01" }],
	"commitment witness": (id) => [
		"people.createCommitment",
		{ personId: other, kind: "core_group", occurredOn: "2026-10-01", witness: { personId: id } },
	],
	merge: (id) => ["people.mergePeople", { sourceId: id, survivorId: other }],
	email: (id) => [
		"communication.sendReviewed",
		{ subject: "Hello", body: "Hello", audience: { groups: [], teamIds: [], personIds: [id] } },
	],
	"invitation email": (id) => [
		"evry.prepareMeetingInvitation",
		{ meetingId: teamMeeting, audience: { groups: [], householdIds: [], personIds: [id] } },
	],
};

test("Evry prepares nothing that can be approved for a retired or merged person, and the same drafts work for a current one", async (t) => {
	await w.admin.execute(
		sql`UPDATE plant SET street='12 Mill Road',city='Austin',country='United States' WHERE id=${P}::uuid`,
	);
	const propose = await evryTurn();
	const left = { retired: await leave("retired"), merged: await leave("merged") };
	for (const [name, draft] of Object.entries(drafts))
		await t.test(name, async () => {
			const current = await person("Current person", { email: `${key()}@example.test` });
			assert.equal(await propose(...draft(current)), "prepared", "current");
			for (const [how, id] of Object.entries(left)) assert.notEqual(await propose(...draft(id)), "prepared", how);
		});
});

test("after a person is retired, Evry still names them on their meeting, task, team and profile", async () => {
	const name = "Rae Retired";
	const id = await person(name, { adultClassification: "adult" });
	ok(
		await write.meetings(guestsWriter.inviteGuest, { requestKey: key(), input: { meetingId: meeting, personId: id } }),
	);
	const task = ok(
		await write.tasks(tasks.create, {
			requestKey: key(),
			input: { title: "Call", category: "general", relation: { kind: "person", id } },
		}),
	).task;
	const rolled = await insert("team_role", { team_id: team, name: "Usher", leadership: false, sort_order: 2 });
	ok(
		await write.teams(
			teamsWriter.assignRole,
			await revised("team_role", rolled, { roleId: rolled, teamId: team, personId: id }),
		),
	);
	await w.retire(id);
	const shown: Record<string, [string, unknown]> = {
		meeting: ["meetings.listGuests", { meetingId: meeting }],
		task: ["tasks.get", { taskId: task.id }],
		team: ["teams.membershipHistory", { teamId: team }],
		profile: ["people.getPerson", { personId: id }],
	};
	for (const [where, [operation, input]] of Object.entries(shown))
		assert.ok(JSON.stringify((await evryRead(operation, input)).rows).includes(name), where);
});
