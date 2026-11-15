import { useSyncExternalStore } from "react";
import { currentAddress, fullAddress, onNavigation, onTraversal, writeAddress } from "../location.ts";

type Hold = (go: () => void) => boolean;
export type LeaveRequest = { readonly leave: () => void; readonly stay: () => void };
export type LeaveBeacon = { readonly url: string; readonly body: unknown };

let hold: Hold | null = null;
let request: LeaveRequest | null = null;
let released = false;
let followed: HTMLAnchorElement | null = null;
let armed = false;
let leaving = false;
let home: string | null = null;
const requestReaders = new Set<() => void>();
const sentBeacons = new WeakMap<Element, string>();

export function holdLeave(next: Hold): () => void {
	hold = next;
	return () => {
		if (hold === next) hold = null;
	};
}

const holding = () => document.querySelector("[data-unsaved][data-leave-hold]") !== null;

const readRequest = () => {
	for (const reader of requestReaders) reader();
};

function dropRequest() {
	if (request === null) return;
	request = null;
	readRequest();
}

function ask(leave: () => void, stay: () => void = () => {}) {
	released = false;
	const settle = (then: () => void) => () => {
		if (request !== asked) return;
		request = null;
		readRequest();
		then();
	};
	const asked: LeaveRequest = { leave: settle(leave), stay: settle(stay) };
	request = asked;
	readRequest();
}

export function leavePage(go: () => void): void {
	if (hold?.(go)) return;
	if (!holding()) return go();
	ask(() => {
		released = true;
		go();
	});
}

const subscribeRequest = (reader: () => void) => {
	requestReaders.add(reader);
	return () => void requestReaders.delete(reader);
};

export const leaveRequestNow = (): LeaveRequest | null => request;

export function useLeaveRequest(): LeaveRequest | null {
	return useSyncExternalStore(subscribeRequest, leaveRequestNow, () => null);
}

export const SAVE_SHORTCUT = "Meta+S Control+S Meta+Shift+S Control+Shift+S";

export const shortcutMark = (
	combos: string,
	{ claim = false, inFields = false }: { claim?: boolean; inFields?: boolean } = {},
) => ({
	"data-shortcut": combos,
	"aria-keyshortcuts": combos,
	...(claim ? { "data-shortcut-claim": "" } : {}),
	...(inFields ? { "data-shortcut-fields": "" } : {}),
});

export const unsavedMark = (unsaved: boolean) => (unsaved ? { "data-unsaved": "" } : {});

export const leaveHoldMark = (unsaved: boolean) => (unsaved ? { "data-unsaved": "", "data-leave-hold": "" } : {});

export const leaveBeaconMark = (beacon: LeaveBeacon | null) =>
	beacon ? { "data-leave-beacon": JSON.stringify(beacon) } : {};

const onGuardEntry = () => (window.history.state as { efLeaveGuard?: unknown } | null)?.efLeaveGuard === true;
const here = () => currentAddress();

function pushGuardEntry() {
	writeAddress(fullAddress(), {
		state: { ...(window.history.state as Record<string, unknown> | null), efLeaveGuard: true },
	});
	armed = true;
}

export function armLeaveHold(): void {
	if (onGuardEntry()) return;
	home = here();
	pushGuardEntry();
}

function traversed() {
	const left = armed;
	armed = onGuardEntry();
	if (here() !== home) dropRequest();
	if (leaving) {
		leaving = false;
		return;
	}
	if (!left || armed || here() !== home) return;
	const back = () => {
		leaving = true;
		window.history.back();
	};
	if (holding()) ask(back, pushGuardEntry);
	else back();
}

function navigated(to: string) {
	released = false;
	if (to.split("#")[0] !== home) dropRequest();
}

const MODIFIERS = ["Meta", "Control", "Alt", "Shift"] as const;

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]") !== null;

const SHIFTED_CHARACTER = /^[^\p{L}\p{N}\s]$/u;

