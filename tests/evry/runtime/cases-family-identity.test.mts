import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createInvitationService } from "../../../packages/domain/src/identity/index.ts";
import type { InvitationMail } from "../../../packages/domain/src/identity/invitations.ts";
import { runDueFeedbackPublication } from "../../../packages/domain/src/jobs/feedback-publication.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { deletionOperations } from "../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import { approveProposal } from "../../../packages/evry/src/index.ts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import { ok, raced, refused, type Actor } from "../../support/fixture.mts";
import { frozenClock } from "../../support/test-database.mts";
import { nativePorts } from "../evals/settings-ports.mts";
import { caseWorld, propose, proposes, read, rowsOf, sql, type CaseWorld } from "./case-world.mts";

const letters: InvitationMail[] = [];
const ports = nativePorts();
const native = {
	...ports,
	invitations: (on: unknown) =>
		createInvitationService({
			db: on as never,
			origin: "https://evry.example.test",
			budgetSecret: "settings-evals",
			people: accountPersonProducer,
			addressBlocked: () => sql`false`,
			async enqueueMail(_tx, letter) {
				letters.push(letter);
				return randomUUID();
			},
		}),
};
let w: CaseWorld;
before(async () => {
	w = await caseWorld("familyidentity", { native });
});
after(() => w?.close());

const seatOf = async (who: Actor) =>
	String((await w.one(sql`SELECT id FROM seat WHERE account_id=${who.id} AND ended_at IS NULL`)).id);
