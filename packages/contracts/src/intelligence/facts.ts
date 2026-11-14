import { z } from "zod";
import { defineSafeError, recordId, type Reply } from "../common/values.ts";
import { instant, localDate } from "../common/time.ts";
import { criterionKey, criterionStatus } from "../phases/index.ts";
import { renewal, signalKey, signalValue } from "./signals.ts";

// Plant Intelligence measured facts (WP-040, PI-001 to PI-015): what Everyfield has measured about a plant's progress
// toward launch, with the evidence behind each number. Every fact keeps Unknown, a real zero, a recorded No and an
// unanswered question apart. Facts are computed on each read from the records the planter keeps; nothing here is a
// model's interpretation. Private care never reaches them, and interviews and 4 C's show only their count and date.

/** The formula version every fact result names, so a later assessment can cite the rules it was built with. */
export const FACTS_FORMULA_VERSION = "plant-facts/1";
/** The committed-adult criterion of Phase 1. */
export const ADULT_TARGET = 30;
/** Growth: below 21 days is on track, 21 to 27 "momentum has slowed", 28 or more "growth has stalled". */
export const GROWTH_SLOWED_DAYS = 21;
export const GROWTH_STALLED_DAYS = 28;
/** Each acquisition window is exactly 28 inclusive plant-local calendar dates. */
export const WINDOW_DAYS = 28;
/** Vision rhythm: a 14-day biweekly target, watch from 21 days, direct from 28. */
export const VISION_TARGET_DAYS = 14;
export const VISION_WATCH_DAYS = 21;
export const VISION_DIRECT_DAYS = 28;
/** Cohesion flags at least this share, and at least this many, disengaged committed people. */
export const COHESION_SHARE = 0.2;
export const COHESION_MIN = 3;

/** The eight ministry responsibilities, in methodology order. Prayer Leader is separate coverage. */
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
export const ministryKey = z.enum(MINISTRY_RESPONSIBILITIES.map((r) => r.key) as [string, ...string[]]);

const personRef = z.strictObject({ id: recordId, name: z.string() });
export type PersonRef = z.infer<typeof personRef>;
const commitmentKind = z.enum(["core_group", "launch_team"]);
/** A measured yes/no criterion result, or Unknown when the records cannot answer. */
const measuredStatus = z.enum(["met", "not_met", "unknown"]);

/** One counted adult and the commitment that counts them: the kinds they signed and the date they became active. */
export const countedAdult = z.strictObject({
	person: personRef,
	kinds: z.array(commitmentKind).min(1),
	committedSince: localDate,
	adultFrom: z.enum(["birth_date", "recorded"]),
});
export type CountedAdult = z.infer<typeof countedAdult>;

export const committedAdults = z.strictObject({
	/** Met at 30 known adults; Unknown while unclassified people could change the result; Not met only when they cannot. */
	status: measuredStatus,
	/** The known adult lower bound. */
	known: z.int().min(0),
	/** The exact total, or null while anyone still needs classifying. */
	exact: z.int().min(0).nullable(),
	/** People with an active commitment and neither a birth date nor an adult or child classification. */
	needsClassifying: z.array(personRef),
	/** Each counted adult once, by name. */
	evidence: z.array(countedAdult),
	/** Active commitments not counted because the person is a child. */
	children: z.int().min(0),
});
export type CommittedAdults = z.infer<typeof committedAdults>;

export const growth = z.strictObject({
	status: z.enum(["on_track", "slowed", "stalled", "unknown"]),
	/** Why growth is Unknown: no adult acquisition yet, or an unclassified person signed after the newest known adult. */
	reason: z.enum(["no_acquisition", "unclassified_newer"]).nullable(),
	/** The newest first-time committed adult's first commitment date. */
	lastAcquiredOn: localDate.nullable(),
	daysSince: z.int().min(0).nullable(),
	/** New adults in [today−27, today] and in [today−55, today−28]. */
	current: z.int().min(0),
	prior: z.int().min(0),
	/** Of `current`, how many have since withdrawn: they still count as new adults here. */
	currentWithdrawn: z.int().min(0),
	windowStart: localDate,
	priorStart: localDate,
});
export type Growth = z.infer<typeof growth>;

