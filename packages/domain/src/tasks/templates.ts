import {
	addCivilDays,
	calendarContext,
	frozenClock,
	instant,
	timeZone,
	type LocalDate,
	type TimeZone,
} from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/tasks";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import { recommendForPhase } from "../wiki/reads.ts";
import { CATALOG, type Catalog, type Checklist } from "./catalog.ts";
import {
	administers,
	command,
	deny,
	parse,
	readerOf,
	readReply,
	reply,
	type Command,
	type Reader,
	type TaskContext,
	type Tx,
} from "./core.ts";
import { itemOf, type TaskRow } from "./queries.ts";
import {
	assigneeFacts,
	auditCreated,
	checkAssignees,
	dueColumns,
	insertTasks,
	newTask,
	reminderChange,
	syncAll,
	type TaskReminders,
} from "./writes.ts";

// Phase checklists (REQ-TSK-009, REQ-TSK-010, REQ-PHASE-006). Browse and preview read the fixed catalog; an import or an
// accepted phase offer copies a checklist into ordinary top-level tasks assigned to the person who chose it. The tasks
// keep no link to the catalog, so a later catalog version never touches them. Only a person's choice creates tasks: a
// phase move, a read or a preview creates none. Owner and Admin only.
//
// An offer belongs to the plant's latest `movement` transition while that transition has no answer. Its answer is
// stored on the transition (offer_answer, answered_at) and in one audit record naming the accepted and declined
// checklists and the tasks created. Later offers leave out every checklist an earlier answer accepted or declined.

const now = () => instant.parse(new Date().toISOString());
const localDateAt = (at: string, zone: TimeZone) => calendarContext(zone, frozenClock(instant.parse(at))).localDate;
const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** Every checklist key an earlier offer of the plant accepted or declined, from the answers' audit records. */
const answeredKeys = (plant: SQL) =>
	sql`(SELECT coalesce(jsonb_agg(DISTINCT k),'[]') FROM audit_event a
	CROSS JOIN LATERAL jsonb_array_elements_text((a.after_value->'accepted') || (a.after_value->'declined')) k
	WHERE a.tenant_id=${plant} AND a.subject_type='phase_transition' AND a.kind='offer_answer')`;
/** The plant's latest phase move, the only transition that can carry an open offer. `t` names a phase_transition row. */
const isLatest = (t: SQL) =>
	sql`${t}.id=(SELECT l.id FROM phase_transition l WHERE l.plant_id=${t}.plant_id AND l.kind='movement'
	ORDER BY l.occurred_at DESC, l.id DESC LIMIT 1)`;
const transitionJson = (t: SQL) =>
	sql`jsonb_build_object('id',${t}.id,'fromPhase',${t}.from_phase,'toPhase',${t}.to_phase,'occurredAt',${iso(sql`${t}.occurred_at`)},
	'answer',${t}.offer_answer,'answeredAt',${iso(sql`${t}.answered_at`)},'latest',${isLatest(t)})`;
const transitionRow = z.object({
	id: z.uuid(),
	fromPhase: c.checklistSummary.shape.phase,
	toPhase: c.checklistSummary.shape.phase,
	occurredAt: instant,
	answer: z.enum(["accepted", "declined"]).nullable(),
	answeredAt: instant.nullable(),
	latest: z.boolean(),
});
type TransitionRow = z.infer<typeof transitionRow>;
const offerTransition = (t: TransitionRow, zone: TimeZone) =>
	c.offerTransition.parse({
		id: t.id,
		fromPhase: t.fromPhase,
		toPhase: t.toPhase,
		occurredAt: t.occurredAt,
		anchorDate: localDateAt(t.occurredAt, zone),
	});
/** What an answer's audit record says it decided. `taskIds` keeps the order the tasks were created in. */
const answerRecord = z.object({
	answer: z.enum(["accepted", "declined"]),
	accepted: z.array(c.templateKey),
	declined: z.array(c.templateKey),
	taskIds: z.array(z.uuid()),
});

const summary = (k: Checklist) =>
	c.checklistSummary.parse({
		key: k.key,
		name: k.name,
		description: k.description,
		phase: k.phase,
		category: k.category,
		taskCount: k.items.length,
	});
/** A checklist's items as the tasks they would create, due `offsetDays` after `anchor`. */
const preview = (k: Checklist, anchor: LocalDate, items = k.items) =>
	c.checklistPreview.parse({
		...summary(k),
		tasks: items.map((i) => ({
			key: i.key,
			title: i.title,
			description: c.normalizeDescription(i.description ?? ""),
			priority: i.priority,
			due: addCivilDays(anchor, i.offsetDays),
		})),
	});

/**
 * The reader's live Owner or Admin access (C13), the plant's zone and phase and, for an offer read, the latest move,
 * the checklists earlier answers settled and a named transition with its answer record and created task titles. One
 * statement, whatever the catalog or the plant holds.
 */
