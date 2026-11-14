import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { notificationCategory } from "@everyfield/contracts/notifications";
import { getPreferences, previewPlanterDigest, readFeedPage } from "@everyfield/domain/notifications";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { ownerOrAdmin } from "../../people/commands/index.ts";

// The Notifications reads (WP-081): the signed-in account's own bell with its exact unread count, its own notification choices
// and a preview of its next church digest. Each one calls the native read the bell and Settings use, under the
// actor's live session, and never takes an account id: another person's notices or settings cannot be asked for.
// Reading never marks anything read (GAP-EVR-421). Notices are offered in a plant context only.

/** Any seat in the selected church: the bell and the notification settings are every account's own. */
export const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;

const refused = (code: string): never => {
	throw new EvryRefusal(code === "invalid_input" ? "invalid_input" : "source_unavailable");
};
const result = (operation: string, rows: SourceRow[], total: number | null, partial = false): SourceResult => ({
	operation,
	status: rows.length || total ? "available" : "not_found",
	rows,
	total,
	page: 1,
	next: null,
	completeness: partial ? "partial" : "complete",
	exclusions: [],
});

/** The church's zone, so the model reads a notice's time as the church's own day and hour. One statement. */
async function churchZone(tx: Transaction, actor: EvryActor) {
	const r = await tx.execute(sql`SELECT timezone FROM plant WHERE id=${actor.owner.id}::uuid`);
	return z.object({ timezone: z.string() }).parse(r.rows[0]).timezone;
}
const localTime = (at: string, zone: string) =>
	new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(at));

const feedInput = z.strictObject({
	unread: z.boolean().optional().describe("true for unread notifications only"),
	category: notificationCategory.optional(),
});
export const feed: ReadAdapter<z.infer<typeof feedInput>> = {
	operation: "notifications.feed",
	description:
		"The user's own notifications, newest first, as the bell shows them: each with its category, title, church-local time and whether it is read. Reading never marks anything read.",
	input: feedInput,
	allowed: inPlant,
	async invoke(tx, actor, input) {
		const reply = await readFeedPage(tx, actor.authority, input);
		if (reply.status !== "ok") return refused(reply.error.code);
		const zone = await churchZone(tx, actor);
		const { feed: page, unread } = reply.value;
		const rows = page.items.map((n): SourceRow => ({
			kind: "notice",
			id: n.id,
			label: n.title,
			fields: {
				category: n.category,
				at: localTime(n.eligibleAt, zone),
				read: n.read,
				overdue: n.overdue,
			},
		}));
		const more = page.nextCursor !== null;
		// With `unread`, the bell's unread count of the same category is the exact total.
		return result("notifications.feed", rows, input.unread ? unread : more ? null : rows.length, more);
	},
};

const onOff = (enabled: boolean | undefined) => (enabled === undefined ? null : enabled ? "on" : "off");
export const preferences: ReadAdapter<Record<string, never>> = {
	operation: "notifications.preferences.get",
	description:
		"The user's own notification settings from Settings > Notifications: for each category, email and in-app on or off, and the church digest cadence (daily or weekly).",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor) {
		const reply = await getPreferences(tx, actor.authority);
		if (reply.status !== "ok") return refused(reply.error.code);
		const { choices, planterCadence } = reply.value;
		const categories = [...new Set(choices.map((c) => c.category))];
		const rows = categories.map((category): SourceRow => {
			const channel = (name: "email" | "in_app") =>
				choices.find((c) => c.category === category && c.channel === name)?.enabled;
			return {
				kind: "setting",
				id: category,
				label: category,
				fields: {
					email: onOff(channel("email")),
					inApp: onOff(channel("in_app")),
					...(category === "planter_digest" ? { cadence: planterCadence, cadenceChoices: "daily, weekly" } : {}),
				},
			};
		});
		return result("notifications.preferences.get", rows, rows.length);
	},
};

export const planterDigest: ReadAdapter<Record<string, never>> = {
	operation: "notifications.previewPlanterDigest",
	description:
		"A preview of the user's next church digest: when it sends, the dates it covers and each open item it will list. Owner or Admin.",
	input: z.strictObject({}),
	allowed: ownerOrAdmin,
	async invoke(tx, actor) {
		const reply = await previewPlanterDigest(tx, actor.authority, { plantId: actor.owner.id }, () => new Date());
		if (reply.status !== "ok") return refused(reply.error.code);
		const { next, zone, cadence } = reply.value;
		if (!next) return result("notifications.previewPlanterDigest", [], 0);
		const rows: SourceRow[] = [
			{
				kind: "digest",
				id: "next",
				label: next.title,
				fields: { sendsAt: localTime(next.sendAt, zone), from: next.start, to: next.end, cadence },
			},
			...next.lines.map((line, n): SourceRow => ({ kind: "digest", id: `line-${n + 1}`, label: line, fields: {} })),
		];
		return result("notifications.previewPlanterDigest", rows, next.total, next.total > next.items.length);
	},
};

/** The installed Notifications read tools, in catalog order. */
export const NOTIFICATION_READS = [feed, preferences, planterDigest] as const;
