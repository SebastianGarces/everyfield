import type { Outcome as Shared } from "@everyfield/contracts/common";
import {
	Alert02Icon,
	BookOpen01Icon,
	CalendarCheckIn01Icon,
	ChartLineData01Icon,
	CheckListIcon,
	CheckmarkBadge01Icon,
	Clock01Icon,
	Comment01Icon,
	FileSearchIcon,
	Link01Icon,
	MailRemove01Icon,
	Rocket01Icon,
	Share08Icon,
	StartUp02Icon,
	Task01Icon,
} from "@hugeicons/core-free-icons";
import type * as c from "@everyfield/contracts/notifications";
import type { Tone } from "@everyfield/ui/controls";
import type { IconSvgElement } from "@everyfield/ui/foundations";
import type { z } from "zod";
import { reviewPath } from "../organizations/reviews/model";
import { milestonePath } from "../residency/model";
import { CATEGORY_TEXT } from "../settings/model";

export type FeedItem = z.infer<typeof c.feedItem>;
export type Feed = z.infer<typeof c.feedResult>;
export type Category = FeedItem["category"];
export type OptOut = z.infer<typeof c.emailOptOutResult>;
export type Reply<T> = c.NotificationReply<T>;
type Code = c.NotificationError["code"];

export type Outcome<T> = Shared<T, Code>;

export type FeedPage = { feed: Feed; unread: number; revision: string; at: number };

export type UnreadCount = { count: number; at: number };

export const stamped = <T extends object>(outcome: Outcome<T>, at: number): Outcome<T & { at: number }> =>
	outcome.status === "ok" ? { status: "ok", value: { ...outcome.value, at } } : outcome;

export type FeedQuery = { unread: boolean; category: Category | null };

export const CATEGORIES = Object.keys(CATEGORY_TEXT) as Category[];
const isCategory = (v: string | null): v is Category => CATEGORIES.includes(v as Category);

export function parseQuery(params: Pick<URLSearchParams, "get">): FeedQuery {
	const category = params.get("category");
	return { unread: params.get("show") === "unread", category: isCategory(category) ? category : null };
}
export function querySearch(q: FeedQuery): string {
	const p = new URLSearchParams();
	if (q.unread) p.set("show", "unread");
	if (q.category) p.set("category", q.category);
	const s = p.toString();
	return s ? `?${s}` : "";
}

const AREA: Record<Category, { area: string; icon: IconSvgElement; tone: Tone }> = {
	task_due: { area: "Tasks", icon: Task01Icon, tone: "amber" },
	task_overdue: { area: "Tasks", icon: Alert02Icon, tone: "magenta" },
	meeting_announcement: { area: "Meetings", icon: CalendarCheckIn01Icon, tone: "green" },
	meeting_reminder: { area: "Meetings", icon: Clock01Icon, tone: "amber" },
	planter_digest: { area: "Digest", icon: CheckListIcon, tone: "green" },
	oversight_digest: { area: "Digest", icon: ChartLineData01Icon, tone: "ink" },
	relationship_milestone: { area: "Connections", icon: Link01Icon, tone: "blue" },
	sharing_milestone: { area: "Sharing", icon: Share08Icon, tone: "blue" },
	phase_milestone: { area: "Phase", icon: StartUp02Icon, tone: "violet" },
	launch_milestone: { area: "Launch", icon: Rocket01Icon, tone: "violet" },
	wiki_upstream_review: { area: "Wiki", icon: BookOpen01Icon, tone: "teal" },
	scheduled_email_unsubscribe: { area: "Messages", icon: MailRemove01Icon, tone: "magenta" },
	residency_confirmation: { area: "My residency", icon: CheckmarkBadge01Icon, tone: "green" },
	residency_feedback: { area: "My residency", icon: Comment01Icon, tone: "blue" },
	answer_review: { area: "Sent for review", icon: FileSearchIcon, tone: "teal" },
};
export const areaOf = (category: Category) => AREA[category];
export const categoryLabel = (category: Category) => CATEGORY_TEXT[category].label;

export function subjectHref(subject: FeedItem["subject"]): string | null {
	if (!subject) return null;
	switch (subject.kind) {
		case "communication":
			return `/communication?message=${encodeURIComponent(subject.id)}`;
		case "task":
			return `/tasks?task=${encodeURIComponent(subject.id)}`;
		case "meeting":
			return `/meetings/${encodeURIComponent(subject.id)}`;
		case "article":
			return `/wiki/${subject.slug.split("/").map(encodeURIComponent).join("/")}?source=global`;
		case "residency_milestone":
			return milestonePath(subject.id);
		case "answer_review":
			return reviewPath(subject.id);
	}
}