export const visionRhythm = z.strictObject({
	/** on_target ≤14 days, over_target 15–20, watch 21–27 (past the 21-day mark), direct 28 or more. */
	status: z.enum(["on_target", "over_target", "watch", "direct", "unknown"]),
	reason: z.enum(["no_attendance", "no_vision_meeting"]).nullable(),
	lastHeldOn: localDate.nullable(),
	daysSince: z.int().min(0).nullable(),
	/** Attended counts of the last two completed Vision meetings, newest first. */
	lastAttendance: z.array(z.int().min(0)).max(2),
	/** The next scheduled Vision meeting. It does not count until it is held. */
	nextScheduledOn: localDate.nullable(),
});
export type VisionRhythm = z.infer<typeof visionRhythm>;

export const cohesion = z.strictObject({
	/** flagged: at least 20% and at least three committed people attended in the prior 28 days but not the last 28. */
	status: z.enum(["steady", "flagged", "unknown"]),
	reason: z.enum(["no_attendance"]).nullable(),
	disengaged: z.array(personRef),
	/** Live people with an active commitment. */
	committed: z.int().min(0),
});
export type Cohesion = z.infer<typeof cohesion>;

export const followUps = z.strictObject({
	/** Unknown until at least one follow-up is measured. */
	status: z.enum(["measured", "unknown"]),
	/** Completed within 48 elapsed hours of the meeting, of `measured`. */
	onTime: z.int().min(0),
	measured: z.int().min(0),
	/** Left out of the ratio, not counted as misses. */
	noLongerNeeded: z.int().min(0),
	/** Younger than 48 hours and still open: not yet measured. */
	pending: z.int().min(0),
	/** Future, superseded or with a completion outside the meeting's time: not measured. */
	unmeasured: z.int().min(0),
	/** Follow-ups with a recorded "contacted" outcome. A ticked task is not contact. */
	contacted: z.int().min(0),
	total: z.int().min(0),
});
export type FollowUps = z.infer<typeof followUps>;

export const coverage = z.strictObject({
	status: z.enum(["met", "not_met"]),
	filled: z.int().min(0).max(MINISTRY_RESPONSIBILITIES.length),
	slots: z.literal(MINISTRY_RESPONSIBILITIES.length),
	/** Distinct people across the eight. */
	people: z.int().min(0),
	responsibilities: z.array(z.strictObject({ key: ministryKey, label: z.string(), people: z.array(personRef) })),
	prayerLeader: z.array(personRef),
});
export type Coverage = z.infer<typeof coverage>;

export const training = z.strictObject({
	/** Met only at 100% of saved required obligations; Unknown when nothing required is assigned. */
	status: measuredStatus,
	complete: z.int().min(0),
	total: z.int().min(0),
	programs: z.array(
		z.strictObject({ id: recordId, name: z.string(), complete: z.int().min(0), total: z.int().min(0) }),
	),
});
export type Training = z.infer<typeof training>;

export const attestationFact = z.strictObject({
	key: signalKey,
	state: z.enum(["answered", "retracted", "unanswered"]),
	value: signalValue.nullable(),
	asOf: localDate.nullable(),
	ageDays: z.int().min(0).nullable(),
	renewal,
});
export type AttestationFact = z.infer<typeof attestationFact>;

/** Only how many human records exist and the latest date: never scores, notes, results or qualification. */
const recordPresence = z.strictObject({ count: z.int().min(0), latestOn: localDate.nullable() });
export const humanRecords = z.strictObject({ interviews: recordPresence, fourCs: recordPresence });

export const plantFacts = z.strictObject({
	asOf: instant,
	today: localDate,
	formulaVersion: z.literal(FACTS_FORMULA_VERSION),
	/** A digest of every input the facts read. Assessment work captured at another revision is stale. */
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
	/** The exit criteria these facts measure. Every other criterion stays Unknown. */
	criteria: z.partialRecord(criterionKey, criterionStatus),
});
export type PlantFacts = z.infer<typeof plantFacts>;

export const readFactsRequest = z.strictObject({});

export const factsError = z.discriminatedUnion("code", [
	defineSafeError("invalid_input", {}, "never"),
	defineSafeError("access_denied", {}, "never"),
]);
export type FactsError = z.infer<typeof factsError>;
export type FactsReply<T> = Reply<T, FactsError>;
