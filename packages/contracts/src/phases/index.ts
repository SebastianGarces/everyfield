import { z } from "zod";
import { accountId, correlationId, recordId, requestKey, revision } from "../common/values.ts";
import { instant } from "../common/time.ts";

// The phases contract (WP-038, PHASE-001 to PHASE-008). A phase is an integer 0 to 6 and nothing else: z.int refuses
// -1, 7, 1.5, "2" and null alike (PHASE-CASE-009). Requests are strict, so a caller can never name a kind.

export const phaseNumber = z.int().min(0).max(6);
export type PhaseNumber = z.infer<typeof phaseNumber>;
export const TERMINAL_PHASE = 6;

/** The 19 stable exit-criterion keys of docs/reference/phase-exit-criteria.ts, in reference order. */
export const CRITERION_KEYS = [
	"values_documented",
	"foundations_complete",
	"coach_assigned",
	"committed_adults",
	"growth_trajectory",
	"financial_base",
	"worship_leader",
	"geographic_area",
	"all_team_leaders",
	"launch_date_set",
	"training_complete",
	"systems_tested",
	"launch_window",
	"readiness_milestones",
	"prelaunch_services",
	"promotion_executed",
	"first_service_complete",
	"guest_data_entered",
	"debrief_done",
] as const;
export const criterionKey = z.enum(CRITERION_KEYS);
export type CriterionKey = z.infer<typeof criterionKey>;

/** The reserved reason of an initial declaration. The server stores it; no caller sends it (PHASE-001). */
export const DECLARATION_REASON = "Declared at setup — where this plant already was when it joined EveryField.";
export const REASON_MAX = 2000;

/** Why a reason was refused, so the dialog can say it next to the field. */
export const reasonProblem = z.enum(["empty", "too_long", "reserved"]);
export type ReasonProblem = z.infer<typeof reasonProblem>;
/** The trimmed reason, or the problem with it. */
export function checkReason(raw: string): { ok: true; reason: string } | { ok: false; problem: ReasonProblem } {
	const reason = raw.trim();
	if (!reason) return { ok: false, problem: "empty" };
	if (reason.length > REASON_MAX) return { ok: false, problem: "too_long" };
	if (reason === DECLARATION_REASON) return { ok: false, problem: "reserved" };
	return { ok: true, reason };
}

/** forward: the next phase; skip_forward: more than one phase on; backward: any earlier phase; same: no change. */
export const direction = z.enum(["forward", "skip_forward", "backward"]);
export type Direction = z.infer<typeof direction>;
export function classifyChange(from: PhaseNumber, to: PhaseNumber): Direction | "same" {
	if (to === from) return "same";
	if (to < from) return "backward";
	return to === from + 1 ? "forward" : "skip_forward";
}

export const declareRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	input: z.strictObject({ phase: phaseNumber }),
});
export const transitionRequest = z.strictObject({
	requestKey,
	expectedRevision: revision,
	// The reason's own rules (checkReason) run after this shape check, so each problem has its own message.
	input: z.strictObject({ toPhase: phaseNumber, reason: z.string() }),
});
export type DeclareRequest = z.input<typeof declareRequest>;
export type TransitionRequest = z.input<typeof transitionRequest>;

const actor = z.strictObject({ accountId, displayName: z.string() }).nullable();
/** One journey entry. Creation and declaration carry no direction; a move always does. Noop receipts are not entries. */
export const journeyEntry = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("creation"),
		id: recordId,
		fromPhase: z.null(),
		toPhase: z.literal(1),
		actor,
		occurredAt: instant,
	}),
	z.strictObject({
		kind: z.literal("initial_declaration"),
		id: recordId,
		fromPhase: phaseNumber,
		toPhase: phaseNumber,
		actor,
		occurredAt: instant,
	}),
	z.strictObject({
		kind: z.literal("movement"),
		id: recordId,
		fromPhase: phaseNumber,
		toPhase: phaseNumber,
		direction,
		reason: z.string().min(1).max(REASON_MAX),
		actor,
		occurredAt: instant,
	}),
]);
export type JourneyEntry = z.infer<typeof journeyEntry>;

/** The church's place on the journey: the current phase, the revision a change must name, and the declaration offer. */
export const journeyState = z.strictObject({
	phase: phaseNumber,
	revision,
	/** True while the declaration slot is unused and the church has no ordinary move. */
	declarable: z.boolean(),
});
export type JourneyState = z.infer<typeof journeyState>;
export const historyResult = z.strictObject({
	state: journeyState,
	plantName: z.string(),
	/** Creation, declaration and moves in the order they happened. */
	entries: z.array(journeyEntry),
});
export type HistoryResult = z.infer<typeof historyResult>;

export const declareResult = z.strictObject({ state: journeyState, entry: journeyEntry });
export type DeclareResult = z.infer<typeof declareResult>;
/** A move returns its entry; the same phase returns a noop receipt with no entry and an unchanged state. */
export const transitionResult = z.discriminatedUnion("outcome", [
	z.strictObject({ outcome: z.literal("moved"), receiptId: recordId, state: journeyState, entry: journeyEntry }),
	z.strictObject({ outcome: z.literal("noop"), receiptId: recordId, state: journeyState }),
]);
export type TransitionResult = z.infer<typeof transitionResult>;

export const catalogCriterion = z.strictObject({
	key: criterionKey,
	label: z.string(),
	/** The software checklist row (the methodology's `playbook_checklist`), not a Playbook gate a person attests. */
	softwareOnly: z.boolean(),
});
export const catalogPhase = z.strictObject({
	phase: phaseNumber,
	name: z.string(),
	terminal: z.boolean(),
	criteria: z.array(catalogCriterion),
});
export const catalog = z.strictObject({ phases: z.array(catalogPhase).length(7) });
export type Catalog = z.infer<typeof catalog>;
export type CatalogPhase = z.infer<typeof catalogPhase>;

export const criterionStatus = z.enum(["met", "not_met", "unknown", "not_tracked"]);
export type CriterionStatus = z.infer<typeof criterionStatus>;
/** Advisory only: it never blocks, advances or regresses a phase (PHASE-004). */
export const readiness = z.strictObject({
	phase: phaseNumber,
	verdict: z.enum(["ready", "approaching", "not_ready", "unknown", "terminal"]),
	ready: z.boolean(),
	humanTransitionAllowed: z.literal(true),
	/** False while no criterion has a measured source (until WP-040). */
	measured: z.boolean(),
	criteria: z.array(z.strictObject({ key: criterionKey, label: z.string(), status: criterionStatus })),
});
export type Readiness = z.infer<typeof readiness>;

const error = <C extends string, D extends z.ZodRawShape>(code: C, details: D, retry: "never" | "refresh") =>
	z.strictObject({ code: z.literal(code), details: z.strictObject(details), correlationId, retry: z.literal(retry) });
/** Every refusal a phase operation returns. */
export const phasesError = z.discriminatedUnion("code", [
	error("invalid_input", {}, "never"),
	error("invalid_reason", { problem: reasonProblem }, "never"),
	error("access_denied", {}, "never"),
	error("unavailable", {}, "never"),
	error("idempotency_conflict", {}, "never"),
	error("already_declared", {}, "refresh"),
	error("revision_conflict", { state: journeyState }, "refresh"),
]);
export type PhasesError = z.infer<typeof phasesError>;
export type PhasesReply<T> = { status: "ok"; value: T } | { status: "refused"; error: PhasesError };
