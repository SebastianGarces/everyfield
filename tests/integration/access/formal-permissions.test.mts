import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, type Actor, type Workspace } from "../../support/fixture.mts";
import {
	createInvitationService,
	createSeatService,
	InvitationRefusal,
} from "../../../packages/domain/src/identity/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";

const table = JSON.parse(readFileSync(new URL("../../../formal/permissions/outcomes.json", import.meta.url), "utf8"))
	.rows as string[][];
const KINDS = ["seat", "invite", "revoke", "accept", "statement"];
const a = (word: string) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;

let fx: Awaited<ReturnType<typeof fixture>>;
let seats: ReturnType<typeof createSeatService>;
let invitations: ReturnType<typeof createInvitationService>;
const proofs = new Map<string, string>();
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(async () => {
	fx = await fixture({ prefix: "formal", max: 8 });
	const db = fx.pools.runtime;
	seats = createSeatService(db);
	invitations = createInvitationService({
		db,
		origin: "http://invitation.example.test",
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		addressBlocked: () => sql`false`,
		enqueueMail: async (_tx, mail) => {
			const proof = /#proof=(\S+)/.exec(mail.text)?.[1];
			if (proof) proofs.set(mail.invitationId, decodeURIComponent(proof));
			return randomUUID();
		},
	});
});
after(async () => {
	await fx?.close();
});

async function resolved(actor: Actor) {
	const authority = await fx.pools.runtime.transaction((tx) =>
		RequestActor.resolve(tx, sessionId.parse(actor.session)),
	);
	assert.ok(authority instanceof RequestActor, JSON.stringify(authority));
	return authority;
}
async function outcome(run: () => Promise<unknown>) {
	try {
		await run();
		return "allow";
	} catch (error) {
		if (error instanceof InvitationRefusal || (error instanceof Error && error.name === "ZodError")) return "refuse";
		throw error;
	}
}
async function liveSeat(account: Actor) {
	const r = await fx.admin.execute(
		sql`SELECT id, revision::text AS revision FROM seat WHERE account_id=${account.id}::uuid AND ended_at IS NULL`,
	);
	assert.equal(r.rows.length, 1);
	return r.rows[0] as { id: string; revision: string };
}
const command = (expectedRevision: string, input: Record<string, unknown>) => ({
	requestKey: randomUUID(),
	expectedRevision,
	input,
});
async function workspace(...roles: string[]) {
	const plant = await fx.plant();
	const owner = await fx.actor(plant, "owner");
	const actors = [];
	for (const role of roles) actors.push(role === "owner" ? owner : await fx.actor(plant, role as "admin" | "member"));
	return { plant, owner, actors };
}
function seatChange(
	authority: RequestActor,
	plant: Workspace,
	op: string,
	input: Record<string, unknown>,
	revision: string,
) {
	const v = command(revision, input);
	if (op === "appointAdmin") return seats.appointAdmin(authority, plant, v);
	if (op === "demote") return seats.demote(authority, plant, v);
	if (op === "changeOrdinaryRole") return seats.changeOrdinaryRole(authority, plant, v);
	if (op === "remove") return seats.remove(authority, plant, v, noReminders);
	throw Error(`unknown seat action ${op}`);
}
function seatInput(op: string, seatId: string, targetRole: string, to: string) {
	const expectedRole = targetRole === "owner" || op === "demote" ? "admin" : targetRole;
	return op === "remove" ? { seatId, expectedRole, handoffs: [] } : { seatId, expectedRole, to };
}
async function invite(owner: Actor, plant: Workspace, email: string, role: string) {
	const sent = await invitations.invite(
		await resolved(owner),
		command("1", { workspace: plant, recipientEmail: email, role }),
	);
	return sent.invitation.invitationId as string;
}
async function invitationRevision(id: string) {
	const r = await fx.admin.execute(sql`SELECT revision::text AS revision FROM invitation WHERE id=${id}::uuid`);
	return (r.rows[0] as { revision: string }).revision;
}
const accept = async (recipient: Actor, id: string) =>
	invitations.accept(
		recipient.session,
		command(await invitationRevision(id), { invitationId: id, proof: proofs.get(id) }),
	);