async function plantFacts(tx: Pick<Database, "execute">, viewer: Reader, offer?: { named: string | null }) {
	const live = liveRead({ session: viewer.session, owner: viewer.owner, seatId: viewer.seatId }, true);
	const named = offer?.named ?? null;
	const r = await tx.execute(sql`SELECT g.live, pl.timezone, pl.phase${
		offer
			? sql`,
	(SELECT ${transitionJson(sql`t`)} FROM phase_transition t WHERE t.plant_id=pl.id AND t.kind='movement'
		ORDER BY t.occurred_at DESC, t.id DESC LIMIT 1) AS latest,
	${answeredKeys(sql`pl.id`)} AS answered,
	(SELECT jsonb_build_object('transition',${transitionJson(sql`t`)},'record',a.after_value,
		'tasks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'title',k.title) ORDER BY x.n),'[]')
			FROM jsonb_array_elements_text(a.after_value->'taskIds') WITH ORDINALITY x(id,n)
			JOIN task k ON k.id=x.id::uuid AND k.plant_id=pl.id))
		FROM phase_transition t LEFT JOIN audit_event a ON a.tenant_id=pl.id AND a.subject_type='phase_transition'
			AND a.subject_id=t.id AND a.kind='offer_answer'
		WHERE ${named}::uuid IS NOT NULL AND t.id=${named}::uuid AND t.plant_id=pl.id AND t.kind='movement') AS named`
			: sql``
	}
	FROM (SELECT ${live} AS live) g LEFT JOIN plant pl ON g.live AND pl.id=${viewer.plantId}::uuid`);
	const row = z
		.object({
			live: z.boolean(),
			timezone: timeZone.nullable(),
			phase: c.checklistSummary.shape.phase.nullable(),
			latest: transitionRow.nullish(),
			answered: z.array(c.templateKey).optional(),
			named: z
				.object({
					transition: transitionRow,
					record: answerRecord.nullable(),
					tasks: z.array(z.object({ id: z.uuid(), title: z.string() })),
				})
				.nullish(),
		})
		.parse(r.rows[0]);
	if (!row.live || row.timezone === null || row.phase === null) deny();
	return { ...row, zone: row.timezone, phase: row.phase };
}
function adminReader(authority: RequestActor) {
	const viewer = readerOf(authority);
	if (!administers(viewer)) deny();
	return viewer;
}

/** The checklists, browse and preview reads. `catalog` is the fixed Everyfield catalog; tests pass another version. */
export function createTemplateReader(catalog: Catalog = CATALOG) {
	return {
		/** tasks.listTemplates: every checklist of the catalog, whatever earlier offers answered, and the plant's phase. */
		async listTemplates(tx: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return readReply(async () => {
				const viewer = adminReader(authority);
				parse(c.listTemplatesRequest, raw);
				const plant = await plantFacts(tx, viewer);
				return c.templateCatalog.parse({
					catalogVersion: catalog.version,
					currentPhase: plant.phase,
					checklists: catalog.checklists.map(summary),
				});
			});
		},
		/** tasks.previewTemplate: one checklist's tasks with due dates from the plant-local date today. Writes nothing. */
		async previewTemplate(tx: Pick<Database, "execute">, authority: RequestActor, raw: unknown) {
			return readReply(async () => {
				const viewer = adminReader(authority);
				const input = parse(c.previewTemplateRequest, raw);
				const checklist = catalog.checklists.find((k) => k.key === input.checklistKey) ?? deny("invalid_input");
				const plant = await plantFacts(tx, viewer);
				const anchor = localDateAt(now(), plant.zone);
				return c.templatePreview.parse({
					catalogVersion: catalog.version,
					anchorDate: anchor,
					checklist: preview(checklist, anchor),
				});
			});
		},
		/**
		 * tasks.readPhaseOffer (PHASE-CASE-006): the open offer of the latest unanswered move, or none. The offer lists the
		 * new phase's checklists that no earlier answer settled, previewed from the move's plant-local date, with the
		 * Wiki's recommendations for that phase. A named transition reads that move instead, with what its answer
		 * decided. Reading creates nothing. Two statements with an open offer (the facts and the Wiki read), else one.
		 */
		async readPhaseOffer(tx: Pick<Database, "execute">, authority: RequestActor, raw: unknown = {}) {
			return readReply(async () => {
				const viewer = adminReader(authority);
				const input = parse(c.readPhaseOfferRequest, raw);
				const plant = await plantFacts(tx, viewer, { named: input.transitionId ?? null });
				if (input.transitionId) {
					const named = plant.named;
					if (!named) return c.phaseOffer.parse({ status: "none" });
					if (named.record && named.transition.answeredAt)
						return c.phaseOffer.parse({
							status: "answered",
							transition: offerTransition(named.transition, plant.zone),
							answer: {
								answer: named.record.answer,
								answeredAt: named.transition.answeredAt,
								accepted: named.record.accepted,
								declined: named.record.declined,
								tasks: named.tasks,
							},
						});
				}
				const latest = plant.latest;
				if (!latest || latest.answer !== null || (input.transitionId && latest.id !== input.transitionId))
					return c.phaseOffer.parse({ status: "none" });
				const transition = offerTransition(latest, plant.zone);
				const settled = new Set(plant.answered ?? []);
				const checklists = catalog.checklists
					.filter((k) => k.phase === latest.toPhase && !settled.has(k.key))
					.map((k) => preview(k, transition.anchorDate));
				if (!checklists.length) return c.phaseOffer.parse({ status: "none" });
				const wiki = await recommendForPhase(tx as Database, authority, { phase: latest.toPhase });
				return c.phaseOffer.parse({
					status: "open",
					transition,
					catalogVersion: catalog.version,
					checklists,
					// The offer stands without its reading list when the Wiki read is refused.
					recommendations:
						wiki.status === "ok"
							? wiki.value.articles.slice(0, 50).map((a) => ({ slug: a.slug, title: a.title, excerpt: a.excerpt }))
							: [],
				});
			});
		},
	};
}
export type TemplateReader = ReturnType<typeof createTemplateReader>;

