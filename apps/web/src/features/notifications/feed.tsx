"use client";

import { useToast } from "@everyfield/ui/controls";
import type { Loadable } from "@everyfield/ui/display";
import { useBrowserZone, useDocumentHidden, useMinuteClock } from "@everyfield/ui/foundations";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { storeContext, useLocalStore } from "../../components/store.ts";
import { createAccountStore, type AccountState } from "./account.store.ts";
import { markAllVisibleRead, markRead, markSelectedRead } from "./actions.ts";
import { readFirstPage, readMore, readRevision, readUnreadCount } from "./fetch.ts";
import {
	cutoffOf,
	markedRead,
	markProblem,
	newRequestKey,
	readTogether,
	withStandingMarks,
	type Clock,
	type FeedItem,
	type FeedPage,
	type FeedQuery,
	type Outcome,
} from "./model.ts";

const STALE_MS = 60_000;

const Account = storeContext<AccountState>("NotificationsProvider");

export function NotificationsProvider({ children }: { children: ReactNode }) {
	const store = useLocalStore(createAccountStore);
	return <Account.Provider value={store}>{children}</Account.Provider>;
}

const lost = () => ({ status: "lost" }) as const;

const unreadCount = createRead(() => readUnreadCount(), { failed: lost, fresh: STALE_MS });

type Counted = Outcome<{ count: number }> | undefined;
const countOf = (value: Counted) => (value?.status === "ok" ? value.value.count : null);
const counted = (count: number) => ({ status: "ok", value: { count } }) as const;

function setCount(count: number) {
	if (unreadCount.peek()?.status === "ready") unreadCount.patch(() => counted(count));
	else unreadCount.seed(counted(count));
}

function adjustCount(delta: number) {
	if (countOf(unreadCount.peek()?.value) === null) return;
	unreadCount.patch((value) => (value.status === "ok" ? counted(Math.max(0, value.value.count + delta)) : value));
}

const countNow = () => countOf(unreadCount.peek()?.value);

export function useUnreadCount(): number | null {
	const hidden = useDocumentHidden();
	const live = countOf(useRead(hidden ? null : unreadCount).value);
	const [shown, setShown] = useState<number | null>(null);
	if (live !== null && live !== shown) setShown(live);
	return live ?? shown;
}

export function useClock(): Clock | null {
	const zone = useBrowserZone();
	const now = useMinuteClock();
	return useMemo(() => (zone === null || now === null ? null : { zone, now }), [zone, now]);
}

type Ready = { items: FeedItem[]; nextCursor: string | null; unread: number; more: "idle" | "loading" | "failed" };
type FeedState = { status: "loading" } | { status: "failed" } | ({ status: "ready" } & Ready);
type Marked = Outcome<{ markedIds: string[] }>;
type Envelope = { requestKey: string; expectedRevision: string };

const fromPage = (page: FeedPage): Ready => ({
	items: page.feed.items,
	nextCursor: page.feed.nextCursor,
	unread: page.unread,
	more: "idle",
});

