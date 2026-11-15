type Hold = (go: () => void) => boolean;

let hold: Hold | null = null;

export function holdLeave(next: Hold): () => void {
	hold = next;
	return () => {
		if (hold === next) hold = null;
	};
}

export function leavePage(go: () => void): void {
	if (!hold?.(go)) go();
}

export const SAVE_SHORTCUT = "Meta+S Control+S Meta+Shift+S Control+Shift+S";

export const shortcutMark = (combos: string) => ({ "data-shortcut": combos, "aria-keyshortcuts": combos });

export const unsavedMark = (unsaved: boolean) => (unsaved ? { "data-unsaved": "" } : {});

const MODIFIERS = ["Meta", "Control", "Alt", "Shift"] as const;

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]") !== null;

function matches(combo: string, event: KeyboardEvent): boolean {
	const parts = combo.split("+");
	const key = parts.pop()?.toLowerCase() ?? "";
	if ((event.key ?? "").toLowerCase() !== key) return false;
	const held = { Meta: event.metaKey, Control: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey };
	if (MODIFIERS.some((m) => held[m] !== parts.includes(m))) return false;
	return parts.length > 0 || !typing(event.target);
}

function shortcutTarget(event: KeyboardEvent): HTMLElement | null {
	for (const element of document.querySelectorAll<HTMLElement>("[data-shortcut]")) {
		if (!element.isConnected || (element.checkVisibility && !element.checkVisibility())) continue;
		const combos = (element.getAttribute("data-shortcut") ?? "").split(/\s+/);
		if (combos.some((combo) => combo && matches(combo, event))) return element;
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
	if (target.matches(":disabled, [aria-disabled=true], [aria-busy=true]")) return;
	event.preventDefault();
	target.click();
}

function onBeforeUnload(event: BeforeUnloadEvent) {
	if (!document.querySelector("[data-unsaved]")) return;
	event.preventDefault();
	event.returnValue = "";
}

type Installed = { keydown: (event: KeyboardEvent) => void; beforeunload: (event: BeforeUnloadEvent) => void };
const INSTALLED = Symbol.for("everyfield.page-events");

if (typeof window !== "undefined") {
	const host = window as unknown as Record<symbol, Installed | undefined>;
	const previous = host[INSTALLED];
	if (previous) {
		window.removeEventListener("keydown", previous.keydown);
		window.removeEventListener("beforeunload", previous.beforeunload);
	}
	host[INSTALLED] = { keydown: onKeyDown, beforeunload: onBeforeUnload };
	window.addEventListener("keydown", onKeyDown);
	window.addEventListener("beforeunload", onBeforeUnload);
}