export type Clock = { zone: string; now: number };

const day = (instant: number, zone: string) =>
	new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		instant,
	);
function dayDistance(instant: number, clock: Clock): number {
	const [a, b] = [day(instant, clock.zone), day(clock.now, clock.zone)].map((d) => Date.parse(`${d}T00:00:00Z`));
	return Math.round((b! - a!) / 86_400_000);
}

export function timeLabel(eligibleAt: string, clock: Clock): string {
	const at = Date.parse(eligibleAt);
	const minutes = Math.floor((clock.now - at) / 60_000);
	const days = dayDistance(at, clock);
	if (days <= 0 && minutes < 1) return "Just now";
	if (days <= 0 && minutes < 60) return `${minutes} min ago`;
	if (days <= 0) return `${Math.floor(minutes / 60)} h ago`;
	if (days === 1)
		return new Intl.DateTimeFormat("en-US", { timeZone: clock.zone, hour: "numeric", minute: "2-digit" })
			.format(at)
			.replace(" AM", " am")
			.replace(" PM", " pm");
	const sameYear = day(at, clock.zone).slice(0, 4) === day(clock.now, clock.zone).slice(0, 4);
	return new Intl.DateTimeFormat("en-US", {
		timeZone: clock.zone,
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	}).format(at);
}

export function groupByDay(items: readonly FeedItem[], clock: Clock) {
	const groups: { label: "Today" | "Yesterday" | "Earlier"; items: FeedItem[] }[] = [];
	for (const item of items) {
		const d = dayDistance(Date.parse(item.eligibleAt), clock);
		const label = d <= 0 ? "Today" : d === 1 ? "Yesterday" : "Earlier";
		const last = groups.at(-1);
		if (last?.label === label) last.items.push(item);
		else groups.push({ label, items: [item] });
	}
	return groups;
}

export function dueLabel(item: Pick<FeedItem, "dueLocalDate" | "overdue">): string | null {
	if (!item.dueLocalDate) return null;
	const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
		Date.parse(`${item.dueLocalDate}T00:00:00Z`),
	);
	return item.overdue ? `Overdue, due ${date}` : `Due ${date}`;
}

export function markedRead(items: readonly FeedItem[], ids: ReadonlySet<string>): FeedItem[] {
	return items.map((i) => (ids.has(i.id) && !i.read ? { ...i, read: true } : i));
}

export function readTogether(item: FeedItem, items: readonly FeedItem[]): string[] {
	const subject = item.subject;
	if (subject?.kind !== "residency_milestone") return [item.id];
	const same = items.filter(
		(i) => !i.read && i.subject?.kind === subject.kind && i.subject.id === subject.id && i.id !== item.id,
	);
	return [item.id, ...same.map((i) => i.id)];
}

export type MarkReach = { ids: ReadonlySet<string>; cutoff: string | null };

const reaches = (item: FeedItem, mark: MarkReach) =>
	mark.ids.has(item.id) || (mark.cutoff !== null && Date.parse(item.eligibleAt) <= Date.parse(mark.cutoff));

export function withStandingMarks(
	items: readonly FeedItem[],
	marks: readonly MarkReach[],
): { items: FeedItem[]; reached: number } {
	let reached = 0;
	const shown = items.map((item) => {
		if (item.read || !marks.some((mark) => reaches(item, mark))) return item;
		reached += 1;
		return { ...item, read: true };
	});
	return { items: shown, reached };
}

export const cutoffOf = (items: readonly FeedItem[]) => items[0]?.eligibleAt ?? null;

export function markProblem(outcome: Exclude<Outcome<unknown>, { status: "ok" }>): string {
	if (outcome.status === "lost") return "We could not reach Everyfield. It is still unread. Try again.";
	switch (outcome.code) {
		case "access_denied":
			return "This notification is no longer available to you. Reload to see the current list.";
		case "conflict":
			return "Your notification settings changed in another window. Try again.";
		default:
			return "We could not mark it read. It is still unread. Try again.";
	}
}

export const newRequestKey = () => `notifications-${crypto.randomUUID()}`;
