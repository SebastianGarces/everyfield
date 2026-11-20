"use client";

import { useHydrated } from "@everyfield/ui/foundations";
import { useMemo, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";

export type ReadSnapshot<T> = {
	readonly status: "loading" | "ready";
	readonly value: T | undefined;
	readonly promise: Promise<T>;
};

export type Read<A extends unknown[], T> = {
	key(...args: A): string;
	get(...args: A): Promise<T>;
	peek(...args: A): ReadSnapshot<T> | null;
	prefetch(...args: A): void;
	seed(value: T | Promise<T>, ...args: A): void;
	refresh(...args: A): Promise<T>;
	retry(...args: A): Promise<T>;
	patch(change: (value: T) => T, ...args: A): void;
	forget(...args: A | []): void;
	snapshot(key: string): ReadSnapshot<T> | null;
	connect(listener: () => void, ...args: A): () => void;
	connectWith(listener: () => void, args: A, bound?: ReaderBound, rerender?: () => void): () => void;
	patchInTransition(change: (value: T) => T, ...args: A): void;
};

export type ReaderBound = { readonly newerThan?: number };

export type ReaderOptions = ReaderBound & { readonly showPrevious?: boolean };

export type ReadOptions<T> = {
	failed: (error: unknown) => T;
	fresh?: number;
	keep?: (value: T) => boolean;
	limit?: number;
	servedAt?: (value: T) => number | undefined;
};

export type ReadState<T> = {
	status: "idle" | "loading" | "ready";
	value: T | undefined;
	reloading: boolean;
	retry(): void;
	reload(): void;
	patch(change: (value: T) => T): void;
};

type Entry<T> = ReadSnapshot<T> & {
	served: number | undefined;
	at: number;
	reusable: boolean;
	unread: boolean;
	changes: readonly ((value: T) => T)[];
};

const onServer = () => typeof window === "undefined";

const outcomeOk = (value: unknown) =>
	!(typeof value === "object" && value !== null && "status" in value && value.status !== "ok");

export function createRead<A extends unknown[], T>(
	load: (...args: A) => Promise<T>,
	{ failed, fresh = 0, keep = outcomeOk, limit = 200, servedAt = () => undefined }: ReadOptions<T>,
): Read<A, T> {
	const entries = new Map<string, Entry<T>>();
	const listeners = new Set<() => void>();
	const readers = new Map<string, number>();
	const rerenders = new Map<string, Map<() => void, () => void>>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const put = (k: string, entry: Entry<T>) => {
		entries.delete(k);
		entries.set(k, entry);
		for (const old of entries.keys()) {
			if (entries.size <= limit) break;
			if (!watched(old) && old !== k) entries.delete(old);
		}
	};
	const settled = (k: string, promise: Promise<T>) =>
		void promise.then((loaded) => {
			const entry = entries.get(k);
			if (entry?.promise !== promise) return;
			const value = entry.changes.reduce((current, change) => change(current), loaded);
			entries.set(k, {
				...entry,
				status: "ready",
				value,
				at: Date.now(),
				served: servedAt(value),
				reusable: keep(value),
				changes: [],
			});
			emit();
		});
	const key = (...args: A) => JSON.stringify(args);
	const watched = (k: string) => (readers.get(k) ?? 0) > 0;

	const usable = (entry: Entry<T> | undefined) =>
		entry !== undefined && (entry.status === "loading" || (entry.reusable && Date.now() - entry.at < fresh))
			? entry
			: undefined;

	const start = (k: string, args: A, keepValue: boolean) => {
		const promise = new Promise<T>((resolve) => resolve(load(...args))).catch(failed);
		if (onServer()) return promise;
		const previous = keepValue ? entries.get(k)?.value : undefined;
		put(k, {
			status: "loading",
			value: previous,
			promise,
			at: Date.now(),
			served: undefined,
			reusable: true,
			unread: !watched(k),
			changes: [],
		});
		settled(k, promise);
		emit();
		return promise;
	};

	const patchWith = (inTransition: boolean, change: (value: T) => T, args: A) => {
		const k = key(...args);
		const entry = entries.get(k);
		if (!entry) return;
		if (entry.status === "loading")
			entries.set(k, {
				...entry,
				value: entry.value === undefined ? undefined : change(entry.value),
				changes: [...entry.changes, change],
			});
		else if (entry.value === undefined) return;
		else {
			const value = change(entry.value);
			entries.set(k, { ...entry, value, promise: Promise.resolve(value), at: Date.now(), reusable: true });
		}
		const deferred = inTransition ? (rerenders.get(k) ?? new Map<() => void, () => void>()) : new Map();
		for (const listener of listeners) if (!deferred.has(listener)) listener();
		for (const rerender of deferred.values()) rerender();
	};

	const connectWith = (listener: () => void, args: A, bound: ReaderBound = {}, rerender?: () => void) => {
		const k = key(...args);
		listeners.add(listener);
		if (rerender) {
			const forKey = rerenders.get(k) ?? new Map<() => void, () => void>();
			forKey.set(listener, rerender);
			rerenders.set(k, forKey);
		}
		const entry = entries.get(k);
		const others = watched(k);
		readers.set(k, (readers.get(k) ?? 0) + 1);
		const live = usable(entry);
		const older =
			bound.newerThan !== undefined &&
			live !== undefined &&
			live.status === "ready" &&
			(live.served === undefined || live.served < bound.newerThan);
		if (live && !older) live.unread = false;
		else start(k, args, others || entry?.unread === true || older);
		return () => {
			listeners.delete(listener);
			rerenders.get(k)?.delete(listener);
			if (rerenders.get(k)?.size === 0) rerenders.delete(k);
			const left = (readers.get(k) ?? 1) - 1;
			if (left > 0) readers.set(k, left);
			else readers.delete(k);
		};
	};

	const get = (...args: A) => {
		const k = key(...args);
		const entry = entries.get(k);
		const live = usable(entry);
		return live ? live.promise : start(k, args, watched(k));
	};

	return {
		key,
		get,
		peek: (...args) => entries.get(key(...args)) ?? null,
		prefetch: (...args) => void get(...args),
		seed: (value, ...args) => {
			const k = key(...args);
			if (onServer() || entries.has(k)) return;
			const promise = value instanceof Promise ? value.catch(failed) : Promise.resolve(value);
			if (value instanceof Promise) {
				put(k, {
					status: "loading",
					value: undefined,
					promise,
					at: Date.now(),
					served: undefined,
					reusable: true,
					unread: true,
					changes: [],
				});
				settled(k, promise);
			} else
				put(k, {
					status: "ready",
					value,
					promise,
					at: Date.now(),
					served: servedAt(value),
					reusable: true,
					unread: true,
					changes: [],
				});
		},
		refresh: (...args) => start(key(...args), args, true),
		retry: (...args) => start(key(...args), args, false),
		patch: (change, ...args) => patchWith(false, change, args),
		patchInTransition: (change, ...args) => patchWith(true, change, args),
		forget: (...args) => {
			if (args.length === 0) entries.clear();
			else entries.delete(key(...(args as A)));
			emit();
		},
		snapshot: (k) => {
			const entry = entries.get(k);
			if (!entry) return null;
			return watched(k) || entry.unread || usable(entry) ? entry : null;
		},
		connect: (listener, ...args) => connectWith(listener, args),
		connectWith,
	};
}

const none = () => () => {};

export function useRead<A extends unknown[], T>(read: Read<A, T> | null, ...args: A): ReadState<T> {
	return useReadWith(read, args);
}

export function useReadWith<A extends unknown[], T>(
	read: Read<A, T> | null,
	args: A,
	{ newerThan, showPrevious = false }: ReaderOptions = {},
): ReadState<T> {
	const hydrated = useHydrated();
	const key = read && hydrated ? read.key(...args) : null;
	const [reloading, startReload] = useTransition();
	const [, setPatched] = useState(0);
	const connect = useMemo(
		() =>
			read && key !== null
				? (listener: () => void) =>
						read.connectWith(listener, JSON.parse(key) as A, { newerThan }, () => setPatched((n) => n + 1))
				: none,
		[read, key, newerThan],
	);
	const snapshot = useSyncExternalStore(
		connect,
		() => (read && key !== null ? read.snapshot(key) : null),
		() => null,
	);
	const [shown, setShown] = useState<{ value: T | undefined }>({ value: undefined });
	const latest = key === null ? undefined : (snapshot?.value ?? shown.value);
	if (shown.value !== latest) setShown({ value: latest });
	const value = snapshot?.value ?? (showPrevious ? latest : undefined);
	return {
		status: key === null ? "idle" : (snapshot?.status ?? "loading"),
		value,
		reloading: reloading || ((snapshot?.status ?? "loading") === "loading" && value !== undefined),
		retry: () => void (read && key !== null && read.retry(...args)),
		reload: () => startReload(() => void (read && key !== null && read.refresh(...args))),
		patch: (change) => void (read && key !== null && read.patchInTransition(change, ...args)),
	};
}

export function useLocalRead<A extends unknown[], T>(
	load: (...args: A) => Promise<T>,
	{ initial, ...options }: ReadOptions<T> & { readonly initial?: T },
	...args: A
): ReadState<T> {
	const [read] = useState(() => {
		const local = createRead(load, options);
		if (initial !== undefined) local.seed(initial, ...args);
		return local;
	});
	const state = useRead(read, ...args);
	return state.status === "idle" && initial !== undefined ? { ...state, value: initial } : state;
}

export function Await<T>({
	state,
	fallback,
	children,
}: {
	state: Pick<ReadState<T>, "value">;
	fallback: ReactNode;
	children: (value: T) => ReactNode;
}) {
	return state.value === undefined ? fallback : children(state.value);
}
