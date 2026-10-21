import * as c from "@everyfield/contracts/people";
import { sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { mutation, parse, readReply, reply, type Context, type Tx, type WriteContext } from "../core.ts";
import { plantId } from "../fields/shared.ts";
import {
	advance,
	attribution,
	nextRevision,
	notFuture,
	personUpdate,
	readHistory,
	recordEvent,
	recorderSql,
	subject,
} from "../assessments/shared.ts";

const criterion = z.object({ rating: c.criterionRating, notes: z.string().nullable() });
const interviewRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	occurred_on: z.string(),
	recorded_at: z.coerce.date(),
	actor_id: z.uuid().nullable(),
	revision: z.string(),
	maturity: criterion,
	gifted: criterion,
	chemistry: criterion,
	rightReasons: criterion,
	season: criterion,
	result: c.interviewResult,
	next_steps: z.string().nullable(),
});
function interviewView(plant: string, raw: unknown) {
	const r = interviewRow.parse(raw);
	return c.interview.parse({
		id: r.id,
		personId: r.person_id,
		occurredOn: r.occurred_on,
		recordedAt: r.recorded_at.toISOString(),
		actor: attribution(plant, r.id, r.actor_id),
		revision: r.revision,
		maturity: r.maturity,
		gifted: r.gifted,
		chemistry: r.chemistry,
		rightReasons: r.rightReasons,
		season: r.season,
		result: r.result,
		nextSteps: r.next_steps,
	});
}
const criterionSql = (column: string) => sql.raw(`jsonb_build_object('rating',r.${column},'notes',r.${column}_notes)`);
const interviewJson = sql`jsonb_build_object('id',r.id,'person_id',r.person_id,'occurred_on',r.interviewed_on::text,
 'recorded_at',r.recorded_at,'actor_id',${recorderSql("r")},'revision',r.revision::text,'maturity',${criterionSql("maturity")},
 'gifted',${criterionSql("gifted")},'chemistry',${criterionSql("chemistry")},'rightReasons',${criterionSql("right_reasons")},
 'season',${criterionSql("season")},'result',r.result,'next_steps',r.next_steps)`;
const latestFirst = sql`r.interviewed_on DESC,r.recorded_at DESC,r.id DESC`;

export const interviews = {
	/**
	 * REQ-PPL-013 and REQ-PPL-020: any result means the interview happened. An earlier stage moves to interviewed in the
	 * same statement as the interview and its history; an advanced stage stays. Next steps are text and create no task.
	 */
	async createInterview(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(c.createInterviewRequest, raw);
			return c.interviewMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.createInterview", input, async (actor, receiptId, audit) => {
					const i = input.input;
					const p = await subject(tx, ctx, i.personId);
					notFuture(p, i.occurredOn);
					const id = randomUUID();
					const step = advance(p, "interviewed");
					audit.writes.push(
						tx.insert(tables.interview).values({
							id,
							plant_id: plant,
							person_id: p.id,
							interviewed_on: i.occurredOn,
							recorded_at: p.now,
							maturity: i.maturity.rating,
							gifted: i.gifted.rating,
							chemistry: i.chemistry.rating,
							right_reasons: i.rightReasons.rating,
							season: i.season.rating,
							maturity_notes: i.maturity.notes,
							gifted_notes: i.gifted.notes,
							chemistry_notes: i.chemistry.notes,
							right_reasons_notes: i.rightReasons.notes,
							season_notes: i.season.notes,
							result: i.result,
							next_steps: i.nextSteps,
						}),
						...personUpdate(tx, plant, p, step.set),
					);
					const revision = nextRevision(p, step.set);
					const stage = step.change?.to ?? p.stage;
					const value = {
						interview: interviewView(plant, {
							id,
							person_id: p.id,
							occurred_on: i.occurredOn,
							recorded_at: p.now,
							actor_id: actor,
							revision: "1",
							maturity: i.maturity,
							gifted: i.gifted,
							chemistry: i.chemistry,
							rightReasons: i.rightReasons,
							season: i.season,
							result: i.result,
							next_steps: i.nextSteps,
						}),
						person: { personId: p.id, stage, revision, stageChange: step.change },
						outcome: "changed",
						receiptId,
					};
					return {
						value,
						subject: p.id,
						action: "people.recorded",
						before: { revision: p.revision, stage: p.stage },
						after: { revision, stage },
						metadata: recordEvent("interview_recorded", id),
					};
				}),
			);
		});
	},
	async getInterviews(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const input = parse(c.personRecordsRequest, raw);
			const h = await readHistory(tx, ctx, input, sql`interview`, interviewJson, latestFirst);
			return c.interviewsResult.parse({
				personId: input.personId,
				latest: h.latest ? interviewView(h.plant, h.latest) : null,
				items: h.items.map((r) => interviewView(h.plant, r)),
				next: h.next,
				total: h.total,
			});
		});
	},
};
