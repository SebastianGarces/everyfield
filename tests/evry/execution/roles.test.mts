import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { owner as ownerValue } from "../../../packages/contracts/src/common/index.ts";
import * as identityContracts from "../../../packages/contracts/src/identity/index.ts";
import * as settingsContracts from "../../../packages/contracts/src/settings/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	READ_DOMAINS,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import { allowedWrites, REVIEWED_WRITES } from "../../../packages/evry/src/proposals/review.ts";
import { fixture, ok, refused, type Actor, type Workspace } from "../../support/fixture.mts";
import { harness } from "../evals/intelligence-harness.mts";
import { nativePorts } from "../evals/settings-ports.mts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
const native = nativePorts();
const seats = () => createSeatService(f.pools.runtime);
let evry: ReturnType<typeof harness>;
const key = () => randomUUID();
const rows = async (q: SQL) => (await f.admin.execute(q)).rows as Record<string, unknown>[];
const one = async (q: SQL) => (await rows(q))[0]!;

before(async () => {
	f = await fixture({ prefix: "evryroles", max: 8 });
	evry = harness(f.pools.runtime, new Date(), native);
});
after(() => f?.close());

const church = () => f.plant({ name: "Harvest Point", city: "Austin" });
const plantOf = (w: Workspace) => {
	const selected = ownerValue.parse(w);
	assert.ok(selected.kind === "plant");
	return selected;
};
const actorOf = async (who: Pick<Actor, "session">) => {
	const found = await RequestActor.resolve(f.pools.runtime, who.session);
	return found instanceof RequestActor ? evryActor(found) : null;
};
const present = async (who: Pick<Actor, "session">) => {
	const actor = await actorOf(who);
	assert.ok(actor);
	return actor;
};
const state = (w: Workspace) =>
	one(sql`SELECT p.city,p.revision::text,(SELECT count(*)::int FROM audit_event WHERE tenant_id=p.id AND action NOT LIKE 'evry.%') AS audits,
		(SELECT count(*)::int FROM job WHERE tenant_id=p.id AND kind<>'assistant_turn') AS jobs,
		(SELECT count(*)::int FROM mail WHERE tenant_id=p.id) AS mail,
		(SELECT jsonb_agg(jsonb_build_array(account_id,role,revision,ended_at IS NULL) ORDER BY id) FROM seat WHERE plant_id=p.id) AS seats
		FROM plant p WHERE p.id=${w.id}`);
const profileEvents = async (w: Workspace) =>
	(
		await rows(
			sql`SELECT actor_id FROM audit_event WHERE tenant_id=${w.id} AND action='plant.profile_changed' AND subject_type<>'command' ORDER BY occurred_at,id`,
		)
	).map((r) => r.actor_id);

