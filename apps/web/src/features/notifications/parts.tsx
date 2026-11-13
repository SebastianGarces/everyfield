"use client";

import { CardIcon, IntentLink, Skeleton } from "@everyfield/ui/controls";
import { cn } from "@everyfield/ui/foundations";
import { areaOf, dueLabel, subjectHref, timeLabel, type Clock, type FeedItem } from "./model.ts";

// One notification entry (prototype .notif-item) and the loading shape of a list of them. The page and the bell share it.

const ROW =
	"grid w-full grid-cols-[36px_minmax(0,1fr)_8px] items-start gap-3 rounded-card p-2.5 text-left transition-[background-color] duration-150";
const CHOOSABLE =
	"cursor-pointer hover:bg-surface-2 focus-visible:shadow-[0_0_0_2px_var(--ef-focus)] focus-visible:outline-none active:bg-surface-3";

/**
 * An entry whose category has a subject page is a link to it, read or not (D-731, D-732); following it marks it read.
 * Any other unread entry is a button that marks it read, and a read one is plain text. Reading never completes the work
 * it is about. The dot and the bold title show unread; the hidden words say it too. `onOpen` runs as a link is
 * followed, so the bell can close.
 */
export function NotificationItem({
	item,
	clock,
	onRead,
	onOpen,
	compact = false,
}: {
	item: FeedItem;
	clock: Clock | null;
	onRead: (item: FeedItem) => void;
	onOpen?: () => void;
	compact?: boolean;
}) {
	const { area, icon, tone } = areaOf(item.category);
	const href = subjectHref(item.subject);
	const due = dueLabel(item);
	const body = (
		<>
			<CardIcon icon={icon} tone={tone} size={36} />
			<span className="min-w-0">
				<span className={cn("block text-md leading-[1.4] text-ink text-pretty", !item.read && "font-semibold")}>
					{item.title}
				</span>
				{item.body && !compact ? (
					<span className="mt-0.5 block text-sm leading-[1.45] text-text-2 text-pretty">{item.body}</span>
				) : null}
				<span className="mt-[3px] flex flex-wrap items-center gap-x-1.5 text-xs text-text-3">
					<span>{area}</span>
					{clock ? (
						<>
							<span aria-hidden="true">·</span>
							<time dateTime={item.eligibleAt}>{timeLabel(item.eligibleAt, clock)}</time>
						</>
					) : null}
					{due ? (
						<>
							<span aria-hidden="true">·</span>
							<span className={cn(item.overdue && "font-medium text-magenta-600")}>{due}</span>
						</>
					) : null}
				</span>
			</span>
			{item.read ? <span /> : <span aria-hidden="true" className="mt-1.5 size-2 rounded-full bg-blue-500" />}
		</>
	);
	const unread = item.read ? null : <span className="sr-only">Unread: </span>;
	return (
		<li>
			{href ? (
				<IntentLink
					href={href}
					onClick={() => {
						onRead(item);
						onOpen?.();
					}}
					className={cn(ROW, CHOOSABLE)}
				>
					{unread}
					{body}
				</IntentLink>
			) : item.read ? (
				<div className={ROW}>{body}</div>
			) : (
				<button type="button" onClick={() => onRead(item)} className={cn(ROW, CHOOSABLE)}>
					{unread}
					{body}
					<span className="sr-only">. Mark as read</span>
				</button>
			)}
		</li>
	);
}

/** The loading shape: icon tiles and two text lines, as many as the list will likely show. */
export function ItemsSkeleton({ rows }: { rows: number }) {
	return (
		<div className="flex flex-col gap-1">
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="grid grid-cols-[36px_minmax(0,1fr)] gap-3 p-2.5">
					<Skeleton shape="circle" width={36} height={36} />
					<div className="flex flex-col gap-2 pt-1">
						<Skeleton shape="line" width="70%" height={14} />
						<Skeleton shape="line" width="30%" height={10} />
					</div>
				</div>
			))}
		</div>
	);
}
