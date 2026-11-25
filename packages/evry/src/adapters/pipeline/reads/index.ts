import { dayText } from "@everyfield/contracts/common";
import { programKind, programRhythm } from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	readEnrollment,
	readPipelineBoard,
	readPipelineGoals,
	readProgram as readProgramDetail,
	readPrograms,
} from "@everyfield/domain/organizations";
import {
	goalHeadline,
	STARTER_STAGES,
	type EnrollmentDetail,
	type ProgramVersion,
} from "@everyfield/contracts/organizations";
import { z } from "zod";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { liveAuthority } from "../../../context/authority.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { organizationSeat, rowId } from "../../native.ts";
import { localWhenText } from "../../../catalog/labels.ts";

function sixMonthsBefore(day: string) {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	const month = y * 12 + (m - 1) - 6;
	const year = Math.floor(month / 12);
	const last = new Date(Date.UTC(year, (month % 12) + 1, 0)).getUTCDate();
	return `${year}-${String((month % 12) + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

const value = <T>(reply: { status: "ok"; value: T } | { status: "refused" }): T => {
	if (reply.status !== "ok") throw new EvryRefusal("access_denied");
	return reply.value;
};

const listInput = z.strictObject({
	stageId: z.uuid().optional(),
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
						fields: {
							stage: s.label,
							stageId: s.id,
							lastMovedOn: p.lastMovedOn,
							responsible: p.responsible?.name ?? null,
						},
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
				? ["names, notes and feedback, because this seat's Pipeline page shows counts per stage only"]
				: ["notes, move reasons, feedback and assessment details, which stay on the Pipeline page"],
			facts: {
				organization: board.organizationName,
				asOf: board.asOf,
				audience: board.audience,
				stale,
				measured: stale
					? `No stage move or first placement since ${dayText(sixMonthsBefore(board.asOf))}, six months before today, in ${board.organizationName}'s time zone.`
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
			exclusions: list.administrator ? [] : ["who may direct a program, which only an Owner or Admin sees"],
			facts: {
				organization: list.organizationName,
				canCreate: list.administrator,
				programs: list.programs.map((p) => p.name).join(", ") || null,
			},
		};
	},
} satisfies ReadAdapter<Record<string, never>>;

const planRows = (v: ProgramVersion): SourceRow[] => [
	...v.stages.map((s) => ({
		kind: "item" as const,
		id: s.id,
		label: s.label,
		fields: { part: "stage", version: v.number, minMonths: s.minMonths, maxMonths: s.maxMonths },
	})),
	...v.milestones.map((m) => ({
		kind: "item" as const,
		id: m.id,
		label: m.title,
		fields: {
			part: "milestone",
			version: v.number,
			lineage: m.lineage,
			description: m.description,
			handsOn: m.handsOn,
		},
	})),
	...v.readings.map((r) => ({
		kind: "item" as const,
		id: r.id,
		label: r.title,
		fields: { part: "reading", version: v.number },
	})),
];

export const STAGE_KIND: Record<string, string> = Object.fromEntries([...STARTER_STAGES, ["other", "Other"]]);

const finishedText = (m: EnrollmentDetail["milestones"][number], detail: EnrollmentDetail) => {
	const c = m.completion;
	if (!c)
		return detail.resident.status === "linked" && detail.resident.milestones === "not_shared"
			? "Progress not shared"
			: "Not finished";
	if (c.confirmedOn === null)
		return `Waiting for confirmation, ${c.recorder ?? detail.person.name} marked it done ${dayText(c.completedOn)}`;
	return `Finished ${dayText(c.completedOn)}`;
};

