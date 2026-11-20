import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	prepareProposal,
	readReview,
	readStagedPhoto,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../../packages/evry/src/index.ts";
import { verifyPeople } from "../../../../../packages/evry/src/adapters/people/reads/index.ts";
import { transaction } from "../../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../../apps/web/src/server/jobs/queue.ts";
import {
	accounts,
	actor,
	admin,
	bucket,
	db,
	people,
	plant,
	png,
	queries,
	setup,
	sql,
	teardown,
} from "../../../runtime/support.mts";
import type { PrivateStorage } from "../../../../../packages/db/src/schema/storage.ts";

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(setup);
after(teardown);

const counted = (start: number) =>
	queries.slice(start).filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(q.trim())).length;

async function turn(who: EvryActor) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const run = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return {
		async propose(operation: string, input: unknown) {
			const start = queries.length;
			const proposal = await prepareProposal(db, who, run, c.id, { operation, input });
			assert.equal(counted(start), 1, operation);
			return proposal;
		},
	};
}

async function approveAndRun(who: EvryActor, proposal: Proposal, storage: PrivateStorage | null = null) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, storage);
	assert.equal(
		(await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, storage))
			.replayed,
		true,
	);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const start = queries.length;
	const outcome = await executeProposal(
		db,
		{
			jobId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		},
		noReminders,
	);
	const statements = counted(start);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], "the effect is queued once");
	return { outcome, statements, review: await readReview(db, who, proposal.id) };
}

async function effectAudits(proposalId: string) {
	const r = await admin.execute(
		sql`SELECT actor_id,action,subject_id FROM audit_event WHERE request_key LIKE ${"evry:" + proposalId + ":%"}`,
	);
	return r.rows as { actor_id: string; action: string; subject_id: string }[];
}
async function personRow(id: string) {
	const r = await admin.execute(
		sql`SELECT display_name,city,stage,state,photo_object_id,revision::text FROM person WHERE id=${id}`,
	);
	return r.rows[0] as Record<string, string | null>;
}
async function addPerson(name: string, stage = "prospect") {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${plant},${plant},${name},'other',clock_timestamp(),${stage},'unknown','unknown',1000,'live')`);
	return id;
}
async function openTask(personId: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
		VALUES(${id},${plant},'Call back','follow_up','medium','not_started',clock_timestamp(),'undated',${personId})`);
	return id;
}

test("INV-budget: a proposed person is created only after approval, once, with its audit row", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const before = (await admin.execute<{ n: number }>(sql`SELECT count(*)::int n FROM person WHERE plant_id=${plant}`))
		.rows[0]!.n;
	const proposal = await t.propose("people.createPerson", { displayName: "Jamie Park", city: "Oak Park" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review, {
		target: null,
		changes: [
			{ field: "displayName", before: null, after: "Jamie Park" },
			{ field: "city", before: null, after: "Oak Park" },
			{ field: "stage", before: null, after: "prospect" },
			{ field: "source", before: null, after: "other" },
			{ field: "adultClassification", before: null, after: "unknown" },
		],
	});
	const count = async () =>
		(await admin.execute<{ n: number }>(sql`SELECT count(*)::int n FROM person WHERE plant_id=${plant}`)).rows[0]!.n;
	assert.equal(await count(), before, "nothing changes before approval");

	const { outcome, statements, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	const created = await admin.execute(
		sql`SELECT id,city,stage FROM person WHERE plant_id=${plant} AND display_name='Jamie Park'`,
	);
	assert.deepEqual(
		created.rows.map((r) => [r.city, r.stage]),
		[["Oak Park", "prospect"]],
	);
	assert.equal(await count(), before + 1);
	assert.deepEqual(await effectAudits(proposal.id), [
		{ actor_id: owner.accountId, action: "people.created", subject_id: created.rows[0]!.id },
	]);
	assert.deepEqual([review.status, review.outcome, review.review.target], ["approved", "completed", null]);
	console.log(JSON.stringify({ effect: "people.createPerson", statements }));
	assert.equal(statements, 5);

	const member = await actor("member");
	await assert.rejects(
		() =>
			prepareProposal(
				db,
				member,
				{ turnId: randomUUID(), tenantId: plant, leaseOwner: "x", generation: "1" },
				randomUUID(),
				{
					operation: "people.createPerson",
					input: { displayName: "Nobody" },
				},
			),
		(e: { code?: string }) => e.code === "access_denied",
	);
});

test("INV-budget: a stage change hands the person's open tasks back as reviewed, in a fixed statement count", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const statements: number[] = [];
	for (const tasks of [1, 3]) {
		const id = await addPerson(`Core ${tasks}`, "core_group");
		const taskIds = await Promise.all(Array.from({ length: tasks }, () => openTask(id)));
		const proposal = await t.propose("people.changeStatus", { personId: id, stage: "attendee", reason: "Moved away" });
		assert.ok(proposal);
		assert.deepEqual(proposal.review.changes, [
			{ field: "stage", before: "core_group", after: "attendee" },
			{ field: "reason", before: null, after: "Moved away" },
			{ field: "openTasksNeedingOwner", before: null, after: tasks },
		]);
		const run = await approveAndRun(owner, proposal);
		assert.equal(run.outcome, "completed");
		statements.push(run.statements);
		assert.equal((await personRow(id)).stage, "attendee");
		const handed = await admin.execute(
			sql`SELECT count(*)::int n FROM task WHERE person_id=${id} AND NOT EXISTS(SELECT FROM task_assignee a WHERE a.task_id=task.id) AND revision=2`,
		);
		assert.equal(handed.rows[0]!.n, taskIds.length);
		assert.deepEqual(
			(await effectAudits(proposal.id)).map((a) => a.action),
			["people.stage_changed"],
		);
	}
	console.log(JSON.stringify({ effect: "people.changeStatus", statements }));
	assert.deepEqual(statements, [7, 7], "the effect does not grow with the number of open tasks");

	const proposal = await t.propose("people.changeStatus", {
		personId: people.casey,
		stage: "attendee",
		reason: "Came twice",
	});
	assert.equal(proposal?.review.changes.length, 2);
	const late = await addPerson("Core late", "core_group");
	const review = await t.propose("people.changeStatus", { personId: late, stage: "prospect", reason: "Paused" });
	assert.ok(review);
	await openTask(late);
	const refused = await approveAndRun(owner, review);
	assert.deepEqual(
		[refused.outcome, refused.review.outcome, (await personRow(late)).stage],
		["refused", "refused", "core_group"],
	);
	assert.deepEqual(await effectAudits(review.id), []);
});

