import { z } from "zod";
import { defineSafeError, recordId, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { criterionKey, criterionStatus } from "../phases/index.ts";
import { renewal, signalKey, signalValue } from "./signals.ts";

export const FACTS_FORMULA_VERSION = "plant-facts/2";
const formulaVersion = z.enum(["plant-facts/1", FACTS_FORMULA_VERSION]);
export const ADULT_TARGET = 30;
export const GROWTH_SLOWED_DAYS = 21;
export const GROWTH_STALLED_DAYS = 28;
export const WINDOW_DAYS = 28;
export const VISION_TARGET_DAYS = 14;
export const VISION_WATCH_DAYS = 21;
export const VISION_DIRECT_DAYS = 28;
export const COHESION_SHARE = 0.2;
export const COHESION_MIN = 3;

export const MINISTRY_RESPONSIBILITIES = [
	{ key: "worship", label: "Worship" },
	{ key: "children", label: "Children's" },
	{ key: "assimilation", label: "Assimilation" },
	{ key: "small_groups", label: "Small Groups" },
	{ key: "administration_finance", label: "Administration/Finance" },
	{ key: "facilities", label: "Facilities" },
	{ key: "promotion", label: "Promotion" },
	{ key: "technology", label: "Technology" },
] as const;
const ministryKey = z.enum(MINISTRY_RESPONSIBILITIES.map((r) => r.key) as [string, ...string[]]);

const personRef = z.strictObject({ id: recordId, name: z.string() });
export type PersonRef = z.infer<typeof personRef>;
const commitmentKind = z.enum(["core_group", "launch_team"]);
const measuredStatus = z.enum(["met", "not_met", "unknown"]);

const countedAdult = z.strictObject({
	person: personRef,
	kinds: z.array(commitmentKind).min(1),
	committedSince: localDate,
	adultFrom: z.enum(["birth_date", "recorded"]),
});

export const committedAdults = z.strictObject({
	status: measuredStatus,
	known: z.int().min(0),
	exact: z.int().min(0).nullable(),
	needsClassifying: z.array(personRef),
	evidence: z.array(countedAdult),
	children: z.int().min(0),
});
export type CommittedAdults = z.infer<typeof committedAdults>;

export const growth = z.strictObject({
	status: z.enum(["on_track", "slowed", "stalled", "unknown"]),
	reason: z.enum(["no_acquisition", "unclassified_newer"]).nullable(),
	lastAcquiredOn: localDate.nullable(),
	daysSince: z.int().min(0).nullable(),
	current: z.int().min(0),
	prior: z.int().min(0),
	currentWithdrawn: z.int().min(0),
	windowStart: localDate,
	priorStart: localDate,
});
export type Growth = z.infer<typeof growth>;

export const visionRhythm = z.strictObject({
	status: z.enum(["on_target", "over_target", "watch", "direct", "unknown"]),
	reason: z.enum(["no_attendance", "no_vision_meeting"]).nullable(),
	lastHeldOn: localDate.nullable(),
	daysSince: z.int().min(0).nullable(),
	lastAttendance: z.array(z.int().min(0)).max(2),
	nextScheduledOn: localDate.nullable(),
});
export type VisionRhythm = z.infer<typeof visionRhythm>;

export const cohesion = z.strictObject({
	status: z.enum(["steady", "flagged", "unknown"]),
	reason: z.enum(["no_attendance"]).nullable(),
	disengaged: z.array(personRef),
	committed: z.int().min(0),
});
export type Cohesion = z.infer<typeof cohesion>;

export const followUps = z.strictObject({
	status: z.enum(["measured", "unknown"]),
	onTime: z.int().min(0),
	measured: z.int().min(0),
	noLongerNeeded: z.int().min(0),
	pending: z.int().min(0),
	unmeasured: z.int().min(0),
	contacted: z.int().min(0),
	total: z.int().min(0),
});
export type FollowUps = z.infer<typeof followUps>;

export const coverage = z.strictObject({
	status: z.enum(["met", "not_met"]),
	filled: z.int().min(0).max(MINISTRY_RESPONSIBILITIES.length),
	slots: z.literal(MINISTRY_RESPONSIBILITIES.length),
	people: z.int().min(0),
	responsibilities: z.array(z.strictObject({ key: ministryKey, label: z.string(), people: z.array(personRef) })),
	prayerLeader: z.array(personRef),
});
export type Coverage = z.infer<typeof coverage>;

export const training = z.strictObject({
	status: measuredStatus,
	complete: z.int().min(0),
	total: z.int().min(0),
	programs: z.array(
		z.strictObject({ id: recordId, name: z.string(), complete: z.int().min(0), total: z.int().min(0) }),
	),
});
export type Training = z.infer<typeof training>;

const attestationFact = z.strictObject({
	key: signalKey,
	state: z.enum(["answered", "retracted", "unanswered"]),
	value: signalValue.nullable(),
	asOf: localDate.nullable(),
	ageDays: z.int().min(0).nullable(),
	renewal,
});

export const firstService = z.discriminatedUnion("path", [
	z.strictObject({
		path: z.literal("milestone"),
		status: z.enum(["met", "unknown"]),
		milestone: z.string().nullable(),
		heldOn: localDate.nullable(),
	}),
	z.strictObject({
		path: z.literal("launch_sunday"),
		status: z.enum(["met", "unknown"]),
		heldOn: localDate.nullable(),
	}),
]);

const recordPresence = z.strictObject({ count: z.int().min(0), latestOn: localDate.nullable() });
const humanRecords = z.strictObject({ interviews: recordPresence, fourCs: recordPresence });

export const plantFacts = z.strictObject({
	asOf: instant,
	today: localDate,
	formulaVersion,
	sourceRevision: z.string().regex(/^[0-9a-f]{64}$/),
	committedAdults,
	growth,
	vision: visionRhythm,
	cohesion,
	followUps,
	coverage,
	training,
	attestations: z.array(attestationFact),
	humanRecords,
	launch: z.strictObject({ targetOn: localDate.nullable(), daysToLaunch: z.int().nullable() }),
	firstService: firstService.optional(),
	criteria: z.partialRecord(criterionKey, criterionStatus),
});
export type PlantFacts = z.infer<typeof plantFacts>;

export const LAUNCH_WINDOW_DAYS = 28;
export function launchCriteria(launch: {
	targetOn: string | null;
	daysToLaunch: number | null;
}): Partial<Record<z.infer<typeof criterionKey>, z.infer<typeof criterionStatus>>> {
	if (!launch.targetOn || launch.daysToLaunch === null) return {};
	return {
		launch_date_set: "met",
		launch_window: launch.daysToLaunch >= 0 && launch.daysToLaunch <= LAUNCH_WINDOW_DAYS ? "met" : "not_met",
	};
}

export const readFactsRequest = z.strictObject({});

export const factsError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
]);
export type FactsError = z.infer<typeof factsError>;
export type FactsReply<T> = Reply<T, FactsError>;
