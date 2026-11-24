import test, { after } from "node:test";
import assert from "node:assert/strict";
import { frozenClock, instant } from "../../../../../packages/contracts/src/common/index.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
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
import { ok, type Actor } from "../../../../support/fixture.mts";
import { key, world, type Row } from "./support.mts";

const w = await world("wp091use");
const { write, P, ctx, tx, insert, person, personRow, db } = w;
after(() => w.database.close());
const reminders = async () => undefined;
const attendance = createAttendanceWriter({ reminders });
const tasks = createTaskWriter({ reminders });
const followups = createFollowUpWriter({ reminders });
const signals = createSignals();
const clock = frozenClock(instant.parse("2026-10-13T16:00:00.000Z"));
const launches = createLaunchWriter({ notices: async () => undefined as never, clock });
const authority = async (actor: Pick<Actor, "session"> = w.actors.admin) => {
	const found = await RequestActor.resolve(db, actor.session);
	assert.ok(found instanceof RequestActor);
	return found;
};
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
	await write.meetings((t, c) =>
		guestsWriter.inviteGuest(t, c, { requestKey: key(), input: { meetingId: meeting, personId: onMeeting } }),
	),
);
const otherTask = ok(
	await write.tasks((t, c) => tasks.create(t, c, { requestKey: key(), input: { title: "Call", category: "general" } })),
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
	"meeting invitation": (id) =>
		write.meetings((t, c) => guestsWriter.inviteGuest(t, c, request({ meetingId: meeting, personId: id }))),
	"meeting guest list": (id) =>
		write.meetings((t, c) => guestsWriter.addGuests(t, c, request({ meetingId: meeting, people: [id] }))),
	"meeting inviter": (id) =>
		write.meetings((t, c) =>
			guestsWriter.inviteGuest(t, c, request({ meetingId: meeting, personId: other, inviterPersonId: id })),
		),
	"meeting check-in": (id) =>
		write.meetings((t, c) => attendance.checkIn(t, c, request({ meetingId: meeting, personId: id }))),
	"meeting attendance": (id) =>
		write.meetings((t, c) =>
			attendance.captureAttendanceBatch(
				t,
				c,
				request({ meetingId: meeting, entries: [{ personId: id, presence: "attended" }] }),
			),
		),
	"meeting kit item": async (id) => {
		const body = await revised("meeting_kit_item", kit, {
			meetingId: meeting,
			itemId: kit,
			patch: { assigneePersonId: id },
		});
		return write.meetings((t, c) => meetingsWriter.updateKitItem(t, c, body));
	},
	"team meeting roster": (id) =>
		write.meetings((t, c) =>
			rosterWriter.copyTeamRoster(t, c, request({ meetingId: teamMeeting, add: [id], remove: [] })),
		),
	"task about a person": (id) =>
		write.tasks((t, c) =>
			tasks.create(t, c, request({ title: "Call", category: "general", relation: { kind: "person", id } })),
		),
	"task relation edit": async (id) => {
		const body = await revised("task", otherTask.id, {
			taskId: otherTask.id,
			patch: { relation: { kind: "person", id } },
		});
		return write.tasks((t, c) => tasks.edit(t, c, body));
	},
	"follow-up": (id) => write.followUps((t, c) => followups.createFollowUp(t, c, request({ personId: id }))),
	"follow-up outcome": (id) =>
		write.followUps((t, c) =>
			followups.recordOutcome(
				t,
				c,
				request({ target: { kind: "person", personId: id }, outcome: "attempted_no_contact", completeTask: false }),
			),
		),
	"team role": async (id) => {
		const body = await revised("team_role", role, { roleId: role, teamId: team, personId: id });
		return write.teams((t, c) => teamsWriter.assignRole(t, c, body));
	},
	"team leader": async (id) => {
		const body = await revised("team", team, { teamId: team, personId: id });
		return write.teams((t, c) => teamsWriter.appointLeader(t, c, body));
	},
	"training roster": async (id) =>
		write.teams(async (t, c) =>
			trainingWriter.setRequiredTrainingParticipants(t, c, {
				requestKey: key(),
				expectedRevision: await w.revisionOf("training_program", program),
				input: { programId: program, personIds: [id], rosterDigest: "0".repeat(64) },
			}),
		),
	"training completion": async (id) => {
		const body = await revised("training_program", program, {
			kind: "program",
			personId: id,
			programId: program,
			earnedOn: "2026-10-01",
		});
		return write.teams((t, c) => trainingWriter.attestCompletion(t, c, body));
	},
	"launch guest": async (id) => launches.addGuestAttendance(db, await authority(), request({ personId: id })),
	tag: (id) => write.people((t, c) => personFields.assignTag(t, c, request({ personId: id, tagId: tag }))),
	skill: (id) =>
		write.people((t, c) => personFields.addSkill(t, c, request({ personId: id, name: "Sound", category: "tech" }))),
	household: async (id) => {
		const body = await revised("person", id, { householdId: household, personId: id, role: "other" });
		return write.people((t, c) => personFields.addToHousehold(t, c, body));
	},
	"new household": async (id) => {
		const body = await revised("person", id, { name: "New home", headPersonId: id });
		return write.people((t, c) => personFields.createHouseholdWithHead(t, c, body));
	},
	guardian: async (id) => {
		const body = await onPerson(id, { guardianPersonId: other, contact: true });
		return write.people((t, c) => personFields.setGuardianContact(t, c, body));
	},
	note: async (id) => {
		const body = await onPerson(id, { body: "Late note" });
		return write.people((t, c) => peopleWriter.addNote(t, c, body));
	},
	details: async (id) => {
		const body = await onPerson(id, { patch: { city: "Elgin" } });
		return write.people((t, c) => peopleWriter.updatePerson(t, c, body));
	},
	assessment: (id) =>
		write.people((t, c) =>
			assessments.createAssessment(
				t,
				c,
				request({
					personId: id,
					occurredOn: "2026-10-01",
					committed: lens,
					compelled: lens,
					contagious: lens,
					courageous: lens,
				}),
			),
		),
	interview: (id) =>
		write.people((t, c) =>
			interviews.createInterview(
				t,
				c,
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
		),
	commitment: (id) =>
		write.people((t, c) =>
			commitments.createCommitment(t, c, request({ personId: id, kind: "core_group", occurredOn: "2026-10-01" })),
		),
	"commitment witness": (id) =>
		write.people((t, c) =>
			commitments.createCommitment(
				t,
				c,
				request({ personId: other, kind: "core_group", occurredOn: "2026-10-01", witness: { personId: id } }),
			),
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