/** New top-level task rows for these items, assigned to the importer and due `offsetDays` after `anchor`. */
function taskRows(
	cmd: Command,
	checklist: Checklist,
	items: Checklist["items"],
	anchor: LocalDate,
	assignees: TaskRow["assignees"],
) {
	return items.map((i) =>
		newTask(cmd.actor.zone, {
			title: i.title,
			description: c.normalizeDescription(i.description ?? ""),
			category: checklist.category,
			priority: i.priority,
			status: "not_started",
			assignees,
			...dueColumns({ kind: "local_date", date: addCivilDays(anchor, i.offsetDays) }, cmd.actor.zone),
		}),
	);
}
/** The command's own audit row, first, so it carries the request key and stored answer. */
function commandRow(
	cmd: Command,
	entry: { kind: "create" | "offer_answer"; subjectType: string; subjectId: string; after: Record<string, unknown> },
) {
	cmd.events.unshift({
		id: cmd.id,
		tenant_id: cmd.actor.plantId,
		actor_id: cmd.actor.accountId,
		actor_token: hash([cmd.actor.plantId, cmd.actor.accountId]),
		action: "tasks.changed",
		kind: entry.kind,
		subject_type: entry.subjectType,
		subject_id: entry.subjectId,
		before_value: null,
		after_value: entry.after,
		metadata: { source: "person" },
	});
}

/** The locked move an answer is for: its answer so far, whether it is the latest move, and what earlier answers settled. */
async function lockOffer(tx: Tx, cmd: Command, transitionId: string, importer: boolean) {
	const r =
		await tx.execute(sql`SELECT ${transitionJson(sql`t`)} AS transition, ${answeredKeys(sql`t.plant_id`)} AS answered,
		${importer ? assigneeFacts(cmd.actor.plantId, [cmd.actor.accountId]) : sql`'[]'::jsonb`} AS importer
	FROM phase_transition t WHERE t.id=${transitionId}::uuid AND t.plant_id=${cmd.actor.plantId}::uuid AND t.kind='movement'
	FOR UPDATE OF t`);
	const row = r.rows[0]
		? z.object({ transition: transitionRow, answered: z.array(c.templateKey), importer: z.unknown() }).parse(r.rows[0])
		: null;
	// A creation entry, a declaration, a noop or another plant's move has no offer.
	if (!row) deny();
	// Another device or person answered first; the screen reads what they decided.
	if (row.transition.answer !== null) deny("offer_answered");
	// A later move replaced this offer.
	if (!row.transition.latest) deny("conflict");
	return row;
}

