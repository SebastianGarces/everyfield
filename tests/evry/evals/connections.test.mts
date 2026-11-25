import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { readHistory } from "../../../packages/domain/src/organizations/index.ts";
import { READ_DOMAINS, readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter } from "../../../packages/evry/src/catalog/types.ts";
import { createConversation, prepareProposal, submitTurn, type EvryActor } from "../../../packages/evry/src/index.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import {
	GRACE_AUSTIN,
	goldenChurch,
	ORGANIZATION,
	PLANT,
	type ActorName,
	type GoldenChurch,
} from "./golden-church.mts";
import { nativePorts } from "./settings-ports.mts";
import { scriptedTurns } from "./scripted-turns.mts";

type Row = [field: string, before: unknown, after: unknown];
type Case = {
	id: string;
	actor: ActorName;
	ask: string;
	calls: string[];
	answer?: string[];
	proposal?: { operation: string; target: string; changes: Row[]; refusal: string | null };
	approve?: true;
};
const { cases } = JSON.parse(readFileSync(new URL("./connections.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

const mail: { to: string; purpose: string }[] = [];
const native = nativePorts(mail);
let church: GoldenChurch;
let turns: ReturnType<typeof scriptedTurns>;
const photo = randomUUID();
const key = randomUUID();
const invited: Record<string, string> = {};
const TOKEN = "f".repeat(32);

async function invite(organization: string, kind: string, recipient: string) {
	const id = randomUUID();
	const { owner } = church.actors;
	await church.admin
		.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,inviter_id,token_hash,state,created_at,revision)
		VALUES(${id},${PLANT},${kind},${recipient},${owner.accountId},${TOKEN + id.replaceAll("-", "")},'pending',clock_timestamp()-interval '2 days',1)`);
	await church.admin
		.execute(sql`INSERT INTO relationship_invitation(invitation_id,plant_id,organization_id,inviter_description,subject_revision)
		VALUES(${id},${PLANT},${organization},'Hope Fellowship',1)`);
	return id;
}

before(async () => {
	church = await goldenChurch({ seatNames: true });
	turns = scriptedTurns(church.db, native);
	invited.grace = await invite(GRACE_AUSTIN, "plant_church", "connect@graceaustin.example.test");
	invited.hill = await invite(ORGANIZATION, "plant_church", "org@example.test");
	const { owner } = church.actors;
	await church.admin
		.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
		VALUES(${photo},${owner.accountId},'avatar',${`private/${owner.accountId}/${key}`},'image/png',10,10,${"0".repeat(64)},'ready',${photo},0)`);
	await church.admin.execute(sql`UPDATE account SET avatar_object_id=${photo} WHERE id=${owner.accountId}`);
});
after(() => church?.close());

const row = async (query: ReturnType<typeof sql>) =>
	(await church.admin.execute(query)).rows[0] as Record<string, unknown>;
const invitation = (id: string) =>
	row(sql`SELECT state,revision::int AS revision FROM invitation WHERE id=${id}::uuid`);
const links = () => row(sql`SELECT count(*)::int AS n FROM affiliation`);
const avatar = () =>
	row(sql`SELECT avatar_object_id AS photo FROM account WHERE id=${church.actors.owner.accountId}::uuid`);
const name = (who: ActorName) =>
	row(sql`SELECT n.display_name AS name FROM seat_identity(${church.actors[who].accountId}::uuid) n`);
const reads = new Map(
	[...READ_DOMAINS.connections, ...READ_DOMAINS.settings].map((a) => [a.operation, a as ReadAdapter<unknown>]),
);
const read = (who: ActorName, operation: string, input: unknown = {}) =>
	invokeRead(church.db, church.actors[who], reads.get(operation)!, input, native);

const AFTER: Record<string, () => Promise<void>> = {
	"CON-06": async () =>
		assert.deepEqual(await row(sql`SELECT warning_days,alert_days FROM plant WHERE id=${PLANT}::uuid`), {
			warning_days: 10,
			alert_days: 21,
		}),
	"CON-08": async () => assert.deepEqual(await name("member"), { name: "Priya S. Shah" }),
	"CON-09": async () => assert.deepEqual(await name("network"), { name: "Ruth A. Calder" }),
	"CON-14": async () => {
		assert.deepEqual(await invitation(invited.grace!), { state: "pending", revision: 2 });
		assert.deepEqual(mail, [{ to: "connect@graceaustin.example.test", purpose: "relationship_invitation" }]);
	},
	"CON-15": async () => {
		assert.deepEqual(await invitation(invited.grace!), { state: "revoked", revision: 3 });
		assert.equal(mail.length, 1, "withdrawing sends nothing");
	},
	"CON-16": async () => {
		assert.deepEqual(await invitation(invited.hill!), { state: "declined", revision: 2 });
		assert.deepEqual(await links(), held);
	},
	"CON-20": async () => assert.deepEqual(await avatar(), { photo: null }),
};
let held: Record<string, unknown>;

