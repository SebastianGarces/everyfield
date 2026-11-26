import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { debriefRequest, type DebriefAnswers } from "../../../packages/contracts/src/launch/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	readReview,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import { fixture, ok, refused, type Actor, type Workspace } from "../../support/fixture.mts";

const DAY = 86_400_000;
const OPERATION = "launch.saveDebriefDraft";
const BLANK: DebriefAnswers = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const reader = createLaunchReader();
const writer = createLaunchWriter({ notices: async () => undefined });
let f: Awaited<ReturnType<typeof fixture>>;

before(async () => {
	f = await fixture({ prefix: "writepolicy", max: 6 });
});
after(() => f?.close());

async function authority(a: Pick<Actor, "session">) {
	const actor = await RequestActor.resolve(f.pools.runtime, a.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
}
const planOf = async (a: Actor) => ok(await reader.readPlan(f.pools.runtime, await authority(a))).plan;
async function launchedPlant() {
	const plant = await f.plant({ timezone: "UTC" });
	const actors = {
		owner: await f.actor(plant, "owner"),
		admin: await f.actor(plant, "admin"),
		member: await f.actor(plant, "member"),
	};
	const who = await authority(actors.owner);
	const save = { requestKey: randomUUID(), expectedRevision: "1", input: { date: day(-3), reason: null } };
	ok(await writer.schedule(f.pools.runtime, who, save));
	ok(
		await writer.recordOutcome(f.pools.runtime, who, {
			requestKey: randomUUID(),
			expectedRevision: (await planOf(actors.owner)).revision,
			input: { actualDate: day(-2), attendance: 40, decisions: null, note: null },
		}),
	);
	return { plant, actors };
}
const footprint = async (plant: Workspace) =>
	(
		await f.admin.execute(sql`SELECT (SELECT count(*)::int FROM launch_debrief WHERE plant_id=${plant.id}) AS debriefs,
			(SELECT count(*)::int FROM audit_event WHERE tenant_id=${plant.id} AND subject_type='launch_debrief') AS audits,
			(SELECT count(*)::int FROM proposal WHERE tenant_id=${plant.id}) AS proposals,
			(SELECT count(*)::int FROM job WHERE tenant_id=${plant.id} AND kind NOT IN ('assistant_turn','evry_effect')) AS jobs,
			(SELECT count(*)::int FROM mail WHERE tenant_id=${plant.id}) AS mail`)
	).rows[0] as Record<string, number>;

async function propose(a: Actor, input: object) {
	const db = f.pools.runtime;
	const who = evryActor(await authority(a));
	const conversation = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, conversation.id, { requestKey: randomUUID(), text: "Save the debrief draft" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	try {
		return await prepareProposal(db, who, lease, conversation.id, { operation: OPERATION, input });
	} finally {
		await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	}
}
async function approve(a: Actor, card: NonNullable<Awaited<ReturnType<typeof propose>>>) {
	const db = f.pools.runtime;
	const who = evryActor(await authority(a));
	await approveProposal(db, who, card.id, { revision: card.revision, digest: card.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: async () => undefined, phaseNotices: async () => undefined },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	const review = await readReview(db, who, card.id);
	return { outcome, code: review.receipt?.code ?? null };
}
const request = (draft: { id: string; revision: string } | null, answers: Partial<DebriefAnswers>) => ({
	requestKey: randomUUID(),
	expectedRevision: draft?.revision ?? "0",
	input: { draftId: draft?.id ?? null, answers: { ...BLANK, ...answers } },
});
const draftOf = async (a: Actor) => {
	const { draft } = (await planOf(a)).debrief!;
	return draft && { id: draft.id, revision: draft.revision, answers: draft.answers };
};

test("AC:WP006-API-KNOW-116 AC:WP006-KNOW-116 saving a Launch debrief draft has one policy, native and through Evry", async (t) => {
	const { plant, actors } = await launchedPlant();
	const db = f.pools.runtime;
	const native = async (a: Actor, raw: unknown) => writer.saveDebriefDraft(db, await authority(a), raw);

	for (const role of ["owner", "admin"] as const)
		await t.test(`${role} is allowed, natively and through Evry, and a retry writes nothing more`, async () => {
			const a = actors[role];
			const first = request(await draftOf(a), { wentWell: `native ${role}` });
			const before = await footprint(plant);
			assert.equal(ok(await native(a, first)).outcome, "changed");
			const saved = await draftOf(a);
			assert.equal(saved?.answers.wentWell, `native ${role}`);
			assert.equal(ok(await native(a, first)).outcome, "changed");
			assert.deepEqual(await draftOf(a), saved);
			const written = await footprint(plant);
			assert.deepEqual(written, { ...before, debriefs: 1, audits: before.audits! + 1 });

			const card = await propose(a, { wentWell: `Evry ${role}` });
			assert.ok(card);
			assert.equal(card.review.refusal, undefined);
			assert.deepEqual(await draftOf(a), saved, "a card alone saves nothing");
			assert.deepEqual(await approve(a, card), { outcome: "completed", code: null });
			assert.equal((await draftOf(a))?.answers.wentWell, `Evry ${role}`);
			assert.equal((await footprint(plant)).audits, written.audits! + 1);
			const again = { revision: card.revision, digest: card.digest };
			await approveProposal(db, evryActor(await authority(a)), card.id, again, null);
			assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], "approving again queues nothing");
			assert.equal((await footprint(plant)).audits, written.audits! + 1, "approving again saves nothing more");
		});

	await t.test("Member and another church's Admin are refused at both entry points with nothing written", async () => {
		const foreign = (await launchedPlant()).actors.admin;
		const draft = await draftOf(actors.owner);
		const before = await footprint(plant);
		const error = refused(await native(actors.member, request(draft, { wentWell: "Member" })), "access_denied");
		assert.equal(JSON.stringify(error).includes("Evry admin"), false);
		await assert.rejects(propose(actors.member, { wentWell: "Member" }), { code: "access_denied" });
		refused(await native(foreign, request(draft, { wentWell: "Foreign" })), "conflict");
		const own = await propose(foreign, { wentWell: "Foreign" });
		assert.equal(JSON.stringify(own).includes("Evry admin"), false);
		assert.deepEqual(await footprint(plant), before);
		assert.deepEqual(await draftOf(actors.owner), draft);
	});

	await t.test("a seat that ended since the card cannot approve it or save natively", async () => {
		const leaving = await f.actor(plant, "admin");
		const card = await propose(leaving, { wentWell: "Leaving" });
		assert.ok(card);
		const held = await authority(leaving);
		const draft = await draftOf(actors.owner);
		const { audits } = await footprint(plant);
		await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${leaving.id}::uuid`);
		refused(await writer.saveDebriefDraft(db, held, request(draft, { wentWell: "Leaving" })), "access_denied");
		await assert.rejects(
			approveProposal(db, evryActor(held), card.id, { revision: card.revision, digest: card.digest }, null),
		);
		assert.equal((await footprint(plant)).audits, audits);
		assert.deepEqual(await draftOf(actors.owner), draft);
	});

	await t.test("a draft changed since it was reviewed is refused at both entry points and kept", async () => {
		const reviewed = await draftOf(actors.admin);
		const card = await propose(actors.admin, { wentWell: "Reviewed earlier" });
		assert.ok(card);
		ok(await native(actors.owner, request(reviewed, { wentWell: "Saved since" })));
		const current = await draftOf(actors.owner);
		const { audits } = await footprint(plant);
		refused(await native(actors.admin, request(reviewed, { wentWell: "Reviewed earlier" })), "conflict");
		assert.deepEqual(await approve(actors.admin, card), { outcome: "refused", code: "revision_conflict" });
		assert.deepEqual(await draftOf(actors.owner), current);
		assert.equal((await footprint(plant)).audits, audits);
	});

	await t.test("the approved card holds exactly the native request, and its input carries no authority", async () => {
		const draft = await draftOf(actors.admin);
		assert.ok(draft);
		const card = await propose(actors.admin, { toChange: "Open the doors earlier" });
		assert.ok(card);
		const wanted = request(draft, { ...draft.answers, toChange: "Open the doors earlier" });
		const [stored] = (await f.admin.execute(sql`SELECT input FROM proposal WHERE id=${card.id}::uuid`)).rows as {
			input: { expectedRevision: string } & Record<string, unknown>;
		}[];
		const { expectedRevision, ...input } = stored!.input;
		assert.deepEqual(
			debriefRequest.parse({ requestKey: wanted.requestKey, expectedRevision, input }),
			debriefRequest.parse(wanted),
		);
		for (const extra of [
			{ approved: true },
			{ expectedRevision: "0" },
			{ accountId: actors.owner.id },
			{ role: "owner" },
			{ plantId: plant.id },
		])
			await assert.rejects(propose(actors.admin, { toChange: "x", ...extra }), { code: "invalid_input" });
		assert.equal((await native(actors.admin, { ...wanted, approved: true })).status, "refused");
		assert.equal((await native(actors.admin, { ...wanted, expectedRevision: undefined })).status, "refused");
		assert.deepEqual(await draftOf(actors.admin), draft);
	});
});
