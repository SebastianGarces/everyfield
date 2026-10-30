"use client";

import type { Loadable } from "@everyfield/ui/display";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { begin, discard, edit, emptyBook, finish, isDirty, isSaving, rebase, same, visible, type Book } from "./drafts";
import { errorReference, errorText } from "./model";
import type { Refusal } from "./save";
import type { GetSectionRequest, SectionKey, SectionResult, SectionSeed, SettingsPort, SettingsViewer } from "./port";

// The settings store lives as long as the dialog's route layout, so a section's draft survives switching sections and
// back/forward (WP-010/ui R2). It is keyed by account and context by its owner (SettingsProvider), so switching
// account remounts it and no draft or cached section crosses accounts.

type StoreValue = {
	port: SettingsPort;
	viewer: SettingsViewer;
	book: Book<SectionKey, Refusal>;
	/** The server value per section as a draft form, for the nav mark and the close guard. */
	servers: Partial<Record<SectionKey, unknown>>;
	observe: (key: SectionKey, server: unknown) => void;
	editDraft: (key: SectionKey, value: unknown, server: unknown) => void;
	runSave: (key: SectionKey, server: unknown, work: (sent: unknown) => Promise<SaveOutcome<unknown>>) => Promise<void>;
	clearDrafts: () => void;
	flows: Record<string, unknown>;
	setFlow: (key: string, update: (prev: unknown) => unknown) => void;
	sections: Map<string, SectionResult>;
	remember: (cacheKey: string, value: SectionResult) => void;
	seed: SectionSeed | null;
};

/**
 * What a section's save work reports. A success gives the server value (as the section's form) from its last reply.
 * A refusal gives it only when an earlier step of the same save committed; otherwise the store uses the latest
 * server value it holds. No value captured when Save was pressed is ever used.
 */
export type SaveOutcome<T> = { ok: true; server: T } | { ok: false; refusal: Refusal; server?: T };

const Store = createContext<StoreValue | null>(null);

function useStore(): StoreValue {
	const store = use(Store);
	if (!store) throw new Error("Settings screens need a SettingsProvider above them.");
	return store;
}

