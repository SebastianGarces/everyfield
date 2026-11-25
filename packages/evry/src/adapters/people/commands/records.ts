import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead, type WriteTx } from "@everyfield/domain/access";
import { columnStages, peopleWriter } from "@everyfield/domain/people";
import {
	classifyAdultRequest,
	pipelineColumn,
	reorderPipelineRequest,
	restorePersonRequest,
	stage,
	STAGE_LABEL,
	type PeopleContext,
	type PeopleReply,
} from "@everyfield/contracts/people";
import { dayText } from "@everyfield/contracts/common";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { dayInput as day, idInput as id, plantAdmin } from "../../native.ts";

type Change = { field: string; before: unknown; after: unknown };
type Prepared = {
	target: { kind: "person" | "retired_person"; id: string; label: string };
	changes: Change[];
	notes: string[];
	refusal: string | null;
	expectedRevision: string;
	request: Record<string, unknown>;
};

const savedRecord = z.strictObject({ expectedRevision: z.string(), request: z.unknown() });

function recordWrite<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	prepare(db: Database, actor: EvryActor, input: I): Promise<Prepared | null>;
	again?(request: unknown): I;
	run(
		tx: WriteTx,
		context: PeopleContext,
		request: { requestKey: string; expectedRevision: string; input: unknown },
	): Promise<PeopleReply<{ receiptId: string }>>;
}): ReviewedWrite<I> {
	const { again } = spec;
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: plantAdmin,
		async review(actor, input, context) {
			const p = await spec.prepare(context.db, actor, input);
			if (!p) return null;
			const review = {
				target: p.target,
				changes: p.changes,
				...(p.notes.length && { notes: p.notes }),
				...(p.refusal && { refusal: p.refusal }),
			};
			const args = { request: p.request, expectedRevision: p.expectedRevision };
			return sql`SELECT ${JSON.stringify(review)}::jsonb AS review, ${JSON.stringify(args)}::jsonb AS args`;
		},
		...(again && { again: (args: unknown) => again(savedRecord.parse(args).request) }),
		async execute(tx, context, args, effectKey): Promise<EffectResult> {
			const { request, expectedRevision } = savedRecord.parse(args);
			const reply = await spec.run(tx, context, { requestKey: effectKey, expectedRevision, input: request });
			return reply.status === "ok"
				? { receiptId: reply.value.receiptId, revision: expectedRevision }
				: { refused: reply.error.code };
		},
	};
}

const mine = (actor: EvryActor) =>
	sql`p.tenant_id=${actor.owner.id}::uuid AND p.plant_id=${actor.owner.id}::uuid
		AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined }, true)}`;

const leftRow = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	state: z.enum(["live", "retired", "merged"]),
	stage,
	revision: z.string(),
	left_on: z.string().nullable(),
	survivor: z.string().nullable(),
});
const restoreInput = z
	.strictObject({
		personId: id.optional(),
		name: z.string().trim().min(1).max(255).optional(),
	})
	.refine((v) => (v.personId === undefined) !== (v.name === undefined), "personId or name");
