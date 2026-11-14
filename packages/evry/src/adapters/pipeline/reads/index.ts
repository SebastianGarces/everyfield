import { programKind, programRhythm } from "@everyfield/contracts/organizations";
import { readPipelineBoard, readPrograms } from "@everyfield/domain/organizations";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { organizationSeat } from "../../native.ts";

// The organization pipeline and its programs (WP-101), read through the same domain reads the Pipeline and Programs
// pages make, under the asker's live seat: an Owner or Admin reads everyone, a Member named responsible staff reads
// their own people, and any other seat reads counts per stage only. No read returns a note, a move's reason, feedback,
// an assessment result or a ranking (REQ-MUL-015).

/** The day six months before `day` (YYYY-MM-DD), clamped to the month's end as the board's SQL date arithmetic does. */
export function sixMonthsBefore(day: string) {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	const month = y * 12 + (m - 1) - 6;
	const year = Math.floor(month / 12);
	const last = new Date(Date.UTC(year, (month % 12) + 1, 0)).getUTCDate();
	return `${year}-${String((month % 12) + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** A native refusal reads as no tenant data: the seat no longer reads this pipeline. */
const value = <T>(reply: { status: "ok"; value: T } | { status: "refused" }): T => {
	if (reply.status !== "ok") throw new EvryRefusal("access_denied");
	return reply.value;
};

const listInput = z.strictObject({
	/** One stage's people (a stage row's id from an earlier result); every stage when left out. */
	stageId: z.uuid().optional(),
	/** The Pipeline page's "no move in six months" filter. */
	stale: z.boolean().optional(),
	page: z.int().min(1).max(10_000).optional(),
});

export const listPeople = {
	operation: "pipeline.listPeople",
	description:
		"This organization's pipeline as the user's Pipeline page shows it: each stage with its count and, when the user's seat may see them, the people in it with their stage, last move day and responsible staff. stale: true gives the page's \"no move in six months\" filter (no stage move or first placement since six months before today, in the organization's time zone). Optional stageId for one stage. A seat that sees counts only gets counts per stage and no names. It never returns notes, reasons, feedback, assessments or rankings, and takes no search text",
	input: listInput,
	allowed: organizationSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const page = input.page ?? 1;
		const board = value(await readPipelineBoard(tx, actor.authority, { stale: input.stale ?? false, page }));
		const counts = board.audience === "counts";
		const stages = board.stages.filter((s) => !input.stageId || s.id === input.stageId);
		const stageRows: SourceRow[] = stages.map((s) => ({
			kind: "stage",
			id: s.id,
			label: s.label,
			fields: counts ? { count: s.count } : ({ count: s.count, matching: s.matching } as SourceRow["fields"]),
		}));
		const people: SourceRow[] = counts
			? []
			: stages.flatMap((s) =>
					s.people.map((p) => ({
						kind: "person" as const,
						id: p.personId,
						label: p.name,
						fields: { stage: s.label, stageId: s.id, lastMovedOn: p.lastMovedOn, responsible: p.responsible?.name ?? null },
					})),
				);
		const next = !counts && page < board.pages ? page + 1 : null;
		const stale = !counts && (input.stale ?? false);
		return {
			operation: "pipeline.listPeople",
			status: "available",
			rows: [...stageRows, ...people],
			total: counts ? stages.reduce((n, s) => n + s.count, 0) : stages.reduce((n, s) => n + s.matching, 0),
			page,
			next,
			completeness: next ? "partial" : "complete",
			exclusions: counts
				? ["This seat's Pipeline page shows counts per stage only: no names, notes or feedback."]
				: ["Notes, move reasons, feedback and assessment details stay on the Pipeline page."],
			facts: {
				organization: board.organizationName,
				asOf: board.asOf,
				audience: board.audience,
				stale,
				measured: stale
					? `No stage move or first placement since ${sixMonthsBefore(board.asOf)}, six months before ${board.asOf}, in ${board.organizationName}'s time zone.`
					: null,
			},
		};
	},
} satisfies ReadAdapter<z.infer<typeof listInput>>;

export const draftPlan = {
	operation: "development.draftPlan",
	description: `What drafting a program plan needs: the staff who may direct it (seat rows), this organization's existing programs and whether the user may create one. Draft the plan from the user's request: a kind (${programKind.options.join(" or ")}), a name, an expected length in months (1 to 120), a meeting rhythm (${programRhythm.options.join(", ")}), up to 20 stages with month ranges and up to 100 milestones. Only an Owner or Admin creates a program, through development.saveProgram`,
	input: z.strictObject({}),
	allowed: organizationSeat,
	async invoke(tx, actor): Promise<SourceResult> {
		const list = value(await readPrograms(tx, actor.authority));
		const rows: SourceRow[] = list.staff.map((s) => ({ kind: "seat", id: s.seatId, label: s.name, fields: {} }));
		return {
			operation: "development.draftPlan",
			status: "available",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: list.administrator ? [] : ["Only an Owner or Admin sees who may direct a program."],
			facts: {
				organization: list.organizationName,
				canCreate: list.administrator,
				programs: list.programs.map((p) => p.name).join(", ") || null,
			},
		};
	},
} satisfies ReadAdapter<Record<string, never>>;

/** The installed pipeline and program reads. */
export const PIPELINE_READS = [listPeople, draftPlan] as const;
