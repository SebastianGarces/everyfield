// Pure rules of the follow-up screens (REQ-MTG-021, REQ-MTG-022, REQ-TSK-004, REQ-TSK-012, REQ-TSK-013). No React and
// no server code, so the rules run the same in the browser, on the server and in node tests.
import type * as c from "@everyfield/contracts/followups";
import type { z } from "zod";
import { lacksOwner } from "../tasks/model.ts";

export type OutcomeValue = z.infer<typeof c.outcome>;
export type Channel = z.infer<typeof c.channel>;
export type OutcomeItem = z.infer<typeof c.outcomeItem>;
export type ContactHistory = z.infer<typeof c.contactHistory>;
export type OutcomeMutation = z.infer<typeof c.outcomeMutation>;
export type ObligationItem = z.infer<typeof c.obligationItem>;
export type ObligationPage = z.infer<typeof c.obligationPage>;
export type DutyItem = z.infer<typeof c.dutyItem>;
export type Coverage = z.infer<typeof c.followUpCoverage>;
export type Owners = z.infer<typeof c.followUpOwners>;
export type HandoffPlan = z.infer<typeof c.handoffPlan>;
export type HandoffResult = z.infer<typeof c.handoffResult>;
export type Account = HandoffPlan["recipients"][number];
export type FollowUpOrigin = z.infer<typeof c.followUpOrigin>;

/** Where a follow-up came from, in words: "After Vision Meeting #4" or "Added by Ruth Allen". */
export const originText = (o: FollowUpOrigin): string =>
	o.kind === "meeting" ? `After ${o.meeting.label}` : o.by ? `Added by ${o.by}` : "Added by hand";
/** Whether a follow-up counts as Needs owner: nobody holds it, or nobody who holds it can own it now (D-a, REQ-TSK-012). */
export const needsOwner = (d: Pick<DutyItem, "owners">) => lacksOwner(d.owners);
export type Owner = DutyItem["owners"][number];

/**
 * Who Correct attendance offers for "Follow-up calls go to" (D-e): the set of eligible owners that most of a meeting's
 * open follow-ups have; a tie goes to the set of the most recent follow-up (the list is newest first). Empty when no
 * open follow-up has an eligible owner, so it reads Needs owner only then.
 */
export function preferredOwners(items: readonly Pick<ObligationItem, "kind" | "state" | "owners">[]): string[] {
	const held = new Map<string, { n: number; ids: string[] }>();
	for (const o of items) {
		if (o.kind !== "first_vision_follow_up" || o.state !== "open") continue;
		const ids = o.owners
			.filter((x) => x.eligible)
			.map((x) => x.accountId)
			.sort();
		if (!ids.length) continue;
		const key = ids.join(",");
		held.set(key, { n: (held.get(key)?.n ?? 0) + 1, ids });
	}
	let best: { n: number; ids: string[] } | null = null;
	for (const set of held.values()) if (best === null || set.n > best.n) best = set;
	return best ? best.ids : [];
}

/** A server answer, or none: `lost` means the reply never arrived, so the save may or may not have happened. */
export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; code: string } | { status: "lost" };

export const OUTCOMES: readonly OutcomeValue[] = [
	"contacted",
	"attempted_no_contact",
	"administrative_completion",
	"no_longer_needed",
];
/** The words each outcome shows with. Only Contacted is contact (REQ-MTG-022). */
export const OUTCOME_LABEL: Record<OutcomeValue, string> = {
	contacted: "Contacted",
	attempted_no_contact: "Tried, no contact",
	administrative_completion: "Done without contact",
	no_longer_needed: "No longer needed",
};
export const OUTCOME_HINT: Record<OutcomeValue, string> = {
	contacted: "You talked with them. Counts as contact.",
	attempted_no_contact: "You called or wrote and did not reach them. Not contact.",
	administrative_completion: "The follow-up is done another way. Not contact.",
	no_longer_needed: "Closes the follow-up without credit or contact.",
};
/** The StatusBadge state of each outcome. The label always says the outcome; the dot only repeats it. */
export const OUTCOME_STATUS = {
	contacted: "positive",
	attempted_no_contact: "attention",
	administrative_completion: "measured",
	no_longer_needed: "unknown",
} as const satisfies Record<OutcomeValue, string>;
export const CHANNELS: readonly Channel[] = ["phone", "text", "in_person", "video", "email", "other"];
export const CHANNEL_LABEL: Record<Channel, string> = {
	phone: "Phone call",
	text: "Text message",
	in_person: "In person",
	video: "Video call",
	email: "Email",
	other: "Other",
};