async function leftPerson(db: Database, actor: EvryActor, input: z.infer<typeof restoreInput>) {
	const name = input.name?.toLowerCase() ?? null;
	const r = await db.execute(sql`SELECT p.id,p.display_name AS name,p.state,p.stage,p.revision::text AS revision,
			(p.retired_at AT TIME ZONE pl.timezone)::date::text AS left_on,s.display_name AS survivor
		FROM person p JOIN plant pl ON pl.id=p.plant_id LEFT JOIN person s ON s.id=p.merged_into_person_id AND s.tenant_id=p.tenant_id
		WHERE ${mine(actor)} AND CASE WHEN ${name}::text IS NULL THEN p.id=${input.personId ?? null}::uuid
			ELSE p.state<>'live' AND strpos(lower(p.display_name),${name}::text)>0 END
		ORDER BY lower(p.display_name)=${name}::text DESC,p.state='retired' DESC,p.retired_at DESC,p.id LIMIT 12`);
	const rows = z.array(leftRow).parse(r.rows);
	const exact = rows.filter((x) => x.name.toLowerCase() === name);
	const named = exact.length ? exact : rows;
	const retired = named.filter((x) => x.state === "retired");
	const found = retired.length ? retired : named;
	if (found.length < 2) return found[0] ?? null;
	const listed = found.map(
		(x) =>
			`${x.name}, ${STAGE_LABEL[x.stage]}${x.left_on ? `, deleted ${dayText(x.left_on, { weekday: "short" })}` : ""} (personId ${x.id})`,
	);
	throw new EvryRefusal(
		"invalid_input",
		`More than one deleted person matches: ${listed.join("; ")}. Ask which one, then propose personId.`,
	);
}
export const restorePerson = recordWrite({
	operation: "people.restorePerson",
	description:
		"Propose bringing back one person who was deleted (removed) from this church, with the same records and history. Deleted people are in no People read: give name, as the user said it, and the card finds them. When a tool error lists more than one, ask which and give that personId. A person merged into another record isn't deleted: the card says to use Unmerge. Nothing changes until the user approves the exact review.",
	input: restoreInput,
	async prepare(db, actor, input) {
		const found = await leftPerson(db, actor, input);
		if (!found)
			throw new EvryRefusal("not_found", "No deleted person in this church matches. Say so and ask for the name.");
		return {
			target: { kind: "retired_person", id: found.id, label: found.name },
			changes: found.state === "retired" ? [{ field: "state", before: found.state, after: "live" }] : [],
			notes:
				found.state === "retired"
					? [
							`They come back to the active list as ${STAGE_LABEL[found.stage]}, with the details they had.`,
							"Their history stays as it is; the restore is added to it.",
							"A seat, account consent or private notes are not restored.",
						]
					: [],
			refusal:
				found.state === "merged"
					? `${found.name} was merged into ${found.survivor ?? "another person"}, not deleted. To bring this record back, use Unmerge on ${found.survivor ?? "that person"}'s page.`
					: found.state === "live"
						? `${found.name} is already in People, so there's nothing to bring back.`
						: null,
			expectedRevision: found.revision,
			request: { personId: found.id },
		};
	},
	run: (tx, context, request) => peopleWriter.restorePerson(tx, context, restorePersonRequest.parse(request)),
});

const classified = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	revision: z.string(),
	birth_date: z.string().nullable(),
	adult: z.enum(["adult", "child", "unknown"]),
	today: z.string(),
});
const { classification, reason } = classifyAdultRequest.shape.input.shape;
const classifyInput = z.strictObject({
	personId: id,
	classification,
	occurredOn: day,
	reason,
});
const ADULT_LABEL = { adult: "Adult", child: "Child", unknown: "Not recorded" } as const;
async function prepareClassification(
	db: Database,
	actor: EvryActor,
	input: z.infer<typeof classifyInput>,
	correction: boolean,
): Promise<Prepared | null> {
	const r =
		await db.execute(sql`SELECT p.id,p.display_name AS name,p.revision::text AS revision,p.birth_date::text AS birth_date,
			p.adult_classification AS adult,(clock_timestamp() AT TIME ZONE pl.timezone)::date::text AS today
		FROM person p JOIN plant pl ON pl.id=p.plant_id
		WHERE ${mine(actor)} AND p.id=${input.personId}::uuid AND p.state='live'`);
	if (!r.rows[0]) return null;
	const p = classified.parse(r.rows[0]);
	const recorded = p.adult !== "unknown";
	return {
		target: { kind: "person", id: p.id, label: p.name },
		changes: [
			{ field: "adultClassification", before: p.adult, after: input.classification },
			{ field: "occurredOn", before: null, after: input.occurredOn },
			{ field: "reason", before: null, after: input.reason },
		],
		notes: [
			"This is recorded as you say it. It is never worked out from a household or a stage. A birth date, once added, sets it instead.",
			...(correction ? ["The earlier answer stays in the history."] : []),
		],
		refusal: p.birth_date
			? `${p.name}'s birth date decides adult or child, so it isn't recorded by hand. Correct the birth date instead.`
			: input.occurredOn > p.today
				? "This date is after today at your church. Choose an earlier date."
				: correction && !recorded
					? `Nothing is recorded for ${p.name} yet, so there's nothing to correct. Ask Evry to record it.`
					: !correction && recorded
						? `${p.name} is already recorded as ${ADULT_LABEL[p.adult]}. Ask Evry to correct it.`
						: null,
		expectedRevision: p.revision,
		request: input,
	};
}
const CLASSIFY_ASK =
	"It needs the date the user learned it (occurredOn, not after today) and their reason in their own words: ask for what they left out. Never work it out from a household, stage, surname or note. A birth date decides it instead. Nothing changes until the user approves the exact review.";
