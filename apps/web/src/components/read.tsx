"use client";

import { useHydrated } from "@everyfield/ui/foundations";
import { useMemo, useSyncExternalStore, useTransition, type ReactNode } from "react";

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
};

export type ReadOptions<T> = {
	failed: (error: unknown) => T;
	fresh?: number;
	keep?: (value: T) => boolean;
};

export type ReadState<T> = {
	status: "idle" | "loading" | "ready";
	value: T | undefined;
	reloading: boolean;
	retry(): void;
	reload(): void;
	patch(change: (value: T) => T): void;
};

type Entry<T> = ReadSnapshot<T> & { at: number; reusable: boolean; unread: boolean };

const outcomeOk = (value: unknown) =>
	!(typeof value === "object" && value !== null && "status" in value && value.status !== "ok");

export function createRead<A extends unknown[], T>(
	load: (...args: A) => Promise<T>,
	{ failed, fresh = 0, keep = outcomeOk }: ReadOptions<T>,
): Read<A, T> {
	const entries = new Map<string, Entry<T>>();
	const listeners = new Set<() => void>();
	const readers = new Map<string, number>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const key = (...args: A) => JSON.stringify(args);
	const watched = (k: string) => (readers.get(k) ?? 0) > 0;

	const usable = (entry: Entry<T> | undefined) =>
		entry !== undefined && (entry.status === "loading" || (entry.reusable && Date.now() - entry.at < fresh));

	const start = (k: string, args: A, keepValue: boolean) => {
		const promise = new Promise<T>((resolve) => resolve(load(...args))).catch(failed);
		const previous = keepValue ? entries.get(k)?.value : undefined;
		entries.set(k, {
			status: "loading",
			value: previous,
			promise,
			at: Date.now(),
			reusable: true,
			unread: !watched(k),
		});
		void promise.then((value) => {
			const entry = entries.get(k);
			if (entry?.promise !== promise) return;
			entries.set(k, { ...entry, status: "ready", value, at: Date.now(), reusable: keep(value) });
			emit();
		});
		emit();
		return promise;
	};

	const get = (...args: A) => {
		const k = key(...args);
		const entry = entries.get(k);
		return usable(entry) ? entry!.promise : start(k, args, watched(k));
	};

	return {
		key,
		get,
		peek: (...args) => entries.get(key(...args)) ?? null,
		prefetch: (...args) => void get(...args),
		seed: (value, ...args) => {
			const k = key(...args);
			if (entries.has(k)) return;
			const promise = value instanceof Promise ? value.catch(failed) : Promise.resolve(value);
			if (value instanceof Promise) {
				entries.set(k, { status: "loading", value: undefined, promise, at: Date.now(), reusable: true, unread: true });
				void promise.then((settled) => {
					const entry = entries.get(k);
					if (entry?.promise !== promise) return;
					entries.set(k, { ...entry, status: "ready", value: settled, at: Date.now(), reusable: keep(settled) });
					emit();
				});
			} else entries.set(k, { status: "ready", value, promise, at: Date.now(), reusable: true, unread: true });
		},
		refresh: (...args) => start(key(...args), args, true),
		retry: (...args) => start(key(...args), args, false),
		patch: (change, ...args) => {
			const k = key(...args);
			const entry = entries.get(k);
			if (entry?.status !== "ready" || entry.value === undefined) return;
			const value = change(entry.value);
			entries.set(k, { ...entry, value, promise: Promise.resolve(value), at: Date.now(), reusable: true });
			emit();
		},
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
		connect: (listener, ...args) => {
			const k = key(...args);
			listeners.add(listener);
			const entry = entries.get(k);
			const others = watched(k);
			readers.set(k, (readers.get(k) ?? 0) + 1);
			if (usable(entry)) entry!.unread = false;
			else start(k, args, others || entry?.unread === true);
			return () => {
				listeners.delete(listener);
				const left = (readers.get(k) ?? 1) - 1;
				if (left > 0) readers.set(k, left);
				else readers.delete(k);
			};
		},
	};
}

const none = () => () => {};

export function useRead<A extends unknown[], T>(read: Read<A, T> | null, ...args: A): ReadState<T> {
	const hydrated = useHydrated();
	const key = read && hydrated ? read.key(...args) : null;
	const [reloading, startReload] = useTransition();
	const connect = useMemo(
		() => (read && key !== null ? (listener: () => void) => read.connect(listener, ...(JSON.parse(key) as A)) : none),
		[read, key],
	);
	const snapshot = useSyncExternalStore(
		connect,
		() => (read && key !== null ? read.snapshot(key) : null),
		() => null,
	);
	return {
		status: key === null ? "idle" : (snapshot?.status ?? "loading"),
		value: snapshot?.value,
		reloading: reloading || (snapshot?.status === "loading" && snapshot.value !== undefined),
		retry: () => void (read && key !== null && read.retry(...args)),
		reload: () => startReload(() => void (read && key !== null && read.refresh(...args))),
		patch: (change) => void (read && key !== null && read.patch(change, ...args)),
	};
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
