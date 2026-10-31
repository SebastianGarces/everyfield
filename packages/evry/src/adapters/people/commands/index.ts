import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { contactColumns, peopleWriter, personFields } from "@everyfield/domain/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import {
	changeStatusRequest,
	createPersonRequest,
	removePersonPhotoRequest,
	retirePersonRequest,
	setPersonPhotoRequest,
	updatePersonRequest,
	type PeopleContext,
	type PeopleReply,
} from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";

// The People reviewed writes. Each review is one SELECT under the proposal's statement: it reads the target live in
// the actor's church and saves the native command's exact arguments, including the revisions the review showed. On
// approval the executor runs the owning native People command once, with the effect key as its request key, so the
// change and its audit row commit together; anything that changed since the review refuses instead of being
// overwritten.

const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");
/** The live person in the actor's church, as `p`. */
const target = (actor: EvryActor, personId: string) =>
	sql`FROM person p WHERE p.id=${personId}::uuid AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
const person = sql`jsonb_build_object('kind','person','id',p.id,'label',p.display_name)`;
const change = (field: string, before: SQL, after: unknown) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${JSON.stringify(after ?? null)}::jsonb)`;
/**
 * The person's open tasks, each handed back as "needs an owner" at the revision the review saw. The native command
 * refuses when the open tasks changed since, so a task is never handed off unreviewed.
 */
const openTasks = sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('kind','needs_owner','dutyId',t.id,'expectedRevision',t.revision::text) ORDER BY t.id),'[]'::jsonb)
	FROM task t WHERE t.plant_id=p.plant_id AND (t.person_id=p.id OR EXISTS(SELECT FROM task_assignee ta WHERE ta.task_id=t.id AND ta.account_id=p.linked_account_id))
		AND t.deleted_at IS NULL AND t.status NOT IN ('complete','no_longer_needed'))`;
const tasksChange = (handoffs: SQL) =>
	sql`CASE WHEN jsonb_array_length(${handoffs})>0 THEN jsonb_build_array(jsonb_build_object('field','openTasksNeedingOwner','before',NULL,'after',jsonb_array_length(${handoffs}))) ELSE '[]'::jsonb END`;

type Receipt = { receiptId: string; revision: string };
/**
 * One reviewed write: `review` selects the review and `args`, the native request without its request key; `run` is
 * the native command.
 */
function reviewed<I, R extends z.ZodType>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	review(actor: EvryActor, input: I): SQL;
	request: R;
	run(
		tx: Transaction,
		context: PeopleContext,
		request: z.output<R>,
		reminders: TaskReminders,
	): Promise<PeopleReply<Receipt>>;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: ownerOrAdmin,
		review: spec.review,
		async execute(tx, context, args, effectKey, reminders): Promise<EffectResult> {
			const request = spec.request.parse({ ...z.object({}).loose().parse(args), requestKey: effectKey });
			const reply = await spec.run(tx, context, request, reminders);
			if (reply.status !== "ok") return { refused: reply.error.code };
			return { receiptId: reply.value.receiptId, revision: reply.value.revision };
		},
	};
}
const personReceipt = <T extends { receiptId: string; person: { revision: string } }>(reply: PeopleReply<T>) =>
	reply.status === "ok"
		? { status: "ok" as const, value: { receiptId: reply.value.receiptId, revision: reply.value.person.revision } }
		: reply;
const photoReceipt = <T extends { receiptId: string; personRevision: string }>(reply: PeopleReply<T>) =>
	reply.status === "ok"
		? { status: "ok" as const, value: { receiptId: reply.value.receiptId, revision: reply.value.personRevision } }
		: reply;

const personId = z.uuid();
const reason = changeStatusRequest.shape.input.shape.reason;

const createInput = createPersonRequest.shape.input;
export const createPerson = reviewed({
	operation: "people.createPerson",
	description:
		"Propose adding one person to this church with their name, contact, address, stage, source and notes. Nothing changes until the user approves the exact review.",
	input: createInput,
	review(_actor, value) {
		const changes = Object.entries(value).flatMap(([field, after]) =>
			after === undefined ? [] : [{ field, before: null, after }],
		);
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',${JSON.stringify(changes)}::jsonb) AS review,
			jsonb_build_object('input',${JSON.stringify(value)}::jsonb) AS args`;
	},
	request: createPersonRequest,
	run: async (tx, context, request) => personReceipt(await peopleWriter.createPerson(tx, context, request)),
});

