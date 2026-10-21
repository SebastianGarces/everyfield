import * as f from "@everyfield/contracts/people";
import { and, eq, ne, sql, type SQL } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	authorize,
	deny,
	mutation,
	parse,
	readReply,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import {
	address,
	addressOf,
	addressView,
	expectRevision,
	hasAddress,
	livePerson,
	next,
	personFacts,
	plantId,
	type Address,
	type PersonFacts,
} from "../fields/shared.ts";

type Role = z.infer<typeof f.householdRole>;
const roleOrder = f.householdRole.options;
const memberRow = z.object({
	id: z.uuid(),
	display_name: z.string(),
	household_role: f.householdRole,
	revision: z.coerce.string(),
	...address,
});
const householdRow = z.object({
	id: z.uuid(),
	name: z.string(),
	revision: z.coerce.string(),
	...address,
	members: z.array(memberRow),
});
type Household = z.infer<typeof householdRow>;
type Member = z.infer<typeof memberRow>;

/**
 * One household with its live members as one JSON value; retired members are history, not membership. A scalar
 * subquery, so a write reads it in the same round trip as its Person (`id` may name the outer `person`).
 */
const householdJson = (plant: string, id: SQL) =>
	sql`(SELECT jsonb_build_object('id',h.id,'name',h.name,'revision',h.revision::text,'street',h.street,'city',h.city,
 'state_province',h.state_province,'postal_code',h.postal_code,'country',h.country,'members',
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'display_name',m.display_name,'household_role',m.household_role,
   'revision',m.revision::text,'street',m.street,'city',m.city,'state_province',m.state_province,'postal_code',m.postal_code,
   'country',m.country)) FROM person m WHERE m.household_id=h.id AND m.tenant_id=h.plant_id AND m.state='live'),'[]'))
 FROM household h WHERE h.id=${id} AND h.plant_id=${plant}::uuid)`;
function household(raw: unknown): Household {
	if (!raw) deny();
	return householdRow.parse(raw);
}
async function readHousehold(tx: Tx, plant: string, id: string): Promise<Household> {
	const result = await tx.execute(sql`SELECT ${householdJson(plant, sql`${id}::uuid`)} AS h`);
	return household(result.rows[0]?.h);
}
const memberOrder = (a: Member, b: Member) =>
	roleOrder.indexOf(a.household_role) - roleOrder.indexOf(b.household_role) ||
	a.display_name.localeCompare(b.display_name) ||
	a.id.localeCompare(b.id);
function view(h: Household) {
	const members = [...h.members].sort(memberOrder);
	return f.householdResult.parse({
		status: "available",
		household: { id: h.id, name: h.name, ...addressView(h), revision: h.revision, memberCount: members.length },
		members: members.map((m) => ({
			personId: m.id,
			displayName: m.display_name,
			role: m.household_role,
			revision: m.revision,
			...addressView(m),
		})),
	});
}
/** The Person row after it joins: a person without a meaningful address takes the household's (REQ-PPL-009). */
function joined(p: PersonFacts, h: Address, role: Role): Member {
	return {
		id: p.id,
		display_name: p.display_name,
		household_role: role,
		revision: next(p.revision),
		...(hasAddress(p) || !hasAddress(h) ? addressOf(p) : addressOf(h)),
	};
}
function personUpdate(tx: Tx, plant: string, p: PersonFacts, set: Partial<typeof tables.person.$inferInsert>) {
	return tx
		.update(tables.person)
		.set({ ...set, revision: sql`${tables.person.revision}+1` })
		.where(and(eq(tables.person.id, p.id), eq(tables.person.tenant_id, plant), eq(tables.person.revision, p.revision)));
}
function householdTouched(tx: Tx, plant: string, id: string) {
	return tx
		.update(tables.household)
		.set({ revision: sql`${tables.household.revision}+1` })
		.where(and(eq(tables.household.id, id), eq(tables.household.plant_id, plant)));
}
/** A Person's history records its membership as one value, so the activity feed can show every join, leave and role. */
const membership = (household: { id: string; name: string } | null, role: Role | null) => ({
	membership: household && role ? { householdId: household.id, name: household.name, role } : null,
});
const householdFacts = (h: Household) => ({ revision: h.revision, name: h.name, ...addressOf(h) });
type HouseholdValue = z.input<typeof f.householdMutationResult>;

