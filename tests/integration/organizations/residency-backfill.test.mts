import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { backfill } from "../../../packages/db/src/schema/migrate.ts";
import { fixture } from "../identity/invitations-support.mts";
import { authorityOf } from "../people/people-support.mts";
import type { Actor } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { accountId, instant } from "../../../packages/contracts/src/common/index.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createOnboardingProducer, readOnboardingEntry } from "../../../packages/domain/src/onboarding/index.ts";
import { residentDiscoveryBackfill } from "../../../packages/domain/src/onboarding/backfill.ts";

let f: Awaited<ReturnType<typeof fixture>>;
type Account = Pick<Actor, "id" | "session">;
let ended: Account, linked: Account, kept: Account, seated: Account, declined: Account, pending: Account;

const onboarding = createOnboardingProducer({
	relationships: async () => {
		throw Error("no relationship notices here");
	},
	enqueue: async () => {
		throw Error("no onboarding mail here");
	},
});
const entryOf = async (a: Account) =>
	(
		await readOnboardingEntry(
			f.db,
			onboarding,
			{
				status: "active",
				accountId: accountId.parse(a.id),
				sessionId: a.session,
				expiresAt: instant.parse(new Date(Date.now() + 3600000).toISOString()),
			},
			await authorityOf(f.db, a),
			true,
		)
	).kind;
const discoveries = async (a: Account) =>
	(
		await f.admin.execute(
			sql`SELECT id,revision::text AS revision,lead_answer,journey_answer,launch_answer,converted_at,converted_plant_id,
	 conversion_operation_id FROM discovery WHERE account_id=${a.id}::uuid`,
		)
	).rows;
const fresh = {
	revision: "1",
	lead_answer: null,
	journey_answer: null,
	launch_answer: null,
	converted_at: null,
	converted_plant_id: null,
	conversion_operation_id: null,
};
const withoutId = (rows: Record<string, unknown>[]) => rows.map(({ id: _id, ...rest }) => rest);
const preChange = (a: Account) => f.admin.execute(sql`DELETE FROM discovery WHERE account_id=${a.id}::uuid`);

const adapter = createOrganizationAdapter(
	{
		invitation: async () => {
			throw Error("no relationship invitation here");
		},
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded' WHERE subject_record_id=${sql.param(v.sourceId)} AND kind='digest' AND false`,
	},
	{ candidates: () => sql`SELECT NULL::uuid WHERE false` },
);
async function leave(a: Account) {
	const l = (
		await f.admin.execute(
			sql`SELECT id,revision::text AS revision,consent_revision::text AS consent FROM residency_link
	 WHERE account_id=${a.id}::uuid AND ended_at IS NULL`,
		)
	).rows[0] as { id: string; revision: string; consent: string };
	const owner = { kind: "account" as const, id: accountId.parse(a.id) };
	await gatedTransaction(f.db, async (tx) => {
		if (!(await RequestActor.claimWrite(tx, a.session, owner))) throw Error("unavailable");
		return adapter["residency.leave"](tx, a.session, owner, {
			requestKey: randomUUID(),
			expectedRevision: l.revision,
			input: { linkId: l.id, expectedConsentRevision: l.consent },
		});
	});
}
async function invited(decision?: "accept" | "decline", beforeAnswer?: (a: Account) => Promise<unknown>) {
	const s = await f.setup("sending_church");
	const i = await f.invitation(s, await f.resident(s.w));
	const a = { id: s.recipient.id, session: s.recipient.session };
	await beforeAnswer?.(a);
	if (decision) {
		const r = await f.invitations.respondResident(a.session, {
			...i.claim,
			input: {
				...i.claim.input,
				decision,
				...(decision === "accept" ? { choices: { shareFoundations: false, shareMilestones: false } } : {}),
			},
		});
		assert.equal(r.status, decision === "accept" ? "accepted" : "declined");
	}
	return a;
}
const run = () => backfill(f.admin, [residentDiscoveryBackfill()], f.schema);
const recorded = async () =>
	(
		await f.admin.execute(
			sql`SELECT name,changed::int AS changed FROM schema_backfill WHERE name=${residentDiscoveryBackfill().name}`,
		)
	).rows;
const counts = async () =>
	(
		await f.admin.execute(
			sql`SELECT account_id,count(*)::int AS n FROM discovery GROUP BY account_id HAVING count(*)>1`,
		)
	).rows;

before(async () => {
	f = await fixture();
	ended = await invited("accept");
	await leave(ended);
	await preChange(ended);
	linked = await invited("accept");
	await preChange(linked);
	kept = await invited("accept", (a) =>
		f.admin.execute(sql`INSERT INTO discovery(id,account_id,revision,lead_answer,journey_answer,launch_answer)
	 VALUES(${randomUUID()},${a.id}::uuid,3,'yes','discerning','no_date')`),
	);
	seated = await invited("accept", async (a) => f.seat(a, await f.workspace("plant")));
	declined = await invited("decline");
	pending = await invited();
});
after(() => f?.close());

test("before the backfill a pre-change resident, ended or still linked, has no Discovery space and gets the start choice", async () => {
	assert.deepEqual(await discoveries(ended), []);
	assert.deepEqual(await discoveries(linked), []);
	assert.equal(await entryOf(ended), "start");
	assert.equal(await entryOf(linked), "start");
});

test("the backfill gives each seatless resident one fresh Discovery space, records its count and leaves everyone else as they were", async () => {
	const keptBefore = await discoveries(kept);
	assert.deepEqual(withoutId(keptBefore), [
		{ ...fresh, revision: "3", lead_answer: "yes", journey_answer: "discerning", launch_answer: "no_date" },
	]);
	assert.deepEqual(await run(), [{ name: "resident_discovery_d1891", changed: 2 }]);
	assert.deepEqual(await recorded(), [{ name: "resident_discovery_d1891", changed: 2 }]);
	assert.deepEqual(withoutId(await discoveries(ended)), [fresh]);
	assert.deepEqual(withoutId(await discoveries(linked)), [fresh]);
	assert.deepEqual(await discoveries(kept), keptBefore);
	assert.deepEqual(await discoveries(seated), []);
	assert.deepEqual(await discoveries(declined), []);
	assert.deepEqual(await discoveries(pending), []);
});

test("after the backfill the ended and the linked pre-change residents both open their Discovery space", async () => {
	assert.equal(await entryOf(ended), "discovery");
	assert.equal(await entryOf(linked), "discovery");
});

test("the backfill runs once: a second migrate skips it by name, and running it again creates nothing", async () => {
	const all = async () =>
		(await f.admin.execute(sql`SELECT id,account_id,revision::text AS revision FROM discovery ORDER BY id`)).rows;
	const rows = await all();
	assert.deepEqual(await run(), []);
	assert.deepEqual(await recorded(), [{ name: "resident_discovery_d1891", changed: 2 }]);
	assert.deepEqual(await all(), rows);
	assert.equal(await f.admin.transaction((tx) => residentDiscoveryBackfill().run(tx)), 0);
	assert.deepEqual(await all(), rows);
	assert.deepEqual(await counts(), []);
});