/** The outcome form as the person fills it. `when` is their explicit answer to "when did it happen?". */
export type Draft = {
	outcome: OutcomeValue | "";
	when: "now" | "earlier" | "";
	/** A local date and time from the form (yyyy-mm-ddThh:mm), read in this browser's zone. */
	at: string;
	channel: Channel | "";
	notes: string;
	/** Complete the follow-up with this outcome. A separate choice from the outcome (REQ-MTG-022). */
	complete: boolean;
};
export const emptyDraft = (): Draft => ({ outcome: "", when: "", at: "", channel: "", notes: "", complete: false });
/**
 * Picks an outcome. Contacted and Done without contact usually finish the follow-up, so the box starts ticked; Tried
 * usually keeps it open. The person can change either. No longer needed closes the task on its own.
 */
export function pickOutcome(d: Draft, outcome: OutcomeValue): Draft {
	return { ...d, outcome, complete: outcome === "contacted" || outcome === "administrative_completion" };
}

export const NOTES_MAX = 2_000;
export type DraftErrors = Partial<Record<"outcome" | "when" | "at" | "notes", string>>;
export type OutcomeInput = {
	outcome: OutcomeValue;
	occurredAt?: string;
	channel: Channel | null;
	notes: string | null;
	completeTask: boolean;
};

/**
 * The contract input from the form, or the problems to show before any request. Contacted needs the person to say when
 * it happened; the server never assumes it. "Just now" is read when the person saves. An earlier time must be in the
 * past. Other outcomes default to now.
 */
export function outcomeInput(
	d: Draft,
	opts: { completable: boolean; now?: Date },
): { ok: true; input: OutcomeInput } | { ok: false; errors: DraftErrors } {
	const now = opts.now ?? new Date();
	const errors: DraftErrors = {};
	if (!d.outcome) errors.outcome = "Choose what happened.";
	if (d.outcome === "contacted" && !d.when) errors.when = "Choose when you talked.";
	let occurredAt: string | undefined;
	if (d.when === "earlier") {
		const parsed = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d.at) ? new Date(d.at) : null;
		if (!parsed || Number.isNaN(parsed.getTime())) errors.at = "Enter the date and time it happened.";
		else if (parsed.getTime() > now.getTime()) errors.at = "This time is in the future. Choose a time that has passed.";
		else occurredAt = parsed.toISOString();
	} else if (d.when === "now") occurredAt = now.toISOString();
	const notes = d.notes.replaceAll("\r\n", "\n").trim();
	if (notes.length > NOTES_MAX) errors.notes = `Keep the note under ${NOTES_MAX.toLocaleString("en-US")} characters.`;
	if (!d.outcome || Object.keys(errors).length) return { ok: false, errors };
	return {
		ok: true,
		input: {
			outcome: d.outcome,
			...(occurredAt ? { occurredAt } : {}),
			channel: d.outcome === "no_longer_needed" || !d.channel ? null : d.channel,
			notes: notes || null,
			completeTask: opts.completable && d.outcome !== "no_longer_needed" && d.complete,
		},
	};
}

/** A correction needs a reason the log keeps with it (REQ-MTG-022). */
export function reasonOf(text: string): { ok: true; reason: string } | { ok: false; error: string } {
	const reason = text.trim();
	if (!reason) return { ok: false, error: "Say why, so the log explains the change." };
	if (reason.length > 500) return { ok: false, error: "Keep the reason under 500 characters." };
	return { ok: true, reason };
}