export const households = {
	async listHouseholds(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(f.listHouseholdsRequest, raw);
			await authorize(tx, ctx);
			const term = input.search?.toLowerCase() ?? "";
			const result =
				await tx.execute(sql`SELECT h.id,h.name,h.revision::text AS revision,h.street,h.city,h.state_province,
 h.postal_code,h.country,(SELECT count(*) FROM person p WHERE p.household_id=h.id AND p.tenant_id=h.plant_id AND p.state='live')::int AS members,
 count(*) OVER ()::int AS total
 FROM household h WHERE h.plant_id=${plant}::uuid AND strpos(lower(h.name),${term})>0
 ORDER BY lower(h.name),h.id LIMIT ${input.limit} OFFSET ${(input.page - 1) * input.limit}`);
			const rows = z
				.array(householdRow.omit({ members: true }).extend({ members: z.number(), total: z.number() }))
				.parse(result.rows);
			const total = rows[0]?.total ?? 0;
			return f.householdsPage.parse({
				items: rows.map((h) => ({
					id: h.id,
					name: h.name,
					...addressView(h),
					revision: h.revision,
					memberCount: h.members,
				})),
				next: input.page * input.limit < total ? input.page + 1 : null,
				total,
			});
		});
	},
	async getHousehold(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(f.householdRequest, raw);
			await authorize(tx, ctx);
			if ("householdId" in input) return view(await readHousehold(tx, plant, input.householdId));
			const p = await personFacts(tx, plant, input.personId, householdJson(plant, sql`person.household_id`));
			return p.household_id ? view(household(p.extra)) : f.householdResult.parse({ status: "none" });
		});
	},
	// The preview for address propagation: the exact live members and the household revision.
	async getHouseholdMembers(tx: Tx, ctx: Context, raw: unknown) {
		return households.getHousehold(tx, ctx, raw);
	},
	async createHouseholdWithHead(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.createHouseholdWithHeadRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.createHouseholdWithHead", input, async (_actor, receiptId, audit) => {
					const { headPersonId, name, ...fields } = input.input;
					const p = await personFacts(tx, plant, headPersonId);
					livePerson(p);
					expectRevision(p.revision, input.expectedRevision);
					if (p.household_id) deny("invalid_subject");
					const home: Household = {
						id: randomUUID(),
						name,
						revision: "1",
						street: fields.street ?? null,
						city: fields.city ?? null,
						state_province: fields.stateProvince ?? null,
						postal_code: fields.postalCode ?? null,
						country: fields.country ?? null,
						members: [],
					};
					const head = joined(p, home, "head");
					home.members.push(head);
					audit.writes.push(
						tx.insert(tables.household).values({ id: home.id, plant_id: plant, name, ...addressOf(home) }),
						personUpdate(tx, plant, p, { household_id: home.id, household_role: "head", ...addressOf(head) }),
					);
					return {
						value: { result: view(home), outcome: "changed", receiptId } satisfies HouseholdValue,
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, ...membership(null, null), ...addressOf(p) },
						after: { revision: head.revision, ...membership(home, "head"), ...addressOf(head) },
					};
				}),
			);
		});
	},
	async updateHousehold(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.updateHouseholdRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.updateHousehold", input, async (_actor, receiptId, audit) => {
					const h = await readHousehold(tx, plant, input.input.householdId);
					expectRevision(h.revision, input.expectedRevision);
					const patch = input.input.patch;
					const set = Object.fromEntries(
						Object.entries({
							name: patch.name,
							street: patch.street,
							city: patch.city,
							state_province: patch.stateProvince,
							postal_code: patch.postalCode,
							country: patch.country,
						}).filter(([k, v]) => v !== undefined && v !== h[k as keyof Household]),
					);
					if (!Object.keys(set).length) {
						const value: HouseholdValue = { result: view(h), outcome: "noop", receiptId };
						return { value, subject: h.id, subjectType: "household", action: "people.updated", outcome: "noop" };
					}
					// Editing the household never rewrites its members' own addresses; propagation is deliberate.
					const after = { ...h, ...set, revision: next(h.revision) };
					audit.writes.push(
						tx
							.update(tables.household)
							.set({ ...set, revision: sql`${tables.household.revision}+1` })
							.where(
								and(
									eq(tables.household.id, h.id),
									eq(tables.household.plant_id, plant),
									eq(tables.household.revision, h.revision),
								),
							),
					);
					return {
						value: { result: view(after), outcome: "changed", receiptId } satisfies HouseholdValue,
						subject: h.id,
						subjectType: "household",
						action: "people.updated",
						before: householdFacts(h),
						after: householdFacts(after),
					};
				}),
			);
		});
	},
	async deleteHousehold(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.deleteHouseholdRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.deleteHousehold", input, async (_actor, receiptId, audit) => {
					const h = await readHousehold(tx, plant, input.input.householdId);
					expectRevision(h.revision, input.expectedRevision);
					if (h.members.length) deny("conflict");
					// Retired members leave the current household in the same statement that deletes it; their own history keeps the
					// household they joined.
					audit.writes.push(
						tx
							.update(tables.person)
							.set({ household_id: null, household_role: null, revision: sql`${tables.person.revision}+1` })
							.where(
								and(
									eq(tables.person.household_id, h.id),
									eq(tables.person.tenant_id, plant),
									ne(tables.person.state, "live"),
								),
							),
						tx.delete(tables.household).where(and(eq(tables.household.id, h.id), eq(tables.household.plant_id, plant))),
					);
					return {
						value: { result: { status: "none" }, outcome: "changed", receiptId } satisfies HouseholdValue,
						subject: h.id,
						subjectType: "household",
						action: "people.retired",
						before: householdFacts(h),
					};
				}),
			);
		});
	},
	async addToHousehold(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.addToHouseholdRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.addToHousehold", input, async (_actor, receiptId, audit) => {
					const { householdId, personId, role } = input.input;
					const p = await personFacts(tx, plant, personId, householdJson(plant, sql`${householdId}::uuid`));
					livePerson(p);
					expectRevision(p.revision, input.expectedRevision);
					const h = household(p.extra);
					if (p.household_id === h.id) {
						const value: HouseholdValue = { result: view(h), outcome: "noop", receiptId };
						return { value, subject: p.id, action: "people.updated", outcome: "noop" };
					}
					// One current household per person: leave the other one first.
					if (p.household_id) deny("invalid_subject");
					const member = joined(p, h, role);
					audit.writes.push(
						personUpdate(tx, plant, p, { household_id: h.id, household_role: role, ...addressOf(member) }),
						householdTouched(tx, plant, h.id),
					);
					const after = { ...h, revision: next(h.revision), members: [...h.members, member] };
					return {
						value: { result: view(after), outcome: "changed", receiptId } satisfies HouseholdValue,
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, ...membership(null, null), ...addressOf(p) },
						after: { revision: member.revision, ...membership(h, role), ...addressOf(member) },
					};
				}),
			);
		});
	},
	async removeFromHousehold(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.removeFromHouseholdRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.removeFromHousehold", input, async (_actor, receiptId, audit) => {
					const p = await personFacts(tx, plant, input.input.personId, householdJson(plant, sql`person.household_id`));
					livePerson(p);
					expectRevision(p.revision, input.expectedRevision);
					if (!p.household_id) {
						const value: HouseholdValue = { result: { status: "none" }, outcome: "noop", receiptId };
						return { value, subject: p.id, action: "people.updated", outcome: "noop" };
					}
					const h = household(p.extra);
					// Leaving keeps the person's own address.
					audit.writes.push(
						personUpdate(tx, plant, p, { household_id: null, household_role: null }),
						householdTouched(tx, plant, h.id),
					);
					const after = { ...h, revision: next(h.revision), members: h.members.filter((m) => m.id !== p.id) };
					return {
						value: { result: view(after), outcome: "changed", receiptId } satisfies HouseholdValue,
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, ...membership(h, p.household_role) },
						after: { revision: next(p.revision), ...membership(null, null) },
					};
				}),
			);
		});
	},
	async setHouseholdRole(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.setHouseholdRoleRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.setHouseholdRole", input, async (_actor, receiptId, audit) => {
					const p = await personFacts(tx, plant, input.input.personId, householdJson(plant, sql`person.household_id`));
					livePerson(p);
					expectRevision(p.revision, input.expectedRevision);
					if (!p.household_id) deny("invalid_subject");
					const h = household(p.extra);
					if (p.household_role === input.input.role) {
						const value: HouseholdValue = { result: view(h), outcome: "noop", receiptId };
						return { value, subject: p.id, action: "people.updated", outcome: "noop" };
					}
					audit.writes.push(personUpdate(tx, plant, p, { household_role: input.input.role }));
					const after = {
						...h,
						members: h.members.map((m) =>
							m.id === p.id ? { ...m, household_role: input.input.role, revision: next(p.revision) } : m,
						),
					};
					return {
						value: { result: view(after), outcome: "changed", receiptId } satisfies HouseholdValue,
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, ...membership(h, p.household_role) },
						after: { revision: next(p.revision), ...membership(h, input.input.role) },
					};
				}),
			);
		});
	},
	async propagateAddress(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.propagateAddressRequest, raw);
			return f.householdMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.propagateAddress", input, async (_actor, receiptId, audit) => {
					const h = await readHousehold(tx, plant, input.input.householdId);
					expectRevision(h.revision, input.expectedRevision);
					// The reviewed preview must still be the exact live membership; otherwise nothing is written.
					const reviewed = new Map<string, string>(input.input.members.map((m) => [m.personId, m.revision]));
					if (reviewed.size !== h.members.length || h.members.some((m) => reviewed.get(m.id) !== m.revision))
						deny("conflict");
					const home = addressOf(h);
					audit.writes.push(
						tx
							.update(tables.person)
							.set({ ...home, revision: sql`${tables.person.revision}+1` })
							.where(
								and(
									eq(tables.person.household_id, h.id),
									eq(tables.person.tenant_id, plant),
									eq(tables.person.state, "live"),
								),
							),
					);
					const after = {
						...h,
						members: h.members.map((m) => ({ ...m, ...home, revision: next(m.revision) })),
					};
					return {
						value: {
							result: view(after),
							outcome: "changed",
							receiptId,
							updatedPeople: h.members.length,
						} satisfies HouseholdValue,
						subject: h.id,
						subjectType: "household",
						action: "people.updated",
						before: { revision: h.revision, propagated: null },
						after: { revision: h.revision, propagated: { ...home, people: [...reviewed.keys()].sort() } },
					};
				}),
			);
		});
	},
};
