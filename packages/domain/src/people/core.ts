import { notExists, and, desc, eq, gt, isNull, lte, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { alias } from "@everyfield/db/columns";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import { currentActor, RequestActor } from "../access/session.ts";
import { readPipelinePerson } from "../access/pipeline.ts";
import { isAdministrator } from "../access/policy.ts";
import { owner, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import type { PeopleContext, PeopleWriteContext, PeopleReply } from "@everyfield/contracts/people";
const operation_o = alias(tables.operation, "o");
const people_result_r = alias(tables.people_result, "r");
const review_r = alias(tables.review, "r");
const conversation_v = alias(tables.conversation, "v");
const effect_e = alias(tables.effect, "e");

export type Tx = Transaction;
/** A read-only request observation. Its owner and session derive from one native authority. */
export class PeopleReadContext {
	readonly authority: RequestActor;
	readonly purpose: PeopleContext["purpose"];
	constructor(authority: RequestActor, purpose: PeopleContext["purpose"]) {
		this.authority = authority;
		this.purpose = purpose;
	}
	get session() {
		return this.authority.session;
	}
	get selected() {
		return this.authority.actor.context.owner;
	}
}
export type Context = PeopleContext | PeopleReadContext;
export type WriteContext = PeopleWriteContext;
export const hash = (v: unknown) => createHash("sha256").update(stable(v)).digest("hex");
function stable(v: unknown): string {
	if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
	if (v !== null && typeof v === "object")
		return (
			"{" +
			Object.entries(v)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
				.join(",") +
			"}"
		);
	return JSON.stringify(v);
}
export class Refusal extends Error {
	readonly code: z.infer<typeof c.peopleError>["code"];
	constructor(code: z.infer<typeof c.peopleError>["code"]) {
		super(code);
		this.code = code;
	}
}
export function deny(code: Refusal["code"] = "unavailable"): never {
	throw new Refusal(code);
}
function refused(error: Refusal): PeopleReply<never> {
	const retry =
		error.code === "conflict" || error.code === "use_reviewed_unmerge"
			? "refresh"
			: error.code === "source_unavailable"
				? "same_request"
				: "never";
	return {
		status: "refused",
		error: c.peopleError.parse({
			code: error.code,
			details: {},
			correlationId: randomUUID(),
			retry,
		}),
	};
}
export async function readReply<T>(body: () => Promise<T>): Promise<PeopleReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return refused(error);
	}
}
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<PeopleReply<T>> {
	await tx.execute(sql`SAVEPOINT people_operation`);
	try {
		const value = await body();
		await tx.execute(sql`RELEASE SAVEPOINT people_operation`);
		return { status: "ok", value };
	} catch (error) {
		await tx.execute(sql`ROLLBACK TO SAVEPOINT people_operation`);
		await tx.execute(sql`RELEASE SAVEPOINT people_operation`);
		if (!(error instanceof Refusal)) throw error;
		return refused(error);
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) deny("invalid_input");
	return r.data;
}
export async function authorize(tx: Tx, context: Context, write = false) {
	const actor =
		!write && context instanceof PeopleReadContext
			? context.authority.actor
			: await currentActor(tx, context.session, context.selected);
	if (
		actor.status !== "active" ||
		actor.context.kind !== "seat" ||
		!["plant", "organization"].includes(context.selected.kind)
	)
		deny();
	if (write && !isAdministrator(actor)) deny();
	return actor;
}
export async function lockOwner(tx: Tx, context: Context) {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sql.param(context.selected.id)},11011))`);
	// Serialize writers before currentActor takes shared lifecycle/seat locks.
	// Parent rows are updated only after account and subject locks, matching provisioning.
}
export const personRow = z.object({
	id: z.uuid(),
	tenant_id: z.uuid(),
	plant_id: z.uuid().nullable(),
	organization_id: z.uuid().nullable(),
	display_name: z.string(),
	first_name: z.string().nullable(),
	last_name: z.string().nullable(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
	street: z.string().nullable(),
	city: z.string().nullable(),
	state_province: z.string().nullable(),
	postal_code: z.string().nullable(),
	country: z.string().nullable(),
	source: c.recruitmentSource,
	source_details: z.string().nullable(),
	notes: z.string().nullable(),
	stage: c.stage.nullable(),
	adult_classification: c.adultClassification.nullable(),
	birth_date: z.coerce.date().nullable(),
	commitment_state: z.enum(["active", "withdrawn", "unknown"]).nullable(),
	created_at: z.coerce.date(),
	state: z.enum(["live", "retired", "merged"]),
	retired_at: z.coerce.date().nullable(),
	merged_into_person_id: z.uuid().nullable(),
	linked_account_id: z.uuid().nullable(),
	revision,
	pipeline_position: z.string().nullable(),
});
export type Person = z.infer<typeof personRow>;
export async function person(tx: Tx, context: Pick<Context, "selected">, id: string, lock = false): Promise<Person> {
	const rows = await tx
		.select()
		.from(tables.person)
		.where(
			and(
				eq(tables.person.id, id),
				eq(tables.person.tenant_id, context.selected.id),
				notExists(
					tx
						.select({ id: tables.organization_person_removal.id })
						.from(tables.organization_person_removal)
						.where(
							and(
								eq(tables.organization_person_removal.person_record_id, tables.person.id),
								eq(tables.organization_person_removal.organization_id, tables.person.tenant_id),
							),
						),
				),
			),
		)
		.for(lock ? "update" : "share", { of: tables.person });
	if (!rows[0]!) deny();
	return personRow.parse(rows[0]!);
}
export async function canReadPerson(tx: Tx, context: Context, p: Person) {
	const a = await authorize(tx, context);
	if (context.selected.kind === "organization" && !isAdministrator(a)) {
		const r = await readPipelinePerson(tx, context.session, context.selected, {
			personId: p.id,
		});
		if (r.status !== "allowed") deny();
	}
	return a;
}
export async function project(tx: Tx, context: Context, p: Person) {
	const base = {
		id: p.id,
		revision: p.revision,
		createdAt: p.created_at.toISOString(),
		displayName: p.display_name,
		firstName: p.first_name,
		lastName: p.last_name,
		email: p.email,
		phone: p.phone,
		street: p.street,
		city: p.city,
		stateProvince: p.state_province,
		postalCode: p.postal_code,
		country: p.country,
		owner: context.selected,
		lifecycle:
			p.state === "live"
				? { state: "live" }
				: p.state === "retired"
					? { state: "retired", retiredAt: p.retired_at!.toISOString() }
					: {
							state: "merged",
							retiredAt: p.retired_at!.toISOString(),
							survivorId: p.merged_into_person_id,
						},
	};
	if (context.selected.kind === "organization") return c.organizationPerson.parse(base);
	const evidence = await tx
		.select({
			id: tables.commitment.id,
			kind: tables.commitment.kind,
			signed_on: tables.commitment.signed_on,
			revision: tables.commitment.revision,
		})
		.from(tables.commitment)
		.where(
			and(
				and(eq(tables.commitment.plant_id, context.selected.id), eq(tables.commitment.person_id, p.id)),
				isNull(tables.commitment.voided_at),
			),
		)
		.orderBy(desc(tables.commitment.signed_on), desc(tables.commitment.id))
		.limit(1);
	const e = evidence[0]!;
	const commitment =
		p.commitment_state === "unknown" || !e
			? { state: "unknown" }
			: {
					state: p.commitment_state,
					evidenceId: e.id,
					kind: e.kind,
					occurredOn: e.signed_on,
					revision: e.revision,
				};
	return c.plantPerson.parse({
		...base,
		stage: p.stage,
		source: p.source,
		sourceDetails: p.source_details,
		summaryNotes: p.notes,
		adultClassification: p.adult_classification,
		birthDate: p.birth_date?.toISOString().slice(0, 10) ?? null,
		commitment,
	});
}
export const contactColumns = {
	displayName: "display_name",
	firstName: "first_name",
	lastName: "last_name",
	email: "email",
	phone: "phone",
	street: "street",
	city: "city",
	stateProvince: "state_province",
	postalCode: "postal_code",
	country: "country",
	source: "source",
	sourceDetails: "source_details",
	summaryNotes: "notes",
	birthDate: "birth_date",
} as const;
export async function patchPerson(tx: Tx, id: string, patch: object) {
	const pairs = Object.entries(patch).filter(([k]) => k in contactColumns);
	if (!pairs.length) return;
	const columns = new Map(Object.entries(contactColumns));
	const changes: Partial<Record<keyof typeof tables.person.$inferInsert, ReturnType<typeof sql>>> = {};
	for (const [key, value] of pairs) {
		const column = columns.get(key);
		if (column) changes[column] = sql`${sql.param(value)}`;
	}
	await tx
		.update(tables.person)
		.set({ ...changes, revision: sql`${tables.person.revision}+1` })
		.where(eq(tables.person.id, id));
}
export type Mutation = { requestKey: string; expectedRevision?: string };
export async function mutation<T>(
	tx: Tx,
	context: WriteContext,
	name: typeof tables.operation.$inferSelect.name,
	input: Mutation,
	body: (
		actorId: string,
		operationId: string,
	) => Promise<{
		value: T;
		subject: string;
		action: NonNullable<typeof tables.event.$inferInsert.action>;
		before?: Person;
		after?: Person;
		reason?: string;
		outcome?: "changed" | "noop";
	}>,
): Promise<unknown> {
	await lockOwner(tx, context);
	const note = ["people.addNote", "people.editNote", "people.deleteNote"].includes(name);
	const orgNote = context.selected.kind === "organization" && note;
	const actor = await authorize(
		tx,
		{ session: context.session, selected: context.selected, purpose: context.purpose },
		!orgNote,
	);
	if (orgNote) {
		const subject = parse(z.object({ input: z.object({ personId: z.uuid() }) }), input).input.personId;
		const access = await readPipelinePerson(tx, context.session, context.selected, { personId: subject });
		if (context.purpose !== "native" || access.status !== "allowed" || !access.duties.some((d) => d.canReadStaffNotes))
			deny();
	}
	const digest = hash({ name, input, origin: context.origin });
	const prior = await tx
		.select({
			id: operation_o.id,
			actor_id: operation_o.actor_id,
			name: operation_o.name,
			request_digest: operation_o.request_digest,
			value: people_result_r.value,
			person_id: people_result_r.person_id,
		})
		.from(operation_o)
		.innerJoin(people_result_r, eq(people_result_r.operation_id, operation_o.id))
		.where(and(eq(operation_o.tenant_id, context.selected.id), eq(operation_o.request_key, input.requestKey)))
		.for("update", { of: [operation_o] });
	if (prior.length) {
		const r = prior[0]!;
		if (r.actor_id !== actor.accountId || r.name !== name || r.request_digest !== digest) deny("conflict");
		if (
			name !== "orgPeople.remove" &&
			(
				await tx
					.select({ id: tables.organization_person_removal.id })
					.from(tables.organization_person_removal)
					.where(
						and(
							eq(tables.organization_person_removal.organization_id, context.selected.id),
							sql`${tables.organization_person_removal.person_record_id} = ${r.person_id}`,
						),
					)
			).length
		)
			deny();
		return r.value;
	}
	if (context.purpose === "model") {
		const o = context.origin;
		const review = await tx
			.select({ id: review_r.id })
			.from(review_r)
			.innerJoin(
				conversation_v,
				and(eq(conversation_v.id, review_r.conversation_id), eq(conversation_v.tenant_id, review_r.tenant_id)),
			)
			.innerJoin(effect_e, and(eq(effect_e.review_id, review_r.id), eq(effect_e.tenant_id, review_r.tenant_id)))
			.where(
				and(
					and(
						and(
							and(
								and(
									and(
										and(
											and(
												and(
													and(
														and(
															and(
																and(
																	and(eq(review_r.id, o.reviewId), eq(review_r.tenant_id, context.selected.id)),
																	eq(review_r.conversation_id, o.conversationId),
																),
																eq(review_r.digest, o.planDigest),
															),
															eq(effect_e.payload_hash, hash({ name, input })),
														),
														eq(
															effect_e.arguments,
															sql<unknown>`(${sql.param(JSON.stringify({ operation: name, input }))})::jsonb`,
														),
													),
													sql`${effect_e.kind} = ${name}`,
												),
												sql<boolean>`(${effect_e.state} IN ('unstarted', 'claimed'))`,
											),
											eq(conversation_v.owner_id, actor.accountId),
										),
										eq(conversation_v.state, "open"),
									),
									eq(review_r.approved_by_id, actor.accountId),
								),
								lte(
									review_r.approved_at,
									sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
								),
							),
							gt(review_r.approved_at, sql<unknown>`(clock_timestamp() - ('15 minutes')::interval)`),
						),
						isNull(review_r.cancelled_at),
					),
					isNull(review_r.superseded_at),
				),
			)
			.for("share", { of: [review_r, conversation_v, effect_e] });
		if (!review.length) deny();
	}
	const operationId = randomUUID();
	const result = await body(actor.accountId, operationId);
	const outcome = result.outcome ?? "changed";
	await tx.insert(tables.operation).values({
		id: operationId,
		tenant_id: context.selected.id,
		actor_id: actor.accountId,
		name: name,
		request_key: input.requestKey,
		request_digest: digest,
		review_id: context.origin.kind === "assistant" ? context.origin.reviewId : null,
		conversation_id: context.origin.kind === "assistant" ? context.origin.conversationId : null,
		state: "complete",
		outcome: outcome === "noop" ? "no_effect" : "committed",
		started_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		completed_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		tool_calls: 0,
		reserved_input: 0,
		reserved_output: 0,
		used_input: 0,
		used_output: 0,
	});
	await tx.insert(tables.people_result).values({
		operation_id: operationId,
		tenant_id: context.selected.id,
		person_id: result.subject === context.selected.id ? null : result.subject,
		value: result.value,
	});
	// Notes own their timeline row and protected correction history. The central
	// audit still records every mutation, without operational bodies.
	if (!note && result.subject !== context.selected.id)
		await tx.insert(tables.people_history).values({
			tenant_id: context.selected.id,
			person_id: result.subject,
			operation_id: operationId,
			actor_id: actor.accountId,
			actor_token: hash([context.selected.id, actor.accountId]),
			action: result.action,
			occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
			before_revision: sql`${result.before?.revision ?? null}`,
			after_revision: sql`${result.after?.revision ?? result.before?.revision ?? "1"}`,
			before_value: result.before ?? null,
			after_value: result.after ?? null,
			reason: result.reason ?? null,
		});
	await tx.insert(tables.event).values({
		tenant_id: context.selected.id,
		target_record_id: result.subject,
		operation_id: operationId,
		actor_id: actor.accountId,
		kind:
			outcome === "noop"
				? "noop"
				: result.action === "people.created"
					? "create"
					: result.action === "people.retired"
						? "retire"
						: result.action === "people.restored"
							? "restore"
							: "edit",
		occurred_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		recorded_at: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
		before_revision: sql`${result.before?.revision ?? null}`,
		after_revision: sql`${result.after?.revision ?? result.before?.revision ?? "1"}`,
		event_key: sql<string>`((${sql.param(operationId)})::uuid)::text`,
		action: result.action,
	});
	if (outcome === "changed") {
		const table = context.selected.kind === "plant" ? tables.plant : tables.organization;
		await tx
			.update(table)
			.set({ material_revision: sql`${table.material_revision}+1` })
			.where(eq(table.id, context.selected.id));
	}
	return result.value;
}
export function expected(p: Person, revision: string) {
	if (p.revision !== revision) deny("conflict");
}
export function live(p: Person) {
	if (p.state !== "live") deny();
}
export async function attribution(tx: Tx, actorId: string | null, token: string) {
	if (actorId) {
		const a = await tx.select({ id: tables.account.id }).from(tables.account).where(eq(tables.account.id, actorId));
		if (a.length) return { kind: "current_account", accountId: actorId };
	}
	return { kind: "former_account", scopeLocalToken: token };
}
export { owner };