/** The checklist writes, on the task writer: import, accept and decline. */
export function templateWriter(reminders: TaskReminders, catalog: Catalog = CATALOG) {
	/** Accept or decline: the answer settles this move and every older unanswered one, with one audit record. */
	async function answer(
		tx: Tx,
		cmd: Command,
		input: { transitionId: string; checklistKeys: readonly string[] | null },
	) {
		if (!administers(cmd.actor)) deny();
		const offer = await lockOffer(tx, cmd, input.transitionId, input.checklistKeys !== null);
		const settled = new Set(offer.answered);
		const offered = catalog.checklists.filter((k) => k.phase === offer.transition.toPhase && !settled.has(k.key));
		const chosen = input.checklistKeys ?? [];
		if (chosen.some((key) => !offered.some((k) => k.key === key))) deny("invalid_input");
		const anchor = localDateAt(offer.transition.occurredAt, cmd.actor.zone);
		const assignees = input.checklistKeys ? checkAssignees(offer.importer, false) : [];
		const rows = offered
			.filter((k) => chosen.includes(k.key))
			.flatMap((k) => taskRows(cmd, k, k.items, anchor, assignees));
		const at = new Date();
		const decided = {
			answer: chosen.length ? ("accepted" as const) : ("declined" as const),
			accepted: offered.filter((k) => chosen.includes(k.key)).map((k) => k.key),
			declined: offered.filter((k) => !chosen.includes(k.key)).map((k) => k.key),
		};
		cmd.writes
			.push(sql`UPDATE phase_transition SET offer_answer=${decided.answer}, answered_at=${at.toISOString()}::timestamptz
			WHERE plant_id=${cmd.actor.plantId}::uuid AND kind='movement' AND offer_answer IS NULL
			AND (occurred_at,id)<=(SELECT occurred_at,id FROM phase_transition WHERE id=${input.transitionId}::uuid)`);
		if (rows.length) cmd.writes.push(...insertTasks(cmd.actor.plantId, cmd.actor.accountId, rows));
		commandRow(cmd, {
			kind: "offer_answer",
			subjectType: "phase_transition",
			subjectId: input.transitionId,
			after: { ...decided, catalogVersion: catalog.version, taskIds: rows.map((r) => r.id) },
		});
		auditCreated(cmd, rows);
		const asOf = now();
		return {
			value: c.offerAnswered.parse({
				receiptId: cmd.id,
				transitionId: input.transitionId,
				answer: {
					...decided,
					answeredAt: at.toISOString(),
					tasks: rows.map((r) => ({ id: r.id, title: r.title })),
				},
				created: rows.map((r) => itemOf(r, asOf)),
			}),
			after: syncAll(
				reminders,
				tx,
				rows.map((r) => reminderChange(cmd.actor.plantId, null, r)),
			),
		};
	}
	return {
		/**
		 * tasks.importTemplate (TARGET-TSK-009): the named items of one checklist as top-level tasks assigned to the
		 * importer, due from the plant-local date today. A retry with the same request key replays the stored answer;
		 * a new key adds another set. A stale version or an unknown key refuses the whole import.
		 */
		async importTemplate(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.importTemplateRequest, raw);
				return command(tx, context, "tasks.importTemplate", input, async (cmd) => {
					if (!administers(cmd.actor)) deny();
					const v = input.input;
					if (v.catalogVersion !== catalog.version) deny("stale_catalog");
					const checklist = catalog.checklists.find((k) => k.key === v.checklistKey) ?? deny("invalid_input");
					const items = v.itemKeys.map((key) => checklist.items.find((i) => i.key === key) ?? deny("invalid_input"));
					const facts = await tx.execute(
						sql`SELECT ${assigneeFacts(cmd.actor.plantId, [cmd.actor.accountId])} AS importer`,
					);
					const rows = taskRows(
						cmd,
						checklist,
						items,
						localDateAt(now(), cmd.actor.zone),
						checkAssignees(facts.rows[0]?.importer, false),
					);
					cmd.writes.push(...insertTasks(cmd.actor.plantId, cmd.actor.accountId, rows));
					commandRow(cmd, {
						kind: "create",
						subjectType: "checklist_import",
						subjectId: cmd.actor.plantId,
						after: { checklistKey: checklist.key, catalogVersion: catalog.version, taskIds: rows.map((r) => r.id) },
					});
					auditCreated(cmd, rows);
					const asOf = now();
					return {
						value: c.templateImport.parse({
							receiptId: cmd.id,
							checklistKey: checklist.key,
							catalogVersion: catalog.version,
							tasks: rows.map((r) => itemOf(r, asOf)),
						}),
						after: syncAll(
							reminders,
							tx,
							rows.map((r) => reminderChange(cmd.actor.plantId, null, r)),
						),
					};
				});
			});
		},
		/** tasks.acceptPhaseOffer (TARGET-TSK-010): the chosen offered checklists' tasks, dated from the move's local date. */
		async acceptPhaseOffer(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.acceptPhaseOfferRequest, raw);
				return command(tx, context, "tasks.acceptPhaseOffer", input, async (cmd) => {
					if (input.input.catalogVersion !== catalog.version) deny("stale_catalog");
					return answer(tx, cmd, input.input);
				});
			});
		},
		/** tasks.declinePhaseOffer: every offered checklist declined; no task. They never come back in a later offer. */
		async declinePhaseOffer(tx: Tx, context: TaskContext, raw: unknown) {
			return reply(tx, async () => {
				const input = parse(c.declinePhaseOfferRequest, raw);
				return command(tx, context, "tasks.declinePhaseOffer", input, async (cmd) =>
					answer(tx, cmd, { transitionId: input.input.transitionId, checklistKeys: null }),
				);
			});
		},
	};
}
