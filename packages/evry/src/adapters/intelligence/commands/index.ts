import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import * as s from "@everyfield/contracts/intelligence";
import { localDate } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/phases";
import { createSignals } from "@everyfield/domain/intelligence";
import { createPhaseWriter, readCatalog, readReadiness } from "@everyfield/domain/phases";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { ownerOrAdmin, STATUS_WORDS } from "../reads/index.ts";

// The phase and manual-signal reviewed writes (WP-074 over WP-038 and WP-039). Each review is one SELECT under the
// proposal's statement: it reads the church's phase or the signal's current answer live and saves the native command's
// exact arguments, including the revision the review showed. On approval the executor runs the owning native command
// once, for the approving session, with the effect key as its request key; anything that changed since the review
// refuses instead of being overwritten. Evry never moves a phase or records a signal by itself.

/** The church the change is about: every phase and signal review targets the selected plant, as `p`. */
const plant = sql`jsonb_build_object('kind','plant','id',p.id,'label',p.name)`;
const inPlant = (actor: EvryActor) => sql`FROM plant p WHERE p.id=${actor.owner.id}::uuid`;
const change = (field: string, before: SQL, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${after})`;
const json = (value: unknown) => sql`${JSON.stringify(value ?? null)}::jsonb`;
/** A plain reason the review cannot be approved as asked, merged into the review when `when` holds; a later one wins. */
const refusal = (when: SQL, text: string) =>
	sql`CASE WHEN ${when} THEN jsonb_build_object('refusal',${text}::text) ELSE '{}'::jsonb END`;
/** The church's own calendar day now. */
const today = sql`(clock_timestamp() AT TIME ZONE p.timezone)::date`;

type Reply<T> = { status: "ok"; value: T } | { status: "refused"; error: { code: string } };
const refused = (reply: { status: "refused"; error: { code: string } }): EffectResult => ({ refused: reply.error.code });

// --- phases ---------------------------------------------------------------------------------------------------

/** The phases' names, indexed by phase number, for a review statement. */
const phaseNames = async () => (await readCatalog()).phases.map((p) => p.name);

const declareInput = z.strictObject({ phase: c.phaseNumber });
export const declarePhase: ReviewedWrite<z.infer<typeof declareInput>> = {
	operation: "phases.declare",
	description:
		"Propose recording, once, the phase this church was already in when it joined Everyfield. Only when its phase history says it is declarable; otherwise propose a phase move. Nothing changes until the user approves the exact review.",
	input: declareInput,
	allowed: ownerOrAdmin,
	async review(actor, value) {
		const names = await phaseNames();
		// Offered only while the declaration slot is unused and the church has never moved: no row otherwise.
		return sql`SELECT jsonb_build_object('target',${plant},'changes',jsonb_build_array(
				${change("phase", sql`${json(names)}->p.phase`, json(names[value.phase]))})) AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('phase',${value.phase}::int)) AS args
			${inPlant(actor)} AND NOT EXISTS(SELECT FROM phase_transition x WHERE x.plant_id=p.id AND x.kind IN ('initial_declaration','movement'))`;
	},
	async execute(tx, _context, args, effectKey, run): Promise<EffectResult> {
		const writer = createPhaseWriter({ notices: run.phaseNotices });
		const reply = await writer.declare(tx as unknown as Database, run.authority, {
			...z.object({}).loose().parse(args),
			requestKey: effectKey,
		});
		if (reply.status !== "ok") return refused(reply);
		return { receiptId: reply.value.entry.id, revision: reply.value.state.revision };
	},
};

const reason = z
	.string()
	.refine((text) => c.checkReason(text).ok, "a reason of 1 to 2,000 characters")
	.describe("Why the church is moving, in the user's words");
const transitionInput = z.strictObject({ toPhase: c.phaseNumber, reason });
export const transitionPhase: ReviewedWrite<z.infer<typeof transitionInput>> = {
	operation: "phases.transition",
	description:
		"Propose moving this church to another phase (forward, skipping ahead or backward), with the reason. The review shows the move's direction and the exit criteria of the current phase not met or with no data yet. Nothing changes until the user approves the exact review.",
	input: transitionInput,
	allowed: ownerOrAdmin,
	async review(actor, value) {
		const catalog = await readCatalog();
		const names = catalog.phases.map((p) => p.name);
		// The exit criteria of each phase that are not met, with their status in words, indexed by phase number.
		const open = readReadiness(catalog).map((r) =>
			r.criteria.filter((x) => x.status !== "met").map((x) => ({ label: x.label, status: STATUS_WORDS[x.status] })),
		);
		const to = sql`${value.toPhase}::int`;
		const direction = sql`CASE WHEN ${to}<p.phase THEN 'backward' WHEN ${to}=p.phase+1 THEN 'forward' WHEN ${to}>p.phase THEN 'skip_forward' END`;
		return sql`SELECT jsonb_build_object('target',${plant},'changes',jsonb_build_array(
				${change("phase", sql`${json(names)}->p.phase`, json(names[value.toPhase]))},
				${change("direction", sql`NULL`, sql`to_jsonb(${direction})`)},
				${change("reason", sql`NULL`, json(value.reason.trim()))})
				||CASE WHEN ${to}>p.phase THEN jsonb_build_array(${change("openCriteria", sql`NULL`, sql`${json(open)}->p.phase`)}) ELSE '[]'::jsonb END)
				||${refusal(sql`${to}=p.phase`, `The church is already in ${names[value.toPhase]}.`)} AS review,
			jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('toPhase',${to},'reason',${value.reason.trim()}::text)) AS args
			${inPlant(actor)}`;
	},
	async execute(tx, _context, args, effectKey, run): Promise<EffectResult> {
		const writer = createPhaseWriter({ notices: run.phaseNotices });
		const reply = await writer.transition(tx as unknown as Database, run.authority, {
			...z.object({}).loose().parse(args),
			requestKey: effectKey,
		});
		if (reply.status !== "ok") return refused(reply);
		return { receiptId: reply.value.receiptId, revision: reply.value.state.revision };
	},
};

// --- manual signals ---------------------------------------------------------------------------------------------

const signals = createSignals();
const label = (key: s.SignalKey) => s.SIGNAL_DEFINITIONS.find((d) => d.key === key)!.label;
/** The signal's current row in the church, as `a` (absent while it was never answered). */
const current = (key: s.SignalKey) =>
	sql`LEFT JOIN attestation a ON a.plant_id=p.id AND a.key=${key} AND a.person_id IS NULL`;
/** The current answer as the signal states it: yes, not_yet, or null while retracted or never answered. */
const answer = sql`to_jsonb(CASE WHEN a.state='answered' THEN CASE WHEN a.answer THEN 'yes' ELSE 'not_yet' END END)`;
const words = z
	.string()
	.trim()
	.min(1)
	.max(s.TEXT_MAX)
	.describe("What the user said about it, in their own words, quoted exactly");
const asOf = localDate.describe("The day it is true as of, YYYY-MM-DD in the church's time zone, no later than today");
const reference = z.string().trim().min(1).max(s.TEXT_MAX).optional().describe("Where it is written down, if the user said");
const afterToday = (date: string) => sql`${date}::date>${today}`;
const FUTURE = "A signal can't be true as of a date after today.";

/** The receipt of a signal write: its revision row, keyed by the effect key. */
async function signalReceipt(
	tx: Parameters<ReviewedWrite<unknown>["execute"]>[0],
	plantId: string,
	effectKey: string,
	reply: Reply<s.SignalWriteResult>,
): Promise<EffectResult> {
	if (reply.status !== "ok") return refused(reply);
	const r = await tx.execute(
		sql`SELECT id FROM attestation_revision WHERE plant_id=${plantId}::uuid AND request_key=${effectKey}`,
	);
	return { receiptId: z.object({ id: z.uuid() }).parse(r.rows[0]).id, revision: reply.value.signal.revision };
}

const attestInput = z.strictObject({ key: s.signalKey, value: s.signalValue, asOf, detail: words, reference });
export const attestSignal: ReviewedWrite<z.infer<typeof attestInput>> = {
	operation: "signals.attest",
	description:
		"Propose recording one manual signal the user reported in this conversation, answered yes or not yet, dated and in the user's own words. Never for a signal nobody reported. Nothing changes until the user approves the exact review.",
	input: attestInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${plant},'changes',jsonb_build_array(
				${change("signal", sql`NULL`, json(label(value.key)))},
				${change("value", answer, json(value.value))},
				${change("asOf", sql`NULL`, json(value.asOf))},
				${change("detail", sql`NULL`, json(value.detail))})
				||${value.reference ? sql`jsonb_build_array(${change("reference", sql`NULL`, json(value.reference))})` : sql`'[]'::jsonb`})
				||${refusal(sql`a.state='answered'`, "This signal already has an answer. Ask Evry to correct or reaffirm it instead.")}
				||${refusal(afterToday(value.asOf), FUTURE)} AS review,
			jsonb_build_object('expectedRevision',coalesce(a.revision,0)::text,'input',${json(value)}) AS args
			FROM plant p ${current(value.key)} WHERE p.id=${actor.owner.id}::uuid`;
	},
	async execute(tx, context, args, effectKey, run) {
		const reply = await signals.attest(tx, run.authority, { ...z.object({}).loose().parse(args), requestKey: effectKey });
		return signalReceipt(tx, context.selected.id, effectKey, reply);
	},
};

