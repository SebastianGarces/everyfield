import { requestIdentity } from "@everyfield/contracts/common";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, desc, eq, inArray, isNull, notExists, sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { createHash, randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { readPipelinePerson } from "../access/pipeline.ts";
import { currentActor, liveRead, RequestActor, requestWrite } from "../access/session.ts";
import {
	auditSavepoint,
	auditTransaction,
	finishAudit,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

import { owner, revision } from "@everyfield/contracts/common";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import * as c from "@everyfield/contracts/people";

export type Tx = Transaction;
/** A read-only request observation. Its owner and session derive from one native authority. */
export class PeopleReadContext {
	readonly authority: RequestActor;
	constructor(authority: RequestActor) {
		this.authority = authority;
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
		if (error instanceof WriteUnavailable) return refused(new Refusal("unavailable"));
		if (!(error instanceof Refusal)) throw error;
		return refused(error);
	}
}
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<PeopleReply<T>> {
	if (requestWrite(tx)) return { status: "ok", value: await body() };
	try {
		return { status: "ok", value: await auditSavepoint(tx, async () => body()) };
	} catch (error) {
		if (error instanceof WriteUnavailable) return refused(new Refusal("unavailable"));
		if (!(error instanceof Refusal)) throw error;
		return refused(error);
	}
}

/** The native request owns rollback, so a successful write needs no nested savepoint. */
export async function withPeopleWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: PeopleWriteContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T>> {
	return readReply(() =>
		auditTransaction(db, async (tx) => {
			const selected = authority.actor.context.owner;
			if (!(await authority.bind(tx, selected))) deny();
			const result = await body(tx, {
				session: authority.session,
				selected,
			});
			if (result.status === "refused") throw new Refusal(result.error.code);
			return result.value;
		}),
	);
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const r = schema.safeParse(raw);
	if (!r.success) deny("invalid_input");
	return r.data;
}
type ActiveActor = Awaited<ReturnType<typeof authorize>>;
export async function authorize(tx: Tx, context: Context, write = false) {
	const actor =
		!write && context instanceof PeopleReadContext
			? context.authority.actor
			: await currentActor(tx, context.session, context.selected, write);
	if (actor.status !== "active" || !["plant", "organization"].includes(context.selected.kind)) deny();
	const seat = actor.context;
	if (seat.kind !== "seat") deny();
	if (write && !isAdministrator(actor)) deny();
	return { ...actor, context: seat };
}
/**
 * The actor a read resolved and the live access check (C13, C22) each of its statements repeats. An organization Admin
 * reads every person, so the check keeps that Admin role; any other reader's role does not change what it reads.
 */
export async function authorizeRead(tx: Tx, context: Context) {
	const actor = await authorize(tx, context);
	const admin = context.selected.kind === "organization" && isAdministrator(actor);
	return {
		actor,
		gate: liveRead({ session: context.session, owner: context.selected, seatId: actor.context.seatId }, admin),
	};
}
/** A write's statements need no read gate: its locked authority holds until COMMIT (D70). */
export const lockedWrite = sql`true`;
export async function lockOwner(tx: Tx, context: Context) {
	const locked = requestWrite(tx);
	if (locked && locked.selected.id === context.selected.id && locked.selected.kind === context.selected.kind) return;
	if (!(await RequestActor.claimWrite(tx, context.session, context.selected))) deny();
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
/** One Person row. A write passes `true` and locks it for update; a read passes its C13 gate and takes no lock. */
export async function person(
	tx: Tx,
	context: Pick<Context, "selected">,
	id: string,
	lock: true | SQL,
): Promise<Person> {
	const query = tx
		.select()
		.from(tables.person)
		.where(
			and(
				eq(tables.person.id, id),
				eq(tables.person.tenant_id, context.selected.id),
				lock === true ? undefined : lock,
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
		);
	const rows = await (lock === true ? query.for("update", { of: tables.person }) : query);
	if (!rows[0]!) deny();
	return personRow.parse(rows[0]!);
}
/** The reader's authority over one Person. Pass the actor a reader already resolved to avoid a second lookup. */
export async function canReadPerson(tx: Tx, context: Context, p: Person, actor?: ActiveActor) {
	const a = actor ?? (await authorize(tx, context));
	if (context.selected.kind === "organization" && !isAdministrator(a)) {
		const r = await readPipelinePerson(tx, context.session, context.selected, {
			personId: p.id,
		});
		if (r.status !== "allowed") deny();
	}
	return a;
}
export async function project(tx: Tx, context: Context, p: Person, gate: SQL) {
	return (await projectPeople(tx, context, [p], gate))[0]!;
}
export async function projectPeople(tx: Tx, context: Context, people: Person[], gate: SQL) {
	const evidence =
		context.selected.kind === "plant" && people.some((p) => p.commitment_state !== "unknown")
			? await tx
					.selectDistinctOn([tables.commitment.person_id], {
						person_id: tables.commitment.person_id,
						id: tables.commitment.id,
						kind: tables.commitment.kind,
						signed_on: tables.commitment.signed_on,
						revision: tables.commitment.revision,
					})
					.from(tables.commitment)
					.where(
						and(
							eq(tables.commitment.plant_id, context.selected.id),
							inArray(
								tables.commitment.person_id,
								people.map((p) => p.id),
							),
							isNull(tables.commitment.voided_at),
							gate,
						),
					)
					.orderBy(tables.commitment.person_id, desc(tables.commitment.signed_on), desc(tables.commitment.id))
			: [];
	const byPerson = new Map(evidence.map((e) => [e.person_id, e]));
	return people.map((p) => {
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
		const e = byPerson.get(p.id);
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
export function contactValues(patch: object) {
	const columns = new Map(Object.entries(contactColumns));
	return Object.fromEntries(
		Object.entries(patch).flatMap(([key, value]) => {
			const column = columns.get(key);
			return column && value !== undefined ? [[column, value]] : [];
		}),
	);
}
export function contactPatch(patch: object) {
	return Object.fromEntries(
		Object.entries(contactValues(patch)).map(([key, value]) => [key, sql`${sql.param(value)}`]),
	);
}
/** The locked fact supplies the reply; the change and audit append together. */
export async function patchPerson(
	tx: Tx,
	ctx: Pick<Context, "selected">,
	id: string,
	rev: string,
	patch: object,
	writes: SQLWrapper[],
) {
	const before = await person(tx, ctx, id, true);
	live(before);
	expected(before, rev);
	const values = contactValues(patch),
		advance = Object.keys(values).length ? 1n : 0n;
	const after = personRow.parse({ ...before, ...values, revision: String(BigInt(before.revision) + advance) });
	writes.push(
		tx
			.update(tables.person)
			.set({ ...contactPatch(patch), revision: sql`${tables.person.revision}+${String(advance)}::bigint` })
			.where(
				and(eq(tables.person.id, id), eq(tables.person.tenant_id, ctx.selected.id), eq(tables.person.revision, rev)),
			),
	);
	return { before, after };
}

export function personChanges(before?: Revisioned, after?: Revisioned) {
	const prior = new Map(Object.entries(before ?? {})),
		next = new Map(Object.entries(after ?? {}));
	const changed = new Set(
		[...prior.keys(), ...next.keys()].filter(
			(k) => k !== "revision" && JSON.stringify(prior.get(k)) !== JSON.stringify(next.get(k)),
		),
	);
	return {
		before: before ? Object.fromEntries([...prior].filter(([k]) => changed.has(k))) : null,
		after: after ? Object.fromEntries([...next].filter(([k]) => changed.has(k))) : null,
	};
}

export type Mutation = { requestKey: string; expectedRevision?: string };
/** The fact a write changed: a Person, or another revisioned people fact such as a tag or household. */
export type Revisioned = { revision: string };
export async function mutation<T>(
	tx: Tx,
	context: WriteContext,
	name: string,
	input: Mutation,
	body: (
		actorId: string,
		operationId: string,
		audit: AuditWrite,
	) => Promise<{
		value: T;
		subject: string;
		action: NonNullable<typeof tables.audit_event.$inferInsert.action>;
		before?: Revisioned;
		after?: Revisioned;
		subjectType?: "tag" | "household" | "person_skill";
		reason?: string;
		outcome?: "changed" | "noop";
	}>,
): Promise<unknown> {
	await lockOwner(tx, context);
	const note = ["people.addNote", "people.editNote", "people.deleteNote"].includes(name);
	const orgNote = context.selected.kind === "organization" && note;
	const actor = await authorize(tx, { session: context.session, selected: context.selected }, !orgNote);
	if (orgNote) {
		const subject = parse(z.object({ input: z.object({ personId: z.uuid() }) }), input).input.personId;
		const access = await readPipelinePerson(tx, context.session, context.selected, { personId: subject });
		if (access.status !== "allowed" || !access.duties.some((d) => d.canReadStaffNotes)) deny();
	}
	// Native digest bytes are persisted; keep already committed retry keys stable.
	const digest = hash({ name, input, origin: { kind: "native" } });
	const identity = requestIdentity.parse({
		owner: context.selected,
		actorId: actor.accountId,
		operation: name,
		requestKey: input.requestKey,
		digest,
	});
	const claim = await prepareWrite(tx, identity);
	if (claim.kind === "conflict") deny("conflict");
	if (claim.kind === "unavailable") deny();
	if (claim.kind === "replay") {
		if (
			name !== "orgPeople.remove" &&
			(
				await tx
					.select({ id: tables.organization_person_removal.id })
					.from(tables.organization_person_removal)
					.where(
						and(
							eq(tables.organization_person_removal.organization_id, context.selected.id),
							sql`${tables.organization_person_removal.person_record_id}=${claim.subject}::uuid`,
						),
					)
			).length
		)
			deny();
		return claim.value;
	}

	const operationId = claim.id;
	const result = await body(actor.accountId, operationId, claim);
	const outcome = result.outcome ?? "changed";
	const delta = personChanges(result.before, result.after);
	const entry = claim.events.find((entry) => entry.id === operationId);
	const audit = {
		id: operationId,
		tenant_id: context.selected.id,
		actor_id: actor.accountId,
		actor_token: hash([context.selected.id, actor.accountId]),
		subject_type: result.subjectType ?? (result.subject === context.selected.id ? context.selected.kind : "person"),
		subject_id: result.subject,
		action: result.action,
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
		before_revision: result.before?.revision ?? null,
		after_revision: result.after?.revision ?? result.before?.revision ?? "1",
		before_value: note ? entry?.before_value : delta.before,
		after_value: note ? entry?.after_value : delta.after,
		reason: result.reason ?? entry?.reason ?? null,
		...(note ? { metadata: entry?.metadata ?? { category: "note" } } : {}),
	};
	if (entry) Object.assign(entry, audit);
	else claim.events.push(audit);
	if (outcome === "changed") {
		const table = context.selected.kind === "plant" ? tables.plant : tables.organization;
		claim.writes.push(
			tx
				.update(table)
				.set({ material_revision: sql`${table.material_revision}+1` })
				.where(eq(table.id, context.selected.id)),
		);
	}
	await finishAudit(tx, claim, identity, result.value);
	return result.value;
}
export function expected(p: Person, revision: string) {
	if (p.revision !== revision) deny("conflict");
}
export function live(p: Person) {
	if (p.state !== "live") deny();
}
export { owner };

const isAdministrator = (actor: { context: { kind: string; role?: string } }) =>
	actor.context.kind === "seat" && actor.context.role !== "member";
