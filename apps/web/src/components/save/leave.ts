type Hold = (go: () => void) => boolean;
type NodeRef = (node: Element | null) => (() => void) | undefined;

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

type Combo = { key: string; mod: boolean; shift: boolean; alt: boolean };
type Run = (event: KeyboardEvent) => boolean | void;
type Shortcut = { combo: Combo; run: Run };

const shortcuts = new Set<Shortcut>();
const unloadHolds = new Set<() => boolean>();

function parseCombo(text: string): Combo {
	const parts = text.toLowerCase().split("+");
	const key = parts.pop() ?? "";
	return { key, mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
}

const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]") !== null;

function matches({ combo }: Shortcut, event: KeyboardEvent): boolean {
	if ((event.key ?? "").toLowerCase() !== combo.key) return false;
	if (event.metaKey || event.ctrlKey ? !combo.mod : combo.mod) return false;
	if (event.altKey !== combo.alt) return false;
	if (combo.shift && !event.shiftKey) return false;
	return combo.mod || !typing(event.target);
}

function onKeyDown(event: KeyboardEvent) {
	for (const shortcut of [...shortcuts].reverse()) {
		if (!matches(shortcut, event) || shortcut.run(event) === false) continue;
		event.preventDefault();
		return;
	}
}

function onBeforeUnload(event: BeforeUnloadEvent) {
	for (const unsaved of unloadHolds)
		if (unsaved()) {
			event.preventDefault();
			event.returnValue = "";
			return;
		}
}

export function registerShortcut(combo: string, run: Run): () => void {
	const shortcut = { combo: parseCombo(combo), run };
	if (shortcuts.size === 0) window.addEventListener("keydown", onKeyDown);
	shortcuts.add(shortcut);
	return () => {
		shortcuts.delete(shortcut);
		if (shortcuts.size === 0) window.removeEventListener("keydown", onKeyDown);
	};
}

export function holdUnload(unsaved: () => boolean): () => void {
	if (unloadHolds.size === 0) window.addEventListener("beforeunload", onBeforeUnload);
	unloadHolds.add(unsaved);
	return () => {
		unloadHolds.delete(unsaved);
		if (unloadHolds.size === 0) window.removeEventListener("beforeunload", onBeforeUnload);
	};
}

export const shortcutRef =
	(combo: string, run: Run): NodeRef =>
	(node) =>
		node ? registerShortcut(combo, run) : undefined;

export const unloadHoldRef =
	(unsaved: () => boolean): NodeRef =>
	(node) =>
		node ? holdUnload(unsaved) : undefined;
