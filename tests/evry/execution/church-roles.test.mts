import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { claimDue, finishClaim, queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { deletionOperations } from "../../../packages/domain/src/settings/index.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	EvryRefusal,
	executeProposal,
	prepareProposal,
	readCatalog,
	readReview,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { CHURCH_COMMANDS } from "../../../packages/evry/src/adapters/settings/commands/index.ts";
import { RELATIONSHIP_COMMANDS } from "../../../packages/evry/src/adapters/relationships/commands/index.ts";
import { SHARING_COMMANDS } from "../../../packages/evry/src/adapters/sharing/commands/index.ts";
import type { ReviewedWrite } from "../../../packages/evry/src/proposals/types.ts";
import { seeds } from "../../support/fixture.mts";
import { goldenChurch, NETWORK, PLANT, type GoldenChurch } from "../evals/golden-church.mts";
import { nativePorts } from "../evals/settings-ports.mts";

const native = nativePorts();
const plant = { kind: "plant", id: PLANT } as const;
let church: GoldenChurch;
let roles: Record<"admin" | "member" | "foreign" | "networkMember" | "seatless" | "revoked", EvryActor>;
before(async () => {
	church = await goldenChurch({ seatNames: true });
	const seed = seeds(church.admin as never);
	const actor = async (who: { session: string }) => {
		const found = await RequestActor.resolve(church.db, who.session as never);
		assert.ok(found instanceof RequestActor);
		return evryActor(found);
	};
	const revoked = await seed.actor(plant, "admin");
	const seatless = await seed.actor(null);
	roles = {
		admin: church.actors.admin,
		member: church.actors.member,
		foreign: church.actors.other,
		networkMember: await actor(
			await seed.actor({ kind: "organization", id: NETWORK, organizationKind: "sending_network" }, "member"),
		),
		seatless: await actor(seatless),
		revoked: await actor(revoked),
	};
	const lead = randomUUID();
	await church.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,
		commitment_state,pipeline_position,state) VALUES(${lead},${PLANT},${PLANT},'Lara Lead','other',clock_timestamp(),'leader','adult','unknown',9001,'live')`);
	await church.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,
		commitment_state,pipeline_position,state,linked_account_id) VALUES(${randomUUID()},${PLANT},${PLANT},'Liam Lead','other',clock_timestamp(),
		'leader','adult','unknown',9002,'live',${seatless.id})`);
	await church.admin.execute(
		sql`WITH g AS (INSERT INTO team(plant_id,name,state,sort_order) VALUES(${PLANT},'Church leadership','active',90) RETURNING id),
			r AS (INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order) SELECT ${PLANT},id,'Lead planter',true,0 FROM g RETURNING id)
			INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) SELECT ${PLANT},id,${lead},'2026-01-01' FROM r`,
	);
	await church.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${revoked.id}`);
});
after(() => church?.close());

const rows = async (q: ReturnType<typeof sql>) => (await church.admin.execute(q)).rows;
const state = async () => ({
	plant: await rows(sql`SELECT * FROM plant WHERE id=${PLANT}`),
	links: await rows(sql`SELECT * FROM affiliation WHERE plant_id=${PLANT} ORDER BY id`),
	seats: await rows(sql`SELECT * FROM seat WHERE plant_id=${PLANT} AND ended_at IS NULL ORDER BY id`),
	deletions: await rows(sql`SELECT * FROM lifecycle_witness ORDER BY id`),
	audits: await rows(sql`SELECT * FROM audit_event WHERE action NOT LIKE 'evry.%' ORDER BY id`),
	notices: await rows(sql`SELECT count(*)::int n FROM notice`),
	mail: await rows(sql`SELECT count(*)::int n FROM mail`),
});
async function nothing(body: () => Promise<unknown>) {
	const before = await state();
	await body();
	assert.deepEqual(await state(), before, "nothing in the church changed");
}

type Action = {
	name: string;
	write: ReviewedWrite<never>;
	input: object;
	again: object;
	native: (tx: never, context: never, request: never) => Promise<unknown>;
	saved: () => Promise<unknown>;
	expected: unknown;
};
const one = async (q: ReturnType<typeof sql>) => Object.values((await rows(q))[0]!)[0];
const ACTIONS: Action[] = [
	{
		name: "plant.updateProfile",
		write: CHURCH_COMMANDS["plant.updateProfile"] as never,
		input: { patch: { name: "Harvest Point" } },
		again: { patch: { name: "Harvest Hill" } },
		native: (tx, context, request) => native.settings.updatePlantProfile(tx, context, request),
		saved: () => one(sql`SELECT name FROM plant WHERE id=${PLANT}`),
		expected: "Harvest Point",
	},
	{
		name: "church.digestSchedule.set",
		write: CHURCH_COMMANDS["church.digestSchedule.set"] as never,
		input: { schedule: { cadence: "daily", hour: 6 } },
		again: { schedule: { cadence: "daily", hour: 5 } },
		native: (tx, context, request) => native.settings.setDigestSchedule(tx, context, request),
		saved: () => one(sql`SELECT digest_cadence||' '||digest_hour FROM plant WHERE id=${PLANT}`),
		expected: "daily 6",
	},
	{
		name: "privacy.setSharing",
		write: SHARING_COMMANDS["privacy.setSharing"] as never,
		input: { organizationId: NETWORK, category: "wiki", enabled: true },
		again: { organizationId: NETWORK, category: "wiki", enabled: false },
		native: (tx, context: { session: never; selected: never }, request) =>
			native.organizations["privacy.setSharing"](tx, context.session, context.selected, request),
		saved: () => one(sql`SELECT share_wiki FROM affiliation WHERE plant_id=${PLANT} AND organization_id=${NETWORK}`),
		expected: true,
	},
	{
		name: "associations.end",
		write: RELATIONSHIP_COMMANDS["associations.end"] as never,
		input: { organizationId: NETWORK },
		again: { organizationId: NETWORK },
		native: (tx, context: { session: never; selected: never }, request) =>
			native.organizations["associations.end"](tx, context.session, context.selected, request),
		saved: () =>
			one(sql`SELECT ended_at IS NOT NULL FROM affiliation WHERE plant_id=${PLANT} AND organization_id=${NETWORK}`),
		expected: true,
	},
];

async function reviewed(a: Action, input: object) {
	const query = await a.write.review(church.actors.admin, input as never, {
		db: church.db,
		mail: null,
		native,
		conversationId: null,
	});
	assert.ok(query);
	return ((await church.admin.execute(query)).rows as { args: object }[])[0]!.args;
}
async function nativeWrite(a: Pick<Action, "native">, who: EvryActor, args: object, selected: object = plant) {
	try {
		const reply = (await gatedTransaction(church.db, async (tx) => {
			const context = { session: who.session, selected };
			if (!(await RequestActor.claimWrite(tx, who.session, selected as never))) return { status: "refused" };
			return a.native(tx as never, context as never, { ...args, requestKey: randomUUID() } as never);
		})) as { status: string };
		return reply.status === "refused" ? "refused" : "allowed";
	} catch (error) {
		assert.match(String(error), /unavailable|stale_revision|conflict/);
		return "refused";
	}
}
async function turn(who: EvryActor) {
	const c = await createConversation(church.db, who, { requestKey: randomUUID() });
	await submitTurn(church.db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(church.db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return (operation: string, input: unknown) =>
		prepareProposal(church.db, who, lease, c.id, { operation, input }, null, native);
}
async function propose(who: EvryActor, a: Action, input: object) {
	const proposal = await (await turn(who))(a.name, input);
	assert.ok(proposal);
	return proposal;
}
const approve = (who: EvryActor, p: { id: string; revision: number; digest: string }) =>
	approveProposal(church.db, who, p.id, { revision: p.revision, digest: p.digest }, null);
async function execute() {
	const [claim] = await claimDue(church.db, ["evry_effect"], 1, 60);
	if (!claim) return null;
	const outcome = await executeProposal(
		church.db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{
			reminders: async () => {
				throw Error("unexpected task reminder replan");
			},
			phaseNotices: async () => undefined,
		},
		null,
		native,
	);
	await transaction(church.db, (tx) =>
		finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }),
	);
	return outcome;
}
const denied = (e: unknown) => e instanceof EvryRefusal && e.code === "access_denied";
const seat = (who: EvryActor, ended: boolean) =>
	church.admin.execute(
		sql`UPDATE seat SET ended_at=${ended ? sql`clock_timestamp()` : null} WHERE account_id=${who.accountId} AND plant_id=${PLANT}`,
	);

test("AC:TARGET-IDN-029 a Member, another church's Owner, a network Member, a seatless lead and a revoked Admin administer nothing, natively or through Evry", async () => {
	for (const a of ACTIONS) {
		const args = await reviewed(a, a.input);
		await nothing(async () => {
			for (const role of ["member", "foreign", "networkMember", "seatless", "revoked"] as const) {
				assert.equal(await nativeWrite(a, roles[role], args), "refused", `${a.name} ${role}`);
				assert.equal(await nativeWrite(a, roles[role], args, roles[role].owner), "refused", `${a.name} ${role} own`);
			}
			for (const role of ["member", "networkMember", "seatless"] as const) {
				assert.equal(
					readCatalog(roles[role]).reviewedWrites.some((w) => w.operation === a.name),
					false,
					`${a.name} ${role}`,
				);
				await assert.rejects(async () => (await turn(roles[role]))(a.name, a.input), denied, `${a.name} ${role}`);
			}
			await assert.rejects(turn(roles.revoked), (e) => e instanceof EvryRefusal, a.name);
			assert.equal(a.write.input.safeParse({ ...a.input, plant: PLANT, tenant: PLANT }).success, false);
		});
	}
	await nothing(async () => {
		const foreign = await (await turn(roles.foreign))("plant.updateProfile", ACTIONS[0]!.input);
		assert.notEqual(
			(foreign!.review.target as { id: string }).id,
			PLANT,
			"Evry proposes only for the asker's own church",
		);
	});
	assert.deepEqual(
		await rows(sql`SELECT linked_account_id FROM person WHERE plant_id=${PLANT} AND display_name='Lara Lead'`),
		[{ linked_account_id: null }],
	);
});

test("AC:TARGET-IDN-029 an Admin revoked between the preview and the approval, or between the approval and the run, changes nothing", async () => {
	for (const a of ACTIONS) {
		const args = await reviewed(a, a.input);
		const early = await propose(roles.admin, a, a.input);
		const late = await propose(roles.admin, a, a.input);
		await nothing(async () => {
			const seats = await rows(sql`SELECT id,ended_at FROM seat WHERE account_id=${roles.admin.accountId}`);
			await approve(roles.admin, late).then(() => undefined);
			await seat(roles.admin, true);
			try {
				await assert.rejects(approve(roles.admin, early), (e) => e instanceof EvryRefusal, a.name);
				assert.notEqual(await execute(), "completed", a.name);
				assert.equal(await execute(), null, a.name);
				assert.equal(await nativeWrite(a, roles.admin, args), "refused", a.name);
			} finally {
				await seat(roles.admin, false);
			}
			assert.deepEqual(await rows(sql`SELECT id,ended_at FROM seat WHERE account_id=${roles.admin.accountId}`), seats);
		}).catch((error: Error) => {
			throw new Error(`${a.name}: ${error.message}`, { cause: error });
		});
		assert.notEqual(await a.saved(), a.expected, a.name);
		assert.notEqual((await readReview(church.db, roles.admin, late.id)).outcome, "completed");
	}
});

test("AC:TARGET-IDN-029 an Admin does each routine action as the Owner does, natively and through a reviewed Evry proposal", async () => {
	for (const a of ACTIONS) {
		const proposal = await propose(roles.admin, a, a.input);
		assert.notEqual(await a.saved(), a.expected, `${a.name} waits for approval`);
		const before = Number((await rows(sql`SELECT count(*)::int n FROM audit_event`))[0]!.n);
		await approve(roles.admin, proposal);
		assert.equal(await execute(), "completed", a.name);
		assert.equal(await a.saved(), a.expected, a.name);
		const audits = await rows(
			sql`SELECT tenant_id,actor_id FROM audit_event WHERE action NOT LIKE 'evry.%' ORDER BY recorded_at DESC LIMIT 1`,
		);
		assert.ok(Number((await rows(sql`SELECT count(*)::int n FROM audit_event`))[0]!.n) > before);
		assert.deepEqual(audits, [{ tenant_id: PLANT, actor_id: roles.admin.accountId }]);
		if (a.name === "associations.end") continue;
		for (const who of [church.actors.owner, roles.admin]) {
			for (const input of [a.again, a.input]) {
				const args = await reviewed(a, input);
				assert.equal(await nativeWrite(a, who, args), "allowed", a.name);
				assert.equal(await nativeWrite(a, who, args), "refused", `${a.name} on a changed review`);
			}
			assert.equal(await a.saved(), a.expected, a.name);
		}
	}
	const link = sql`SELECT id,revision::text AS revision FROM affiliation WHERE plant_id=${PLANT} AND organization_id=${NETWORK}`;
	const [{ id, revision }] = (await rows(link)) as [{ id: string; revision: string }];
	await church.admin.execute(sql`UPDATE affiliation SET ended_at=NULL WHERE id=${id}`);
	const end = ACTIONS.at(-1)!;
	assert.equal(
		await nativeWrite(end, roles.admin, { ...(await reviewed(end, end.input)), expectedRevision: revision }),
		"allowed",
	);
	assert.equal(await end.saved(), true);
});

test("AC:TARGET-IDN-029 only the Owner asks to delete the church, natively; Evry offers it to nobody", async () => {
	const deletion = deletionOperations({
		workspaceNotice: async () => {},
		queue: (tx, i) =>
			queueJobs(tx as never, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: `purge/${i.requestId}`,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
	});
	const action = {
		native: (tx: never, context: never, request: never) => deletion.requestWorkspaceDeletion(tx, context, request),
	};
	const revision = String((await rows(sql`SELECT revision::text r FROM plant WHERE id=${PLANT}`))[0]!.r);
	const args = { expectedRevision: revision, input: { plant, confirmed: true } };
	await nothing(async () => {
		for (const role of ["admin", "member", "foreign", "networkMember", "seatless", "revoked"] as const)
			assert.equal(await nativeWrite(action, roles[role], args), "refused", role);
		for (const who of [church.actors.owner, roles.admin, roles.member, roles.networkMember]) {
			assert.deepEqual(
				readCatalog(who)
					.reviewedWrites.map((w) => w.operation)
					.filter((o) => /workspace|church.*delet/i.test(o)),
				[],
			);
			for (const operation of ["churches.requestWorkspaceDeletion", "account.requestWorkspaceDeletion"])
				await assert.rejects(
					async () => (await turn(who))(operation, { plant, confirmed: true }),
					(e) => e instanceof EvryRefusal,
				);
		}
	});
	assert.equal(await nativeWrite(action, church.actors.owner, args), "allowed");
	assert.deepEqual(
		await rows(sql`SELECT kind,plant_id,state FROM lifecycle_witness WHERE opaque_subject_id=${PLANT}`),
		[{ kind: "plant", plant_id: PLANT, state: "pending_deletion" }],
	);
});
