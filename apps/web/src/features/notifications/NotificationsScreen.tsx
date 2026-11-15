"use client";

import { Notification01Icon, NotificationOff01Icon, Settings02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	Card,
	IntentLink,
	PageHeader,
	SegmentedControl,
	Select,
} from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import { useClock, useFeed } from "./feed.tsx";
import {
	CATEGORIES,
	categoryLabel,
	groupByDay,
	querySearch,
	type Category,
	type FeedPage,
	type FeedQuery,
} from "./model.ts";
import { ItemsSkeleton, NotificationItem } from "./parts.tsx";

// The Notifications page (prototype #/notifications): the account's own feed, newest first, with All and Unread, a
// category filter and Load older. The filters live in the address; changing one reads the first page again without
// reloading the page.

const ANY = "any";

export function NotificationsScreen({ initialQuery, initial }: { initialQuery: FeedQuery; initial: FeedPage }) {
	const [query, setQuery] = useState(initialQuery);
	const feed = useFeed(query, initial);
	const clock = useClock();

	const go = (next: FeedQuery) => {
		setQuery(next);
		window.history.replaceState(null, "", `/notifications${querySearch(next)}`);
		void feed.load(next);
	};
	const ready = feed.state.status === "ready" ? feed.state.data : null;
	const openShown = ready?.items.filter((i) => !i.read).length ?? 0;
	// Mark-all has no category, so a filtered page marks the unread entries it shows.
	const markLabel = query.category ? "Mark shown as read" : "Mark all read";
	const canMark = query.category ? openShown > 0 : (ready?.unread ?? 0) > 0 || openShown > 0;

	return (
		<>
			<PageHeader
				size="xl"
				title="Notifications"
				subtitle="Reminders and updates for you. Change what you get in settings."
				actions={
					<>
						<IntentLink href="/settings/notifications" className={buttonVariants({ variant: "secondary" })}>
							<Icon icon={Settings02Icon} size={18} />
							Preferences
						</IntentLink>
						<Button variant="primary" icon={Tick02Icon} disabled={!canMark} onClick={feed.markAll}>
							{markLabel}
						</Button>
					</>
				}
			/>
			<Card className="w-full max-w-[880px] gap-2 px-[18px] py-5 max-app-sm:px-3">
				<div className="flex flex-wrap items-center gap-3 px-2 pb-1.5">
					<SegmentedControl
						label="Show"
						value={query.unread ? "unread" : "all"}
						onValueChange={(v) => go({ ...query, unread: v === "unread" })}
						options={[
							{ value: "all", label: "All" },
							{ value: "unread", label: "Unread", ...(ready ? { count: ready.unread } : {}) },
						]}
					/>
					<div className="w-[240px] max-app-sm:w-full">
						<Select
							aria-label="Category"
							value={query.category ?? ANY}
							onValueChange={(v) => go({ ...query, category: v === ANY ? null : (v as Category) })}
							options={[
								{ value: ANY, label: "All categories" },
								...CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })),
							]}
						/>
					</div>
				</div>
				<LoadableView
					state={feed.state}
					isEmpty={(d) => d.items.length === 0}
					loadingLabel="Loading notifications"
					skeleton={<ItemsSkeleton rows={5} />}
					empty={
						query.unread
							? {
									icon: Tick02Icon,
									title: "You are all caught up",
									text: query.category
										? `No unread ${categoryLabel(query.category).toLowerCase()}.`
										: "Nothing unread. New reminders and updates will show up here.",
									action: (
										<Button variant="secondary" size="sm" onClick={() => go({ ...query, unread: false })}>
											Show all
										</Button>
									),
								}
							: query.category
								? {
										icon: NotificationOff01Icon,
										title: `No ${categoryLabel(query.category).toLowerCase()} yet`,
										action: (
											<Button variant="secondary" size="sm" onClick={() => go({ ...query, category: null })}>
												Show all categories
											</Button>
										),
									}
								: {
										icon: Notification01Icon,
										title: "No notifications yet",
										text: "Task reminders, meeting updates and digests for you will show up here.",
									}
					}
				>
					{(data) => (
						<div
							aria-busy={feed.refreshing || undefined}
							className="transition-opacity duration-150 aria-busy:opacity-60"
						>
							{clock ? (
								groupByDay(data.items, clock).map((g) => (
									<section key={g.label} aria-labelledby={`day-${g.label}`} className="pt-4 first:pt-1">
										<h2
											id={`day-${g.label}`}
											className="flex items-center gap-2.5 px-1 pb-2 font-sans text-sm font-semibold tracking-normal text-text-2"
										>
											{g.label}
											<span aria-hidden="true" className="h-px grow bg-line" />
										</h2>
										<ul>
											{g.items.map((item) => (
												<NotificationItem key={item.id} item={item} clock={clock} onRead={feed.markOne} />
											))}
										</ul>
									</section>
								))
							) : (
								<ul aria-label="Notifications">
									{data.items.map((item) => (
										<NotificationItem key={item.id} item={item} clock={null} onRead={feed.markOne} />
									))}
								</ul>
							)}
							{data.nextCursor || data.more === "failed" ? (
								<div className="flex flex-col items-center gap-2 pt-3">
									{data.more === "failed" ? (
										<p role="alert" className="text-sm text-text-2">
											Older notifications did not load. Nothing was changed.
										</p>
									) : null}
									<Button variant="ghost" size="sm" loading={data.more === "loading"} onClick={feed.more}>
										{data.more === "failed" ? "Try again" : "Load older"}
									</Button>
								</div>
							) : null}
						</div>
					)}
				</LoadableView>
			</Card>
		</>
	);
}