export const readProgram = {
	operation: "development.readProgram",
	description:
		"This organization's development programs as Programs shows them. Without programId: each program with its kind, director, whether the user directs it, its published version number and whether a draft is in progress. With programId (a program row's id): its published version and its draft, each with rhythm and expected length in facts and, as rows, its stages, its milestones (each with its lineage, which carries it across versions) and its reading list, and whether the user directs it. Only the program's current director edits its plan, through development.draftNextVersion. With programId and enrolled: true, also the enrollments the user's Programs page shows (enrollment rows) and, for an Owner or Admin, the pipeline people who can be enrolled (candidate rows, by personId). With enrollmentId (an enrollment row's id) alone: that one enrollment's cohort, dates, stage, next meeting and version in facts, the stages of its version (stage rows) and its milestones (milestone rows, each with its progress as the page shows it: Not finished, Waiting for confirmation, Finished or Progress not shared). It never returns feedback, notes or reasons",
	input: z.strictObject({
		programId: z.uuid().optional(),
		enrolled: z.boolean().optional(),
		enrollmentId: rowId.optional(),
	}),
	allowed: organizationSeat,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const done = (rows: SourceRow[], facts: SourceResult["facts"], exclusion: string): SourceResult => ({
			operation: "development.readProgram",
			status: "available",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [exclusion],
			facts,
		});
		const plans = "who is enrolled, completions, feedback and notes, which stay in Programs";
		const shown = "feedback, notes and progress a resident does not share, which stay in Programs";
		if (input.enrollmentId) {
			const read = await readEnrollment(tx, actor.authority, { enrollmentId: input.enrollmentId });
			if (read.status !== "ok") return { ...done([], {}, shown), status: "not_found", total: 0 };
			const e = read.value;
			return done(
				[
					...e.stages.map((s) => ({
						kind: "item" as const,
						id: s.id,
						label: s.label,
						fields: { part: "stage", version: e.versionNumber, current: s.id === e.stage.id },
					})),
					...e.milestones.map((m) => ({
						kind: "item" as const,
						id: m.id,
						label: m.title,
						fields: { part: "milestone", version: e.versionNumber, progress: finishedText(m, e) },
					})),
				],
				{
					enrollmentId: e.id,
					person: e.person.name,
					programId: e.program.id,
					program: e.program.name,
					director: e.program.director.name,
					directedByYou: e.viewer.director,
					version: e.versionNumber,
					newerVersion: e.newerVersion?.number ?? null,
					cohort: e.cohort,
					startedOn: e.startedOn,
					expectedEndOn: e.expectedEndOn,
					status: e.status,
					stage: e.stage.label,
					nextMeeting: e.nextMeeting ? `${localWhenText(e.nextMeeting.at)} (${e.nextMeeting.timezone})` : null,
					account: e.resident.status === "linked" ? "Linked" : "Not linked",
				},
				shown,
			);
		}
		if (!input.programId) {
			const list = value(await readPrograms(tx, actor.authority));
			return done(
				list.programs.map((p) => ({
					kind: "item",
					id: p.id,
					label: p.name,
					fields: {
						part: "program",
						kind: p.kind,
						director: p.director.name,
						directedByYou: p.director.seatId === actor.seatId,
						publishedVersion: p.publishedNumber,
						draft: p.draft,
					},
				})),
				{ organization: list.organizationName },
				plans,
			);
		}
		const p = value(await readProgramDetail(tx, actor.authority, { programId: input.programId }));
		const enrolled: SourceRow[] = input.enrolled
			? [
					...p.enrollments.map((e) => ({
						kind: "item" as const,
						id: e.id,
						label: e.name,
						fields: {
							part: "enrollment",
							cohort: e.cohort,
							status: e.status,
							stage: e.stage,
							version: e.versionNumber,
						},
					})),
					...p.people.map((x) => ({
						kind: "item" as const,
						id: x.personId,
						label: x.name,
						fields: { part: "candidate" },
					})),
				]
			: [];
		return done(
			[...enrolled, ...(p.published ? planRows(p.published) : []), ...(p.draft ? planRows(p.draft) : [])],
			{
				programId: p.id,
				program: p.name,
				kind: p.kind,
				director: p.director.name,
				directedByYou: p.viewer.director,
				publishedVersion: p.published?.number ?? null,
				publishedRhythm: p.published?.rhythm ?? null,
				publishedMonths: p.published?.expectedMonths ?? null,
				draftVersion: p.draft?.number ?? null,
				draftRhythm: p.draft?.rhythm ?? null,
				draftMonths: p.draft?.expectedMonths ?? null,
				...(input.enrolled && { today: p.today, timeZone: p.timezone }),
			},
			input.enrolled ? shown : plans,
		);
	},
} satisfies ReadAdapter<{ programId?: string; enrolled?: boolean; enrollmentId?: string }>;