async function propose(actor: EvryActor, operation: string, input: unknown) {
	const c = await createConversation(church.db, actor, { requestKey: randomUUID() });
	await submitTurn(church.db, actor, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(church.db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	try {
		return await prepareProposal(church.db, actor, lease, c.id, { operation, input }, null, native);
	} finally {
		await transaction(church.db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	}
}

test("INV-evry-connections: every settings, account and link invitation case passes on the scripted model, nothing changes before approval, and no token, key or photo version is shown", async () => {
	held = await links();
	for (const c of cases) {
		const turn = await turns.ask(church.actors[c.actor], c.ask);
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads: ${turn.answer}`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		for (const hidden of [photo, key, TOKEN, "connect@graceaustin.example.test"])
			assert.equal(turn.transcript.includes(hidden), false, `${c.id} hides ${hidden}`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, c.id);
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id}: ${turn.answer}`);
		const [proposal] = turn.proposals;
		assert.equal(proposal!.operation, c.proposal.operation, c.id);
		assert.equal(proposal!.review.target?.label, c.proposal.target, c.id);
		assert.deepEqual(
			proposal!.review.changes.map((x) => [x.field, x.before, x.after]),
			c.proposal.changes,
			c.id,
		);
		assert.equal(proposal!.review.refusal ?? null, c.proposal.refusal, c.id);
		for (const hidden of [photo, TOKEN]) assert.equal(JSON.stringify(proposal).includes(hidden), false, c.id);
		if (!c.approve) continue;
		const { outcome } = await turns.approve(church.actors[c.actor], proposal!);
		assert.equal(outcome, "completed", c.id);
		await AFTER[c.id]!();
	}
});

test("INV-evry-connections: a settings change that went stale, an inactivity pair out of order and a resend inside its cooldown are refused and change nothing", async () => {
	const { owner } = church.actors;
	const days = () => row(sql`SELECT warning_days,alert_days FROM plant WHERE id=${PLANT}::uuid`);
	const stale = (await propose(owner, "settings.saveSection", { section: "church", warningDays: 5 }))!;
	await church.admin.execute(sql`UPDATE plant SET alert_days=30,revision=revision+1 WHERE id=${PLANT}::uuid`);
	const refused = await turns.approve(owner, stale);
	assert.deepEqual([refused.outcome, refused.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.deepEqual(await days(), { warning_days: 10, alert_days: 30 });

	const swapped = (await propose(owner, "settings.saveSection", { section: "church", warningDays: 6 }))!;
	await church.admin.execute(
		sql`UPDATE proposal SET input=jsonb_set(input,'{input,change,value,warningDays}','40') WHERE id=${swapped.id}::uuid`,
	);
	assert.equal((await turns.approve(owner, swapped)).outcome, "refused");
	assert.deepEqual(await days(), { warning_days: 10, alert_days: 30 });

	const id = await invite(GRACE_AUSTIN, "plant_church", "again@graceaustin.example.test");
	const first = (await propose(owner, "associations.resendInvitation", { invitationId: id }))!;
	const second = (await propose(owner, "associations.resendInvitation", { invitationId: id }))!;
	assert.equal((await turns.approve(owner, first)).outcome, "completed");
	const sent = mail.length;
	assert.equal((await turns.approve(owner, second)).review.receipt?.code, "stale_revision");
	await church.admin.execute(sql`UPDATE invitation SET resent_at=clock_timestamp() WHERE id=${id}::uuid`);
	const soon = (await propose(owner, "associations.revokeInvitation", { invitationId: id }))!;
	const cooling = (await propose(church.actors.admin, "associations.resendInvitation", { invitationId: id }))!;
	assert.equal((await turns.approve(church.actors.admin, cooling)).review.receipt?.code, "resend_cooldown");
	assert.equal(mail.length, sent, "one mail for one resend");

	await church.admin.execute(
		sql`UPDATE invitation SET created_at=clock_timestamp()-interval '40 days',resent_at=NULL WHERE id=${id}::uuid`,
	);
	assert.equal(await propose(owner, "associations.revokeInvitation", { invitationId: id }), null, "expired");
	assert.equal((await turns.approve(owner, soon)).review.receipt?.code, "access_denied");
});

test("INV-tenancy: link invitations and history show each side only its own, only the addressed seat declines, and a Member is offered no invitation change", async () => {
	const id = await invite(ORGANIZATION, "plant_church", "someone-else@example.test");
	const listed = async (who: ActorName) =>
		(await read(who, "associations.listInvitations")).rows.map((r) => [r.id, r.label, r.fields.direction]);
	assert.deepEqual(await listed("owner"), [[id, "Hill Country Church", "sent"]]);
	assert.deepEqual(await listed("org"), [[id, "Hope Fellowship", "received"]]);
	for (const who of ["network", "other", "empty"] as const) assert.deepEqual(await listed(who), [], who);

	const decline = (await propose(church.actors.org, "associations.declineInvitation", { invitationId: id }))!;
	assert.equal(decline.review.refusal, "This invitation was sent to someone else here, so only they can decline it.");
	await assert.rejects(turns.approve(church.actors.org, decline), /review_closed/);
	for (const who of ["network", "other", "org"] as const)
		assert.equal(
			await propose(
				church.actors[who],
				who === "network" ? "associations.declineInvitation" : "associations.revokeInvitation",
				{ invitationId: id },
			),
			null,
			who,
		);
	assert.deepEqual(await invitation(id), { state: "pending", revision: 1 });
	assert.deepEqual(
		readCatalog(church.actors.member).reviewedWrites.filter((w) => w.operation.startsWith("associations.")),
		[],
	);

	for (const [who, scope] of [
		["owner", { plant: church.actors.owner.owner }],
		["network", { organization: church.actors.network.owner }],
	] as const) {
		const mine = await read(who, "associations.getHistory");
		const theirs = await readHistory(church.db, church.actors[who].authority, scope);
		assert.ok(theirs.status === "available");
		assert.deepEqual(
			mine.rows.map((r) => r.id).sort(),
			[...theirs.activeRelationships, ...theirs.items].map((r) => r.id as string).sort(),
			who,
		);
		assert.ok(mine.rows.length > 0, who);
	}
});
