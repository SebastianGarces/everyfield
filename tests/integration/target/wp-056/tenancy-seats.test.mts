import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { sessionId } from "../../../../packages/contracts/src/common/index.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { listPlants } from "../../../../packages/domain/src/oversight/index.ts";
import { codeOf, fixture, key, type Fixture } from "../../identity/invitations-support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let f: Fixture;
before(async () => {
	f = await fixture();
});
after(() => f?.close());
const one = async (query: SQL) => (await f.admin.execute(query)).rows[0] ?? assert.fail("no row");
const liveSeats = async (account: string) =>
	Number((await one(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${account} AND ended_at IS NULL`)).n);
const resolved = async (session: string) => RequestActor.resolve(f.db, sessionId.parse(session));
const binds = async (authority: RequestActor, owner: { kind: "plant" | "organization"; id: string }) =>
	gatedTransaction(f.db, async (tx) => (await authority.bind(tx, owner as never)) !== null);
const lists = async (authority: RequestActor, workspace: { kind: string; id: string }) =>
	f.seats.list(authority, { workspace }).then(
		() => true,
		(error: unknown) => (codeOf(error) === "invitation_unavailable" ? false : assert.fail(String(error))),
	);

test("AC:TEN-005 one account holds one active seat; concurrent invitations, a title, an organization link and a stale session add no second scope", async () => {
	const c = caseOf("TEN-005");
	const input = c.given["case-input"] as {
		concurrent_tenants: string[];
		lead_title: boolean;
		affiliation: string;
		pending_domain: boolean;
	};
	assert.deepEqual(input.concurrent_tenants, ["P", "Q"]);
	assert.equal((c.given.I as { role: string }).role, "Admin");
	const P = await f.workspace("plant", { name: "Harvest Point", timezone: "America/Chicago" });
	const Q = await f.workspace("plant", { name: "Grace Hill", timezone: "America/New_York" });
	const S1 = await f.workspace("sending_church");
	const A = await f.account(input.pending_domain ? "pending_domain" : "active", "alex@example.test");
	const claims = [];
	for (const w of [P, Q]) {
		const sender = await f.account();
		await f.seat(sender, w);
		const result = await f.invitations.invite(await f.actor(sender.session), {
			requestKey: key(),
			expectedRevision: "1",
			input: { workspace: w, role: "admin", recipientEmail: A.email },
		});
		const proof = await f.proof(result.invitation.invitationId);
		claims.push({
			requestKey: key(),
			expectedRevision: "1",
			input: { invitationId: result.invitation.invitationId, proof },
		});
	}

	const pending = await resolved(A.session);
	assert.deepEqual(pending, { status: "pending_domain", accountId: A.id });
	const claimed = [];
	for (const w of [P, Q, S1])
		claimed.push(
			await gatedTransaction(f.db, async (tx) => RequestActor.claimWrite(tx, sessionId.parse(A.session), w as never)),
		);
	const pendingActs = pending instanceof RequestActor || claimed.some((write) => write !== null);

	const settled = await Promise.allSettled(claims.map((claim) => f.invitations.accept(A.session, claim)));
	assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(settled));
	const lost = settled.find((r) => r.status === "rejected");
	assert.equal(codeOf((lost as PromiseRejectedResult).reason), "invitation_unavailable");
	const [won, other] = settled[0]!.status === "fulfilled" ? [P, Q] : [Q, P];
	const maxSeats = await liveSeats(A.id);
	assert.equal(
		Number(
			(
				await one(
					sql`SELECT count(*)::int AS n FROM invitation WHERE id=${claims[won === P ? 1 : 0]!.input.invitationId} AND state='pending'`,
				)
			).n,
		),
		1,
	);
	await assert.rejects(
		f.admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${A.id},${other.id},'admin',clock_timestamp())`,
		),
		(error) => (error as { cause?: { code?: string } }).cause?.code === "23505",
	);

	const person = randomUUID();
	await f.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at,linked_account_id)
		VALUES(${person},${other.id},${other.id},'Alex Rivera','other','leader','unknown','unknown','1','live',clock_timestamp(),${A.id})`);
	const team = (
		await one(
			sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${other.id},'Leadership','active',0) RETURNING id`,
		)
	).id;
	const roleId = (
		await one(
			sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order) VALUES(${other.id},${team},'Lead planter',true,0) RETURNING id`,
		)
	).id;
	await f.admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${other.id},${roleId},${person},'2026-01-01')`,
	);
	await f.admin
		.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,
		share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${won.id},${S1.id},clock_timestamp(),true,true,true,true,true,true,true)`);

	const seated = await resolved(A.session);
	assert.ok(seated instanceof RequestActor);
	assert.deepEqual(seated.actor.context.kind, "seat");
	const scopes = {
		won: (await binds(seated, won)) && (await lists(seated, won)),
		other: (await binds(seated, other)) || (await lists(seated, other)),
		organization: (await binds(seated, S1)) || (await lists(seated, S1)) || (await listPlants(f.db, seated)) !== null,
	};
	assert.deepEqual(scopes, { won: true, other: false, organization: false });
	assert.equal(await liveSeats(A.id), 1);
	const titleSeat = Number(
		(await one(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${A.id} AND plant_id=${other.id}`)).n,
	);

	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id} AND ended_at IS NULL`);
	const stale = {
		binds: await binds(seated, won),
		lists: await lists(seated, won),
		other: await binds(seated, other),
	};
	assert.deepEqual(stale, { binds: false, lists: false, other: false });
	const fresh = await resolved(A.session);
	assert.ok(fresh instanceof RequestActor);
	assert.equal(fresh.actor.context.kind, "account");
	assert.deepEqual(
		[await binds(fresh, won), await binds(fresh, other), await lists(fresh, won)],
		[false, false, false],
	);

	assert.deepEqual(
		{
			max_active_seats: maxSeats,
			combined_tenant_scope_allowed: scopes.other || scopes.organization || stale.binds || stale.other,
			title_creates_seat: titleSeat > 0,
			pending_domain_can_act: pendingActs,
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});
