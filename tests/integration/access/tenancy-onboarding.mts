import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { createOnboardingProducer, readOnboardingEntry } from "../../../packages/domain/src/onboarding/index.ts";
import { accountId, instant, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { readLeadPlanter } from "../../../packages/domain/src/settings/index.ts";
import { plain, tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const producer = createOnboardingProducer({ relationships: async () => {}, enqueue: async () => {} });
type Planter = Awaited<ReturnType<typeof planter>>;
const planters = {} as Record<"a" | "b" | "leadA", Planter>;

async function planter(t: Tenancy, name: string) {
	const { f, key, ok } = t;
	const p = { id: key(), user: key(), session: sessionId.parse(key()) };
	await f.admin.execute(sql`INSERT INTO auth_user(id,name,email,email_verified)
		VALUES(${p.user},'Synthetic',${`${p.user}@example.test`},true)`);
	await f.admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_kind,registration_state)
		VALUES(${p.id},${p.user},'planter','active')`);
	await f.admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${p.session},${p.user},${randomUUID()},clock_timestamp()+interval '1 day')`);
	const ctx = { session: p.session, selected: { kind: "account" as const, id: accountId.parse(p.id) } };
	const created = ok(
		await gatedTransaction(f.db, (tx) =>
			producer.createPlant(tx, ctx, {
				requestKey: key(),
				expectedRevision: "1",
				input: { name, locality: { city: "Boston" }, confirmed: true },
			}),
		),
	);
	return { ...p, name, plant: created.plant, actor: await f.actor(p.session) };
}

export async function seedOnboarding(t: Tenancy) {
	planters.a = await planter(t, `${t.MARK} onboarding church`);
	planters.b = await planter(t, "Beta onboarding church");
	const lead = await planter(t, `${t.MARK} lead church`);
	t.ok(
		await gatedTransaction(t.f.db, (tx) =>
			producer.answerLead(
				tx,
				{ session: lead.session, selected: lead.plant },
				{
					requestKey: t.key(),
					expectedRevision: "1",
					input: {
						answer: "yes",
						assignment: {
							kind: "minimal_role",
							roleName: "Lead pastor",
							container: { kind: "minimal", name: "Leadership" },
						},
					},
				},
			),
		),
	);
	planters.leadA = lead;
}

const fresh = (plant: Planter["plant"]) => ({
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

const entryOf = (p: Planter) => ({ kind: "plant", plantName: p.name, resume: fresh(p.plant) });

export function onboardingCases(t: Tenancy, who: TenancyOwner) {
	const owner = who === t.ownerA ? planters.a : planters.b;
	const entry = () =>
		readOnboardingEntry(
			t.f.db,
			producer,
			{
				status: "active",
				accountId: accountId.parse(owner.id),
				sessionId: owner.session,
				expiresAt: instant.parse(new Date(Date.now() + 3_600_000).toISOString()),
			},
			owner.actor,
			true,
		);
	return [
		tenancyCase("onboarding:readOnboardingEntry", async () => ({ status: "ok", value: await entry() }), {
			value: entryOf(owner),
			control: (value) => assert.deepEqual(value, entryOf(planters.a)),
		}),
		tenancyCase(
			"settings:readLeadPlanter",
			() => plain(() => readLeadPlanter(t.f.db, (who === t.ownerA ? planters.leadA : planters.b).actor)),
			{
				check: (value) => assert.deepEqual([value!.lead, value!.people], [null, []]),
				control: (value) => assert.deepEqual([value!.canEdit, value!.people.length], [true, 1]),
			},
		),
	];
}
