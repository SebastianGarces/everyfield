"use client";

import type { Loadable } from "@everyfield/ui/display";
import { createContext, use, type ReactNode } from "react";
import { useRead } from "../../components/read.tsx";
import { storeContext, useLocalStore, useShallow } from "../../components/store.ts";
import { isDirty, isSaving, visible } from "./drafts";
import { errorReference, errorText } from "./model";
import type { Refusal } from "./save";
import type { GetSectionRequest, SectionKey, SectionResult, SectionSeed, SettingsPort, SettingsViewer } from "./port";
import {
	createSettingsStore,
	withAccountRevision,
	selectDirtyKeys,
	type SaveOutcome,
	type SettingsReads,
	type SettingsState,
} from "./settings.store";

const Settings = storeContext<SettingsState>("Settings");
const ViewerContext = createContext<SettingsViewer | null>(null);

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
	const store = useLocalStore(() => createSettingsStore({ port, seed }));
	return (
		<Settings.Provider value={store}>
			<ViewerContext value={viewer}>{children}</ViewerContext>
		</Settings.Provider>
	);
}

export function useSettings(): { port: SettingsPort; viewer: SettingsViewer } {
	const viewer = use(ViewerContext);
	const port = Settings.useSelect((state) => state.port);
	if (!viewer) throw new Error("Settings screens need a SettingsProvider above them.");
	return { port, viewer };
}

export function useReads(): SettingsReads {
	return Settings.useSelect((state) => state.reads);
}

export function useFlows() {
	return Settings.useSelect((state) => state.port.flows);
}

export function useDirtySections(): { keys: SectionKey[]; clear: () => void } {
	const keys = Settings.useSelect(useShallow(selectDirtyKeys));
	const clear = Settings.useSelect((state) => state.actions.clear);
	return { keys, clear };
}

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
	serverChanged: (server: T) => void;
} {
	const book = Settings.useSelect((state) => state.book);
	const actions = Settings.useSelect((state) => state.actions);
	return {
		draft: visible(book, key, saved) as T,
		dirty: isDirty(book, key, saved),
		saving: isSaving(book, key),
		refusal: book.refusals[key] ?? null,
		setDraft: (next: T) => actions.edit(key, next, saved),
		save: (work) => actions.save(key, saved, work as (sent: unknown) => Promise<SaveOutcome<unknown>>),
		serverChanged: (server: T) => actions.observe(key, server),
	};
}

export function useFlowState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
	const value = Settings.useSelect((state) => (key in state.flows ? state.flows[key] : initial)) as T;
	const setFlow = Settings.useSelect((state) => state.actions.setFlow);
	const set = (next: T | ((prev: T) => T)) =>
		setFlow(key, (prev) => {
			const current = (prev === undefined ? initial : prev) as T;
			return typeof next === "function" ? (next as (p: T) => T)(current) : next;
		});
	return [value, set];
}

export function useLatestFlow<T>(key: string, initial: T): () => T {
	const store = Settings.useStoreApi();
	return () => {
		const flows = store.getState().flows;
		return (key in flows ? flows[key] : initial) as T;
	};
}

export function useSection<S extends SectionResult["section"], F = unknown>(
	request: GetSectionRequest & { section: S },
	draft?: { key: SectionKey; formOf: (value: Extract<SectionResult, { section: S }>) => F | undefined },
): {
	state: Loadable<Extract<SectionResult, { section: S }>>;
	replace: (value: SectionResult) => void;
	reload: () => void;
} {
	const reads = useReads();
	const actions = Settings.useSelect((state) => state.actions);
	const read = useRead(reads.section, request);
	const reply = read.value;
	const accountRevision = Settings.useSelect((state) => state.accountRevision);
	const observe = (value: SectionResult) => {
		if (!draft || value.section !== request.section) return;
		const form = draft.formOf(value as Extract<SectionResult, { section: S }>);
		if (form !== undefined) actions.observe(draft.key, form);
	};
	const state: Loadable<Extract<SectionResult, { section: S }>> =
		reply === undefined
			? { status: "loading" }
			: reply.status === "ok"
				? {
						status: "ready",
						data: withAccountRevision(reply.value, accountRevision) as Extract<SectionResult, { section: S }>,
					}
				: {
						status: "error",
						title: "This section did not load",
						meta:
							reply.status === "refused"
								? `${errorText(reply.error)} Reference ${errorReference(reply.error)}.`
								: "Everyfield could not be reached. Check your connection.",
						onRetry: read.retry,
					};
	return {
		state,
		replace: (value) => {
			actions.replaceSection(request, value);
			observe(value);
		},
		reload: () =>
			void reads.section.refresh(request).then((next) => {
				if (next.status !== "ok") return;
				actions.sectionLoaded(next.value);
				observe(next.value);
			}),
	};
}
