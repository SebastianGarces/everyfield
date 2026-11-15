"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";

type Listener = () => void;
type EntryChange = { navigationType: "push" | "replace" | "reload" | "traverse" | null };
type EntryChanges = {
	addEventListener(type: "currententrychange", listener: (event: EntryChange) => void): void;
	removeEventListener(type: "currententrychange", listener: (event: EntryChange) => void): void;
};

export type AddressParams = Omit<URLSearchParams, "append" | "delete" | "set" | "sort">;
export type Address = { readonly pathname: string; readonly params: AddressParams };
export type AddressWrite = { replace?: boolean; state?: Record<string, unknown> };

const changes = new Set<Listener>();
const traversals = new Set<Listener>();
let routerBehind = false;
let writing = false;

const entryChanges = () => (window as { navigation?: EntryChanges }).navigation;

function traversed() {
	routerBehind = true;
	for (const listener of changes) listener();
	for (const listener of traversals) listener();
}

function routerWrote(event: EntryChange) {
	if (!writing && event.navigationType !== "traverse") routerBehind = false;
}

function watch(set: Set<Listener>, listener: Listener): () => void {
	if (changes.size + traversals.size === 0) {
		window.addEventListener("popstate", traversed);
		entryChanges()?.addEventListener("currententrychange", routerWrote);
	}
	set.add(listener);
	return () => {
		set.delete(listener);
		if (changes.size + traversals.size > 0) return;
		window.removeEventListener("popstate", traversed);
		entryChanges()?.removeEventListener("currententrychange", routerWrote);
	};
}

const subscribe = (listener: Listener) => watch(changes, listener);

export const onTraversal = (listener: Listener) => watch(traversals, listener);

export const traversalRef =
	(listener: Listener) =>
	(node: Element | null): (() => void) | undefined =>
		node ? onTraversal(listener) : undefined;

export const currentAddress = () => window.location.pathname + window.location.search;

export function writeAddress(href: string | URL, { replace = false, state }: AddressWrite = {}): void {
	writing = true;
	try {
		if (replace) window.history.replaceState(state ?? null, "", href);
		else window.history.pushState(state ?? null, "", href);
	} finally {
		writing = false;
	}
	routerBehind = true;
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

let last: { href: string; address: Address } | null = null;

function addressOf(href: string): Address {
	if (last?.href === href) return last.address;
	const url = new URL(href, "http://address.invalid");
	last = { href, address: { pathname: url.pathname, params: url.searchParams } };
	return last.address;
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
	return addressOf(newest(seen, router));
}
