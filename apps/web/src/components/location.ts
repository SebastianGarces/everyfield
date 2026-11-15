"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";

type Listener = () => void;
type EntryChange = { navigationType: "push" | "replace" | "reload" | "traverse" | null };
type EntryChanges = {
	addEventListener(type: "currententrychange", listener: (event: EntryChange) => void): void;
};

export type AddressParams = Omit<URLSearchParams, "append" | "delete" | "set" | "sort">;
export type Address = { readonly pathname: string; readonly params: AddressParams };
export type AddressWrite = { replace?: boolean; state?: Record<string, unknown> };
export type AddressRule = (to: URL, from: URL | null) => string | null;

const changes = new Set<Listener>();
const traversals = new Set<Listener>();
const rules: AddressRule[] = [];
let routerBehind = false;
let writing = false;
let shown: string | null = null;

const ORIGIN = "http://address.invalid";
export const currentAddress = () => window.location.pathname + window.location.search;
const urlOf = (href: string | URL) => new URL(href, ORIGIN);

function ruled(to: URL, from: URL | null): string | null {
	for (const rule of rules) {
		const next = rule(to, from);
		if (next !== null) return next;
	}
	return null;
}

function write(href: string | URL, replace: boolean, state: Record<string, unknown> | null) {
	writing = true;
	try {
		if (replace) window.history.replaceState(state, "", href);
		else window.history.pushState(state, "", href);
	} finally {
		writing = false;
	}
	routerBehind = true;
	shown = currentAddress();
}

function traversed() {
	const from = shown === null ? null : urlOf(shown);
	shown = currentAddress();
	const rewrite = ruled(urlOf(shown), from);
	if (rewrite !== null) write(rewrite, true, window.history.state);
	routerBehind = true;
	for (const listener of changes) listener();
	for (const listener of traversals) listener();
}

function routerWrote(event: EntryChange) {
	if (writing || event.navigationType === "traverse") return;
	routerBehind = false;
	shown = currentAddress();
}

if (typeof window !== "undefined") {
	shown = currentAddress();
	window.addEventListener("popstate", traversed);
	(window as { navigation?: EntryChanges }).navigation?.addEventListener("currententrychange", routerWrote);
}

const subscribe = (listener: Listener) => {
	changes.add(listener);
	return () => void changes.delete(listener);
};

export function onTraversal(listener: Listener): () => void {
	traversals.add(listener);
	return () => void traversals.delete(listener);
}

export function addAddressRule(rule: AddressRule): void {
	if (!rules.includes(rule)) rules.push(rule);
}

export function writeAddress(href: string | URL, { replace = false, state }: AddressWrite = {}): void {
	const from = shown === null ? null : urlOf(shown);
	write(ruled(urlOf(href), from) ?? href, replace, state ?? null);
	for (const listener of changes) listener();
}

const marked = (value: string) => (routerBehind ? `+${value}` : `-${value}`);
const newest = (seen: string, router: string) => (seen.startsWith("+") ? seen.slice(1) : router);

export function usePath(): string {
	const router = usePathname();
	const seen = useSyncExternalStore(
		subscribe,
		() => marked(window.location.pathname),
		() => `-${router}`,
	);
	return newest(seen, router);
}

export function useAddress(): Address {
	const pathname = usePathname();
	const search = useSearchParams().toString();
	const router = search ? `${pathname}?${search}` : pathname;
	const seen = useSyncExternalStore(
		subscribe,
		() => marked(currentAddress()),
		() => `-${router}`,
	);
	const href = newest(seen, router);
	return useMemo(() => {
		const url = urlOf(href);
		return { pathname: url.pathname, params: url.searchParams };
	}, [href]);
}