const monthText = (month: string) =>
	new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(
		Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1),
	);
export const readGoals = {
	operation: "pipeline.readGoals",
	description:
		"This organization's sending goals as its Pipeline page shows them: each goal's leaders to develop, churches to plant, year, why, the day it counts from and, for each stage kind it counts, how many people reached that kind since then. Facts give today's date there, the people in each stage kind now and the active residents; plants sent is not available yet. Counts only, never a name",
	input: z.strictObject({}),
	allowed: organizationSeat,
	async invoke(tx, actor): Promise<SourceResult> {
		const g = value(await readPipelineGoals(tx, actor.authority));
		return {
			operation: "pipeline.readGoals",
			status: "available",
			rows: g.goals.map((x) => ({
				kind: "item",
				id: x.id,
				label: goalHeadline(x),
				fields: {
					leaderTarget: x.leaderTarget,
					plantTarget: x.plantTarget,
					targetYear: x.targetYear,
					rationale: x.rationale,
					countingFrom: x.countingFrom,
					counts: x.counts.map((c) => `${c.label} (${STAGE_KIND[c.kind]}): ${c.count}`).join("; ") || null,
				},
			})),
			total: g.goals.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["the names behind each count"],
			facts: {
				asOf: g.asOf,
				canEdit: g.canEdit,
				pipelineToday: g.kinds.map((k) => `${STAGE_KIND[k.kind]}: ${k.count}`).join("; ") || null,
				activeResidents: g.activeResidents,
				plantsSent: "Not available yet",
			},
		};
	},
} satisfies ReadAdapter<Record<string, never>>;

export const readConversationCounts = {
	operation: "pipeline.readConversationCounts",
	description:
		"How many leadership conversations staff logged, as the Pipeline page counts them by the day they happened: the last six months (month rows) and the last four quarters (quarter rows). Counts only: never who met whom, a note or whether a note exists",
	input: z.strictObject({}),
	allowed: organizationSeat,
	async invoke(tx, actor): Promise<SourceResult> {
		const g = value(await readPipelineGoals(tx, actor.authority));
		const rows: SourceRow[] = [
			...g.conversations.months.map((m) => ({
				kind: "item" as const,
				id: m.month,
				label: monthText(m.month),
				fields: { period: "month", count: m.count },
			})),
			...g.conversations.quarters.map((q) => ({
				kind: "item" as const,
				id: `${q.year}-Q${q.quarter}`,
				label: `Q${q.quarter} ${q.year}`,
				fields: { period: "quarter", count: q.count },
			})),
		];
		return {
			operation: "pipeline.readConversationCounts",
			status: "available",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["who met whom, and any conversation note"],
			facts: { asOf: g.asOf },
		};
	},
} satisfies ReadAdapter<Record<string, never>>;

export const PIPELINE_READS = [listPeople, draftPlan, readProgram, readGoals, readConversationCounts] as const;

export async function pipelineListsPeople(db: Pick<Database, "execute">, actor: EvryActor) {
	if (!organizationSeat(actor) || !actor.seatId) return false;
	const r = await db.execute(sql`SELECT ${liveAuthority(actor)} AND (${actor.role !== "member"} OR EXISTS(
		SELECT FROM pipeline_person pp JOIN person p ON p.id=pp.person_id AND p.tenant_id=pp.organization_id AND p.state='live'
		WHERE pp.organization_id=${actor.owner.id}::uuid AND pp.responsible_seat_id=${actor.seatId}::uuid)) AS lists`);
	return r.rows[0]?.lists === true;
}