test("INV-access: every row of the permissions model's outcome table has a conformance case", () => {
	assert.ok(table.length > 0);
	assert.deepEqual(
		table.filter((row) => !KINDS.includes(row[0]!)),
		[],
	);
});

for (const [, op, actorRole, targetRole, to, expected] of table.filter((r) => r[0] === "seat"))
	test(`INV-access: ${op}${to === "none" ? "" : ` to ${to}`} by ${a(actorRole!)} on ${a(targetRole!)} seat: ${expected}, as the model says`, async () => {
		const { plant, actors } = await workspace(actorRole!, targetRole!);
		const [actor, target] = actors as [Actor, Actor];
		const seat = await liveSeat(target);
		const authority = await resolved(actor);
		const input = seatInput(op!, seat.id, targetRole!, to!);
		assert.equal(await outcome(() => seatChange(authority, plant, op!, input, seat.revision)), expected);
	});

for (const [, inviterRole, role, expected] of table.filter((r) => r[0] === "invite"))
	test(`INV-access: ${a(inviterRole!)} invites ${a(role!)}: ${expected}, as the model says`, async () => {
		const { plant, actors } = await workspace(inviterRole!);
		const email = `${randomUUID()}@example.test`;
		assert.equal(await outcome(() => invite(actors[0]!, plant, email, role!)), expected);
	});

for (const [, actorRole, expected] of table.filter((r) => r[0] === "revoke"))
	test(`INV-access: ${a(actorRole!)} revokes a pending invitation: ${expected}, as the model says`, async () => {
		const { plant, owner, actors } = await workspace(actorRole!);
		const id = await invite(owner, plant, `${randomUUID()}@example.test`, "member");
		const authority = await resolved(actors[0]!);
		assert.equal(await outcome(() => invitations.revoke(authority, command("1", { invitationId: id }))), expected);
	});

for (const [, state, seated, role, expected] of table.filter((r) => r[0] === "accept"))
	test(`INV-access: ${a(seated!)} account accepts ${a(state!)} ${role} invitation: ${expected}, as the model says`, async () => {
		const { plant, owner } = await workspace();
		const recipient = await fx.actor(seated === "seated" && state !== "accepted" ? await fx.plant() : null, "member");
		const id = await invite(owner, plant, recipient.email, role!);
		if (state === "revoked") await invitations.revoke(await resolved(owner), command("1", { invitationId: id }));
		if (state === "expired")
			await fx.admin.execute(sql`UPDATE invitation SET created_at=created_at-interval '31 days' WHERE id=${id}::uuid`);
		if (state === "accepted") {
			await accept(recipient, id);
			if (seated === "seatless")
				await fx.admin.execute(
					sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${recipient.id}::uuid AND ended_at IS NULL`,
				);
		}
		assert.equal(await outcome(() => accept(recipient, id)), expected);
	});

for (const [, kind, role, event, expected] of table.filter((r) => r[0] === "statement"))
	test(`INV-access: ${a(kind === "read" ? "read" : "admin read")} by ${a(role!)} after ${event === "none" ? "no change" : event.replace("_", " ")}: ${expected}, as the model says`, async () => {
		const { plant, owner, actors } = await workspace(role!);
		const actor = actors[0]!;
		const authority = await resolved(actor);
		const ownerAuthority = await resolved(owner);
		const seat = await liveSeat(actor);
		if (event === "session_ended")
			await fx.admin.execute(sql`DELETE FROM auth_session WHERE id=${actor.session}::uuid`);
		else if (event === "seat_removed")
			await seatChange(ownerAuthority, plant, "remove", seatInput("remove", seat.id, role!, "none"), seat.revision);
		else if (event === "demoted")
			await seatChange(ownerAuthority, plant, "demote", seatInput("demote", seat.id, role!, "member"), seat.revision);
		else if (event === "promoted")
			await seatChange(
				ownerAuthority,
				plant,
				"appointAdmin",
				seatInput("appointAdmin", seat.id, role!, "admin"),
				seat.revision,
			);
		else assert.equal(event, "none");
		const read =
			kind === "read"
				? () => seats.list(authority, { workspace: plant })
				: () => invitations.list(authority, { workspace: plant });
		assert.equal(await outcome(read), expected);
	});
