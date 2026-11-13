import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";
import { CATEGORY_TEXT } from "../../settings/model.ts";
import { digestSchedule, noticeWhen, reviewedNotices, settingChanges, type Review } from "./model.ts";

// What a notifications review shows (WP-082): exactly which of the account's own notices get marked read, how many a
// mark-all covers, or which of its own settings change and which stay. It never names another person.

const category = (key: string) => CATEGORY_TEXT[key as keyof typeof CATEGORY_TEXT]?.label ?? key;
const onOff = (on: boolean) => (on ? "On" : "Off");

function Box({ children }: { children: ReactNode }) {
	return <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">{children}</div>;
}
function Change({ before, after }: { before: string; after: string }) {
	return (
		<span className="flex flex-wrap items-center gap-x-1.5">
			<span className="sr-only">from </span>
			<span className="text-text-2">{before}</span>
			<Icon icon={ArrowRight02Icon} size={16} className="text-text-3" />
			<span className="sr-only"> to </span>
			<span className="font-medium text-ink">{after}</span>
		</span>
	);
}

export function NoticeChanges({ review }: { review: Review }) {
	const { operation } = review;
	const { changes } = review.review;
	if (operation === "notifications.markSelectedRead") {
		const notices = reviewedNotices(review);
		return (
			<Box>
				<p className="text-text-2">
					{notices.length === 1 ? "This notification" : `These ${notices.length} notifications`} will be marked read:
				</p>
				<ul className="flex flex-col gap-2">
					{notices.map((n) => (
						<li key={n.id} className="flex flex-col">
							<span className="font-medium break-words text-ink">{n.title}</span>
							<span className="text-xs text-text-3">
								{category(n.category)} · {noticeWhen(n)}
							</span>
						</li>
					))}
				</ul>
			</Box>
		);
	}
	if (operation === "notifications.markAllVisibleRead") {
		const unread = changes.find((c) => c.field === "unread");
		const count = Number(unread?.before ?? 0);
		return (
			<Box>
				<div className="grid grid-cols-[minmax(88px,auto)_1fr] items-baseline gap-x-3">
					<span className="text-text-2">Unread</span>
					<Change before={count.toLocaleString()} after="0" />
				</div>
				<p className="text-text-2">
					All {count.toLocaleString()} unread {count === 1 ? "notification" : "notifications"} in your bell will be
					marked read. One that arrives after this review stays unread.
				</p>
			</Box>
		);
	}
	if (operation === "notifications.setPreferences")
		return (
			<Box>
				{settingChanges(review).map((group) => (
					<div key={group.category} className="flex flex-col gap-1">
						<span className="font-medium text-ink">{category(group.category)}</span>
						<dl className="flex flex-col gap-1">
							{group.channels.map((c) => (
								<div key={c.channel} className="grid grid-cols-[minmax(64px,auto)_1fr] items-baseline gap-x-3">
									<dt className="text-text-2">{c.channel}</dt>
									<dd>
										{c.before === c.after ? (
											<span className="text-text-2">Stays {onOff(c.after).toLowerCase()}</span>
										) : (
											<Change before={onOff(c.before)} after={onOff(c.after)} />
										)}
									</dd>
								</div>
							))}
						</dl>
					</div>
				))}
			</Box>
		);
	if (operation === "notifications.digestCadence.set") {
		const change = changes.find((c) => c.field === "planter_digest.cadence");
		return (
			<Box>
				<div className="flex flex-col gap-1">
					<span className="font-medium text-ink">{category("planter_digest")}</span>
					<Change before={digestSchedule(change?.before) ?? "Weekly"} after={digestSchedule(change?.after) ?? ""} />
				</div>
			</Box>
		);
	}
	return null;
}