test("AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-RETIRE a retirement runs once on the reviewed person; its receipt stays and nothing retargets", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const p1 = await addPerson("Alex Rivera (P1)");
	const p2 = await addPerson("Alex Chen (P2)");
	await openTask(p2);
	const proposal = await t.propose("people.deletePerson", { personId: p2, reason: "Duplicate entry" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review, {
		target: { kind: "person", id: p2, label: "Alex Chen (P2)" },
		changes: [
			{ field: "state", before: "live", after: "retired" },
			{ field: "reason", before: null, after: "Duplicate entry" },
			{ field: "openTasksNeedingOwner", before: null, after: 1 },
		],
	});
	const p1Before = await personRow(p1);
	const { outcome, statements, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	console.log(JSON.stringify({ effect: "people.deletePerson", statements }));
	assert.equal(statements, 8);
	assert.deepEqual([(await personRow(p2)).state, await personRow(p1)], ["retired", p1Before]);
	assert.deepEqual(await effectAudits(proposal.id), [
		{ actor_id: owner.accountId, action: "people.retired", subject_id: p2 },
	]);
	assert.deepEqual([review.outcome, review.review.target, review.review.withheld], ["completed", null, true]);
	assert.ok(review.receipt?.receiptId);
	assert.deepEqual(
		(await verifyPeople(db, owner, [p1, p2])).map((r) => r.id),
		[p1],
	);
	assert.equal(await t.propose("people.deletePerson", { personId: p2, reason: "Again" }), null);
	assert.equal(await t.propose("people.updatePerson", { personId: p2, patch: { city: "Elgin" } }), null);
});

test("AC:PROVIDER48-002 a photo change uses only this church's own verified upload and runs once; removal releases it", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const photos = bucket();
	const upload = (await photos.upload(png)).id;
	const foreign = randomUUID();
	await admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation,expires_at)
		SELECT ${foreign},plant_id,'person_photo','private/'||plant_id||'/'||gen_random_uuid(),'image/png',100,100,${"0".repeat(64)},'ready',${foreign},0,clock_timestamp()+interval '15 minutes'
		FROM person WHERE id=${people.foreign}`);
	assert.equal(await t.propose("people.setPersonPhoto", { personId: people.alexRivera, uploadId: foreign }), null);
	assert.equal(await t.propose("people.removePersonPhoto", { personId: people.alexRivera }), null, "no photo yet");

	const set = await t.propose("people.setPersonPhoto", { personId: people.alexRivera, uploadId: upload });
	assert.ok(set);
	assert.deepEqual(set.review.changes, [{ field: "photo", before: null, after: upload }]);
	assert.equal((await personRow(people.alexRivera)).photo_object_id, null, "nothing changes before approval");
	const first = await approveAndRun(owner, set, photos.storage);
	assert.equal(first.outcome, "completed");
	assert.equal((await personRow(people.alexRivera)).photo_object_id, upload);

	const remove = await t.propose("people.removePersonPhoto", { personId: people.alexRivera });
	assert.ok(remove);
	assert.deepEqual(remove.review.changes, [{ field: "photo", before: upload, after: null }]);
	const second = await approveAndRun(owner, remove);
	assert.equal(second.outcome, "completed");
	assert.equal((await personRow(people.alexRivera)).photo_object_id, null);
	const cleanup = await admin.execute(
		sql`SELECT count(*)::int n FROM job WHERE kind='object_cleanup' AND subject_record_id=${upload}`,
	);
	assert.equal(cleanup.rows[0]!.n, 1, "the released object is queued for cleanup");
	assert.deepEqual(
		[...(await effectAudits(set.id)), ...(await effectAudits(remove.id))].map((a) => a.action),
		["people.updated", "people.updated"],
	);
	console.log(
		JSON.stringify({
			effect: "people.setPersonPhoto/removePersonPhoto",
			statements: [first.statements, second.statements],
		}),
	);
	assert.deepEqual([first.statements, second.statements], [6, 6]);
});

test("AC:UI45-003 a photo proposal's owner sees the exact staged upload while the review lasts; approval needs it", async () => {
	const owner = await actor("owner");
	const t = await turn(owner);
	const photos = bucket();
	const other = Buffer.concat([png, Buffer.from("second upload")]);
	const [a, b] = [await photos.upload(png), await photos.upload(other)];
	const target = await addPerson("Robin Photo");
	const first = await t.propose("people.setPersonPhoto", { personId: target, uploadId: a.id });
	const second = await t.propose("people.setPersonPhoto", { personId: target, uploadId: b.id });
	assert.ok(first && second);

	const start = queries.length;
	const shown = await readStagedPhoto(db, photos.storage, owner, first.id);
	console.log(JSON.stringify({ read: "evry.readStagedPhoto", statements: counted(start) }));
	assert.equal(counted(start), 5);
	assert.deepEqual([Buffer.from(shown.bytes), shown.mediaType], [png, "image/png"]);
	assert.deepEqual(Buffer.from((await readStagedPhoto(db, photos.storage, owner, second.id)).bytes), other);

	const refusal = (p: Promise<unknown>) =>
		p.then(
			() => "delivered",
			(e: { code?: string }) => e.code,
		);
	for (const who of ["member", "foreign"] as const)
		assert.equal(await refusal(readStagedPhoto(db, photos.storage, await actor(who), first.id)), "not_found", who);
	await admin.execute(
		sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${accounts.owner.session}`,
	);
	try {
		assert.equal(await refusal(readStagedPhoto(db, photos.storage, owner, first.id)), "not_found", "signed out");
		assert.equal(
			await refusal(
				approveProposal(db, owner, first.id, { revision: first.revision, digest: first.digest }, photos.storage),
			),
			"not_found",
		);
	} finally {
		await admin.execute(
			sql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '1 day' WHERE id=${accounts.owner.session}`,
		);
	}

	photos.objects.delete(b.key);
	assert.equal(await refusal(readStagedPhoto(db, photos.storage, owner, second.id)), "not_found");
	const witness = { revision: second.revision, digest: second.digest };
	assert.equal(await refusal(approveProposal(db, owner, second.id, witness, photos.storage)), "photo_unavailable");
	assert.equal(await refusal(approveProposal(db, owner, second.id, witness, null)), "photo_unavailable");
	assert.equal((await readReview(db, owner, second.id)).status, "pending");
	const c = await photos.upload(png);
	const third = await t.propose("people.setPersonPhoto", { personId: target, uploadId: c.id });
	assert.ok(third);
	await admin.execute(sql`UPDATE file_object SET state='cleanup' WHERE id=${c.id}`);
	assert.equal(
		await refusal(
			approveProposal(db, owner, third.id, { revision: third.revision, digest: third.digest }, photos.storage),
		),
		"photo_unavailable",
	);
	const queued = await admin.execute(
		sql`SELECT count(*)::int n FROM job WHERE kind='evry_effect' AND (producer_key LIKE ${second.id + ":%"} OR producer_key LIKE ${third.id + ":%"})`,
	);
	assert.equal(queued.rows[0]!.n, 0, "a refused approval queues nothing");

	const begin = queries.length;
	const approved = await approveProposal(
		db,
		owner,
		first.id,
		{ revision: first.revision, digest: first.digest },
		photos.storage,
	);
	console.log(JSON.stringify({ write: "evry.approveProposal(people.setPersonPhoto)", statements: counted(begin) }));
	assert.equal(counted(begin), 7);
	assert.deepEqual([approved.replayed, approved.proposal.status], [false, "approved"]);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the approved photo change is queued");
	const outcome = await executeProposal(
		db,
		{
			jobId: claim.id,
			tenantId: claim.tenant_id,
			leaseOwner: claim.lease_owner,
			generation: claim.claim_generation,
		},
		noReminders,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "completed");
	assert.equal((await personRow(target)).photo_object_id, a.id, "approve saves that exact upload");
	assert.equal(await refusal(readStagedPhoto(db, photos.storage, owner, first.id)), "not_found");
});
