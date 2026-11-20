import { requestIdentity } from "@everyfield/contracts/common";
import type { Database } from "@everyfield/db/client";
import {
	and,
	desc,
	eq,
	getTableColumns,
	inArray,
	isNull,
	notExists,
	sql,
	type SQL,
	type SQLWrapper,
} from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { hash } from "../operations/canonical.ts";
import "server-only";
import { z } from "zod";
import { effectiveAdult, plantTodaySql } from "./adult.ts";
import { readPipelinePerson } from "../access/pipeline.ts";
import { boundWrite, currentActor, liveRead, RequestActor, type WriteTx } from "../access/session.ts";
import {
	auditSavepoint,
	finishAudit,
	nativeWrite,
	checkedRead,
	declareWrite,
	prepareWrite,
	type AuditWrite,
	type WritePath,
} from "../operations/writes.ts";
export { hash };

import { revision } from "@everyfield/contracts/common";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import * as c from "@everyfield/contracts/people";
import { defineRefusals, type Deny } from "../operations/refusals.ts";

export type Tx = WriteTx;
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
const refusals = defineRefusals(c.peopleError, { writeUnavailable: "unavailable" });
export const { Refusal, settle: readReply } = refusals;
export const deny: Deny<typeof c.peopleError> = refusals.deny;
export async function reply<T>(tx: Tx, body: () => Promise<T>): Promise<PeopleReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readReply(() => auditSavepoint(tx, async () => body()));
}

export async function replyWithoutSavepoint<T>(tx: Tx, body: () => Promise<T>): Promise<PeopleReply<T>> {
	if (boundWrite(tx)) return { status: "ok", value: await body() };
	return readReply(body);
}

