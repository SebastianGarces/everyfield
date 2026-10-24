"use client";

import { Notification01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	EmptyState,
	IntentLink,
	Popover,
	PopoverAnchor,
	PopoverContent,
	StatePanel,
} from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useAccount, useClock, useFeed } from "./feed.tsx";
import { readUnreadCount } from "./fetch.ts";
import { ItemsSkeleton, NotificationItem } from "./parts.tsx";

// The bell's drop-down (screens.md, Overlays: Notification drop-down). The frame passes `open` to the top bar's bell
// and renders `element`. The count loads once the frame is on screen and again when the tab comes back after a while.

const ALL = { unread: false, category: null } as const;
const SHOWN = 6;
const STALE_MS = 60_000;

export function useNotificationBell() {
	const account = useAccount();
	const [open, setOpen] = useState(false);
	const anchor = useRef<HTMLElement | null>(null);
	const feed = useFeed(ALL, null);
	const clock = useClock();
	const counted = useRef(0);
	const setCount = account.setCount;

	useEffect(() => {
		const refresh = () => {
			if (document.visibilityState !== "visible" || Date.now() - counted.current < STALE_MS) return;
			counted.current = Date.now();
			void readUnreadCount().then((r) => r.status === "ok" && setCount(r.value.count));
		};
		refresh();
		document.addEventListener("visibilitychange", refresh);
		return () => document.removeEventListener("visibilitychange", refresh);
	}, [setCount]);

	/** The top bar calls this from the bell's click; the bell is the drop-down's anchor and gets focus back on close. */
	const show = (event?: MouseEvent<HTMLElement>) => {
		if (event) anchor.current = event.currentTarget;
		counted.current = Date.now();
		setOpen(true);
		void feed.load(ALL);
	};

	const element = (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />
			<PopoverContent
				label="Notifications"
				align="end"
				className="flex w-[380px] flex-col p-2"
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					anchor.current?.focus();
				}}
			>
				<div className="flex items-center justify-between gap-3 py-1 pr-1 pl-2.5">
					<h2 className="font-sans text-md font-semibold text-ink">Notifications</h2>
					<Button
						variant="ghost"
						size="sm"
						disabled={feed.state.status !== "ready" || !(account.count ?? feed.state.data.unread)}
						onClick={feed.markAll}
					>
						Mark all read
					</Button>
				</div>
				<div className="max-h-[min(440px,calc(100dvh-180px))] overflow-y-auto">
					{feed.state.status === "loading" ? (
						<div aria-busy="true">
							<span className="sr-only" role="status">
								Loading notifications
							</span>
							<ItemsSkeleton rows={3} />
						</div>
					) : feed.state.status === "error" ? (
						<StatePanel
							tone="error"
							title="Notifications did not load"
							headingLevel="h3"
							className="py-8"
							actions={
								<Button variant="secondary" size="sm" onClick={feed.state.onRetry}>
									Try again
								</Button>
							}
						>
							Nothing was changed. Try again in a moment.
						</StatePanel>
					) : feed.state.data.items.length === 0 ? (
						<EmptyState icon={Notification01Icon} title="No notifications yet" className="py-8">
							Reminders and updates for you will show up here.
						</EmptyState>
					) : (
						<ul aria-label="Latest notifications">
							{feed.state.data.items.slice(0, SHOWN).map((item) => (
								<NotificationItem key={item.id} item={item} clock={clock} onRead={feed.markOne} compact />
							))}
						</ul>
					)}
				</div>
				<IntentLink
					href="/notifications"
					onClick={() => setOpen(false)}
					className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-1.5 w-full" })}
				>
					See all notifications
				</IntentLink>
			</PopoverContent>
		</Popover>
	);
	return { unread: account.count ?? 0, open: show, element };
}