async function nativeProfile(who: Actor, w: Workspace, city: string, requestKey = key(), expectedRevision?: string) {
	const revision = expectedRevision ?? String((await state(w)).revision);
	return gatedTransaction(f.pools.runtime, (tx) =>
		native.settings.updatePlantProfile(
			tx,
			{ session: who.session, selected: ownerValue.parse(who.selected) as never },
			{ requestKey, expectedRevision: revision, input: { plant: plantOf(w), patch: { city } } },
		),
	);
}
async function proposed(actor: EvryActor, operation: string, input: unknown) {
	const db = f.pools.runtime;
	const conversation = await createConversation(db, actor, { requestKey: key() });
	await submitTurn(db, actor, conversation.id, { requestKey: key(), text: "Change it", references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	try {
		return await prepareProposal(
			db,
			actor,
			{
				turnId: claim.id,
				tenantId: claim.tenant_id,
				leaseOwner: claim.lease_owner,
				generation: claim.claim_generation,
			},
			conversation.id,
			{ operation, input },
			null,
			native,
		);
	} finally {
		await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	}
}
const approve = (actor: EvryActor, card: { id: string; revision: number; digest: string }) =>
	approveProposal(f.pools.runtime, actor, card.id, { revision: card.revision, digest: card.digest }, null);
async function runApproved() {
	const db = f.pools.runtime;
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: async () => undefined, phaseNotices: async () => undefined },
		null,
		native,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	return outcome;
}
const refusedHere = (run: () => Promise<unknown>) =>
	assert.rejects(run, (e) => {
		assert.ok(e instanceof Error && "code" in e && typeof e.code === "string", String(e));
		return true;
	});
const offersProfile = (actor: EvryActor) => allowedWrites(actor).some((w) => w.operation === "plant.updateProfile");

const ASK = "update our church's city to Waco";

async function deniedEverywhere(who: Actor, w: Workspace, label: string) {
	const before = await state(w);
	const reply = await nativeProfile(who, w, "Waco");
	refused(reply, "unavailable");
	const actor = await actorOf(who);
	if (actor) {
		const inside = actor.owner.kind === "plant" && actor.owner.id === w.id;
		if (inside || actor.owner.kind !== "plant") {
			assert.equal(offersProfile(actor), false, `${label} is offered no profile change`);
			const turn = await evry.ask(actor, ASK);
			assert.deepEqual(turn.proposals, [], label);
			await refusedHere(() => proposed(actor, "plant.updateProfile", { patch: { city: "Waco" } }));
		}
	}
	assert.deepEqual(await state(w), before, `${label} changes nothing`);
	return actor;
}

test("AC:ROLE43-001 Owner and Admin change the church profile alike in Settings and through Evry; a Member, another church's Owner and a removed Admin are refused in both", async () => {
	const w = await church(),
		q = await church();
	const roles = {
		Owner: await f.actor(w, "owner"),
		Admin: await f.actor(w, "admin"),
		Member: await f.actor(w, "member"),
		foreign_Owner: await f.actor(q, "owner"),
		revoked_Admin: await f.actor(w, "admin"),
	};
	const expectedEvents: string[] = [];
	let n = 0;
	for (const who of [roles.Owner, roles.Admin]) {
		const request = key();
		const revision = String((await state(w)).revision);
		const city = `Native ${++n}`;
		const saved = ok(await nativeProfile(who, w, city, request, revision));
		assert.deepEqual(ok(await nativeProfile(who, w, city, request, revision)), saved, "the same intent again");
		refused(await nativeProfile(who, w, "Stale", key(), revision), "conflict");
		assert.equal((await state(w)).city, city);
		const actor = await present(who);
		assert.equal(offersProfile(actor), true);
		const turn = await evry.ask(actor, ASK.replace("Waco", `Evry ${n}`));
		assert.equal(turn.proposals.length, 1, turn.answer);
		const card = turn.proposals[0]!;
		assert.deepEqual(
			[card.operation, card.review.changes],
			["plant.updateProfile", [{ field: "city", before: city, after: `Evry ${n}` }]],
		);
		assert.equal((await state(w)).city, city, "nothing runs before approval");
		assert.equal(await evry.approveAndRun(actor, card), "completed");
		assert.equal((await state(w)).city, `Evry ${n}`);
		await approve(actor, card);
		assert.equal((await claimDue(f.pools.runtime, ["evry_effect"], 1, 60)).length, 0, "an approved change runs once");
		expectedEvents.push(who.id, who.id);
		assert.deepEqual(await profileEvents(w), expectedEvents);
	}

	await deniedEverywhere(roles.Member, w, "Member");
	await deniedEverywhere(roles.foreign_Owner, w, "foreign_Owner");
	await deniedEverywhere({ ...roles.foreign_Owner, selected: w }, w, "foreign_Owner claiming the church");
	const own = await evry.ask(await present(roles.foreign_Owner), ASK);
	assert.equal(own.proposals[0]!.review.target?.id, q.id, "another church's Owner only ever reaches their own church");
	const ownersCard = (await evry.ask(await present(roles.Owner), ASK)).proposals[0]!;
	const before = await state(w);
	for (const who of [roles.foreign_Owner, roles.Member]) {
		const actor = await present(who);
		await refusedHere(() => approve(actor, ownersCard));
	}
	assert.deepEqual(await state(w), before);

	const removed = await present(roles.revoked_Admin);
	const held = (await evry.ask(removed, ASK)).proposals[0]!;
	const late = (await evry.ask(removed, ASK)).proposals[0]!;
	await approve(removed, late);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${roles.revoked_Admin.id}`);
	const ended = await state(w);
	await refusedHere(() => approve(removed, held));
	assert.notEqual(await runApproved(), "completed", "an approved change stops when the seat ends first");
	await deniedEverywhere(roles.revoked_Admin, w, "revoked_Admin");
	assert.deepEqual((await state(w)).city, ended.city);
	assert.deepEqual(await profileEvents(w), expectedEvents);
});

test("AC:ROLE43-006 a linked lead title, an unlinked lead contact and a pending or ended Admin seat administer nothing in Settings or through Evry", async () => {
	const w = await church();
	const ownerSeat = await f.actor(w, "owner");
	const person = async (name: string, linked: string | null, email: string) => {
		const [id, team] = [key(), key()];
		await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id,email) VALUES(${id},${w.id},${w.id},${name},'other','leader',
			'adult','unknown',1,'live',clock_timestamp(),${linked},${email})`);
		await f.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
			VALUES(${team},${w.id},${name + " team"},'active',1,${id},'explicit')`);
	};
	const actors = {
		linked_Member_lead: await f.actor(w, "member"),
		unlinked_lead: await f.actor(null),
		pending_Admin: await f.actor(null),
		revoked_Admin: await f.actor(w, "admin"),
	};
	await person("Linked Lead", actors.linked_Member_lead.id, actors.linked_Member_lead.email);
	await person("Unlinked Lead", null, actors.unlinked_lead.email);
	const member = await f.actor(w, "member");
	const memberSeat = String((await one(sql`SELECT id FROM seat WHERE account_id=${member.id}`)).id);
	const promotion = { seatId: memberSeat, expectedRole: "member", to: "admin" } as const;
	const inviter = await RequestActor.resolve(f.pools.runtime, ownerSeat.session);
	assert.ok(inviter instanceof RequestActor);
	const pending = await native.invitations(f.pools.runtime).invite(inviter, {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: plantOf(w), role: "admin", recipientEmail: actors.pending_Admin.email },
	});
	assert.equal(pending.invitation.status, "pending");
	const revokedOffer = await f.actor(null);
	const revoked = await native.invitations(f.pools.runtime).invite(inviter, {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: plantOf(w), role: "admin", recipientEmail: revokedOffer.email },
	});
	await native.invitations(f.pools.runtime).revoke(inviter, {
		requestKey: key(),
		expectedRevision: revoked.invitation.revision,
		input: { invitationId: revoked.invitation.invitationId },
	});
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${actors.revoked_Admin.id}`);
	for (const [label, who] of [...Object.entries(actors), ["revoked_invitation", revokedOffer] as const]) {
		const before = await state(w);
		await deniedEverywhere(who, w, label);
		const asPlant = { ...who, selected: w };
		await deniedEverywhere(asPlant, w, `${label} claiming the church`);
		const authority = await RequestActor.resolve(f.pools.runtime, who.session);
		if (authority instanceof RequestActor) {
			await refusedHere(() =>
				native.invitations(f.pools.runtime).invite(authority, {
					requestKey: key(),
					expectedRevision: "1",
					input: { workspace: plantOf(w), role: "admin", recipientEmail: key() + "@example.test" },
				}),
			);
			await refusedHere(() =>
				seats().appointAdmin(authority, plantOf(w), {
					requestKey: key(),
					expectedRevision: "1",
					input: promotion,
				}),
			);
		}
		assert.deepEqual(await state(w), before, label);
	}
	assert.deepEqual(await profileEvents(w), []);
	await seats().appointAdmin(inviter, plantOf(w), { requestKey: key(), expectedRevision: "1", input: promotion });
	assert.equal(
		(await one(sql`SELECT role FROM seat WHERE id=${memberSeat}`)).role,
		"admin",
		"the Owner's same request",
	);
});