const patch = updatePersonRequest.shape.input.shape.patch.refine((p) => Object.keys(p).length > 0, "empty patch");
const columns = new Map<string, string>(Object.entries(contactColumns));
export const updatePerson = reviewed({
	operation: "people.updatePerson",
	description:
		"Propose a change to one person's name, contact, address, source, notes or birth date. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId, patch }),
	review(actor, value) {
		const changes = Object.entries(value.patch).map(([field, after], n) => ({
			n,
			field,
			col: columns.get(field)!,
			after: after ?? null,
		}));
		return sql`SELECT jsonb_build_object('target',${person},
				'changes',(SELECT jsonb_agg(jsonb_build_object('field',k.field,'before',to_jsonb(p)->k.col,'after',k.after) ORDER BY k.n)
					FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) k(n int,field text,col text,after jsonb))) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,'patch',${JSON.stringify(value.patch)}::jsonb)) AS args
			${target(actor, value.personId)}`;
	},
	request: updatePersonRequest,
	run: async (tx, context, request) => personReceipt(await peopleWriter.updatePerson(tx, context, request)),
});

const core = sql`('core_group','launch_team','leader')`;
export const changeStatus = reviewed({
	operation: "people.changeStatus",
	description:
		"Propose moving one person to another pipeline stage, with the reason. Leaving the core stages hands their open tasks back as needing an owner. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId, stage: changeStatusRequest.shape.input.shape.stage, reason }),
	review(actor, value) {
		const handoffs = sql`CASE WHEN p.stage IN ${core} AND ${value.stage}::text NOT IN ${core} THEN ${openTasks} ELSE '[]'::jsonb END`;
		return sql`SELECT jsonb_build_object('target',${person},'changes',
				jsonb_build_array(${change("stage", sql`to_jsonb(p.stage)`, value.stage)},${change("reason", sql`NULL`, value.reason)})||${tasksChange(sql`h.handoffs`)}) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,'stage',${value.stage}::text,'reason',${value.reason}::text,'handoffs',h.handoffs)) AS args
			FROM person p CROSS JOIN LATERAL (SELECT ${handoffs} AS handoffs) h
			WHERE p.id=${value.personId}::uuid AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
	},
	request: changeStatusRequest,
	run: async (tx, context, request, reminders) =>
		personReceipt(await peopleWriter.changeStatus(tx, context, request, reminders)),
});

export const deletePerson = reviewed({
	operation: "people.deletePerson",
	description:
		"Propose removing one person from this church's current people, with the reason. Their history stays and their open tasks need a new owner. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId, reason }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${person},'changes',
				jsonb_build_array(${change("state", sql`to_jsonb(p.state)`, "retired")},${change("reason", sql`NULL`, value.reason)})||${tasksChange(sql`h.handoffs`)}) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,'reason',${value.reason}::text,
				'reviewRevision',(SELECT material_revision::text FROM plant WHERE id=p.plant_id),'handoffs',h.handoffs)) AS args
			FROM person p CROSS JOIN LATERAL (SELECT ${openTasks} AS handoffs) h
			WHERE p.id=${value.personId}::uuid AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
	},
	request: retirePersonRequest,
	run: async (tx, context, request, reminders) =>
		personReceipt(await peopleWriter.retirePerson(tx, context, request, reminders)),
});

export const setPersonPhoto = reviewed({
	operation: "people.setPersonPhoto",
	description:
		"Propose making a photo the user uploaded in this church the person's photo. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId, uploadId: z.uuid() }),
	review(actor, value) {
		// Only this church's own verified, unexpired upload that no person uses yet, as the native command requires.
		return sql`SELECT jsonb_build_object('target',${person},'changes',jsonb_build_array(${change("photo", sql`to_jsonb(p.photo_object_id)`, value.uploadId)})) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,'uploadId',${value.uploadId}::uuid)) AS args
			${target(actor, value.personId)} AND EXISTS(SELECT FROM file_object f WHERE f.id=${value.uploadId}::uuid AND f.tenant_id=p.tenant_id
				AND f.purpose='person_photo' AND f.state='ready' AND f.expires_at>clock_timestamp()
				AND NOT EXISTS(SELECT FROM person o WHERE o.photo_object_id=f.id))`;
	},
	request: setPersonPhotoRequest,
	run: async (tx, context, request) => photoReceipt(await personFields.setPersonPhoto(tx, context, request)),
});

export const removePersonPhoto = reviewed({
	operation: "people.removePersonPhoto",
	description: "Propose removing one person's photo. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ personId }),
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${person},'changes',jsonb_build_array(${change("photo", sql`to_jsonb(p.photo_object_id)`, null)})) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id)) AS args
			${target(actor, value.personId)} AND p.photo_object_id IS NOT NULL`;
	},
	request: removePersonPhotoRequest,
	run: async (tx, context, request) => photoReceipt(await personFields.removePersonPhoto(tx, context, request)),
});

/** The installed People reviewed writes, keyed by operation. */
export const PEOPLE_COMMANDS = {
	"people.createPerson": createPerson,
	"people.updatePerson": updatePerson,
	"people.changeStatus": changeStatus,
	"people.deletePerson": deletePerson,
	"people.setPersonPhoto": setPersonPhoto,
	"people.removePersonPhoto": removePersonPhoto,
} as const;