const correctInput = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("correct"), key: s.signalKey, value: s.signalValue, asOf, detail: words, reference }),
	z.strictObject({ action: z.literal("retract"), key: s.signalKey }),
]);
export const correctSignal: ReviewedWrite<z.infer<typeof correctInput>> = {
	operation: "signals.correct",
	description:
		"Propose correcting a signal's current answer to the other value, dated and in the user's own words, or retracting it. Nothing changes until the user approves the exact review.",
	input: correctInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		const retract = value.action === "retract";
		const after = retract
			? [change("value", answer, json("retracted"))]
			: [
					change("value", answer, json(value.value)),
					change("asOf", sql`to_jsonb(a.as_of::text)`, json(value.asOf)),
					change("detail", sql`to_jsonb(a.statement)`, json(value.detail)),
					...(value.reference ? [change("reference", sql`to_jsonb(a.source_description)`, json(value.reference))] : []),
				];
		const same = retract ? sql`false` : sql`a.answer=${value.value === "yes"}`;
		return sql`SELECT jsonb_build_object('target',${plant},'changes',jsonb_build_array(
				${change("signal", sql`NULL`, json(label(value.key)))},${sql.join(after, sql`,`)}))
				||${refusal(sql`a.state IS DISTINCT FROM 'answered'`, "This signal has no current answer to correct. Ask Evry to record it instead.")}
				||${refusal(sql`a.state='answered' AND ${same}`, "The signal already has that answer, so there is nothing to correct.")}
				||${retract ? sql`'{}'::jsonb` : refusal(afterToday(value.asOf), FUTURE)} AS review,
			jsonb_build_object('expectedRevision',coalesce(a.revision,0)::text,'input',${json(value)}) AS args
			FROM plant p ${current(value.key)} WHERE p.id=${actor.owner.id}::uuid`;
	},
	async execute(tx, context, args, effectKey, run) {
		const reply = await signals.correct(tx, run.authority, { ...z.object({}).loose().parse(args), requestKey: effectKey });
		return signalReceipt(tx, context.selected.id, effectKey, reply);
	},
};

