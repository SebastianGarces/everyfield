import "../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../packages/db/src/query.ts";
import { currentActor } from "../../../../packages/domain/src/access/session.ts";
import { createOrganizationAdapter } from "../../../../packages/domain/src/organizations/index.ts";
import { peopleWriter, withPeopleWrite } from "../../../../packages/domain/src/people/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { evryActor, EvryRefusal, prepareProposal, readCatalog } from "../../../../packages/evry/src/index.ts";
import { codeOf, fixture, type Fixture } from "../../identity/invitations-support.mts";
import { ok } from "../../../support/fixture.mts";

let f: Fixture;
before(async () => {
	f = await fixture();
});
after(() => f?.close());

const COACH = /coach|mentor/i;

test("AC:TARGET-IDN-018 Evry lists no coach tool for anyone, forged coach requests refuse and write nothing, and a recorded outside mentor gets no access", async () => {
	const plant = await f.workspace(),
		org = await f.workspace("sending_church");
	const seated = async (w: typeof plant, role: "owner" | "admin" | "member") => {
		const a = await f.account();
		await f.seat(a, w, role);
		return { ...a, actor: await f.actor(a.session) };
	};
	const owner = await seated(plant, "owner"),
		admin = await seated(plant, "admin"),
		member = await seated(plant, "member"),
		director = await seated(org, "owner");
	const morgan = await f.account("active", "morgan@example.test");
	const discovery = { ...morgan, actor: await f.actor(morgan.session) };
	for (const who of [owner, admin, member, director, discovery]) {
		const catalog = readCatalog(evryActor(who.actor));
		const operations = [...catalog.domains.flatMap((d) => d.operations), ...catalog.reviewedWrites];
		assert.ok(who === discovery || operations.length > 0);
		assert.deepEqual(
			operations.filter((o) => COACH.test(o.operation)),
			[],
		);
		assert.deepEqual(
			catalog.domains.filter((d) => COACH.test(d.domain)),
			[],
		);
	}
	const named = (
		await f.admin.execute<{ name: string }>(
			sql`SELECT table_name||'.'||column_name AS name FROM information_schema.columns WHERE table_schema=${f.schema} AND (table_name ~* 'coach|mentor' OR column_name ~* 'coach|mentor')`,
		)
	).rows;
	assert.deepEqual(named, []);
	const state = async () =>
		(
			await f.admin
				.execute(sql`SELECT (SELECT count(*)::int FROM seat) seats,(SELECT count(*)::int FROM invitation) invitations,
				(SELECT count(*)::int FROM affiliation) affiliations,(SELECT count(*)::int FROM residency_link) links,
				(SELECT count(*)::int FROM platform_grant) grants,(SELECT count(*)::int FROM proposal) proposals,
				(SELECT count(*)::int FROM audit_event) events,(SELECT count(*)::int FROM mail) mail`)
		).rows[0];
	const before = await state();
	const envelope = (input: object) => ({ requestKey: randomUUID(), expectedRevision: "1", input });
	const invalid = (attempt: Promise<unknown>) =>
		assert.rejects(attempt, (error) => {
			assert.ok(error instanceof Error && error.name === "ZodError", String(error));
			return true;
		});
	for (const role of ["coach", "mentor"])
		await invalid(
			f.invitations.invite(owner.actor, envelope({ workspace: plant, role, recipientEmail: morgan.email })),
		);
	await invalid(
		f.invitations.invite(
			owner.actor,
			envelope({ workspace: { ...plant, kind: "coach" }, role: "member", recipientEmail: morgan.email }),
		),
	);
	const adminSeat = (await f.admin.execute<{ id: string }>(sql`SELECT id FROM seat WHERE account_id=${member.id}`))
		.rows[0]!.id;
	await invalid(
		f.seats.appointAdmin(owner.actor, plant, envelope({ seatId: adminSeat, expectedRole: "member", to: "coach" })),
	);
	const organizations = createOrganizationAdapter(
		{ invitation: async () => {}, invalidate: () => sql`SELECT 1` },
		{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
	);
	await invalid(
		gatedTransaction(f.db, (tx) =>
			organizations["associations.invite"](
				tx,
				owner.session as never,
				plant,
				envelope({
					pair: { kind: "coach", subject: plant, organization: org },
					recipientEmail: morgan.email,
					terms: "coach",
				}),
			),
		),
	);
	const native = f.native();
	for (const path of ["coach/invite", "coach/accept", "coaches", "coach/assign"]) {
		const response = await native(path, { plant: plant.id, email: morgan.email });
		assert.equal(response.status, 404, path);
	}
	for (const operation of ["coaches.invite", "coaches.assign", "coach.accept", "people.assignCoach"])
		await assert.rejects(
			prepareProposal(
				f.db,
				evryActor(owner.actor),
				{ turnId: randomUUID(), tenantId: plant.id, leaseOwner: randomUUID(), generation: "1" } as never,
				randomUUID(),
				{ operation, input: { plant: plant.id, email: morgan.email } },
			),
			(error) => {
				assert.ok(error instanceof EvryRefusal, String(error));
				return true;
			},
		);
	assert.deepEqual(await state(), before);

	const recorded = ok(
		await withPeopleWrite(f.db, owner.actor, (tx, context) =>
			peopleWriter.createPerson(tx, context, {
				requestKey: randomUUID(),
				input: {
					displayName: "Morgan Mentor",
					email: morgan.email,
					adultClassification: "adult",
					summaryNotes: "Our outside mentor since 2026-10-01, confirmed",
				},
			}),
		),
	);
	assert.ok(recorded.person.id);
	const after = await state();
	assert.deepEqual(
		{ ...after, events: before!.events, proposals: before!.proposals },
		before,
		"the mentor record grants no seat, link or invitation",
	);
	assert.deepEqual(await gatedTransaction(f.db, (tx) => currentActor(tx, morgan.session, plant)), {
		status: "unavailable",
	});
	assert.equal(
		(
			await f.admin.execute<{ linked: string | null }>(
				sql`SELECT linked_account_id AS linked FROM person WHERE id=${recorded.person.id}`,
			)
		).rows[0]!.linked,
		null,
	);
	await assert.rejects(f.seats.list(discovery.actor, { workspace: plant }), (error) => {
		assert.equal(codeOf(error), "invitation_unavailable");
		return true;
	});
});