test("AC:ROLE43-002 asked to delete the church, Evry prepares nothing for anyone and points to Settings; asked to delete a login it reaches only the asker's own", async () => {
	const w = await church();
	const roles = [await f.actor(w, "owner"), await f.actor(w, "admin"), await f.actor(w, "member")];
	assert.deepEqual(
		Object.keys(REVIEWED_WRITES).filter((o) => /workspacedeletion|deletechurch|churches\./i.test(o)),
		[],
	);
	for (const who of roles) {
		const actor = await present(who);
		const before = await state(w);
		const turn = await evry.ask(actor, "delete our church");
		assert.deepEqual(turn.proposals, []);
		assert.match(turn.answer, /Only the church's Owner can delete the church/);
		await refusedHere(() => proposed(actor, "churches.requestWorkspaceDeletion", { confirmed: true }));
		await refusedHere(() => proposed(actor, "account.requestDeletion", { accountId: roles[2]!.id }));
		const own = await evry.ask(actor, "delete my account");
		assert.deepEqual(
			own.proposals.map((card) => card.review.target?.id),
			[who.id],
		);
		assert.deepEqual(await state(w), before);
	}
	assert.equal((await one(sql`SELECT count(*)::int AS n FROM lifecycle_witness`)).n, 0);
});

const EXCLUDED =
	/transfer|claim_?owner|ownership|co[_-]?lead|restore_?(former|lead|owner|seat|access|admin|member)|rejoin|former|designat(?!eCoreValues)|nominat|(recover|promote)_?owner/i;
test("AC:ROLE43-017 no native or Evry command transfers or claims ownership, makes a co-lead, restores a former lead or rejoins one", async () => {
	const read = (path: string) => JSON.parse(readFileSync(new URL("../../../" + path, import.meta.url), "utf8"));
	const catalog = read("docs/catalog/operations.json") as {
		operations: { id: string; purpose: string; feature_ids: string[] }[];
	};
	const tools = read("docs/catalog/evry-tools.json") as { operation_ids: string[] };
	assert.ok(catalog.operations.length > 200 && tools.operation_ids.length > 100);
	const registered = {
		catalog: catalog.operations.filter((o) => EXCLUDED.test(o.id)).map((o) => o.id),
		tools: tools.operation_ids.filter((id) => EXCLUDED.test(id)),
		writes: Object.keys(REVIEWED_WRITES).filter((id) => EXCLUDED.test(id)),
		reads: Object.values(READ_DOMAINS)
			.flat()
			.map((r) => r.operation as string)
			.filter((id) => EXCLUDED.test(id)),
		seats: Object.keys(createSeatService(f.pools.runtime)).filter((name) => EXCLUDED.test(name)),
		invitations: Object.keys(native.invitations(f.pools.runtime)).filter((name) => EXCLUDED.test(name)),
		settings: Object.keys({ ...native.settings, ...native.account }).filter((name) => EXCLUDED.test(name)),
		onboarding: Object.keys(
			createOnboardingProducer({ relationships: async () => {}, enqueue: async () => {} }),
		).filter((name) => EXCLUDED.test(name)),
		contracts: Object.keys({ ...identityContracts, ...settingsContracts }).filter((name) =>
			/transfer|claimOwner|ownership|coLead|rejoin|formerLead|nominat/i.test(name),
		),
	};
	assert.deepEqual(registered, {
		catalog: [],
		tools: [],
		writes: [],
		reads: [],
		seats: [],
		invitations: [],
		settings: [],
		onboarding: [],
		contracts: [],
	});

	const w = await church();
	const roles = {
		owner: await f.actor(w, "owner"),
		admin: await f.actor(w, "admin"),
		member: await f.actor(w, "member"),
	};
	const former = await f.actor(w, "admin");
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${former.id}`);
	const seatOf = async (who: Actor) =>
		String((await one(sql`SELECT id FROM seat WHERE account_id=${who.id} AND plant_id=${w.id}`)).id);
	const before = await state(w);
	for (const request of ["transfer", "claim_owner", "restore_former_lead", "co_lead"])
		for (const who of Object.values(roles)) {
			const actor = await present(who);
			for (const operation of [`seats.${request}`, `identity.${request}`, `plant.${request}`])
				await refusedHere(() => proposed(actor, operation, { seatId: key() }));
		}
	const authority = (await present(roles.owner)).authority;
	const change = async (who: Actor, to: string) => ({
		requestKey: key(),
		expectedRevision: "1",
		input: { seatId: await seatOf(who), expectedRole: "member", to },
	});
	for (const write of [seats().changeOrdinaryRole, seats().appointAdmin, seats().demote])
		await assert.rejects(write(authority, plantOf(w), await change(roles.member, "owner")));
	await assert.rejects(
		native.invitations(f.pools.runtime).invite(authority, {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: plantOf(w), role: "owner", recipientEmail: former.email },
		}),
	);
	await refusedHere(async () => seats().changeOrdinaryRole(authority, plantOf(w), await change(former, "admin")));
	assert.deepEqual(await state(w), before);
});

test("AC:ROLE43-016 through Evry a plant Admin or lead is offered no organization, library-wide or platform change", async () => {
	const w = await church();
	const org = await f.organization("sending_church", { name: "Grace Sending" });
	const admin = await f.actor(w, "admin");
	const director = await f.actor(org, "owner");
	const PLANT_REGION = "organizations.correctReportingLocation";
	const orgOnly = (actor: EvryActor) =>
		allowedWrites(actor)
			.map((x) => x.operation)
			.filter(
				(o) =>
					o !== PLANT_REGION &&
					/^(organizations|pipeline|oversight|wiki\.(add|edit|hide|publish)Organization|residency|platform|flags)\b/.test(
						o,
					),
			);
	const actor = await present(admin);
	assert.deepEqual(orgOnly(actor), []);
	const organizationSeat = await present(director);
	assert.ok(orgOnly(organizationSeat).includes("organizations.updateProfile"));
	const offersRegion = (seat: EvryActor) => allowedWrites(seat).some((x) => x.operation === PLANT_REGION);
	assert.deepEqual(
		[offersRegion(actor), offersRegion(organizationSeat)],
		[true, false],
		"the reporting Region is the church's own setting, not an organization change",
	);
	const before = await one(sql`SELECT to_jsonb(o) AS row FROM organization o WHERE id=${org.id}`);
	await refusedHere(() => proposed(actor, "organizations.updateProfile", { patch: { description: "Mine" } }));
	await refusedHere(() => proposed(actor, PLANT_REGION, { plant: { kind: "plant", id: org.id }, regionItemId: key() }));
	const CHANGE = "update our organization's description to: Mine";
	const offered = await evry.ask(organizationSeat, CHANGE);
	assert.deepEqual(
		offered.proposals.map((card) => [card.operation, card.review.target?.id]),
		[["organizations.updateProfile", org.id]],
		"the same words prepare the change for the organization's own Owner",
	);
	assert.deepEqual((await evry.ask(actor, CHANGE)).proposals, []);
	assert.deepEqual(await one(sql`SELECT to_jsonb(o) AS row FROM organization o WHERE id=${org.id}`), before);
	assert.equal((await one(sql`SELECT count(*)::int AS n FROM platform_grant`)).n, 0);
});