const roleOf = async (who: Actor) =>
	(await w.rows(sql`SELECT role FROM seat WHERE account_id=${who.id} AND ended_at IS NULL`)).map((r) => r.role);
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
const proofIn = (letter: InvitationMail) => decodeURIComponent(/#proof=([^\s]+)/.exec(letter.text)![1]!);
const accept = (who: Actor, letter: InvitationMail, requestKey: string = randomUUID()) =>
	native.invitations(w.db).accept(who.session, {
		requestKey,
		expectedRevision: "1",
		input: { invitationId: letter.invitationId, proof: proofIn(letter) },
	});
const code = (attempt: Promise<unknown>) =>
	attempt.then(
		() => "accepted",
		(e: { code?: string }) => e.code ?? "refused",
	);
async function link(plant: string, organization: string) {
	await w.admin
		.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${plant},${organization},clock_timestamp()-interval '1 day',false,false,false,false,false,false,true)`);
}
const CREDENTIAL =
	/^(auth|security|marketing|platformAdmin|access)\.|password|signIn|signOut|session|token|emailChange|register/i;

test("AC:EVRY-FAMILY-IDENTITY-PLATFORM one invite gives one seat, Owner and Admin run the same routine, only the Owner may delete, one ended link leaves the other, and a deletion is cancelled only before its deadline", async () => {
	const c = await w.church();
	const owner = await w.seated(c.P, "owner", { user: { name: "Olivia Owner" } });
	const member = await w.seated(c.P, "member", { user: { name: "Max Member" } });
	const offeredTo = async (who: Actor) => (await w.ask(who, "hi", [])).offered;

	const guest = await w.seated(null as never, "owner", { email: "guest@example.test" });
	const stranger = await w.seated(null as never, "owner", { email: "stranger@example.test" });
	const second = randomUUID();
	await w.admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${second},${guest.user},${randomUUID()},clock_timestamp()+interval '1 day')`);
	const invited = await w.apply(c.A, "seats.invite", { email: guest.email, role: "member" });
	assert.equal(invited.outcome, "completed");
	const letter = letters.at(-1)!;
	assert.deepEqual([letter.recipientEmail, letter.purpose], [guest.email, "seat_invitation"]);
	assert.deepEqual(
		rowsOf(await w.look(c.A, "seats.listInvitations", {})).map((r) => r.fields.role),
		["Member"],
	);
	assert.notEqual(await code(accept(stranger, letter)), "accepted", "only the addressed account may claim it");
	const claims = await raced(
		w.admin,
		w.db,
		sql`SELECT 1 FROM invitation WHERE id=${letter.invitationId}::uuid FOR UPDATE`,
		[() => code(accept(guest, letter)), () => code(accept({ ...guest, session: second as never }, letter))],
	);
	assert.equal(claims.filter((x) => x === "accepted").length, 1, JSON.stringify(claims));
	assert.deepEqual([await roleOf(guest), await roleOf(stranger)], [["member"], []]);
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM invitation WHERE id=${letter.invitationId} AND state='accepted'`),
		1,
	);
	const elsewhere = await w.plant({});
	const rival = await w.seated(elsewhere, "owner");
	await w.apply(rival, "seats.invite", { email: guest.email, role: "admin" });
	assert.notEqual(await code(accept(guest, letters.at(-1)!)), "accepted", "one active seat");
	assert.deepEqual(await roleOf(guest), ["member"]);

	const routine: [operation: string, input: (n: number) => object][] = [
		["plant.updateProfile", (n) => ({ patch: { city: `City ${n}` } })],
		["church.digestSchedule.set", (n) => ({ schedule: { cadence: "daily", hour: 5 + n } })],
		["seats.changeOrdinaryRole", (n) => ({ seatId: guestSeat, role: n ? "member" : "admin" })],
		["seats.invite", (n) => ({ email: `new${n}@example.test`, role: "admin" })],
	];
	const guestSeat = await seatOf(guest);
	for (const [operation, input] of routine)
		for (const [n, who] of [owner, c.A].entries()) {
			const before =
				await w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${c.P.id} AND actor_id=${who.id}
				AND action NOT LIKE 'evry.%'`);
			await w.apply(who, operation, input(n));
			assert.ok(
				(await w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${c.P.id} AND actor_id=${who.id}
				AND action NOT LIKE 'evry.%'`)) > before,
				`${operation} by each`,
			);
		}
	assert.deepEqual(
		(await offeredTo(owner)).filter((o) => !/^onboarding\.|answerLeadOnboarding/.test(o)),
		await offeredTo(c.A),
		"the same catalog but for the Owner's own setup",
	);
	assert.deepEqual(await w.one(sql`SELECT city,digest_hour::int AS hour FROM plant WHERE id=${c.P.id}`), {
		city: "City 1",
		hour: 6,
	});
	assert.deepEqual(await roleOf(guest), ["member"]);
	const plain = await offeredTo(member);
	assert.deepEqual(
		routine.map(([o]) => o).filter((o) => plain.includes(o)),
		[],
		"a Member gets none of them",
	);
	const listed = rowsOf(await w.look(c.A, "seats.list", {}));
	assert.deepEqual(
		listed.filter((r) => r.fields.you).map((r) => [r.label, r.fields.role]),
		[["Alex Admin", "Admin"]],
		"the caller's own current membership",
	);
	const demoted = await w.ask(c.A, "Demote the Owner", [
		proposes("seats.changeOrdinaryRole", { seatId: await seatOf(owner), role: "member" }),
	]);
	assert.deepEqual([demoted.proposals, Boolean(demoted.replies[0].error)], [[], true], "not an ordinary role");
	assert.deepEqual(await roleOf(owner), ["owner"]);

	const zone = await w.prepare(c.A, "plant.setTimezone", { timeZone: "America/New_York" });
	assert.deepEqual(zone.review.changes, [{ field: "timeZone", before: "America/Chicago", after: "America/New_York" }]);
	assert.match(zone.review.notes![1]!, /digest email, Wed, Oct 14: 7:00 AM → 6:00 AM Eastern time$/);
	assert.equal(zone.review.notes!.at(-1), "Task due dates keep their day.");
	assert.equal((await w.one(sql`SELECT timezone FROM plant WHERE id=${c.P.id}`)).timezone, "America/Chicago");

	const lead = await w.seated(c.P, "member", { user: { name: "Lena Lead" } });
	const before = await offeredTo(lead);
	const person = await c.person("Lena Lead", { stage: "leader", email: lead.email });
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${lead.id} WHERE id=${person}`);
	await w.admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${randomUUID()},${c.P.id},'Lead team','active',1,${person},'explicit')`);
	assert.deepEqual(
		(await offeredTo(lead)).filter((o) => !before.includes(o) && !/^(meetings|teams|phases)\./.test(o)),
		[],
		"a lead title grants no account privilege",
	);
	assert.deepEqual(await roleOf(lead), ["member"]);

	const workspace = async (who: Actor) =>
		gatedTransaction(w.db, async (tx) => {
			await RequestActor.claimWrite(tx, who.session, c.P as never);
			return deletion.requestWorkspaceDeletion(
				tx as never,
				{ session: who.session, selected: c.P } as never,
				{
					requestKey: randomUUID(),
					expectedRevision: String((await w.one(sql`SELECT revision::text AS r FROM plant WHERE id=${c.P.id}`)).r),
					input: { plant: c.P, confirmed: true },
				} as never,
			);
		});
	for (const who of [c.A, member, lead]) assert.equal(await code(workspace(who)), "unavailable");
	for (const who of [owner, c.A, member, guest, stranger]) {
		const all = await offeredTo(who);
		assert.deepEqual(
			all.filter((o) => CREDENTIAL.test(o) || /workspacedelet|cancelDeletion/i.test(o)),
			[],
		);
	}
	for (const operation of ["auth.signIn", "account.changePassword", "churches.requestWorkspaceDeletion"]) {
		const tried = await w.quiet(() => w.ask(owner, operation, [proposes(operation, {})]));
		assert.deepEqual([tried.replies[0].error, tried.proposals], ["not_offered", []]);
	}

	const discovery = await offeredTo(stranger);
	assert.ok(discovery.includes("discovery.create") && discovery.includes("onboarding.createPlant"));
	assert.deepEqual(
		discovery.filter((o) => /^(people|teams|meetings|phases|intelligence|oversight|seats|plant|tasks)\./.test(o)),
		[],
	);
	const pending = await w.seated(null as never, "owner", { account: { registration_state: "pending_domain" } });
	assert.equal(
		(await RequestActor.resolve(w.db, pending.session)) instanceof RequestActor,
		false,
		"no grant before it ends",
	);
	const director = await w.seated(await w.organization("sending_network", { name: "Far network" }), "member");
	assert.deepEqual(
		(await offeredTo(director)).filter((o) => /^(people|seats|plant)\./.test(o)),
		[],
	);

	const [S1, N1] = [
		await w.organization("sending_church", { name: "Sending One" }),
		await w.organization("sending_network", { name: "Network One" }),
	];
	await link(c.P.id, S1.id);
	await link(c.P.id, N1.id);
	const active = async () =>
		(
			await w.rows(
				sql`SELECT o.name FROM affiliation a JOIN organization o ON o.id=a.organization_id WHERE a.plant_id=${c.P.id} AND a.ended_at IS NULL ORDER BY 1`,
			)
		).map((r) => r.name);
	const [s1, n1] = [await w.seated(S1, "admin"), await w.seated(N1, "admin")];
	const sees = async (who: Actor) => rowsOf(await w.look(who, "oversight.listPlants", {})).map((r) => r.id);
	assert.deepEqual([await sees(s1), await sees(n1)], [[c.P.id], [c.P.id]]);
	await w.apply(c.A, "associations.end", { organizationId: S1.id });
	assert.deepEqual([await active(), await sees(s1), await sees(n1)], [["Network One"], [], [c.P.id]]);
	const history = await w.look(c.A, "associations.getHistory", {});
	assert.match(JSON.stringify(history.rows), /Sending One/);
	assert.match(JSON.stringify(await w.look(c.A, "privacy.getSharing", {})), /Network One/);

	const words = "The task filter hides CONTACT guest@example.test for Casey Reed";
	await w.apply(c.A, "feedback.submit", { category: "suggestion", description: words });
	const published: { title: string; body: string }[] = [];
	await runDueFeedbackPublication(
		w.db,
		{
			repository: { id: "10", name: "everyfield-test/feedback" },
			issues: {
				search: async () => ({ kind: "found", issues: [] }),
				create: async (_repository: unknown, issue: never) => {
					published.push(issue);
					return { kind: "created", issue: { number: 1, url: "https://github.example.test/1" } };
				},
			},
			operatorMail: null,
		} as never,
		10,
		Date.now() + 30_000,
	);
	const kept = await w.one(sql`SELECT id,description,reference FROM feedback WHERE account_id=${c.A.id}`);
	assert.equal(kept.description, words, "the private words are kept");
	assert.equal(published.length, 1);
	const shown = JSON.stringify(published);
	assert.ok(shown.includes(String(kept.reference)));
	for (const secret of [words, "CONTACT", "guest@example.test", "Casey", c.A.id, c.A.email, c.P.id, "CARE"])
		assert.equal(shown.includes(secret), false, secret);
	const status = async (who: Actor) =>
		w.look(who, "feedback.getOwnStatus", { feedbackId: kept.id }).then((r) => [r.status, rowsOf(r).length]);
	assert.deepEqual(
		[await status(c.A), await status(owner)],
		[
			["available", 1],
			["not_found", 0],
		],
		"own status only",
	);

	const said = "Invite someone, change our profile and end our link";
	const invite = await w.prepare(c.A, "seats.invite", { email: "late@example.test", role: "member" });
	await c.foreignReview(invite);
	await c.foreign(
		said,
		[
			() => [read("seats.list", {}), read("associations.getHistory", {})],
			() => propose("seats.remove", { seatId: guestSeat }),
			() => propose("associations.end", { organizationId: N1.id }),
		],
		{ secrets: ["Olivia Owner", "Network One", words], found: ["Foreign Member"], on: { onError: "go_on" } },
	);
	const sent = letters.length;
	await c.failedWrite(invite, "invitation");
	assert.equal(letters.length > sent, true);

	const leaving = await w.prepare(member, "account.requestDeletion", {});
	await approveProposal(w.db, await w.actorOf(member), leaving.id, w.witness(leaving), null);
	assert.equal(await w.effect(), "completed");
	assert.equal(await readViewer(w.db, member.session as never), null, "the normal session is revoked");
	const witness = await w.one<{ request_id: string; rev: string; requested: string; until: string }>(
		sql`SELECT request_id,request_revision::text AS rev,requested_at::text AS requested,cancel_until::text AS until FROM lifecycle_witness WHERE opaque_subject_id=${member.id}`,
	);
	assert.equal(Date.parse(witness.until) - Date.parse(witness.requested), 30 * 86_400_000);
	const subject = { kind: "account" as const, id: member.id };
	const restricted = async () =>
		openedDeletion(
			gatedTransaction(w.admin, (tx) =>
				issueRestrictedDeletionSession(tx as never, { subject, requestId: witness.request_id } as never, async () => ({
					accountId: member.id,
					provenAt: new Date(),
				})),
			) as never,
			{ subject, requestId: witness.request_id } as never,
		);
	const proof = await restricted();
	const seen = ok(
		await gatedTransaction(w.db, (tx) =>
			deletion.getAccountDeletionStatus(tx as never, proof as never, { subject, requestId: witness.request_id }),
		),
	) as Record<string, unknown>;
	assert.deepEqual(
		Object.keys(seen).sort(),
		["cancelUntil", "requestId", "requestedAt", "revision", "status", "subject"],
		"no normal content",
	);
	const deadline = Date.parse(witness.until);
	const cancelAt = async (instant: number) => {
		await w.at(new Date(instant).toISOString());
		return frozenClock(w.admin, w.schema, new Date(instant).toISOString(), async () => {
			const held = await restricted();
			return gatedTransaction(w.db, (tx) =>
				deletion.cancelAccountDeletion(
					tx as never,
					held as never,
					{
						requestKey: randomUUID(),
						expectedRevision: witness.rev,
						input: { subject, requestId: witness.request_id },
					} as never,
				),
			);
		});
	};
	const stateOf = async () =>
		(await w.one(sql`SELECT state FROM lifecycle_witness WHERE opaque_subject_id=${member.id}`)).state;
	refused(await cancelAt(deadline), "deadline_passed");
	assert.equal(await stateOf(), "pending_deletion");
	ok(await cancelAt(deadline - 1));
	assert.equal(await stateOf(), "cancelled");
});
