"use client";

import { useHydrated } from "@everyfield/ui/foundations";
import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";

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
	subscribe(listener: () => void): () => void;
};

export type ReadOptions<T> = {
	failed: (error: unknown) => T;
	fresh?: number;
	keep?: (value: T) => boolean;
};

export type ReadState<T> = {
	status: "idle" | "loading" | "ready";
	value: T | undefined;
	promise: Promise<T> | null;
	reloading: boolean;
	retry(): void;
	reload(): void;
	patch(change: (value: T) => T): void;
};

type Entry<T> = ReadSnapshot<T> & { at: number; reusable: boolean };

const outcomeOk = (value: unknown) =>
	!(typeof value === "object" && value !== null && "status" in value && value.status !== "ok");

export function createRead<A extends unknown[], T>(
	load: (...args: A) => Promise<T>,
	{ failed, fresh = 0, keep = outcomeOk }: ReadOptions<T>,
): Read<A, T> {
	const entries = new Map<string, Entry<T>>();
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const key = (...args: A) => JSON.stringify(args);

	const settle = (k: string, promise: Promise<T>) =>
		void promise.then((value) => {
			if (entries.get(k)?.promise !== promise) return;
			entries.set(k, { status: "ready", value, promise, at: Date.now(), reusable: keep(value) });
			emit();
		});
	const start = (k: string, promise: Promise<T>, value: T | undefined) => {
		entries.set(k, { status: "loading", value, promise, at: Date.now(), reusable: true });
		settle(k, promise);
		return promise;
	};
	const run = (args: A) => new Promise<T>((resolve) => resolve(load(...args))).catch(failed);
	const usable = (entry: Entry<T> | undefined) =>
		entry !== undefined && (entry.status === "loading" || (entry.reusable && Date.now() - entry.at < fresh));

	const get = (...args: A) => {
		const k = key(...args);
		const entry = entries.get(k);
		return usable(entry) ? entry!.promise : start(k, run(args), undefined);
	};
	const again = (args: A, keepValue: boolean) => {
		const k = key(...args);
		const promise = start(k, run(args), keepValue ? entries.get(k)?.value : undefined);
		emit();
		return promise;
	};
	return {
		key,
		get,
		peek: (...args) => entries.get(key(...args)) ?? null,
		prefetch: (...args) => void get(...args),
		seed: (value, ...args) => {
			const k = key(...args);
			if (entries.has(k)) return;
			if (value instanceof Promise) start(k, value.catch(failed), undefined);
			else entries.set(k, { status: "ready", value, promise: Promise.resolve(value), at: Date.now(), reusable: true });
		},
		refresh: (...args) => again(args, true),
		retry: (...args) => again(args, false),
		patch: (change, ...args) => {
			const k = key(...args);
			const entry = entries.get(k);
			if (entry?.status !== "ready" || entry.value === undefined) return;
			const value = change(entry.value);
			entries.set(k, { status: "ready", value, promise: Promise.resolve(value), at: Date.now(), reusable: true });
			emit();
		},
		forget: (...args) => {
			if (args.length === 0) entries.clear();
			else entries.delete(key(...(args as A)));
			emit();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}

const none = () => () => {};

export function useRead<A extends unknown[], T>(read: Read<A, T> | null, ...args: A): ReadState<T> {
	const hydrated = useHydrated();
	const key = read && hydrated ? read.key(...args) : null;
	const [started, setStarted] = useState<string | null>(null);
	const [reloading, startReload] = useTransition();
	if (read && key !== null && (started !== key || read.peek(...args) === null)) {
		read.get(...args);
		if (started !== key) setStarted(key);
	}
	const snapshot = useSyncExternalStore(
		read?.subscribe ?? none,
		() => (read && key !== null ? read.peek(...args) : null),
		() => null,
	);
	return {
		status: snapshot === null ? "idle" : snapshot.status,
		value: snapshot?.value,
		promise: snapshot?.promise ?? null,
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
