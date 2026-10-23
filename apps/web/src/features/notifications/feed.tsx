"use client";

import { useToast } from "@everyfield/ui/controls";
import type { Loadable } from "@everyfield/ui/display";
import { createContext, use, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { markAllVisibleRead, markRead, markSelectedRead } from "./actions.ts";
import { readFirstPage, readMore, readRevision } from "./fetch.ts";
import {
	cutoffOf,
	markedRead,
	markProblem,
	newRequestKey,
	type Clock,
	type FeedItem,
	type FeedPage,
	type FeedQuery,
	type Outcome,
} from "./model.ts";

// The feed's client state, shared by the page and the bell: the account's unread count and mark revision, the browser
// clock, and one hook that loads a filtered feed and marks entries read optimistically, rolling back with a message.

type Account = {
	/** The account's whole unread count, the bell's number; null until the first read answers. */
	count: number | null;
	setCount: (count: number) => void;
	adjust: (delta: number) => void;
	/** The account revision each mark's envelope carries, from the latest feed read. */
	revision: () => string | null;
	setRevision: (revision: string) => void;
};
const AccountContext = createContext<Account | null>(null);

/** The account's unread count and revision, shared by the bell and the page so a mark in one shows in the other. */
export function NotificationsProvider({ children }: { children: ReactNode }) {
	const [count, setCount] = useState<number | null>(null);
	// Stable for the frame's life, so effects that depend on them run once.
	const [stable] = useState(() => {
		let revision: string | null = null;
		return {
			revision: () => revision,
			setRevision: (r: string) => {
				revision = r;
			},
			adjust: (delta: number) => setCount((n) => (n === null ? n : Math.max(0, n + delta))),
		};
	});
	const value = useMemo<Account>(() => ({ count, setCount, ...stable }), [count, stable]);
	return <AccountContext value={value}>{children}</AccountContext>;
}
export function useAccount(): Account {
	const account = use(AccountContext);
	if (!account) throw new Error("useAccount needs NotificationsProvider (the product frame)");
	return account;
}

let clock: Clock | null = null;
const clockSubscribe = (changed: () => void) => {
	const timer = setInterval(() => {
		clock = null;
		changed();
	}, 60_000);
	return () => clearInterval(timer);
};
const clockSnapshot = () => (clock ??= { zone: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() });
/** The browser's zone and minute; null during server rendering, so times and day groups never mismatch on hydration. */
export const useClock = () => useSyncExternalStore(clockSubscribe, clockSnapshot, () => null);

type Ready = { items: FeedItem[]; nextCursor: string | null; unread: number; more: "idle" | "loading" | "failed" };
type Marked = Outcome<{ markedIds: string[] }>;
type Envelope = { requestKey: string; expectedRevision: string };

/** A server action rejects when its request fails on the network; that is a lost answer, not a crash. */
const lost = () => ({ status: "lost" }) as const;

/**
 * One filtered feed. `initial` is the server's first page; null loads it in the browser (the bell). Marks show at
 * once; a refusal or lost answer puts the entries back as unread and says why. Each mark fixes its envelope at first
 * send: "Try again" after a lost answer resends that same envelope, which the producer replays instead of marking
 * twice. A conflict means a settings save changed the revision; the mark reads it and sends once more with a new key.
 */
export function useFeed(query: FeedQuery, initial: FeedPage | null) {
	const toast = useToast();
	const account = useAccount();
	const [state, setState] = useState<{ status: "loading" } | { status: "failed" } | ({ status: "ready" } & Ready)>(
		initial ? { status: "ready", ...fromPage(initial) } : { status: "loading" },
	);
	const [refreshing, setRefreshing] = useState(false);
	const latest = useRef(0);
	const { setRevision, setCount } = account;
	// The server's first page brings the revision marks carry and, unfiltered by category, the bell's fresh count.
	const first = useRef({ page: initial, category: query.category });
	useEffect(() => {
		const { page, category } = first.current;
		if (!page) return;
		setRevision(page.revision);
		if (!category) setCount(page.unread);
	}, [setRevision, setCount]);

	const load = async (q: FeedQuery) => {
		const ticket = ++latest.current;
		setState((s) => (s.status === "ready" ? s : { status: "loading" }));
		setRefreshing(true);
		const r = await readFirstPage(q);
		if (ticket !== latest.current) return;
		setRefreshing(false);
		if (r.status !== "ok") return setState({ status: "failed" });
		setState({ status: "ready", ...fromPage(r.value) });
		setRevision(r.value.revision);
		// Without a category the count is the account's whole unread count, the bell's number.
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

	/** Sends one mark with its fixed envelope; on a conflict reads the new revision and sends once more. */
	const deliver = async (envelope: Envelope, run: (e: Envelope) => Promise<Marked>): Promise<Marked> => {
		const r = await run(envelope).catch(lost);
		if (r.status !== "refused" || r.code !== "conflict") return r;
		const fresh = await readRevision();
		if (fresh.status !== "ok") return r;
		setRevision(fresh.value.revision);
		return run({ requestKey: newRequestKey(), expectedRevision: fresh.value.revision }).catch(lost);
	};

	/**
	 * Shows `ids` as read and the unread count lowered by `drop`, sends the mark and, on failure, shows the same
	 * entries as unread again. `settle` gets the number the server marked.
	 */
	const mark = (
		ids: Set<string>,
		drop: number,
		run: (e: Envelope) => Promise<Marked>,
		settle?: (n: number) => void,
	) => {
		const envelope = { requestKey: newRequestKey(), expectedRevision: account.revision() ?? "0" };
		const go = async () => {
			setState((s) =>
				s.status === "ready" ? { ...s, items: markedRead(s.items, ids), unread: Math.max(0, s.unread - drop) } : s,
			);
			account.adjust(-drop);
			const r = await deliver(envelope, run);
			if (r.status === "ok") return settle?.(r.value.markedIds.length);
			setState((s) =>
				s.status === "ready"
					? { ...s, items: s.items.map((i) => (ids.has(i.id) ? { ...i, read: false } : i)), unread: s.unread + drop }
					: s,
			);
			account.adjust(drop);
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
		if (!item.read) mark(new Set([item.id]), 1, (e) => markRead(e, item.id));
	};

	/**
	 * Mark all read. Unfiltered, it marks every visible entry up to the newest one shown (REQ-NTF-003), older pages
	 * included, and the answer says how many changed. With a category filter it marks the unread entries this page
	 * shows, 50 at a time, because mark-all has no category.
	 */
	const markAll = () => {
		if (state.status !== "ready") return;
		const open = state.items.filter((i) => !i.read);
		const cutoff = cutoffOf(state.items);
		if (!query.category && cutoff) {
			const before = state.unread;
			if (before === 0 && !open.length) return;
			mark(
				new Set(open.map((i) => i.id)),
				before,
				(e) => markAllVisibleRead(e, cutoff),
				(marked) => {
					if (marked >= before) return;
					setState((s) => (s.status === "ready" ? { ...s, unread: before - marked } : s));
					account.adjust(before - marked);
				},
			);
			return;
		}
		for (let i = 0; i < open.length; i += 50) {
			const chunk = open.slice(i, i + 50).map((n) => n.id);
			mark(new Set(chunk), chunk.length, (e) => markSelectedRead(e, chunk));
		}
	};

	const loadable: Loadable<Ready> =
		state.status === "ready"
			? { status: "ready", data: state }
			: state.status === "loading"
				? { status: "loading" }
				: { status: "error", title: "Notifications did not load", onRetry: () => void load(query) };
	return { state: loadable, refreshing, load, more, markOne, markAll };
}

const fromPage = (page: FeedPage): Ready => ({
	items: page.feed.items,
	nextCursor: page.feed.nextCursor,
	unread: page.unread,
	more: "idle",
});
