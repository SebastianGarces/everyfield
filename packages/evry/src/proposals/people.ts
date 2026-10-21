import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { contactColumns, peopleWriter } from "@everyfield/domain/people";
import { updatePersonRequest, type PeopleContext } from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { ReviewedWrite } from "./types.ts";

// The built-in reviewed write: the native people.updatePerson, under the same domain authority (WP-059 adds the rest
// of the People commands). The review shows each changed field before and after; the person's revision at review time
// is the expected revision, so a change made since the review refuses instead of overwriting it.

const patch = updatePersonRequest.shape.input.shape.patch.refine((p) => Object.keys(p).length > 0, "empty patch");
const input = z.strictObject({ personId: z.uuid(), patch });
type Input = z.infer<typeof input>;
const columns = new Map<string, string>(Object.entries(contactColumns));
const args = z.strictObject({ personId: z.uuid(), patch, expectedRevision: z.string() });

export const updatePerson: ReviewedWrite<Input> = {
	operation: "people.updatePerson",
	description:
		"Propose a change to one person's name, contact, address, source, notes or birth date. Nothing changes until the user approves the exact review.",
	input,
	allowed: (actor: EvryActor) => actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin"),
	review(actor, value) {
		const changes = Object.entries(value.patch).map(([field, after], n) => ({
			n,
			field,
			col: columns.get(field)!,
			after: after ?? null,
		}));
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','person','id',p.id,'label',p.display_name),
				'changes',(SELECT jsonb_agg(jsonb_build_object('field',k.field,'before',to_jsonb(p)->k.col,'after',k.after) ORDER BY k.n)
					FROM jsonb_to_recordset(${JSON.stringify(changes)}::jsonb) k(n int,field text,col text,after jsonb))) AS review,
			jsonb_build_object('personId',p.id,'patch',${JSON.stringify(value.patch)}::jsonb,'expectedRevision',p.revision::text) AS args
			FROM person p WHERE p.id=${value.personId}::uuid AND p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid AND p.state='live'`;
	},
	async execute(tx: Transaction, context: PeopleContext, raw: unknown, effectKey: string) {
		const a = args.parse(raw);
		const request = updatePersonRequest.parse({
			requestKey: effectKey,
			expectedRevision: a.expectedRevision,
			input: { personId: a.personId, patch: a.patch },
		});
		const reply = await peopleWriter.updatePerson(tx, context, request);
		if (reply.status !== "ok") return { refused: reply.error.code };
		return { receiptId: reply.value.receiptId, revision: reply.value.person.revision };
	},
};