const reaffirmInput = z.strictObject({ key: s.signalKey });
export const reaffirmSignal: ReviewedWrite<z.infer<typeof reaffirmInput>> = {
	operation: "signals.reaffirm",
	description:
		"Propose confirming that one of the signals renewed every 30 days is still true, which dates its current answer today. Nothing changes until the user approves the exact review.",
	input: reaffirmInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		const renews = s.SIGNAL_DEFINITIONS.find((d) => d.key === value.key)!.reaffirms;
		// The native command dates the answer on the day it runs, so the review says "today", never a fixed date.
		return sql`SELECT jsonb_build_object('target',${plant},'changes',jsonb_build_array(
				${change("signal", sql`NULL`, json(label(value.key)))},
				${change("value", answer, answer)},
				${change("asOf", sql`to_jsonb(a.as_of::text)`, json("today"))}))
				||${refusal(sql`a.state IS DISTINCT FROM 'answered'`, "This signal has no current answer to reaffirm. Ask Evry to record it instead.")}
				||${refusal(sql.raw(String(!renews)), "This signal doesn't need renewing, so it can't be reaffirmed.")} AS review,
			jsonb_build_object('expectedRevision',coalesce(a.revision,0)::text,'input',jsonb_build_object('key',${value.key}::text,
				'expectedValue',CASE WHEN a.answer THEN 'yes' ELSE 'not_yet' END)) AS args
			FROM plant p ${current(value.key)} WHERE p.id=${actor.owner.id}::uuid`;
	},
	async execute(tx, context, args, effectKey, run) {
		const reply = await signals.reaffirm(tx, run.authority, { ...z.object({}).loose().parse(args), requestKey: effectKey });
		return signalReceipt(tx, context.selected.id, effectKey, reply);
	},
};

/** The installed phase and signal reviewed writes, keyed by operation. */
export const INTELLIGENCE_COMMANDS = {
	"phases.declare": declarePhase,
	"phases.transition": transitionPhase,
	"signals.attest": attestSignal,
	"signals.correct": correctSignal,
	"signals.reaffirm": reaffirmSignal,
} as const;
