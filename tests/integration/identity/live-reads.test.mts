import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "./invitations-support.mts";
import { readOwnResidency } from "../../../packages/domain/src/access/index.ts";
import { createTaskWriter, taskReader, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { sectionOperations } from "../../../packages/domain/src/settings/sections.ts";
import { evryActor } from "../../../packages/evry/src/context/actor.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import { listPeople } from "../../../packages/evry/src/adapters/people/reads/index.ts";
import {
	createConversation,
	latestConversation,
	listConversations,
	readConversation,
} from "../../../packages/evry/src/conversations/store.ts";

let f;
before(async () => {
	f = await fixture();
});
after(() => f?.close());

const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};

// People reads have their own 42-path check in tests/integration/people/people.test.mts.
test("INV-reads (C22, C27): Tasks, Settings, Evry and residency reads hold no lock on the reader's session, so sign-out never waits for them", async () => {
	const plant = await f.workspace(),
		org = await f.workspace("sending_church");
	const seated = async (w, role) => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	const owner = await seated(plant, "owner"),
		orgOwner = await seated(org, "owner");
	const task = ok(
		await withTaskWrite(f.db, owner.actor, (tx, ctx) =>
			createTaskWriter({ reminders: async () => {} }).create(tx, ctx, {
				requestKey: randomUUID(),
				input: { title: "C22 task" },
			}),
		),
	).task;
	const team = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${plant.id},'Worship','active',0)`,
	);
	await f.admin.execute(
		sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings,consent_revision,revision)
			VALUES(${plant.id},${org.id},clock_timestamp(),true,false,false,false,false,false,false,1,1)`,
	);
	const evry = evryActor(owner.actor);
	const conversation = await createConversation(f.db, evry, { requestKey: randomUUID(), title: "C22" });
	// A resident's own residency link in a sending network.
	const s = await f.setup("sending_network"),
		resident = await f.resident(s.w),
		i = await f.invitation(s, resident);
	const accepted = await f.invitations.respondResident(s.recipient.session, {
		...i.claim,
		input: { ...i.claim.input, decision: "accept", choices: { shareFoundations: false, shareMilestones: false } },
	});
	assert.equal(accepted.status, "accepted");
	const residentActor = await f.actor(s.recipient.session);

	const settings = sectionOperations({ suppression: async () => "unavailable" } as never);
	const principal = { display_name: "Synthetic", email: "c22@example.test", verified: true };
	const section = (who, request) => (tx) =>
		settings.getSection(tx, { authority: who.actor, principal }, request).then(ok);
	const tasks = (op, input?) => (tx) => taskReader[op](tx, owner.actor, input).then(ok);
	// Each read runs inside an open transaction, where a session lock would last until COMMIT.
	const reads: [string, (tx) => Promise<unknown>][] = [
		["tasks get", tasks("get", { taskId: task.id })],
		["tasks list", tasks("list", {})],
		["tasks count", tasks("count", {})],
		["tasks statusHistory", tasks("statusHistory", { taskId: task.id })],
		["tasks listSubtasks", tasks("listSubtasks", { parentId: task.id })],
		["tasks listPrerequisites", tasks("listPrerequisites", { taskId: task.id })],
		["tasks findOpenOccurrence", tasks("findOpenOccurrence", { taskId: task.id })],
		["tasks eligibleAssignees", tasks("eligibleAssignees")],
		["tasks relationOptions", tasks("relationOptions", { kind: "person" })],
		["tasks prerequisiteCandidates", tasks("prerequisiteCandidates", { taskId: task.id })],
		["settings account", section(owner, { section: "account" })],
		["settings notifications", section(owner, { section: "notifications" })],
		["settings plant", section(owner, { section: "plant", plant })],
		["settings teams", section(owner, { section: "teams", plant, teamId: team })],
		["settings affiliations", section(owner, { section: "affiliations", plant, organization: org })],
		["settings organization", section(orgOwner, { section: "organization", organization: org })],
		["evry listConversations", (tx) => listConversations(tx, evry, {})],
		["evry readConversation", (tx) => readConversation(tx, evry, conversation.id)],
		["evry latestConversation", (tx) => latestConversation(tx, evry)],
		["evry invokeRead", (tx) => invokeRead(tx, evry, listPeople, {})],
		["readOwnResidency", (tx) => readOwnResidency(tx, s.recipient.session, s.w, { personId: resident })],
		[
			"readOwnResidency observed",
			(tx) => {
				residentActor.observe(tx);
				return readOwnResidency(tx, s.recipient.session, s.w, { personId: resident });
			},
		],
	];
	const sessions = [owner.session, orgOwner.session, s.recipient.session];
	const waited = [];
	for (const [name, read] of reads)
		await f.db.transaction(async (tx) => {
			assert.ok(await read(tx), name);
			// The read's transaction is still open: a sign-out or session refresh must not wait for it.
			try {
				await f.admin.transaction(async (a) => {
					await a.execute(sql`SET LOCAL lock_timeout='250ms'`);
					await a.execute(sql`UPDATE auth_session SET expires_at=expires_at WHERE id=ANY(${sql.param(sessions)}::uuid[])`);
				});
			} catch {
				waited.push(name);
			}
		});
	assert.deepEqual(waited, []);
});
