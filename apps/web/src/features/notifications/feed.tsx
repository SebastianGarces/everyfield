"use client";

import { useToast } from "@everyfield/ui/controls";
import type { Loadable } from "@everyfield/ui/display";
import { useBrowserZone, useDocumentHidden, useMinuteClock } from "@everyfield/ui/foundations";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { createRead, useReadWith } from "../../components/read.tsx";
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
	type UnreadCount,
} from "./model.ts";

const STALE_MS = 60_000;

const Account = storeContext<AccountState>("NotificationsProvider");

export function NotificationsProvider({ account, children }: { account: string; children: ReactNode }) {
	const store = useLocalStore(() => createAccountStore(account));
	return <Account.Provider value={store}>{children}</Account.Provider>;
}

type Counted = Outcome<UnreadCount>;

const unreadCount = createRead((account: string) => readUnreadCount(account), {
	failed: (): Counted => ({ status: "lost" }),
	fresh: STALE_MS,
	servedAt: (value) => (value.status === "ok" ? value.value.at : undefined),
});

const countOf = (value: Counted | undefined) => (value?.status === "ok" ? value.value : null);
const counted = (count: number, at: number): Counted => ({ status: "ok", value: { count, at } });

function setCount(account: string, count: number, at: number) {
	const next = counted(count, at);
	if (unreadCount.peek(account)?.status === "ready") unreadCount.patch(() => next, account);
	else unreadCount.seed(next, account);
}

function adjustCount(account: string, delta: number) {
	const now = countOf(unreadCount.peek(account)?.value);
	if (now) unreadCount.patch(() => counted(Math.max(0, now.count + delta), now.at), account);
}

function useUnreadCount(page: UnreadCount | null): UnreadCount | null {
	const account = Account.useSelect((s) => s.account);
	const hidden = useDocumentHidden();
	const [shown, setShown] = useState<UnreadCount | null>(null);
	const behindPage = page !== null && shown !== null && shown.at < page.at && shown.count !== page.count;
	const live = countOf(
		useReadWith(hidden ? null : unreadCount, [account], { newerThan: behindPage ? page.at : undefined }).value,
	);
	if (live && (live.count !== shown?.count || live.at !== shown.at)) setShown(live);
	return live ?? shown;
}

export function useCountRefresh(): () => void {
	const account = Account.useSelect((s) => s.account);
	return () => void unreadCount.refresh(account);
}

export function useReadElsewhere(): (ids: readonly string[]) => void {
	const account = Account.useSelect((s) => s.account);
	const { stand, confirm } = Account.useSelect((s) => s.actions);
	return (ids) => {
		const token = {};
		stand({ token, ids: new Set(ids), cutoff: null });
		confirm(token);
		void unreadCount.refresh(account);
	};
}

const lost = () => ({ status: "lost" }) as const;

export function useClock(): Clock | null {
	const zone = useBrowserZone();
	const now = useMinuteClock();
	return useMemo(() => (zone === null || now === null ? null : { zone, now }), [zone, now]);
}

type Ready = {
	items: FeedItem[];
	nextCursor: string | null;
	unread: number;
	at: number;
	more: "idle" | "loading" | "failed";
};
type FeedState = { status: "loading" } | { status: "failed" } | ({ status: "ready" } & Ready);
type Marked = Outcome<{ markedIds: string[] }>;
type Envelope = { requestKey: string; expectedRevision: string };

const fromPage = (page: FeedPage): Ready => ({
	items: page.feed.items,
	nextCursor: page.feed.nextCursor,
	unread: page.unread,
	at: page.at,
	more: "idle",
});

export function useFeed(query: FeedQuery, initial: FeedPage | null) {
	const toast = useToast();
	const { stand, withdraw, confirm } = Account.useSelect((s) => s.actions);
	const marks = Account.useSelect((s) => s.marks);
	const account = Account.useSelect((s) => s.account);
	const [state, setState] = useState<FeedState>(() =>
		initial ? { status: "ready", ...fromPage(initial) } : { status: "loading" },
	);
	const [refreshing, setRefreshing] = useState(false);
	const latest = useRef(0);
	const revision = useRef(initial?.revision ?? null);

	const standing = state.status === "ready" ? withStandingMarks(state.items, marks) : null;
	const count = useUnreadCount(
		initial && !query.category && state.status === "ready" && standing
			? { count: Math.max(0, state.unread - standing.reached), at: state.at }
			: null,
	);
	const countIsNewer = state.status === "ready" && count !== null && count.at >= state.at;
	const shown: (Ready & { status: "ready" }) | null =
		state.status === "ready" && standing
			? {
					...state,
					items: standing.items,
					unread: !query.category && countIsNewer && count ? count.count : Math.max(0, state.unread - standing.reached),
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
		if (!q.category) setCount(account, r.value.unread, r.value.at);
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
		if (!query.category && shown && !countIsNewer) setCount(account, shown.unread, shown.at);
		const go = async () => {
			const token = {};
			setState((s) =>
				s.status === "ready" ? { ...s, items: markedRead(s.items, ids), unread: Math.max(0, s.unread - drop) } : s,
			);
			adjustCount(account, -drop);
			stand({ token, ids, cutoff });
			const r = await deliver(envelope, run);
			if (r.status === "ok") {
				confirm(token);
				return settle?.(r.value.markedIds.length);
			}
			withdraw(token);
			setState((s) =>
				s.status === "ready"
					? { ...s, items: s.items.map((i) => (ids.has(i.id) ? { ...i, read: false } : i)), unread: s.unread + drop }
					: s,
			);
			adjustCount(account, drop);
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
			const before = shown.unread;
			if (before === 0 && !open.length) return;
			mark(
				new Set(open.map((i) => i.id)),
				before,
				(e) => markAllVisibleRead(e, cutoff),
				(marked) => {
					if (marked >= before) return;
					setState((s) => (s.status === "ready" ? { ...s, unread: before - marked } : s));
					adjustCount(account, before - marked);
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
	return { state: loadable, count: count?.count ?? null, refreshing, load, more, markOne, markAll };
}