/** A local date-time value (yyyy-mm-ddThh:mm) for an instant, in this browser's zone, for a datetime-local field. */
export function localInputOf(at: string | Date): string {
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** The form for correcting a recorded outcome: its current values, said again by the person. */
export function draftOf(item: OutcomeItem): Draft {
	return {
		outcome: item.outcome,
		when: "earlier",
		at: localInputOf(item.occurredAt),
		channel: item.channel ?? "",
		notes: item.notes ?? "",
		complete: item.completedTask,
	};
}

/**
 * The contact log after a saved outcome: the new entry in its time place, and the entry a correction or withdrawal
 * changed, as it reads now. Entries sort latest first by when it happened, then when it was recorded, then ID, so a late
 * historical entry never becomes the latest.
 */
export function withOutcome(items: readonly OutcomeItem[], m: Pick<OutcomeMutation, "record" | "previous">) {
	const changed = [m.record, ...(m.previous ? [m.previous] : [])];
	const rest = items.filter((i) => !changed.some((x) => x.id === i.id));
	return [...rest, ...changed].sort(
		(a, b) =>
			b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
	);
}

export const FOLLOW_UP_WINDOW_MS = 48 * 60 * 60 * 1000;
/**
 * The 48-hour window of a first-Vision follow-up at `now`, from the meeting's actual start (REQ-MTG-021): hours left
 * while it is open, rounded down, or closed. The measure itself is the server's; this is only the countdown.
 */
export function windowAt(originAt: string, now = Date.now()): { open: true; hoursLeft: number } | { open: false } {
	const left = Date.parse(originAt) + FOLLOW_UP_WINDOW_MS - now;
	if (Date.parse(originAt) > now || left < 0) return { open: false };
	return { open: true, hoursLeft: Math.floor(left / 3_600_000) };
}

/** The 48-hour result of a first-Vision follow-up, in words, with its StatusBadge state. */
export function measurementText(m: NonNullable<ObligationItem["measurement"]>): {
	text: string;
	status: "positive" | "risk" | "unknown";
} {
	if (m.reason === "measured")
		return m.success ? { text: "Within 48 h", status: "positive" } : { text: "Missed 48 h", status: "risk" };
	const why = {
		immature: "48 h not over",
		waived: "Not counted: no longer needed",
		superseded: "Not counted: replaced",
		future_origin: "Not counted yet",
		invalid_completion: "Not counted: time outside the window",
	} as const;
	return { text: why[m.reason], status: "unknown" };
}

/**
 * The eligible follow-up owners (REQ-TSK-012) from a handoff preview of the viewer's own account: the other eligible
 * accounts, plus the viewer when the viewer is eligible. Sorted by name.
 */
export function ownersOf(plan: Pick<HandoffPlan, "from" | "recipients">): Account[] {
	const me =
		plan.from.eligible && plan.from.displayName !== null
			? [{ accountId: plan.from.accountId, displayName: plan.from.displayName }]
			: [];
	return [...me, ...plan.recipients].sort(
		(a, b) => a.displayName.localeCompare(b.displayName) || a.accountId.localeCompare(b.accountId),
	);
}

/** Contact log entries per page on the Person page and in the task panel; "Show earlier" reads the next one. */
export const HISTORY_PAGE = 20;
/** Contacts per page on the Follow-ups page. */
export const COVERAGE_PAGE = 24;
/** The most follow-ups one handoff request may move (REQ-TSK-013). */
export const HANDOFF_LIMIT = 100;
/**
 * A handoff selection after the preview was read again: the person's own choice, kept for the follow-ups still in the
 * preview, with their latest revisions. Follow-ups that left the preview drop out; none is added.
 */
export function keepSelection(selected: ReadonlySet<string>, duties: readonly DutyItem[]): Set<string> {
	return new Set(duties.filter((d) => selected.has(d.taskId)).map((d) => d.taskId));
}

/** Why a save was refused, in words. Only a server answer reaches this. */
export function problemText(code: string): string {
	switch (code) {
		case "conflict":
			return "It changed since you opened it. We loaded the latest version and kept your answers. Check them, then save again.";
		case "future_occurrence":
			return "The time is in the future. Choose a time that has passed.";
		case "owner_ineligible":
			return "That person cannot own follow-ups now. Owners need a current seat and a committed stage. Choose someone else.";
		case "handoff_target_ineligible":
			return "That person cannot take follow-ups now. Choose someone from the updated list.";
		case "protected_owner":
			return "Follow-ups cannot be taken from the church's Owner.";
		case "invalid_subject":
			return "This person or follow-up can no longer take this change. They may be retired.";
		case "invalid_input":
			return "Some answers are not valid. Check them and try again.";
		case "access_denied":
		case "unauthorized":
			return "Your seat cannot make this change. Your role may have changed; reload the page.";
		default:
			return "The server could not make this change. Try again in a moment.";
	}
}

/** The Follow-ups page's totals: open follow-ups per current owner, per former owner, without owner, contacts with none. */
export type Totals = Pick<Coverage, "owners" | "formerOwners" | "needsOwner" | "uncovered">;
type Move = {
	/** Who held the follow-up before, or "new" for one just created. */
	before: readonly Owner[] | "new";
	/** Who holds it now: each eligible owner counts it, and an ineligible one stays on the handoff tally (REQ-TSK-013). */
	after: readonly Owner[];
	firstForContact?: boolean;
};
/** One follow-up changing hands, for the totals: from `before`'s owners to `after`'s. */
export const moveOf = (before: Pick<DutyItem, "owners">, after: readonly Owner[]): Move => ({
	before: before.owners,
	after,
});
/**
 * The totals after follow-ups changed owners, from the server's answers (REQ-TSK-012, REQ-TSK-013, D-a): a follow-up
 * counts once under each eligible owner, under Needs owner when it has none, and under each ineligible owner on the
 * handoff tally. A new follow-up for a contact that had none takes that contact out of "no follow-up".
 */
export function totalsAfter(t: Totals, moves: readonly Move[]): Totals {
	const tally = (list: Totals["owners"]) => new Map(list.map((o) => [o.accountId, { ...o }]));
	const owners = tally(t.owners);
	const former = tally(t.formerOwners);
	let { needsOwner, uncovered } = t;
	const add = (map: typeof owners, who: Account, n: number) => {
		const o = map.get(who.accountId) ?? { accountId: who.accountId, displayName: who.displayName, open: 0 };
		o.open += n;
		if (o.open > 0) map.set(who.accountId, o);
		else map.delete(who.accountId);
	};
	const count = (list: readonly Owner[], n: 1 | -1) => {
		const eligible = list.filter((o) => o.eligible);
		for (const o of eligible) add(owners, o, n);
		if (!eligible.length) needsOwner += n;
		for (const o of list.filter((x) => !x.eligible)) add(former, o, n);
	};
	for (const m of moves) {
		if (m.before !== "new") count(m.before, -1);
		count(m.after, 1);
		if (m.firstForContact) uncovered -= 1;
	}
	const sorted = (map: typeof owners) =>
		[...map.values()].sort(
			(a, b) => a.displayName.localeCompare(b.displayName) || a.accountId.localeCompare(b.accountId),
		);
	return {
		owners: sorted(owners),
		formerOwners: sorted(former),
		needsOwner: Math.max(0, needsOwner),
		uncovered: Math.max(0, uncovered),
	};
}
/** A contact's coverage from its open follow-ups: none is "uncovered", any without an owner is "needs_owner". */
export const coverageOf = (duties: readonly Pick<DutyItem, "owners">[]): "owned" | "needs_owner" | "uncovered" =>
	duties.length === 0 ? "uncovered" : duties.some(needsOwner) ? "needs_owner" : "owned";
