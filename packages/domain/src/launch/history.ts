import * as c from "@everyfield/contracts/launch";
import "server-only";
import { z } from "zod";

// Launch history (LCH-002, LCH-010): the shared audit rows of Launch writes, read back as entries. The audit row is the
// history; there is no second journal. Seeded readiness, readiness repair and draft saves are bookkeeping, not changes a
// planter made to their launch, so they stay out.

export const LAUNCH_ACTIONS = [
	"launch.changed",
	"launch.outcome_recorded",
	"launch.corrected",
	"launch.debrief_submitted",
	"launch.summary_published",
] as const;
type Action = (typeof LAUNCH_ACTIONS)[number];

const auditRow = z.object({
	id: z.uuid(),
	at: z.string(),
	actorId: z.uuid().nullable(),
	actorName: z.string().nullable(),
	action: z.enum(LAUNCH_ACTIONS),
	kind: z.string(),
	subjectType: z.string(),
	before: z.record(z.string(), z.unknown()).nullable(),
	after: z.record(z.string(), z.unknown()).nullable(),
	reason: z.string().nullable(),
	metadata: z.record(z.string(), z.unknown()),
	title: z.string().nullable(),
	guestName: z.string().nullable(),
});
type Row = z.infer<typeof auditRow>;
const DATE_EVENTS = new Set(["scheduled", "moved", "postponed", "rescheduled"]);
const OUTCOME_FIELDS = ["actualDate", "attendance", "decisions"] as const;
/** A stored value as history shows it; the entry's own parse checks it. */
const value = (v: unknown) => (v === undefined ? null : v) as string | number | null;

/** What one audit row changed, or null when it is bookkeeping rather than a Launch change. */
function changeOf(r: Row): z.input<typeof c.historyChange> | null {
	const event = r.metadata.event;
	const action: Action = r.action;
	switch (r.subjectType) {
		case "launch": {
			if (action === "launch.outcome_recorded" || action === "launch.corrected") {
				const changes = OUTCOME_FIELDS.filter((f) => r.after && f in r.after).map((field) => ({
					field,
					before: value(r.before?.[field]),
					after: value(r.after?.[field]),
				}));
				// The note is the planter's own words: history says it changed, never what it says.
				const notes = r.metadata.noteChanged === true ? [{ field: "note" as const, before: null, after: null }] : [];
				return {
					kind: "outcome",
					event: action === "launch.corrected" ? "corrected" : "recorded",
					changes: [...changes, ...notes],
					reason: r.reason,
				};
			}
			if (typeof event !== "string" || !DATE_EVENTS.has(event)) return null;
			return {
				kind: "date",
				event: event as "scheduled",
				from: value(r.before?.targetDate) as string | null,
				to: value(r.after?.targetDate) as string | null,
				reason: r.reason,
			};
		}
		case "launch_milestone":
			if (r.kind !== "complete" && r.kind !== "reopen") return null;
			return { kind: "milestone", event: r.kind === "complete" ? "completed" : "reopened", title: r.title ?? "" };
		case "launch_guest":
			return r.kind === "create"
				? { kind: "guest", name: r.guestName, added: r.metadata.createdPerson === true }
				: null;
		case "launch_debrief":
			if (action !== "launch.debrief_submitted" && action !== "launch.corrected") return null;
			return {
				kind: "debrief",
				event: action === "launch.corrected" ? "corrected" : "submitted",
				version: z.int().parse(r.after?.version),
			};
		case "launch_summary":
			return action === "launch.summary_published"
				? { kind: "summary", version: z.int().parse(r.after?.version) }
				: null;
		default:
			return null;
	}
}

/** History entries from the journal rows, newest first as read. A deleted account reads as a former account (null). */
export function historyOf(raw: unknown[]): c.HistoryEntry[] {
	return raw.flatMap((x) => {
		const r = auditRow.parse(x);
		const change = changeOf(r);
		if (!change) return [];
		const actor = r.actorId && r.actorName !== null ? { accountId: r.actorId, displayName: r.actorName } : null;
		return [c.historyEntry.parse({ id: r.id, at: r.at, actor, change })];
	});
}
