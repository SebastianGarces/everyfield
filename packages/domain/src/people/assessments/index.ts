import * as c from "@everyfield/contracts/people";
import { sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { mutation, parse, readReply, reply, type Context, type Tx, type WriteContext } from "../core.ts";
import { plantId } from "../fields/shared.ts";
import {
	attribution,
	notFuture,
	readHistory,
	recordEvent,
	recorderSql,
	receiptOf,
	replayed,
	subject,
} from "./shared.ts";

const lens = z.object({ score: z.number(), notes: z.string().nullable() });
const assessmentRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	occurred_on: z.string(),
	recorded_at: z.coerce.date(),
	actor_id: z.uuid().nullable(),
	revision: z.string(),
	committed: lens,
	compelled: lens,
	contagious: lens,
	courageous: lens,
});
type AssessmentRow = z.infer<typeof assessmentRow>;
/** REQ-PPL-012: the total is always the sum of the four stored scores, computed here and nowhere else. */
function assessmentView(plant: string, raw: unknown) {
	const r: AssessmentRow = assessmentRow.parse(raw);
	return c.assessment.parse({
		id: r.id,
		personId: r.person_id,
		occurredOn: r.occurred_on,
		recordedAt: r.recorded_at.toISOString(),
		actor: attribution(plant, r.id, r.actor_id),
		revision: r.revision,
		committed: r.committed,
		compelled: r.compelled,
		contagious: r.contagious,
		courageous: r.courageous,
		total: r.committed.score + r.compelled.score + r.contagious.score + r.courageous.score,
	});
}
const lensSql = (name: string) => sql.raw(`jsonb_build_object('score',r.${name},'notes',r.${name}_notes)`);
const assessmentJson = sql`jsonb_build_object('id',r.id,'person_id',r.person_id,'occurred_on',r.assessed_on::text,
 'recorded_at',r.recorded_at,'actor_id',${recorderSql("r")},'revision',r.revision::text,'committed',${lensSql("committed")},
 'compelled',${lensSql("compelled")},'contagious',${lensSql("contagious")},'courageous',${lensSql("courageous")})`;
// Latest first by assessment date, then recorded instant, then ID: a late historical entry never becomes latest.
const latestFirst = sql`r.assessed_on DESC,r.recorded_at DESC,r.id DESC`;

export const assessments = {
	async createAssessment(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(c.createAssessmentRequest, raw);
			let fresh: unknown;
			const stored = await mutation<unknown>(
				tx,
				ctx,
				"people.createAssessment",
				input,
				async (actor, receiptId, audit) => {
					const a = input.input;
					const p = await subject(tx, ctx, a.personId);
					notFuture(p, a.occurredOn);
					const id = randomUUID();
					audit.writes.push(
						tx.insert(tables.four_cs).values({
							id,
							plant_id: plant,
							person_id: p.id,
							assessed_on: a.occurredOn,
							recorded_at: p.now,
							committed: a.committed.score,
							compelled: a.compelled.score,
							contagious: a.contagious.score,
							courageous: a.courageous.score,
							committed_notes: a.committed.notes,
							compelled_notes: a.compelled.notes,
							contagious_notes: a.contagious.notes,
							courageous_notes: a.courageous.notes,
						}),
					);
					// Recording an assessment never changes stage (REQ-PPL-012).
					const value = {
						assessment: assessmentView(plant, {
							id,
							person_id: p.id,
							occurred_on: a.occurredOn,
							recorded_at: p.now,
							actor_id: actor,
							revision: "1",
							committed: a.committed,
							compelled: a.compelled,
							contagious: a.contagious,
							courageous: a.courageous,
						}),
						person: { personId: p.id, stage: p.stage, revision: p.revision, stageChange: null },
						outcome: "changed",
						receiptId,
					};
					fresh = value;
					return {
						value: receiptOf(value, "assessment", id),
						subject: p.id,
						action: "people.recorded",
						before: { revision: p.revision },
						after: { revision: p.revision },
						metadata: recordEvent("assessment_recorded", id),
					};
				},
			);
			// A retry rebuilds the private record from its row; central audit holds only the receipt.
			return c.assessmentMutationResult.parse(
				fresh ?? (await replayed(tx, plant, stored, "assessment", sql`four_cs`, assessmentJson, assessmentView)),
			);
		});
	},
	async getAssessments(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const input = parse(c.personRecordsRequest, raw);
			const h = await readHistory(tx, ctx, input, sql`four_cs`, assessmentJson, latestFirst);
			return c.assessmentsResult.parse({
				personId: input.personId,
				latest: h.latest ? assessmentView(h.plant, h.latest) : null,
				items: h.items.map((r) => assessmentView(h.plant, r)),
				next: h.next,
				total: h.total,
			});
		});
	},
};
