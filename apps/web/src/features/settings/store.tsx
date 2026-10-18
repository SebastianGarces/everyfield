"use client";

import type { Loadable } from "@everyfield/ui/display";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { errorReference, errorText, sameValue } from "./model";
import type { GetSectionRequest, SectionKey, SectionResult, SettingsPort, SettingsViewer } from "./port";

// The settings store lives as long as the dialog's route layout, so a section's draft survives switching sections and
// back/forward (WP-010/ui R2). It is keyed by account and context by its owner (SettingsProvider), so switching
// account remounts it and no draft or cached section crosses accounts.

type Draft = { value: unknown; dirty: boolean };

type StoreValue = {
	port: SettingsPort;
	viewer: SettingsViewer;
	drafts: Partial<Record<SectionKey, Draft>>;
	setDraft: (key: SectionKey, value: unknown, dirty: boolean) => void;
	settleDraft: (key: SectionKey, sent: unknown) => void;
	flows: Record<string, unknown>;
	setFlow: (key: string, update: (prev: unknown) => unknown) => void;
	clearDrafts: () => void;
	sections: Map<string, SectionResult>;
	remember: (cacheKey: string, value: SectionResult) => void;
};

const Store = createContext<StoreValue | null>(null);

function useStore(): StoreValue {
	const store = use(Store);
	if (!store) throw new Error("Settings screens need a SettingsProvider above them.");
	return store;
}

export function SettingsProvider({
	port,
	viewer,
	children,
}: {
	port: SettingsPort;
	viewer: SettingsViewer;
	children: ReactNode;
}) {
	const [drafts, setDrafts] = useState<Partial<Record<SectionKey, Draft>>>({});
	const [sections, setSections] = useState(() => new Map<string, SectionResult>());
	const setDraft = useCallback(
		(key: SectionKey, value: unknown, dirty: boolean) =>
			setDrafts((all) => {
				if (!dirty) {
					if (!(key in all)) return all;
					const next = { ...all };
					delete next[key];
					return next;
				}
				return { ...all, [key]: { value, dirty } };
			}),
		[],
	);
	const clearDrafts = useCallback(() => setDrafts({}), []);
	const [flows, setFlows] = useState<Record<string, unknown>>({});
	const setFlow = useCallback(
		(key: string, update: (prev: unknown) => unknown) => setFlows((all) => ({ ...all, [key]: update(all[key]) })),
		[],
	);
	// After a successful save, drop the draft only if it is still exactly what was sent. An edit made while the
	// save was pending stays as a draft.
	const settleDraft = useCallback(
		(key: SectionKey, sent: unknown) =>
			setDrafts((all) => {
				if (!all[key] || !sameValue(all[key].value, sent)) return all;
				const next = { ...all };
				delete next[key];
				return next;
			}),
		[],
	);
	const remember = useCallback(
		(cacheKey: string, value: SectionResult) => setSections((all) => new Map(all).set(cacheKey, value)),
		[],
	);
	const value = useMemo(
		() => ({ port, viewer, drafts, setDraft, settleDraft, clearDrafts, sections, remember, flows, setFlow }),
		[port, viewer, drafts, setDraft, settleDraft, clearDrafts, sections, remember, flows, setFlow],
	);

	// A reload or tab close with unsaved drafts asks the browser to confirm.
	const anyDirty = Object.keys(drafts).length > 0;
	useEffect(() => {
		if (!anyDirty) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [anyDirty]);

	return <Store value={value}>{children}</Store>;
}

export function useSettings() {
	const { port, viewer } = useStore();
	return { port, viewer };
}

/** The sections that hold unsaved drafts. */
export function useDirtySections(): { keys: SectionKey[]; clear: () => void } {
	const { drafts, clearDrafts } = useStore();
	return { keys: Object.keys(drafts) as SectionKey[], clear: clearDrafts };
}

/**
 * A section's draft. It starts from the saved value and stays in the store until it matches the saved value again
 * or a save of it succeeds, so leaving the section and coming back keeps what was typed. A section is dirty exactly
 * when the store holds its draft: the footer, the nav mark and the close guard read the same fact. `settle(sent)`
 * after a successful save drops the draft if it is still what was sent (so "Name " saved as "Name" is clean).
 */
export function useDraft<T>(
	key: SectionKey,
	saved: T,
): { draft: T; setDraft: (next: T) => void; dirty: boolean; reset: () => void; settle: (sent: T) => void } {
	const { drafts, setDraft, settleDraft } = useStore();
	const stored = drafts[key];
	const draft = stored ? (stored.value as T) : saved;
	return {
		draft,
		dirty: stored !== undefined,
		setDraft: (next: T) => setDraft(key, next, !sameValue(next, saved)),
		settle: (sent: T) => settleDraft(key, sent),
		reset: () => setDraft(key, saved, false),
	};
}

/**
 * State of a multi-step flow that must outlive its section, such as an email link that is sending or was sent.
 * It lives in the store, so switching sections and coming back shows the same step, and a reply that arrives while
 * another section is open still lands. Switching account remounts the store and drops it.
 */
export function useFlowState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
	const { flows, setFlow } = useStore();
	const value = (key in flows ? flows[key] : initial) as T;
	const set = useCallback(
		(next: T | ((prev: T) => T)) =>
			setFlow(key, (prev) => {
				const current = (prev === undefined ? initial : prev) as T;
				return typeof next === "function" ? (next as (p: T) => T)(current) : next;
			}),
		// `initial` is a constant per call site.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[key, setFlow],
	);
	return [value, set];
}

function cacheKeyOf(request: GetSectionRequest): string {
	return JSON.stringify(request);
}

/**
 * Loads one section through the port and keeps the last loaded value in the store, so switching back shows it at
 * once. `replace` stores the section a save returned.
 */
export function useSection<S extends SectionResult["section"]>(
	request: GetSectionRequest & { section: S },
): {
	state: Loadable<Extract<SectionResult, { section: S }>>;
	replace: (value: SectionResult) => void;
	reload: () => void;
} {
	const { port, sections, remember } = useStore();
	const key = cacheKeyOf(request);
	const cached = sections.get(key) as Extract<SectionResult, { section: S }> | undefined;
	// A failure belongs to one key and attempt, so a new request or a retry never shows an old failure.
	const [failure, setFailure] = useState<{ key: string; attempt: number; meta: string } | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (cached && attempt === 0) return;
		let live = true;
		port.getSection(JSON.parse(key) as GetSectionRequest).then((reply) => {
			if (!live) return;
			if (reply.status === "ok") remember(key, reply.value);
			else setFailure({ key, attempt, meta: `${errorText(reply.error)} Reference ${errorReference(reply.error)}.` });
		});
		return () => {
			live = false;
		};
		// The cached value is read once per key; a reload bumps the attempt.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [port, key, attempt, remember]);

	const reload = useCallback(() => setAttempt((n) => n + 1), []);
	const replace = useCallback((value: SectionResult) => remember(key, value), [key, remember]);
	const failed = failure && failure.key === key && failure.attempt === attempt ? failure : null;
	const state: Loadable<Extract<SectionResult, { section: S }>> = failed
		? { status: "error", title: "This section did not load", meta: failed.meta, onRetry: reload }
		: cached
			? { status: "ready", data: cached }
			: { status: "loading" };
	return { state, replace, reload };
}
