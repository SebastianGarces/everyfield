// The onboarding read of INV-tenancy (tenancy.test.mts): readOnboardingEntry for a plant Owner. The shared churches are
// raw fixture rows with no onboarding setup, so each church's owner here is a planter who created that church through
// the real onboarding producer, as tests/integration/onboarding/onboarding.test.mts does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { createOnboardingProducer, readOnboardingEntry } from "../../../packages/domain/src/onboarding/index.ts";

// The producer's mail and relationship ports as local fakes that send nothing; no notice is read back here.
const producer = createOnboardingProducer({ relationships: async () => {}, enqueue: async () => {} });
const planters = {};

/** A planter account and the church it creates through onboarding: church A's carries MARK, church B's does not. */
async function planter(t, name) {
	const { f, key, ok } = t;
	const p = { id: key(), user: key(), session: key() };
	// Raw rows because an account is registered through the outside authentication service, as the onboarding tests seed it.
	await f.admin.execute(sql`INSERT INTO auth_user(id,name,email,email_verified)
		VALUES(${p.user},'Synthetic',${`${p.user}@example.test`},true)`);
	await f.admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_kind,registration_state)
		VALUES(${p.id},${p.user},'planter','active')`);
	await f.admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${p.session},${p.user},${randomUUID()},clock_timestamp()+interval '1 day')`);
	const ctx = { session: p.session, selected: { kind: "account", id: p.id } };
	const created = ok(
		await f.db.transaction((tx) =>
			producer.createPlant(tx, ctx, {
				requestKey: key(),
				expectedRevision: "1",
				input: { name, locality: { city: "Boston" }, confirmed: true },
			}),
		),
	);
	return { ...p, name, plant: created.plant, actor: await f.actor(p.session) };
}

export async function seedOnboarding(t) {
	planters.a = await planter(t, `${t.MARK} onboarding church`);
	planters.b = await planter(t, "Beta onboarding church");
}

/** The resume of a church just created through onboarding, with no step taken yet. */
const fresh = (plant) => ({
	status: "available",
	plant: { kind: "plant", id: plant.id },
	basics: "created",
	completion: { status: "unfinished" },
	currentPhase: 1,
	journey: { status: "pending" },
	launch: { status: "pending" },
	lead: { answer: "pending" },
	materialRevision: "2",
	peopleStep: "pending",
	reading: { status: "incomplete" },
	revision: "1",
	scheduleRevision: "1",
	scheduledLaunchDate: null,
	values: "missing",
});

export function onboardingCases(t, who) {
	const owner = who === t.ownerA ? planters.a : planters.b;
	const entry = () =>
		readOnboardingEntry(
			t.f.db,
			producer,
			{
				status: "active",
				accountId: owner.id,
				sessionId: owner.session,
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			},
			owner.actor,
			true,
		);
	return [
		[
			"onboarding:readOnboardingEntry",
			{
				run: async () => ({ status: "ok", value: await entry() }),
				expected: {
					value: { kind: "plant", plantName: owner.name, resume: fresh(owner.plant) },
					control: (value) =>
						assert.deepEqual(value, {
							kind: "plant",
							plantName: `${t.MARK} onboarding church`,
							resume: fresh(planters.a.plant),
						}),
				},
			},
		],
	];
}