export const recordAdultClassification = recordWrite({
	operation: "people.recordAdultClassification",
	description: `Propose recording whether one person is an adult or a child, when nothing is recorded. ${CLASSIFY_ASK}`,
	input: classifyInput,
	prepare: (db, actor, input) => prepareClassification(db, actor, input, false),
	again: (request) => classifyInput.parse(request),
	run: (tx, context, request) =>
		peopleWriter.recordAdultClassification(tx, context, classifyAdultRequest.parse(request)),
});
export const correctAdultClassification = recordWrite({
	operation: "people.correctAdultClassification",
	description: `Propose correcting a recorded adult or child status that is wrong; unknown sets it back to Not recorded. ${CLASSIFY_ASK}`,
	input: classifyInput,
	prepare: (db, actor, input) => prepareClassification(db, actor, input, true),
	again: (request) => classifyInput.parse(request),
	run: (tx, context, request) =>
		peopleWriter.correctAdultClassification(tx, context, classifyAdultRequest.parse(request)),
});

const columnRow = z.strictObject({
	name: z.string(),
	revision: z.string(),
	cards: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
});
const reorderInput = z.strictObject({ personId: id, afterId: id.nullable() });
const columnOf = (s: z.infer<typeof stage>) =>
	pipelineColumn.options.find((column) => columnStages(column).includes(s)) ?? "core_group";
export const reorderPipeline = recordWrite({
	operation: "people.reorderPipeline",
	description:
		"Propose moving one person within their own pipeline column: afterId null puts them at the top, or afterId places them just after that person in the same column. Their stage stays, and nobody else is changed. To move someone to another column use people.changeStatus. Nothing changes until the user approves the exact review.",
	input: reorderInput,
	async prepare(db, actor, input) {
		const found = await db.execute(sql`SELECT p.stage FROM person p
			WHERE ${mine(actor)} AND p.id=${input.personId}::uuid AND p.state='live'`);
		if (!found.rows[0]) return null;
		const column = columnOf(stage.parse(found.rows[0].stage));
		const r = await db.execute(sql`SELECT p.display_name AS name,
				coalesce((SELECT c.revision::text FROM people_column c WHERE c.plant_id=p.plant_id AND c.column_name=${column}),'1') AS revision,
				(SELECT jsonb_agg(jsonb_build_object('id',o.id,'name',o.display_name) ORDER BY o.pipeline_position,o.created_at,o.id)
					FROM person o WHERE o.plant_id=p.plant_id AND o.state='live' AND o.stage=ANY(${sql.param(columnStages(column))}::text[])) AS cards
			FROM person p WHERE ${mine(actor)} AND p.id=${input.personId}::uuid AND p.state='live'
				AND p.stage=ANY(${sql.param(columnStages(column))}::text[])`);
		if (!r.rows[0]) return null;
		const { name, revision, cards } = columnRow.parse(r.rows[0]);
		const at = cards.findIndex((x) => x.id === input.personId);
		const others = cards.filter((x) => x.id !== input.personId);
		const anchor = input.afterId === null ? -1 : others.findIndex((x) => x.id === input.afterId);
		const misplaced = input.afterId !== null && anchor < 0;
		const place = (n: number) => `${n + 1} of ${cards.length}`;
		return {
			target: { kind: "person", id: input.personId, label: name },
			changes: [{ field: "columnPlace", before: place(at), after: misplaced ? null : place(anchor + 1) }],
			notes: [
				`${anchor < 0 ? "First" : `Just after ${others[anchor]?.name}`} in the ${STAGE_LABEL[column]} column, for everyone in this church.`,
				"Their stage stays, and nobody else is changed.",
			],
			refusal: misplaced
				? `Name someone else in the ${STAGE_LABEL[column]} column to place ${name} after.`
				: at === anchor + 1
					? `${name} is already ${anchor < 0 ? "first" : "there"} in the ${STAGE_LABEL[column]} column.`
					: null,
			expectedRevision: revision,
			request: { column, personId: input.personId, afterId: input.afterId },
		};
	},
	run: (tx, context, request) => peopleWriter.reorderPipeline(tx, context, reorderPipelineRequest.parse(request)),
});

export const PEOPLE_RECORD_COMMANDS = {
	"people.restorePerson": restorePerson,
	"people.recordAdultClassification": recordAdultClassification,
	"people.correctAdultClassification": correctAdultClassification,
	"people.reorderPipeline": reorderPipeline,
} as const;
