import type {
	Cohesion,
	CommittedAdults,
	FollowUps,
	Growth,
	PlantFacts,
	Training,
	VisionRhythm,
} from "@everyfield/contracts/intelligence";
import type { Status } from "@everyfield/ui/display";

// The measured-facts section's pure model (WP-040): every sentence the planter reads about a fact. No React and no
// server code, so the UI tests call it directly. Unknown always says what is missing; it never reads as zero or No.

export type Verdict = { status: Status; label: string };
const UNKNOWN: Verdict = { status: "unknown", label: "Unknown" };

/** "Oct 23, 2026" for a plant-local date. */
export const dayLabel = (date: string) =>
	new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
		new Date(date + "T00:00:00Z"),
	);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const days = (n: number) => plural(n, "day");

export const adultsVerdict = (a: CommittedAdults): Verdict =>
	a.status === "met"
		? { status: "positive", label: "Met" }
		: a.status === "not_met"
			? { status: "attention", label: "Not met" }
			: UNKNOWN;
/** The headline number: the exact count, or Unknown with the known lower bound. */
export const adultsValue = (a: CommittedAdults) => (a.exact !== null ? String(a.exact) : "Unknown");
export function adultsDetail(a: CommittedAdults): string {
	if (a.exact === null)
		return `At least ${a.known} committed ${a.known === 1 ? "adult" : "adults"}. ${plural(a.needsClassifying.length, "person needs", "people need")} an adult or child classification before the count is known.`;
	return `${plural(a.exact, "committed adult")}, each counted once across core group and launch team.`;
}
export const childrenNote = (a: CommittedAdults) =>
	a.children
		? `${plural(a.children, "child", "children")} with a commitment ${a.children === 1 ? "is" : "are"} not counted.`
		: null;
export const KIND_LABEL = { core_group: "Core group", launch_team: "Launch team" } as const;

export const GROWTH_LABEL: Record<Growth["status"], Verdict> = {
	on_track: { status: "positive", label: "On track" },
	slowed: { status: "attention", label: "Momentum has slowed" },
	stalled: { status: "risk", label: "Growth has stalled" },
	unknown: UNKNOWN,
};
export const growthValue = (g: Growth) => (g.daysSince === null ? "Unknown" : days(g.daysSince));
export function growthDetail(g: Growth): string {
	const windows = `${plural(g.current, "new adult")} in the last 28 days${g.currentWithdrawn ? ` (${g.currentWithdrawn} since withdrew, still counted as new)` : ""}, ${g.prior} in the 28 days before.`;
	if (g.reason === "no_acquisition") return "No committed adult has a commitment date yet.";
	if (g.reason === "unclassified_newer")
		return `Someone who signed more recently has no adult or child classification, so the growth clock cannot be read. ${windows}`;
	return `Since the newest first-time committed adult signed on ${dayLabel(g.lastAcquiredOn!)}. ${windows}`;
}

export const VISION_LABEL: Record<VisionRhythm["status"], Verdict> = {
	on_target: { status: "positive", label: "Within 14 days" },
	over_target: { status: "measured", label: "Past the 14-day target" },
	watch: { status: "attention", label: "Past the 21-day mark" },
	direct: { status: "risk", label: "Past the 28-day mark" },
	unknown: UNKNOWN,
};
export const visionValue = (v: VisionRhythm) => (v.daysSince === null ? "Unknown" : days(v.daysSince));
export function visionDetail(v: VisionRhythm): string {
	if (v.reason === "no_attendance") return "No attendance is recorded yet, so the Vision rhythm cannot be measured.";
	const next = v.nextScheduledOn ? ` Next scheduled ${dayLabel(v.nextScheduledOn)}; it counts once it is held.` : "";
	if (v.reason === "no_vision_meeting") return `No Vision meeting has been held with attendance yet.${next}`;
	const seen = v.lastAttendance.length === 2 ? ` ${v.lastAttendance[1]} then ${v.lastAttendance[0]} attended.` : "";
	return `Since the last completed Vision meeting on ${dayLabel(v.lastHeldOn!)}.${seen}${next}`;
}

export const COHESION_LABEL: Record<Cohesion["status"], Verdict> = {
	steady: { status: "positive", label: "Steady" },
	flagged: { status: "attention", label: "Worth a look" },
	unknown: UNKNOWN,
};
export const cohesionValue = (c: Cohesion) =>
	c.status === "unknown" ? "Unknown" : `${c.disengaged.length} of ${c.committed}`;
export const cohesionDetail = (c: Cohesion) =>
	c.status === "unknown"
		? "No attendance is recorded yet, so cohesion cannot be measured."
		: "Committed people who attended in the 28 days before last but not in the last 28 days.";

export const followUpsValue = (f: FollowUps) =>
	f.status === "unknown" ? "Unknown" : `${f.onTime} of ${f.measured} on time`;
export function followUpsDetail(f: FollowUps): string {
	const parts = [
		f.status === "unknown"
			? "No meeting follow-up is old enough to measure yet."
			: "Completed within 48 hours of the meeting.",
	];
	if (f.noLongerNeeded)
		parts.push(
			`${f.noLongerNeeded} left out because ${f.noLongerNeeded === 1 ? "it was" : "they were"} no longer needed.`,
		);
	if (f.pending) parts.push(`${f.pending} still inside the 48 hours.`);
	if (f.unmeasured) parts.push(`${f.unmeasured} could not be measured.`);
	return parts.join(" ");
}
/** Contact stays apart from task work: only a recorded "contacted" outcome counts. */
export const contactLine = (f: FollowUps) =>
	`Recorded contact: ${plural(f.contacted, "follow-up")}. A ticked task is not contact.`;

export const coverageValue = (c: PlantFacts["coverage"]) =>
	`${c.filled} of ${c.slots} filled, ${plural(c.people, "person", "people")}`;

export const trainingVerdict = (t: Training): Verdict =>
	t.status === "met"
		? { status: "positive", label: "Complete" }
		: t.status === "not_met"
			? { status: "attention", label: "Not complete" }
			: UNKNOWN;
export const trainingValue = (t: Training) => (t.status === "unknown" ? "Unknown" : `${t.complete} of ${t.total}`);
export const trainingDetail = (t: Training) =>
	t.status === "unknown"
		? "No one is assigned to a required training program yet."
		: "People who completed each required program they are assigned to.";

export const presenceLine = (count: number, latestOn: string | null, noun: string) =>
	count === 0 ? `No ${noun} recorded.` : `${plural(count, noun)} recorded, latest ${dayLabel(latestOn!)}.`;
