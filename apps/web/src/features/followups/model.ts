import type * as c from "@everyfield/contracts/followups";
import { FOLLOW_UP_WINDOW_MS } from "@everyfield/contracts/followups";
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

export const originText = (o: FollowUpOrigin): string =>
	o.kind === "meeting" ? `After ${o.meeting.label}` : o.by ? `Added by ${o.by}` : "Added by hand";
export const needsOwner = (d: Pick<DutyItem, "owners">) => lacksOwner(d.owners);
export type Owner = DutyItem["owners"][number];

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

export const OUTCOMES: readonly OutcomeValue[] = [
	"contacted",
	"attempted_no_contact",
	"administrative_completion",
	"no_longer_needed",
];
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

export type Draft = {
	outcome: OutcomeValue | "";
	when: "now" | "earlier" | "";
	at: string;
	channel: Channel | "";
	notes: string;
	complete: boolean;
	stored?: { at: string; instant: string };
};
export const emptyDraft = (): Draft => ({ outcome: "", when: "", at: "", channel: "", notes: "", complete: false });
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

export function outcomeInput(
	d: Draft,
	opts: { completable: boolean; now: Date },
): { ok: true; input: OutcomeInput } | { ok: false; errors: DraftErrors } {
	const { now } = opts;
	const errors: DraftErrors = {};
	if (!d.outcome) errors.outcome = "Choose an outcome.";
	if (d.outcome === "contacted" && !d.when) errors.when = "Choose when you talked.";
	let occurredAt: string | undefined;
	if (d.when === "earlier" && d.stored && d.at === d.stored.at) occurredAt = d.stored.instant;
	else if (d.when === "earlier") {
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

export function reasonOf(text: string): { ok: true; reason: string } | { ok: false; error: string } {
	const reason = text.trim();
	if (!reason) return { ok: false, error: "Say why, so the log explains the change." };
	if (reason.length > 500) return { ok: false, error: "Keep the reason under 500 characters." };
	return { ok: true, reason };
}

export function localInputOf(at: string | Date): string {
	const d = new Date(at);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function draftOf(item: OutcomeItem): Draft {
	const at = localInputOf(item.occurredAt);
	return {
		outcome: item.outcome,
		when: "earlier",
		at,
		channel: item.channel ?? "",
		notes: item.notes ?? "",
		complete: item.completedTask,
		stored: { at, instant: item.occurredAt },
	};
}

export function withOutcome(items: readonly OutcomeItem[], m: Pick<OutcomeMutation, "record" | "previous">) {
	const changed = [m.record, ...(m.previous ? [m.previous] : [])];
	const rest = items.filter((i) => !changed.some((x) => x.id === i.id));
	return [...rest, ...changed].sort(
		(a, b) =>
			b.occurredAt.localeCompare(a.occurredAt) || b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id),
	);
}

export const recentAfter = (items: readonly OutcomeItem[], m: Pick<OutcomeMutation, "record" | "previous">) =>
	withOutcome(items, m).slice(0, 3);

export function windowAt(originAt: string, now: number): { open: true; hoursLeft: number } | { open: false } {
	const left = Date.parse(originAt) + FOLLOW_UP_WINDOW_MS - now;
	if (Date.parse(originAt) > now || left < 0) return { open: false };
	return { open: true, hoursLeft: Math.floor(left / 3_600_000) };
}

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

export const HISTORY_PAGE = 20;
export const COVERAGE_PAGE = 24;
export function keepSelection(selected: ReadonlySet<string>, duties: readonly DutyItem[]): Set<string> {
	return new Set(duties.filter((d) => selected.has(d.taskId)).map((d) => d.taskId));
}

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

export type Totals = Pick<Coverage, "owners" | "formerOwners" | "needsOwner" | "uncovered">;
type Move = {
	before: readonly Owner[] | "new";
	after: readonly Owner[];
	firstForContact?: boolean;
};
export const moveOf = (before: Pick<DutyItem, "owners">, after: readonly Owner[]): Move => ({
	before: before.owners,
	after,
});
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
export const coverageOf = (duties: readonly Pick<DutyItem, "owners">[]): "owned" | "needs_owner" | "uncovered" =>
	duties.length === 0 ? "uncovered" : duties.some(needsOwner) ? "needs_owner" : "owned";