export function useFeed(query: FeedQuery, initial: FeedPage | null) {
	const toast = useToast();
	const { stand, withdraw } = Account.useSelect((s) => s.actions);
	const marks = Account.useSelect((s) => s.marks);
	const count = useUnreadCount();
	const [state, setState] = useState<FeedState>(() => {
		if (!initial) return { status: "loading" };
		if (!query.category) unreadCount.seed(counted(initial.unread));
		return { status: "ready", ...fromPage(initial) };
	});
	const [refreshing, setRefreshing] = useState(false);
	const latest = useRef(0);
	const revision = useRef(initial?.revision ?? null);

	const standing = state.status === "ready" ? withStandingMarks(state.items, marks) : null;
	const shown: (Ready & { status: "ready" }) | null =
		state.status === "ready" && standing
			? {
					...state,
					items: standing.items,
					unread: query.category || count === null ? Math.max(0, state.unread - standing.reached) : count,
				}
			: null;

	const load = async (q: FeedQuery) => {
		const ticket = ++latest.current;
		setState((s) => (s.status === "ready" ? s : { status: "loading" }));
		setRefreshing(true);
		const r = await readFirstPage(q);
		if (ticket !== latest.current) return;
		setRefreshing(false);
		if (r.status !== "ok") return setState({ status: "failed" });
		setState({ status: "ready", ...fromPage(r.value) });
		revision.current = r.value.revision;
		if (!q.category) setCount(r.value.unread);
	};

	const more = async () => {
		if (state.status !== "ready" || !state.nextCursor || state.more === "loading") return;
		const ticket = latest.current;
		setState({ ...state, more: "loading" });
		const r = await readMore(query, state.nextCursor);
		if (ticket !== latest.current) return;
		setState((s) => {
			if (s.status !== "ready") return s;
			if (r.status !== "ok") return { ...s, more: "failed" };
			const known = new Set(s.items.map((i) => i.id));
			return {
				...s,
				items: [...s.items, ...r.value.items.filter((i) => !known.has(i.id))],
				nextCursor: r.value.nextCursor,
				more: "idle",
			};
		});
	};

	const deliver = async (envelope: Envelope, run: (e: Envelope) => Promise<Marked>): Promise<Marked> => {
		const r = await run(envelope).catch(lost);
		if (r.status !== "refused" || r.code !== "conflict") return r;
		const fresh = await readRevision();
		if (fresh.status !== "ok") return r;
		revision.current = fresh.value.revision;
		return run({ requestKey: newRequestKey(), expectedRevision: fresh.value.revision }).catch(lost);
	};

	const mark = (
		ids: Set<string>,
		drop: number,
		run: (e: Envelope) => Promise<Marked>,
		settle?: (n: number) => void,
		cutoff: string | null = null,
	) => {
		const envelope = { requestKey: newRequestKey(), expectedRevision: revision.current ?? "0" };
		const go = async () => {
			const token = {};
			setState((s) =>
				s.status === "ready" ? { ...s, items: markedRead(s.items, ids), unread: Math.max(0, s.unread - drop) } : s,
			);
			adjustCount(-drop);
			stand({ token, ids, cutoff });
			const r = await deliver(envelope, run);
			if (r.status === "ok") return settle?.(r.value.markedIds.length);
			withdraw(token);
			setState((s) =>
				s.status === "ready"
					? { ...s, items: s.items.map((i) => (ids.has(i.id) ? { ...i, read: false } : i)), unread: s.unread + drop }
					: s,
			);
			adjustCount(drop);
			toast({
				tone: "error",
				message: markProblem(r),
				...(r.status === "lost"
					? { action: { label: "Try again", altText: "Mark it read again from the list", onSelect: () => void go() } }
					: {}),
			});
		};
		void go();
	};

	const markOne = (item: FeedItem) => {
		if (item.read) return;
		const ids = readTogether(item, shown?.items ?? []);
		if (ids.length === 1) mark(new Set(ids), 1, (e) => markRead(e, item.id));
		else mark(new Set(ids), ids.length, (e) => markSelectedRead(e, ids));
	};

	const markAll = () => {
		if (!shown) return;
		const open = shown.items.filter((i) => !i.read);
		const cutoff = cutoffOf(shown.items);
		if (!query.category && cutoff) {
			const before = countNow() ?? shown.unread;
			if (before === 0 && !open.length) return;
			mark(
				new Set(open.map((i) => i.id)),
				before,
				(e) => markAllVisibleRead(e, cutoff),
				(marked) => {
					if (marked >= before) return;
					setState((s) => (s.status === "ready" ? { ...s, unread: before - marked } : s));
					adjustCount(before - marked);
				},
				cutoff,
			);
			return;
		}
		for (let i = 0; i < open.length; i += 50) {
			const chunk = open.slice(i, i + 50).map((n) => n.id);
			mark(new Set(chunk), chunk.length, (e) => markSelectedRead(e, chunk));
		}
	};

	const loadable: Loadable<Ready> = shown
		? { status: "ready", data: shown }
		: state.status === "loading"
			? { status: "loading" }
			: { status: "error", title: "Notifications did not load", onRetry: () => void load(query) };
	return { state: loadable, count, refreshing, load, more, markOne, markAll };
}