export async function withPeopleWrite<T>(
	db: Database,
	authority: RequestActor,
	body: (tx: Tx, context: PeopleWriteContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T>> {
	const selected = authority.actor.context.owner;
	return readReply(() =>
		nativeWrite(db, authority, selected, async (tx) => {
			const result = await body(tx, {
				session: authority.session,
				selected,
			});
			if (result.status === "refused") throw new Refusal(result.error.code, result.error.details);
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
	return seated(context, actor, write);
}
function seated(context: Context, actor: Awaited<ReturnType<typeof currentActor>>, write: boolean) {
	if (actor.status !== "active" || !["plant", "organization"].includes(context.selected.kind)) deny("unavailable");
	const seat = actor.context;
	if (seat.kind !== "seat") deny("unavailable");
	if (write && !isAdministrator(actor)) deny("unavailable");
	return { ...actor, context: seat };
}
export async function authorizeRead(tx: Tx, context: Context) {
	return readGate(context, await authorize(tx, context));
}
export function authorizeCachedWrite(context: PeopleReadContext) {
	return seated(context, context.authority.actor, true);
}
export function authorizeCachedRead(context: PeopleReadContext) {
	return readGate(context, seated(context, context.authority.actor, false));
}
function readGate(context: Context, actor: ActiveActor) {
	const admin = context.selected.kind === "organization" && isAdministrator(actor);
	return {
		actor,
		gate: liveRead({ session: context.session, owner: context.selected, seatId: actor.context.seatId }, admin),
	};
}
export const lockedWrite = sql`true`;
export async function lockOwner(tx: Tx, context: Context) {
	const locked = boundWrite(tx);
	if (locked && locked.selected.id === context.selected.id && locked.selected.kind === context.selected.kind) return;
	if (!(await RequestActor.claimWrite(tx, context.session, context.selected))) deny("unavailable");
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
	plant_today: z.string().nullable().optional(),
});
export const personColumns = {
	...getTableColumns(tables.person),
	plant_today: sql<string | null>`${plantTodaySql(sql`${tables.person.plant_id}`)}`.as("plant_today"),
};
export type Person = z.infer<typeof personRow>;
export async function person(
	tx: Tx,
	context: Pick<Context, "selected">,
	id: string,
	lock: true | SQL,
): Promise<Person> {
	const query = tx
		.select(personColumns)
		.from(tables.person)
		.where(
			and(
				eq(tables.person.id, id),
				eq(tables.person.tenant_id, context.selected.id),
				lock === true ? undefined : lock,
				unremoved(tx),
			),
		);
	const checked = lock === true ? await checkedRead(tx, query.getSQL(), sql`FOR UPDATE OF ${tables.person}`) : null;
	if (checked) {
		if (!checked[0]) deny("unavailable");
		return personRow.parse(checked[0]);
	}
	const rows = await (lock === true ? query.for("update", { of: tables.person }) : query);
	if (!rows[0]!) deny("unavailable");
	return personRow.parse(rows[0]!);
}
const unremoved = (tx: Tx) =>
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
	);
export async function canReadPerson(tx: Tx, context: Context, p: Person, actor?: ActiveActor) {
	const a = actor ?? (await authorize(tx, context));
	if (context.selected.kind === "organization" && !isAdministrator(a)) {
		const r = await readPipelinePerson(tx, context.session, context.selected, {
			personId: p.id,
		});
		if (r.status !== "allowed") deny("unavailable");
	}
	return a;
}
export async function project(tx: Tx, context: Context, p: Person, gate: SQL) {
	return (await projectPeople(tx, context, [p], gate))[0]!;
}
export async function projectPeople(tx: Tx, context: Context, rows: Person[], gate: SQL) {
	const people = await withToday(tx, context, rows);
	const known = context.selected.kind === "plant" && people.some((p) => p.commitment_state !== "unknown");
	if (known) await declareWrite(tx, "established");
	const evidence = known
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
	return projectWith(context, people, evidence);
}
async function withToday(tx: Tx, context: Context, people: Person[]) {
	if (context.selected.kind !== "plant" || !people.some((p) => p.birth_date && p.plant_today === undefined))
		return people;
	await declareWrite(tx, "established");
	const [{ today }] = (await tx
		.select({ today: sql<string>`${plantTodaySql(sql`${context.selected.id}::uuid`)}` })
		.from(tables.plant)
		.where(eq(tables.plant.id, context.selected.id))) as [{ today: string }];
	return people.map((p) => ({ ...p, plant_today: p.plant_today ?? today }));
}
export type Evidence = {
	person_id: string;
	id: string;
	kind: "core_group" | "launch_team";
	signed_on: string;
	revision: string;
};
export const evidenceJson = (plant: string, person: SQL) =>
	sql`(SELECT jsonb_build_object('person_id',k.person_id,'id',k.id,'kind',k.kind,'signed_on',k.signed_on::text,'revision',k.revision::text)
 FROM commitment k WHERE k.plant_id=${plant}::uuid AND k.person_id=${person} AND k.voided_at IS NULL ORDER BY k.signed_on DESC,k.id DESC LIMIT 1)`;
export function projectWith(context: Pick<Context, "selected">, people: Person[], evidence: Evidence[]) {
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
		const birthDate = p.birth_date?.toISOString().slice(0, 10) ?? null,
			adult = effectiveAdult(birthDate, p.adult_classification ?? "unknown", p.plant_today ?? null);
		return c.plantPerson.parse({
			...base,
			stage: p.stage,
			source: p.source,
			sourceDetails: p.source_details,
			summaryNotes: p.notes,
			adultClassification: adult.value,
			adultClassificationSource: adult.source,
			birthDate,
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
function contactPatch(patch: object) {
	return Object.fromEntries(
		Object.entries(contactValues(patch)).map(([key, value]) => [key, sql`${sql.param(value)}`]),
	);
}
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
			(k) => k !== "revision" && k !== "plant_today" && JSON.stringify(prior.get(k)) !== JSON.stringify(next.get(k)),
		),
	);
	return {
		before: before ? Object.fromEntries([...prior].filter(([k]) => changed.has(k))) : null,
		after: after ? Object.fromEntries([...next].filter(([k]) => changed.has(k))) : null,
	};
}

const peopleWritePaths = {
	"orgPeople.merge": "established",
	"orgPeople.unmerge": "established",
	"people.addNote": "single",
	"people.addSkill": "established",
	"people.addToHousehold": "established",
	"people.assignTag": "established",
	"people.changeStatus": "established",
	"people.correctAdultClassification": "established",
	"people.correctCommitmentLifecycle": "established",
	"people.correctPersonRecord": "established",
	"people.createAssessment": "established",
	"people.createCommitment": "established",
	"people.createHouseholdWithHead": "established",
	"people.createInterview": "established",
	"people.createPerson": "single",
	"people.createTag": "established",
	"people.deleteHousehold": "established",
	"people.deleteNote": "established",
	"people.deletePerson": "established",
	"people.deleteTag": "established",
	"people.editNote": "established",
	"people.mergePeople": "established",
	"people.propagateAddress": "established",
	"people.reactivateCommitment": "established",
	"people.recordAdultClassification": "established",
	"people.removeFromHousehold": "established",
	"people.removePersonPhoto": "established",
	"people.removeSkill": "established",
	"people.removeTag": "established",
	"people.reorderPipeline": "established",
	"people.restorePerson": "established",
	"people.setHouseholdRole": "established",
	"people.setPersonPhoto": "established",
	"people.unmergePeople": "established",
	"people.updateHousehold": "established",
	"people.updatePerson": "single",
	"people.updateSkill": "established",
	"people.updateTag": "established",
	"people.withdrawCommitment": "established",
} as const satisfies Record<string, WritePath>;
export type PeopleWrite = keyof typeof peopleWritePaths;

export type Mutation = { requestKey: string; expectedRevision?: string };
export type Revisioned = { revision: string };
export async function mutation<T>(
	tx: Tx,
	context: WriteContext,
	name: PeopleWrite,
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
		reason?: string | null;
		outcome?: "changed" | "noop";
		metadata?: Record<string, string>;
	}>,
): Promise<unknown> {
	await declareWrite(tx, context.selected.kind === "organization" ? "established" : peopleWritePaths[name]);
	await lockOwner(tx, context);
	const note = ["people.addNote", "people.editNote", "people.deleteNote"].includes(name);
	const orgNote = context.selected.kind === "organization" && note;
	const actor = await authorize(tx, { session: context.session, selected: context.selected }, !orgNote);
	if (orgNote) {
		const subject = parse(z.object({ input: z.object({ personId: z.uuid() }) }), input).input.personId;
		const access = await readPipelinePerson(tx, context.session, context.selected, { personId: subject });
		if (access.status !== "allowed" || !access.duties.some((d) => d.canReadStaffNotes)) deny("unavailable");
	}
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
	if (claim.kind === "unavailable") deny("unavailable");
	if (claim.kind === "replay") {
		if (
			context.selected.kind === "organization" &&
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
			deny("unavailable");
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
							: result.action === "people.merged"
								? "merge"
								: result.action === "people.unmerged"
									? "unmerge"
									: "edit",
		before_revision: result.before?.revision ?? null,
		after_revision: result.after?.revision ?? result.before?.revision ?? "1",
		before_value: note ? entry?.before_value : delta.before,
		after_value: note ? entry?.after_value : delta.after,
		reason: result.reason ?? entry?.reason ?? null,
		...(note
			? { metadata: entry?.metadata ?? { category: "note" } }
			: result.metadata
				? { metadata: result.metadata }
				: {}),
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
	if (p.state !== "live") deny("unavailable");
}

const isAdministrator = (actor: { context: { kind: string; role?: string } }) =>
	actor.context.kind === "seat" && actor.context.role !== "member";
