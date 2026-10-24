import {
	Alert02Icon,
	BookOpen01Icon,
	CalendarCheckIn01Icon,
	ChartLineData01Icon,
	CheckListIcon,
	Clock01Icon,
	Link01Icon,
	Rocket01Icon,
	Share08Icon,
	StartUp02Icon,
	Task01Icon,
} from "@hugeicons/core-free-icons";
import type * as c from "@everyfield/contracts/notifications";
import type { Tone } from "@everyfield/ui/controls";
import type { IconSvgElement } from "@everyfield/ui/foundations";
import type { z } from "zod";
import { CATEGORY_TEXT } from "../settings/model";

// Pure rules for the notification feed, the bell and the email opt-out page: the words, the grouping and the local
// changes a mark makes while its answer is on the way.

export type FeedItem = z.infer<typeof c.feedItem>;
export type Feed = z.infer<typeof c.feedResult>;
export type Category = FeedItem["category"];
export type OptOut = z.infer<typeof c.emailOptOutResult>;
export type Reply<T> = c.NotificationReply<T>;
type Code = c.NotificationError["code"];

/** A screen action's answer. "lost" means no answer arrived: the same request key may be sent again. */
export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; code: Code } | { status: "lost" };

/**
 * What the feed page and the bell read: one page, the unread count of the same filter, and the account revision that
 * every mark's envelope carries. Marking never changes that revision; a settings save does.
 */
export type FeedPage = { feed: Feed; unread: number; revision: string };

/** The page's filters, kept in the address (?show=unread&category=task_due). */
export type FeedQuery = { unread: boolean; category: Category | null };

export const CATEGORIES = Object.keys(CATEGORY_TEXT) as Category[];
const isCategory = (v: string | null): v is Category => CATEGORIES.includes(v as Category);

export function parseQuery(params: URLSearchParams): FeedQuery {
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

/** The area line under each entry and its icon tile, as in the prototype's notification items. */
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
};
export const areaOf = (category: Category) => AREA[category];
export const categoryLabel = (category: Category) => CATEGORY_TEXT[category].label;

/** The browser's time zone and the minute it is, for "12 min ago" and the day groups. Null until the browser answers. */
export type Clock = { zone: string; now: number };

const day = (instant: number, zone: string) =>
	new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		instant,
	);
function dayDistance(instant: number, clock: Clock): number {
	const [a, b] = [day(instant, clock.zone), day(clock.now, clock.zone)].map((d) => Date.parse(`${d}T00:00:00Z`));
	return Math.round((b! - a!) / 86_400_000);
}

/** "Just now", "12 min ago" and "3 h ago" today; "4:12 pm" yesterday; "Oct 6" before; "Oct 6, 2025" in another year. */
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

/** The feed in Today, Yesterday and Earlier, newest first, as the server ordered it. */
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

/** "Due Oct 24" or "Overdue, due Oct 22" for a task entry. A local date, so it is formatted as written. */
export function dueLabel(item: Pick<FeedItem, "dueLocalDate" | "overdue">): string | null {
	if (!item.dueLocalDate) return null;
	const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
		Date.parse(`${item.dueLocalDate}T00:00:00Z`),
	);
	return item.overdue ? `Overdue, due ${date}` : `Due ${date}`;
}

/** The entries with these ids shown as read. */
export function markedRead(items: readonly FeedItem[], ids: ReadonlySet<string>): FeedItem[] {
	return items.map((i) => (ids.has(i.id) && !i.read ? { ...i, read: true } : i));
}

/**
 * The cutoff for "Mark all read": the newest entry the person sees. Entries that arrive after it stay unread
 * (REQ-NTF-003, mark-all-visible). Null when nothing is shown.
 */
export const cutoffOf = (items: readonly FeedItem[]) => items[0]?.eligibleAt ?? null;

/** Words for a refused or lost mark. The entry shows as unread again. */
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

/** A fresh request key for one mark. A retry after a lost answer sends the same key again. */
export const newRequestKey = () => `notifications-${crypto.randomUUID()}`;
