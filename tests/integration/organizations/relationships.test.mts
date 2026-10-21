import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as S from "./support.mts";
import * as Q from "../../../packages/contracts/src/organizations/index.ts";
import { readAnswerableInvitation } from "../../../packages/domain/src/organizations/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { sendOnboardingRelationships } from "../../../apps/web/src/server/jobs/notifications.ts";
before(S.setup);
after(S.teardown);
const accepted = (v: unknown) => {
	const r = Q.acceptedInvitationResult.parse(v);
	assert.equal(r.status, "accepted");
	if (r.status !== "accepted") throw Error();
	return r;
};
const pending = (v: unknown) => Q.invitationResult.parse(v);
async function invite(
	a: Awaited<ReturnType<typeof S.identity>>,
	o: Awaited<ReturnType<typeof S.tenant>>,
	recipient: string,
) {
	return pending(
		await S.call(
			"associations.invite",
			a,
			S.command({
				pair: {
					kind: a.selected.kind === "plant" ? "plant" : a.selected.kind === "account" ? "discovery" : "sending_church",
					...(a.selected.kind === "account" ? { accountId: a.account } : { subject: a.selected }),
					organization: o,
				},
				recipientEmail: recipient,
			}),
		),
	);
}
async function approve(i: ReturnType<typeof pending>, a: Awaited<ReturnType<typeof S.identity>>, key = randomUUID()) {
	return accepted(
		await S.call(
			"associations.acceptInvitation",
			a,
			S.command({ invitationId: i.invitationId, proof: S.proofs.get(i.invitationId), decision: "accept" }, "1", key),
		),
	);
}
test("AC:AF-001 AC:AF-002 AC:AF-003 AC:AF-004 AC:AF-005 AC:AF-006 AC:AF-007 exact subject history preserves independent affiliations and no seats", async () => {
	const p = await S.tenant("plant"),
		a = await S.identity(p),
		o = [
			await S.tenant("sending_church"),
			await S.tenant("sending_church"),
			await S.tenant("sending_network"),
			await S.tenant("sending_network"),
		];
	for (const indexes of [[], [0], [2], [0, 2], [0, 1], [2, 3]]) {
		await S.db.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE plant_id=${sql.param(p.id)}`);
		for (const n of indexes) {
			await S.db.execute(
				sql`DELETE FROM affiliation WHERE plant_id=${sql.param(p.id)} AND organization_id=${sql.param(o[n].id)}`,
			);
			await S.affiliation(p, o[n]);
		}
		const h = Q.relationshipHistoryResult.parse(await S.call("associations.getHistory", a, { plant: p }));
		assert.equal(h.status, "available");
		if (h.status !== "available") throw Error();
		assert.deepEqual(
			h.activeRelationships.map((r) => r.pair.organization.id).sort(),
			indexes.map((n) => o[n].id).sort(),
		);
		assert.deepEqual(h.items, []);
		assert.equal(
			(await S.db.execute(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${sql.param(a.account)}`)).rows[0].n,
			1,
		);
	}
	const p2 = await S.tenant("plant"),
		a2 = await S.identity(p2),
		oa = await S.identity(o[0]);
	await invite(a2, o[0], oa.email);
	const h = Q.relationshipHistoryResult.parse(await S.call("associations.getHistory", a2, { plant: p2 }));
	assert.equal(h.status, "available");
	if (h.status === "available") assert.deepEqual(h.activeRelationships, []);
});
test("AC:AF-008 AC:AF-009 AC:AF-011 AC:AF-018 AC:AF-027 approval is exact-addressed, concurrent and replay-safe across all five subject types", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p, "admin"),
		church = await S.tenant("sending_church"),
		network = await S.tenant("sending_network"),
		ca = await S.identity(church, "admin"),
		na = await S.identity(network, "admin");
	const c = await invite(pa, church, ca.email),
		n = await invite(pa, network, na.email),
		key = randomUUID();
	const result = await Promise.all([approve(c, ca, key), approve(c, ca, key), approve(n, na)]);

	assert.equal(
		(
			await S.db.execute(
				sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${sql.param(result[0].relationship.id)}`,
			)
		).rows[0].n,
		1,
	);
	assert.equal(
		(
			await S.db.execute(
				sql`SELECT count(*)::int AS n FROM affiliation WHERE plant_id=${sql.param(p.id)} AND ended_at IS NULL`,
			)
		).rows[0].n,
		2,
	);
	const cn = await invite(ca, network, na.email);
	assert.equal((await approve(cn, na)).relationship.pair.kind, "sending_church");
	for (const o of [church, network]) {
		const d = await S.identity();
		await S.db.execute(sql`INSERT INTO discovery(account_id) VALUES(${sql.param(d.account)})`);
		const i = await invite(d, o, o.id === church.id ? ca.email : na.email);
		assert.equal((await approve(i, o.id === church.id ? ca : na)).relationship.pair.kind, "discovery");
		assert.equal(
			(await S.db.execute(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${sql.param(d.account)}`)).rows[0].n,
			0,
		);
	}
	const view = Q.sharingResult.parse(await S.call("privacy.getSharing", pa, { plant: p, organization: church }));
	assert.equal(view.view, "plant_administration");
	if (view.view === "plant_administration")
		assert.deepEqual(view.choices, {
			people: true,
			meetings: true,
			tasks: true,
			ministry_teams: true,
			wiki: true,
			activity: true,
			shared_findings: true,
		});
});
test("AC:AF-016 AC:AF-017 AC:AF-019 AC:ROLE43-016 AC:TARGET-IDN-020 wrong side, Member, proof, expiry and revoked initiator cannot approve", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		member = await S.identity(o, "member"),
		foreign = await S.identity(await S.tenant("sending_church"));
	const i = await invite(pa, o, oa.email),
		q = S.command({ invitationId: i.invitationId, proof: S.proofs.get(i.invitationId), decision: "accept" });
	for (const a of [pa, member, foreign])
		await assert.rejects(S.call("associations.acceptInvitation", a, q), /unavailable/);
	await assert.rejects(
		S.call("associations.acceptInvitation", oa, S.command({ ...q.input, proof: "wrong" })),
		/unavailable/,
	);
	await S.db.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(pa.account)}`);
	await assert.rejects(S.call("associations.acceptInvitation", oa, q), /unavailable/);
	await S.db.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(pa.account)}`);
	await S.db.execute(
		sql`UPDATE invitation SET created_at=clock_timestamp()-interval '30 days' WHERE id=${sql.param(i.invitationId)}`,
	);
	await assert.rejects(S.call("associations.acceptInvitation", oa, q), /unavailable/);
	assert.equal(
		(await S.db.execute(sql`SELECT count(*)::int AS n FROM affiliation WHERE plant_id=${sql.param(p.id)}`)).rows[0].n,
		0,
	);
});
test("AC:AF-010 AC:AF-014 AC:AF-015 AC:AF-020 AC:AF-021 AC:AF-022 AC:AF-023 AC:AF-024 AC:AF-025 AC:AF-026 AC:AF-031 AC:AF-034 AC:AF-040 AC:AF-041 AC:ORG55-002 AC:ORG55-003 AC:GAP-IDN-027 AC:TARGET-IDN-021 AC:TARGET-IDN-027 ending one pair keeps other links, content and minimal history", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		n = await S.tenant("sending_network");
	const other = await S.affiliation(p, n, true),
		i = await invite(pa, o, oa.email),
		approvalKey = randomUUID(),
		a = await approve(i, oa, approvalKey);
	assert.deepEqual(await approve(i, oa, approvalKey), a);
	const member = await S.identity(p, "member"),
		foreign = await S.identity(await S.tenant("sending_network"));
	const q = S.command({
		relationshipId: a.relationship.id,
		pair: a.relationship.pair,
		confirmed: true,
		reason: "Retained domain reason",
	});
	for (const actor of [member, foreign]) await assert.rejects(S.call("associations.end", actor, q), /unavailable/);
	const r = Q.mutationResult.parse(await S.call("associations.end", oa, q));
	assert.equal(r.status, "committed");
	assert.deepEqual(await S.call("associations.end", oa, q), r);
	await S.call("associations.end", oa, S.command(q.input, "0"));
	const h = Q.relationshipHistoryResult.parse(await S.call("associations.getHistory", pa, { plant: p }));
	assert.equal(h.status, "available");
	if (h.status !== "available") throw Error();
	assert.deepEqual(
		h.activeRelationships.map((r) => r.id),
		[other],
	);
	assert.equal(h.items.length, 2);
	assert.deepEqual(h.items.find((r) => r.event === "ended")?.reason, {
		status: "available",
		value: "Retained domain reason",
	});
	for (const actor of [oa, foreign])
		assert.deepEqual(await S.call("associations.getHistory", actor, { plant: p }), { status: "unavailable" });
	const m = Q.relationshipHistoryResult.parse(await S.call("associations.getHistory", member, { plant: p }));
	if (m.status !== "available") throw Error();
	assert.deepEqual(
		m.items.map((r) => r.reason),
		[{ status: "withheld" }, { status: "withheld" }],
	);
	assert.equal(
		(
			await S.db.execute(
				sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${sql.param(pa.account)} AND ended_at IS NULL`,
			)
		).rows[0].n,
		1,
	);
	const audit = await S.db.execute(
		sql`SELECT count(*)::int AS n,bool_and(e.tenant_id IN (coalesce(a.plant_id,a.account_id,a.sending_church_id),a.organization_id)) AS owned,bool_and(NOT(e.metadata ?| ARRAY['body','email','notes'])) AS safe FROM audit_event h JOIN audit_event e ON e.id=h.id JOIN affiliation a ON a.id=e.subject_id WHERE h.subject_id=${sql.param(a.relationship.id)}`,
	);
	assert.deepEqual(audit.rows, [{ n: 2, owned: true, safe: true }]);
	assert.equal(
		(
			await S.db.execute(
				sql`SELECT count(*)::int AS n FROM job WHERE producer_key LIKE 'relationship_ended/%' AND subject_record_id=${sql.param(a.relationship.id)}`,
			)
		).rows[0].n,
		1,
	);
	await assert.rejects(approve(i, oa, approvalKey), /unavailable/);
	await assert.rejects(approve(i, oa), /stale_revision|unavailable/);
	const j = await invite(pa, o, oa.email),
		rejoined = await approve(j, oa);
	assert.equal(rejoined.relationship.id, a.relationship.id);
	assert.equal(rejoined.relationship.revision, "3");
});
test("INV-relationships: invitation rotation, duplicate intents, decline, revoke and rolling limit preserve token boundaries", async () => {
	const p = await S.tenant("plant"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		i = await invite(pa, o, oa.email),
		old = S.proofs.get(i.invitationId);
	await assert.rejects(invite(pa, o, oa.email), /pending_invitation/);
	// BUG-wp007-writes: the same address for another organization while one request waits is a refusal, not a database error.
	await assert.rejects(invite(pa, await S.tenant("sending_network"), oa.email), /address_pending/);
	await assert.rejects(
		S.call("associations.resendInvitation", pa, S.command({ invitationId: i.invitationId })),
		/resend_cooldown/,
	);
	await S.db.execute(
		sql`UPDATE invitation SET created_at=clock_timestamp()-interval '2 minutes' WHERE id=${sql.param(i.invitationId)}`,
	);
	const r = pending(await S.call("associations.resendInvitation", pa, S.command({ invitationId: i.invitationId })));
	assert.equal(r.revision, "2");
	assert.notEqual(S.proofs.get(i.invitationId), old);
	await assert.rejects(
		S.call(
			"associations.acceptInvitation",
			oa,
			S.command({ invitationId: i.invitationId, proof: old, decision: "accept" }, "2"),
		),
		/unavailable/,
	);
	const d = Q.declinedInvitationResult.parse(
		await S.call(
			"associations.declineInvitation",
			oa,
			S.command({ invitationId: i.invitationId, decision: "decline" }, "2"),
		),
	);
	assert.equal(d.status, "declined");
	const j = await invite(pa, o, oa.email);
	await S.call("associations.revokeInvitation", pa, S.command({ invitationId: j.invitationId }));
	await assert.rejects(approve(j, oa), /stale_revision|unavailable/);
	const k = await invite(pa, o, oa.email);
	await S.call("associations.revokeInvitation", pa, S.command({ invitationId: k.invitationId }));
	await assert.rejects(invite(pa, o, oa.email), /invitation_limit/);
	const saved = await S.db.execute(
		sql`SELECT result->'receipt' AS receipt,result FROM audit_event WHERE result IS NOT NULL`,
	);
	assert.equal(JSON.stringify(saved.rows).includes(S.proofs.get(k.invitationId)), false);
});

test("INV-invitation-detail: only the addressed receiving Owner or Admin can read a request's details, even with the proof (ruling D48)", async () => {
	const p = await S.tenant("plant", "Harvest Point"),
		pa = await S.identity(p),
		o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		member = await S.identity(o, "member"),
		otherAddress = await S.identity(o, "admin"),
		wrongOrg = await S.identity(await S.tenant("sending_church")),
		seatless = await S.identity();
	const i = await invite(pa, o, oa.email),
		proof = S.proofs.get(i.invitationId)!;
	const read = (a: Awaited<ReturnType<typeof S.identity>>, input: unknown = { invitationId: i.invitationId, proof }) =>
		S.tx((c) => readAnswerableInvitation(c, a.session, a.selected, input));
	for (const holder of [wrongOrg, seatless, pa, member, otherAddress])
		assert.deepEqual(await read(holder), { status: "unavailable" });
	assert.deepEqual(await read(oa, { invitationId: i.invitationId, proof: "wrong" }), { status: "unavailable" });
	const shown = await read(oa);
	assert.equal(shown.status, "pending");
	if (shown.status !== "pending") throw Error();
	assert.equal(shown.invitationId, i.invitationId);
	// INV-reads: the respond page reads the request with the observed actor, in a fixed number of statements, no lock.
	const statements: string[] = [];
	let recording = false;
	const instrumented = new WeakSet<object>();
	S.runtime.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		client.query = function (...args: unknown[]) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text);
			return Reflect.apply(query, this, args);
		} as typeof client.query;
	});
	const authority = await S.tx((c) => RequestActor.resolve(c, oa.session));
	if (!(authority instanceof RequestActor)) throw Error();
	recording = true;
	const observed = await S.tx((c) => {
		authority.observe(c);
		return readAnswerableInvitation(c, oa.session, oa.selected, { invitationId: i.invitationId, proof });
	});
	recording = false;
	assert.deepEqual(observed, shown);
	assert.ok(statements.length <= 10, `respond read: ${statements.length} statements`);
	assert.equal(
		statements.some((q) => /for\s+(update|share)|access_session|invitation_identity/i.test(q)),
		false,
		"the respond read must not lock or resolve the actor again",
	);
	assert.equal(shown.inviterDescription, "Harvest Point");
	assert.deepEqual(shown.pair, i.pair);
	await S.call(
		"associations.respondInvitation",
		oa,
		S.command({ invitationId: i.invitationId, proof, decision: "decline" }),
	);
	assert.deepEqual(await read(oa), { status: "unavailable" });
});

test("AC:TARGET-IDN-021 a Discovery conversion and an organization ending that link at the same time both finish", async () => {
	// The production mounts bind the write gate before the command body; this binds it the same way.
	const onboarding = createOnboardingProducer({
		relationships: (c, inputs) => sendOnboardingRelationships(c, inputs, S.mail),
		async enqueue() {},
	});
	const o = await S.tenant("sending_church"),
		oa = await S.identity(o),
		d = await S.identity();
	const [discovery] = (
		await S.db.execute(sql`INSERT INTO discovery(account_id) VALUES(${sql.param(d.account)}) RETURNING id`)
	).rows as { id: string }[];
	const link = await S.affiliation(d.selected, o);
	const pair = { kind: "discovery", accountId: d.account, organization: o };
	let bound!: () => void;
	const gate = new Promise<void>((resolve) => (bound = resolve));
	const end = S.tx(async (c) => {
		assert.ok(await RequestActor.claimWrite(c, oa.session, oa.selected));
		bound();
		await waitingOnLock();
		return S.api["associations.end"](
			c,
			oa.session,
			oa.selected,
			S.command({ relationshipId: link, pair, confirmed: true, reason: null }),
		);
	});
	await gate;
	const conversion = S.tx((c) =>
		onboarding.convertDiscovery(
			c,
			{ session: d.session, selected: d.selected },
			S.command({ discoveryId: discovery!.id, name: "New plant", confirmed: true, relationships: [] }),
		),
	);
	// A deadlock or lock timeout rejects one side with its Postgres code (40P01 or 55P03).
	const outcome = (r: PromiseSettledResult<unknown>) =>
		r.status === "fulfilled"
			? r.value
			: { failed: (r.reason as { cause?: { code?: string } }).cause?.code ?? String(r.reason) };
	const [ended, converted] = (await Promise.allSettled([end, conversion])).map(outcome);
	assert.deepEqual(ended, { status: "committed" });
	assert.equal((converted as { value?: { status?: string } }).value?.status, "converted", JSON.stringify(converted));
	const rows = await S.db.execute(
		sql`SELECT (SELECT ended_at IS NOT NULL FROM affiliation WHERE id=${sql.param(link)}) AS ended,
		(SELECT count(*)::int FROM audit_event WHERE subject_id=${sql.param(link)} AND action='affiliation.ended') AS end_events,
		(SELECT converted_at IS NOT NULL FROM discovery WHERE id=${sql.param(discovery!.id)}) AS converted`,
	);
	assert.deepEqual(rows.rows[0], { ended: true, end_events: 1, converted: true });
});
/** Resolves once another transaction of this test role waits for a row lock. */
async function waitingOnLock() {
	for (let attempt = 0; attempt < 400; attempt++) {
		const r = await S.runtime.execute(
			sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock'`,
		);
		if ((r.rows[0] as { n: number }).n > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw Error("the rival transaction never waited for a lock");
}
