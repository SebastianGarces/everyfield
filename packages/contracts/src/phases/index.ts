import { z } from "zod";
import { accountId, defineSafeError, recordId, requestKey, revision, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";

export const phaseNumber = z.int().min(0).max(6);
export type PhaseNumber = z.infer<typeof phaseNumber>;
export const TERMINAL_PHASE = 6;

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

export const DECLARATION_REASON = "Declared at setup — where this plant already was when it joined EveryField.";
export const REASON_MAX = 2000;

export const reasonProblem = z.enum(["empty", "too_long", "reserved"]);
export type ReasonProblem = z.infer<typeof reasonProblem>;
export function checkReason(raw: string): { ok: true; reason: string } | { ok: false; problem: ReasonProblem } {
	const reason = raw.trim();
	if (!reason) return { ok: false, problem: "empty" };
	if (reason.length > REASON_MAX) return { ok: false, problem: "too_long" };
	if (reason === DECLARATION_REASON) return { ok: false, problem: "reserved" };
	return { ok: true, reason };
}

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
	input: z.strictObject({ toPhase: phaseNumber, reason: z.string() }),
});

const actor = z.strictObject({ accountId, displayName: z.string() }).nullable();
export const phaseEntry = z.discriminatedUnion("kind", [
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
export type PhaseEntry = z.infer<typeof phaseEntry>;
export const journeyEntry = z.discriminatedUnion("kind", [
	...phaseEntry.options,
	z.strictObject({
		kind: z.literal("launch_sunday"),
		id: recordId,
		actualDate: localDate,
		actor,
		occurredAt: instant,
	}),
	z.strictObject({
		kind: z.literal("gathering"),
		id: recordId,
		name: z.string(),
		reachedOn: localDate,
		actor,
		occurredAt: instant,
	}),
]);
export type JourneyEntry = z.infer<typeof journeyEntry>;

export const journeyState = z.strictObject({
	phase: phaseNumber,
	revision,
	declarable: z.boolean(),
});
export type JourneyState = z.infer<typeof journeyState>;
export const historyResult = z.strictObject({
	state: journeyState,
	plantName: z.string(),
	timeZone: z.string(),
	entries: z.array(journeyEntry),
});
export type HistoryResult = z.infer<typeof historyResult>;

export const declareResult = z.strictObject({ state: journeyState, entry: phaseEntry });
export type DeclareResult = z.infer<typeof declareResult>;
export const transitionResult = z.discriminatedUnion("outcome", [
	z.strictObject({ outcome: z.literal("moved"), receiptId: recordId, state: journeyState, entry: phaseEntry }),
	z.strictObject({ outcome: z.literal("noop"), receiptId: recordId, state: journeyState }),
]);
export type TransitionResult = z.infer<typeof transitionResult>;

export const catalogCriterion = z.strictObject({
	key: criterionKey,
	label: z.string(),
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
export const readiness = z.strictObject({
	phase: phaseNumber,
	verdict: z.enum(["ready", "approaching", "not_ready", "unknown", "terminal"]),
	ready: z.boolean(),
	humanTransitionAllowed: z.literal(true),
	measured: z.boolean(),
	criteria: z.array(z.strictObject({ key: criterionKey, label: z.string(), status: criterionStatus })),
});
export type Readiness = z.infer<typeof readiness>;

export const phasesError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("invalid_reason", { problem: reasonProblem }, "never"),
	defineSafeError("access_denied", {}, "never"),
	defineSafeError("idempotency_conflict", {}, "never"),
	defineSafeError("already_declared", {}, "refresh"),
	defineSafeError("revision_conflict", { state: journeyState }, "refresh"),
]);
export type PhasesError = z.infer<typeof phasesError>;
export type PhasesReply<T> = Reply<T, PhasesError>;
