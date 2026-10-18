import { and, eq, lte, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import * as c from "@everyfield/contracts/people";
import { authorize, deny, parse } from "./core.ts";
import type { Tx, Context } from "./core.ts";
import { z } from "zod";
const eventRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	occurred_at: z.coerce.date(),
	action: z.string(),
	from_stage: c.stage.nullable(),
	to_stage: c.stage.nullable(),
	state: z.enum(["live", "retired", "merged"]),
	revision: z.string(),
});
const personRow = z.object({
	id: z.uuid(),
	created_at: z.coerce.date(),
	state: z.enum(["live", "retired", "merged"]),
	merged_into_person_id: z.uuid().nullable(),
	retired_at: z.coerce.date().nullable(),
});
export async function pipelineMetrics(tx: Tx, ctx: Context, raw: unknown) {
	if (ctx.selected.kind !== "plant" || ctx.purpose !== "native") deny();
	const input = parse(c.pipelineMetricsRequest, raw);
	await authorize(tx, ctx);
	const plant = (
		await tx
			.select({
				timezone: tables.plant.timezone,
				material_revision: tables.plant.material_revision,
				now: sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
			})
			.from(tables.plant)
			.where(eq(tables.plant.id, ctx.selected.id))
			.for("share")
	)[0]!;
	if (new Date(input.asOf) > plant.now) deny("invalid_input");
	const bounds = z
		.object({ start: z.coerce.date(), finish: z.coerce.date() })
		.parse(
			(
				await tx.execute(
					sql`SELECT ${sql.param(input.from)}::date::timestamp AT TIME ZONE ${sql.param(plant.timezone)} AS start,(${sql.param(input.through)}::date+1)::timestamp AT TIME ZONE ${sql.param(plant.timezone)} AS finish`,
				)
			).rows[0]!,
		);
	const asOf = new Date(input.asOf);
	const people = (
		await tx
			.select({
				id: tables.person.id,
				created_at: tables.person.created_at,
				state: tables.person.state,
				merged_into_person_id: tables.person.merged_into_person_id,
				retired_at: tables.person.retired_at,
			})
			.from(tables.person)
			.where(and(eq(tables.person.plant_id, ctx.selected.id), lte(tables.person.created_at, asOf)))
	).map((r) => personRow.parse(r));
	// Pull only stage/lifecycle evidence, never protected note/contact bodies.
	const events = (
		await tx.execute(
			sql`SELECT id,person_id,occurred_at,action,before_value->>'stage' AS from_stage,after_value->>'stage' AS to_stage,after_value->>'state' AS state,after_revision AS revision FROM people_history WHERE tenant_id=${sql.param(ctx.selected.id)} AND occurred_at<=${sql.param(asOf)} AND after_value IS NOT NULL AND after_value ? 'state' ORDER BY occurred_at,id`,
		)
	).rows.map((r) => eventRow.parse(r));
	const canonical = (id: string) => {
		const seen = new Set<string>();
		let p = people.find((p) => p.id === id);
		while (p?.merged_into_person_id && p.retired_at && p.retired_at <= asOf) {
			if (seen.has(p.id)) deny("source_unavailable");
			seen.add(p.id);
			p = people.find((x) => x.id === p!.merged_into_person_id);
		}
		return p?.id ?? id;
	};
	const at = (id: string, instant: Date) => events.findLast((e) => e.person_id === id && e.occurred_at <= instant);
	// A pre-existing Person with no historical snapshot cannot silently become zero.
	if (people.some((p) => !at(p.id, asOf))) deny("source_unavailable");
	const current = new Map<string, Set<string>>(c.stage.options.map((s) => [s, new Set()]));
	for (const p of people) {
		const e = at(p.id, asOf)!;
		if (e.state === "live" && e.to_stage) current.get(e.to_stage)!.add(canonical(p.id));
	}
	const cohortKnown = people.every((p) => p.created_at >= bounds.start || !!at(p.id, bounds.start));
	const transitions = c.stage.options.slice(0, -1).map((from, i) => {
		const to = c.stage.options[i + 1]!,
			changed = new Set(
				events
					.filter(
						(e) =>
							e.action === "people.stage_changed" &&
							e.from_stage === from &&
							e.to_stage === to &&
							e.occurred_at >= bounds.start &&
							e.occurred_at < bounds.finish,
					)
					.map((e) => canonical(e.person_id)),
			);
		const cohort = new Set(
			people
				.filter((p) => p.created_at <= bounds.start)
				.filter((p) => {
					const e = at(p.id, bounds.start);
					return e?.state === "live" && e.to_stage === from;
				})
				.map((p) => canonical(p.id)),
		);
		const conversion = !cohortKnown
			? { status: "unknown", reason: "cohort_unavailable" }
			: !cohort.size
				? { status: "unknown", reason: "empty_cohort" }
				: {
						status: "known",
						cohortPeople: cohort.size,
						cohortTransitionPeople: [...changed].filter((id) => cohort.has(id)).length,
					};
		return { from, to, distinctPeople: changed.size, conversion };
	});
	return c.pipelineMetricsResult.parse({
		owner: ctx.selected,
		asOf: input.asOf,
		zone: plant.timezone,
		sourceRevision: plant.material_revision,
		from: input.from,
		through: input.through,
		unit: "distinct_canonical_people",
		currentStages: c.stage.options.map((stage) => ({
			stage,
			distinctPeople: current.get(stage)!.size,
		})),
		transitions,
	});
}
