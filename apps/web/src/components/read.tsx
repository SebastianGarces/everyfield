"use client";

import { useHydrated } from "@everyfield/ui/foundations";
import { Suspense, use, useState, useTransition, type ReactNode } from "react";

type Tracked<T> = Promise<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T };

export type Read<A extends unknown[], T> = {
	key(...args: A): string;
	get(...args: A): Promise<T>;
	refresh(...args: A): Promise<T>;
	prefetch(...args: A): void;
	seed(value: T, ...args: A): void;
	forget(...args: A): void;
};

export type ReadOptions<T> = {
	failed: (error: unknown) => T;
	fresh?: number;
	keep?: (value: T) => boolean;
};

export type ReadState<T> = {
	promise: Promise<T> | null;
	retry(): void;
	reload(): void;
	reloading: boolean;
	patch(change: (value: T) => T): void;
};

const outcomeOk = (value: unknown) =>
	!(typeof value === "object" && value !== null && "status" in value && value.status !== "ok");

function track<T>(promise: Promise<T>): Tracked<T> {
	const tracked = promise as Tracked<T>;
	void promise.then((value) => {
		tracked.status = "fulfilled";
		tracked.value = value;
	});
	return tracked;
}

export function settled<T>(value: T): Promise<T> {
	const promise = Promise.resolve(value) as Tracked<T>;
	promise.status = "fulfilled";
	promise.value = value;
	return promise;
}

export function createRead<A extends unknown[], T>(
	load: (...args: A) => Promise<T>,
	{ failed, fresh = 0, keep = outcomeOk }: ReadOptions<T>,
): Read<A, T> {
	const entries = new Map<string, { at: number; promise: Tracked<T> }>();
	const key = (...args: A) => JSON.stringify(args);
	const current = (at: number, promise: Tracked<T>) => promise.status !== "fulfilled" || Date.now() - at < fresh;
	const start = (k: string, args: A) => {
		for (const [old, entry] of entries) if (!current(entry.at, entry.promise)) entries.delete(old);
		const promise = track(new Promise<T>((resolve) => resolve(load(...args))).catch(failed));
		const entry = { at: Date.now(), promise };
		entries.set(k, entry);
		void promise.then((value) => {
			if (!keep(value) && entries.get(k) === entry) entries.delete(k);
		});
		return promise;
	};
	const get = (...args: A) => {
		const k = key(...args);
		const entry = entries.get(k);
		return entry && current(entry.at, entry.promise) ? entry.promise : start(k, args);
	};
	return {
		key,
		get,
		refresh: (...args) => start(key(...args), args),
		prefetch: (...args) => void get(...args),
		seed: (value, ...args) => void entries.set(key(...args), { at: Date.now(), promise: settled(value) as Tracked<T> }),
		forget: (...args) => void entries.delete(key(...args)),
	};
}

export function useRead<A extends unknown[], T>(read: Read<A, T> | null, ...args: A): ReadState<T> {
	const hydrated = useHydrated();
	const key = read && hydrated ? read.key(...args) : null;
	const [held, setHeld] = useState<{ key: string; promise: Promise<T> } | null>(null);
	const [reloading, startReload] = useTransition();
	let shown = key === null ? null : held;
	if (read && key !== null && held?.key !== key) {
		shown = { key, promise: read.get(...args) };
		setHeld(shown);
	}
	const again = () => {
		if (read && key !== null) setHeld({ key, promise: read.refresh(...args) });
	};
	return {
		promise: shown?.promise ?? null,
		retry: again,
		reload: () => startReload(again),
		reloading,
		patch: (change) => {
			const promise = shown?.promise as Tracked<T> | undefined;
			if (!read || key === null || promise?.status !== "fulfilled") return;
			const value = change(promise.value as T);
			read.seed(value, ...args);
			setHeld({ key, promise: settled(value) });
		},
	};
}

export function Await<T>({
	promise,
	fallback,
	children,
}: {
	promise: Promise<T> | null;
	fallback: ReactNode;
	children: (value: T) => ReactNode;
}) {
	if (!promise) return fallback;
	return (
		<Suspense fallback={fallback}>
			<Resolved promise={promise}>{children}</Resolved>
		</Suspense>
	);
}

function Resolved<T>({ promise, children }: { promise: Promise<T>; children: (value: T) => ReactNode }) {
	return children(use(promise));
}