export function SettingsProvider({
	port,
	viewer,
	seed = null,
	children,
}: {
	port: SettingsPort;
	viewer: SettingsViewer;
	seed?: SectionSeed | null;
	children: ReactNode;
}) {
	// The draft book (drafts.ts). React state drives rendering; the ref is the same value for async save code,
	// which must decide on the latest book, not the one its render saw. Only commit() writes either.
	const [book, setBook] = useState(() => emptyBook<SectionKey, Refusal>());
	const bookRef = useRef(book);
	const commit = useCallback((next: Book<SectionKey, Refusal>) => {
		bookRef.current = next;
		setBook(next);
	}, []);
	const [servers, setServers] = useState<Partial<Record<SectionKey, unknown>>>({});
	const serversRef = useRef(servers);
	const observe = useCallback(
		(key: SectionKey, server: unknown) => {
			if (key in serversRef.current && same(serversRef.current[key], server)) return;
			if (key in serversRef.current) commit(rebase(bookRef.current, key, serversRef.current[key], server));
			serversRef.current = { ...serversRef.current, [key]: server };
			setServers(serversRef.current);
		},
		[commit],
	);
	const [sections, setSections] = useState(() => new Map<string, SectionResult>());
	const editDraft = useCallback(
		(key: SectionKey, value: unknown, server: unknown) => commit(edit(bookRef.current, key, value, server)),
		[commit],
	);
	// The store owns every save: at most one per section, whichever screen started it, and its reply lands here even
	// after the section unmounted. The reply is reconciled against the server value it reports, never a snapshot.
	const runSave = useCallback(
		async (key: SectionKey, server: unknown, work: (sent: unknown) => Promise<SaveOutcome<unknown>>) => {
			const started = begin(bookRef.current, key, server);
			if (!started) return;
			commit(started.book);
			let outcome: SaveOutcome<unknown>;
			try {
				outcome = await work(started.sent);
			} catch {
				outcome = {
					ok: false,
					refusal: {
						message: "Everyfield could not be reached, so this may not have saved. Load the latest version to check.",
						reference: "EF-OFFLINE",
						code: "unknown",
					},
				};
			}
			if (outcome.server !== undefined) observe(key, outcome.server);
			commit(finish(bookRef.current, key, outcome, serversRef.current[key]));
		},
		[commit, observe],
	);
	const clearDrafts = useCallback(() => {
		let next = bookRef.current;
		for (const key of Object.keys(next.edits) as SectionKey[]) next = discard(next, key);
		commit(next);
	}, [commit]);
	const [flows, setFlows] = useState<Record<string, unknown>>({});
	const setFlow = useCallback(
		(key: string, update: (prev: unknown) => unknown) => setFlows((all) => ({ ...all, [key]: update(all[key]) })),
		[],
	);
	const remember = useCallback(
		(cacheKey: string, value: SectionResult) => setSections((all) => new Map(all).set(cacheKey, value)),
		[],
	);
	const value = useMemo(
		() => ({
			port,
			viewer,
			book,
			servers,
			observe,
			editDraft,
			runSave,
			clearDrafts,
			sections,
			remember,
			flows,
			setFlow,
			seed,
		}),
		[port, viewer, book, servers, observe, editDraft, runSave, clearDrafts, sections, remember, flows, setFlow, seed],
	);

	// A reload or tab close with unsaved drafts asks the browser to confirm.
	const anyDirty = dirtyKeys(book, servers).length > 0;
	useEffect(() => {
		if (!anyDirty) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [anyDirty]);

	return <Store value={value}>{children}</Store>;
}

function dirtyKeys(book: Book<SectionKey, Refusal>, servers: Partial<Record<SectionKey, unknown>>): SectionKey[] {
	return (Object.keys(book.edits) as SectionKey[]).filter((key) => isDirty(book, key, servers[key]));
}

export function useSettings() {
	const { port, viewer } = useStore();
	return { port, viewer };
}

/** The read the server started with the page, for sections with their own read (the brand kit). */
export function useSeed(): SectionSeed | null {
	return useStore().seed;
}

/** Your photo, email, password, own time zone and deletion (SettingsPort.flows). */
export function useFlows() {
	return useStore().port.flows;
}

/** The sections whose visible value differs from the server value. */
export function useDirtySections(): { keys: SectionKey[]; clear: () => void } {
	const { book, servers, clearDrafts } = useStore();
	return { keys: dirtyKeys(book, servers), clear: clearDrafts };
}

/**
 * A section's draft, from the store's book (drafts.ts). `saved` is the server value as this form, from the section
 * cache. The draft survives leaving the section; so do its save in flight and its refusal. `save(work)` starts the
 * section's one save: `work` gets exactly what is sent and reports the outcome with the server value after it.
 */
export function useDraft<T>(
	key: SectionKey,
	saved: T,
): {
	draft: T;
	setDraft: (next: T) => void;
	dirty: boolean;
	saving: boolean;
	refusal: Refusal | null;
	save: (work: (sent: T) => Promise<SaveOutcome<T>>) => Promise<void>;
} {
	const { book, observe, editDraft, runSave } = useStore();
	const savedJson = JSON.stringify(saved);
	useEffect(() => {
		observe(key, JSON.parse(savedJson));
	}, [observe, key, savedJson]);
	return {
		draft: visible(book, key, saved) as T,
		dirty: isDirty(book, key, saved),
		saving: isSaving(book, key),
		refusal: book.refusals[key] ?? null,
		setDraft: (next: T) => editDraft(key, next, saved),
		save: (work) => runSave(key, saved, work as (sent: unknown) => Promise<SaveOutcome<unknown>>),
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
	const { port, sections, remember, seed } = useStore();
	const key = cacheKeyOf(request);
	const cached = sections.get(key) as Extract<SectionResult, { section: S }> | undefined;
	// A failure belongs to one key and attempt, so a new request or a retry never shows an old failure.
	const [failure, setFailure] = useState<{ key: string; attempt: number; meta: string } | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (cached && attempt === 0) return;
		let live = true;
		// The first load of the page's own section uses the read the server started (a React thenable, so wrapped).
		const seeded = attempt === 0 && seed && "request" in seed && cacheKeyOf(seed.request) === key ? seed.value : null;
		Promise.resolve(seeded ?? port.getSection(JSON.parse(key) as GetSectionRequest)).then((reply) => {
			if (!live) return;
			if (reply.status === "ok") remember(key, reply.value);
			else setFailure({ key, attempt, meta: `${errorText(reply.error)} Reference ${errorReference(reply.error)}.` });
		});
		return () => {
			live = false;
		};
		// The cached value and the seed are read once per key; a reload bumps the attempt.
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