function matches(combo: string, event: KeyboardEvent, inFields: boolean): boolean {
	const parts = combo.split("+");
	const key = parts.pop()?.toLowerCase() ?? "";
	if ((event.key ?? "").toLowerCase() !== key) return false;
	const shiftFree = !parts.includes("Shift") && SHIFTED_CHARACTER.test(key);
	const held = { Meta: event.metaKey, Control: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey };
	if (MODIFIERS.some((m) => !(m === "Shift" && shiftFree) && held[m] !== parts.includes(m))) return false;
	return parts.length > 0 || inFields || !typing(event.target);
}

function shortcutTarget(event: KeyboardEvent): HTMLElement | null {
	for (const element of document.querySelectorAll<HTMLElement>("[data-shortcut]")) {
		if (!element.isConnected || (element.checkVisibility && !element.checkVisibility())) continue;
		const combos = (element.getAttribute("data-shortcut") ?? "").split(/\s+/);
		const inFields = element.hasAttribute("data-shortcut-fields");
		if (combos.some((combo) => combo && matches(combo, event, inFields))) return element;
	}
	return null;
}

function onKeyDown(event: KeyboardEvent) {
	if (event.defaultPrevented) return;
	const target = shortcutTarget(event);
	if (!target) return;
	if (target instanceof HTMLFormElement) {
		event.preventDefault();
		target.requestSubmit();
		return;
	}
	if (target.matches(":disabled, [aria-disabled=true], [aria-busy=true]")) {
		if (target.hasAttribute("data-shortcut-claim")) event.preventDefault();
		return;
	}
	event.preventDefault();
	target.click();
}

function onClick(event: MouseEvent) {
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
	const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
	if (!(link instanceof HTMLAnchorElement) || link === followed) return;
	if (link.hasAttribute("download") || link.target === "_blank") return;
	const url = new URL(link.href, window.location.href);
	if (url.origin !== window.location.origin) return;
	if (url.pathname === window.location.pathname && url.search === window.location.search) return;
	if (!holding()) return;
	event.preventDefault();
	event.stopPropagation();
	ask(() => {
		followed = link;
		try {
			link.click();
		} finally {
			followed = null;
		}
	});
}

function onBeforeUnload(event: BeforeUnloadEvent) {
	if (released || !document.querySelector("[data-unsaved]")) return;
	event.preventDefault();
	event.returnValue = "";
}

function onPageHide() {
	for (const element of document.querySelectorAll<HTMLElement>("[data-leave-beacon]")) {
		const marked = element.getAttribute("data-leave-beacon") ?? "null";
		const beacon = JSON.parse(marked) as LeaveBeacon | null;
		if (!beacon || sentBeacons.get(element) === marked) continue;
		sentBeacons.set(element, marked);
		void fetch(beacon.url, {
			method: "POST",
			keepalive: true,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(beacon.body),
		}).catch(() => undefined);
	}
}

type Installed = {
	keydown: (event: KeyboardEvent) => void;
	beforeunload: (event: BeforeUnloadEvent) => void;
	click: (event: MouseEvent) => void;
	pagehide: () => void;
	traversal: () => void;
	navigation: () => void;
};
const INSTALLED = Symbol.for("everyfield.page-events");

if (typeof window !== "undefined") {
	const host = window as unknown as Record<symbol, Installed | undefined>;
	const previous = host[INSTALLED];
	if (previous) {
		window.removeEventListener("keydown", previous.keydown);
		window.removeEventListener("beforeunload", previous.beforeunload);
		window.removeEventListener("click", previous.click, true);
		window.removeEventListener("pagehide", previous.pagehide);
		previous.traversal();
		previous.navigation();
	}
	armed = onGuardEntry();
	home = armed ? here() : null;
	host[INSTALLED] = {
		keydown: onKeyDown,
		beforeunload: onBeforeUnload,
		click: onClick,
		pagehide: onPageHide,
		traversal: onTraversal(traversed),
		navigation: onNavigation(navigated),
	};
	window.addEventListener("keydown", onKeyDown);
	window.addEventListener("beforeunload", onBeforeUnload);
	window.addEventListener("click", onClick, true);
	window.addEventListener("pagehide", onPageHide);
}
