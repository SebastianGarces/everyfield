"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useSyncExternalStore } from "react";
import { ONE_TIME_LINK_VALUES, oneTimeLinkValue, type LinkWindow, type OneTimeLinkName } from "./one-time-link.ts";

type Listener = () => void;
type EntryChange = { navigationType: "push" | "replace" | "reload" | "traverse" | null };
type EntryChanges = {
	addEventListener(type: "currententrychange", listener: (event: EntryChange) => void): void;
	removeEventListener(type: "currententrychange", listener: (event: EntryChange) => void): void;
};

export type AddressParams = Omit<URLSearchParams, "append" | "delete" | "set" | "sort">;
export type Address = { readonly pathname: string; readonly params: AddressParams };
export type AddressWrite = { replace?: boolean; state?: Record<string, unknown> };
export type AddressRule = (to: URL, from: URL | null) => string | null;

const changes = new Set<Listener>();
const linkValueReaders = new Set<Listener>();
const traversals = new Set<Listener>();
const navigations = new Set<Listener>();
const rules = new Map<string, AddressRule>();
let routerBehind = false;
let writing = false;
let shown: string | null = null;

const ORIGIN = "http://address.invalid";
export const currentAddress = () => window.location.pathname + window.location.search;
const fullAddress = () => currentAddress() + window.location.hash;
const urlOf = (href: string | URL) => new URL(href, ORIGIN);

function ruled(to: URL, from: URL | null): string | null {
	for (const rule of rules.values()) {
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
	shown = fullAddress();
}

const storeWindow: LinkWindow = {
	get location() {
		return window.location;
	},
	history: {
		get state() {
			return window.history.state;
		},
		replaceState: (state, _unused, url) => write(url, true, (state ?? null) as Record<string, unknown> | null),
	},
	get sessionStorage() {
		return window.sessionStorage;
	},
};

const readLinkValues = () => {
	for (const reader of linkValueReaders) reader();
};

function takeLinkValue(): void {
	if (oneTimeLinkValue(ONE_TIME_LINK_VALUES, storeWindow, true)?.value) readLinkValues();
}

function traversed() {
	const from = shown === null ? null : urlOf(shown);
	takeLinkValue();
	shown = fullAddress();
	const rewrite = ruled(urlOf(shown), from);
	if (rewrite !== null) write(rewrite, true, window.history.state);
	routerBehind = true;
	for (const listener of changes) listener();
	for (const listener of traversals) listener();
	navigated();
}

function navigated() {
	for (const listener of [...navigations]) listener();
}

function linkFollowed(event: MouseEvent) {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
	if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return;
	if ((link.target && link.target !== "_self") || link.origin !== window.location.origin) return;
	navigated();
}

function routerWrote(event: EntryChange) {
	if (writing || event.navigationType === "traverse") return;
	routerBehind = false;
	shown = fullAddress();
}

type Installed = {
	popstate: () => void;
	entry: (event: EntryChange) => void;
	click: (event: MouseEvent) => void;
};
const INSTALLED = Symbol.for("everyfield.location");

if (typeof window !== "undefined") {
	const host = window as unknown as Record<symbol, Installed | undefined>;
	const navigation = (window as { navigation?: EntryChanges }).navigation;
	const previous = host[INSTALLED];
	if (previous) {
		window.removeEventListener("popstate", previous.popstate);
		navigation?.removeEventListener("currententrychange", previous.entry);
		document.removeEventListener("click", previous.click);
	}
	host[INSTALLED] = { popstate: traversed, entry: routerWrote, click: linkFollowed };
	shown = fullAddress();
	window.addEventListener("popstate", traversed);
	navigation?.addEventListener("currententrychange", routerWrote);
	document.addEventListener("click", linkFollowed);
}

const subscribe = (listener: Listener) => {
	changes.add(listener);
	return () => void changes.delete(listener);
};

export function onTraversal(listener: Listener): () => void {
	traversals.add(listener);
	return () => void traversals.delete(listener);
}

export function onNavigation(listener: Listener): () => void {
	navigations.add(listener);
	return () => void navigations.delete(listener);
}

export function addAddressRule(name: string, rule: AddressRule): void {
	rules.set(name, rule);
}

export function writeAddress(href: string | URL, { replace = false, state }: AddressWrite = {}): void {
	const from = shown === null ? null : urlOf(shown);
	write(ruled(urlOf(href), from) ?? href, replace, state ?? null);
	for (const listener of changes) listener();
	navigated();
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

const subscribeLinkValue = (listener: Listener) => {
	linkValueReaders.add(listener);
	return () => void linkValueReaders.delete(listener);
};

function linkValueNow(name: OneTimeLinkName): string | null {
	const at = oneTimeLinkValue(ONE_TIME_LINK_VALUES, storeWindow, false);
	if (at?.name !== name) return null;
	return at.value ?? (at.key === null ? null : window.sessionStorage.getItem(at.key));
}

export function useOneTimeLinkValue(name: OneTimeLinkName): string | null | undefined {
	return useSyncExternalStore(
		subscribeLinkValue,
		() => linkValueNow(name),
		() => undefined,
	);
}

export function forgetOneTimeLinkValue(name: OneTimeLinkName): void {
	const at = oneTimeLinkValue(ONE_TIME_LINK_VALUES, storeWindow, false);
	if (at?.name !== name) return;
	if (at.value !== null) oneTimeLinkValue(ONE_TIME_LINK_VALUES, storeWindow, true);
	if (at.key !== null) window.sessionStorage.removeItem(at.key);
	readLinkValues();
	if (at.value !== null) for (const listener of changes) listener();
}
