import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { claimDue } from "../../../../packages/domain/src/jobs/queue.ts";
import { guestsWriter } from "../../../../packages/domain/src/meetings/index.ts";
import { createTaskWriter } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsWriter } from "../../../../packages/domain/src/teams/index.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import {
	createConversation,
	EvryRefusal,
	evryActor,
	invokeRead,
	prepareProposal,
	submitTurn,
	type MailPort,
} from "../../../../packages/evry/src/index.ts";
import { READ_DOMAINS } from "../../../../packages/evry/src/catalog/catalog.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { ok } from "../../../support/fixture.mts";
import { key, world } from "../../../integration/target/sql/core/support.mts";

const w = await world("wp091evry");
const { write, authority, P, insert, person, personRow, db } = w;
after(() => w.database.close());
const tasks = createTaskWriter({ reminders: async () => undefined });
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
await w.admin.execute(sql`INSERT INTO launch(plant_id,status,target_date,actual_date,outcome_recorded_at)
	VALUES(${P},'completed','2026-10-11','2026-10-11','2026-10-12T12:00:00Z')`);
async function leave(how: "retired" | "merged") {
	const id = await person("Zed Leaving", { adultClassification: "adult" });
	if (how === "retired") await w.retire(id);
	else await w.merge(id, await person("Survivor"));
	assert.equal((await personRow(id)).state, how);
	return id;
}

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
		await write.teams(teamsWriter.assignRole, {
			requestKey: key(),
			expectedRevision: await w.revisionOf("team_role", rolled),
			input: { roleId: rolled, teamId: team, personId: id },
		}),
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
