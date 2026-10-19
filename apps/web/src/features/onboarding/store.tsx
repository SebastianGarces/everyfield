"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
	begin,
	editDrafts,
	initialState,
	needsReload,
	parseStep,
	reload,
	setView,
	settle,
	type Drafts,
	type Entry,
	type Hold,
	type Op,
	type Settled,
	type State,
	type StepKey,
} from "./model";
import type { OnboardingPort } from "./port";

// The onboarding store (WP-009/ui R6). It owns the one command on the wire, so a reply lands in the store even if
// the step that sent it is gone, and facts change only from the server's reply (model.ts settle). The view follows
// the address bar's ?step= so browser Back moves between steps.

type Store = {
	get(): State;
	subscribe(listener: () => void): () => void;
	set(next: State): void;
};
function createStore(initial: State): Store {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			state = next;
			for (const listener of listeners) listener();
		},
	};
}

export type Actions = {
	go(view: StepKey): void;
	edit(patch: Partial<Drafts>): void;
	/** Send one command. Resolves to the hold when nothing was sent, else to whether the server accepted it. */
	run(op: Op, input: unknown): Promise<Hold | "ok" | "refused">;
	/** Load the latest facts from the server, keeping drafts. */
	refresh(): Promise<void>;
};
const Context = createContext<{ store: Store; actions: Actions } | null>(null);

const STEP_PARAM = "step";
function writeStep(view: StepKey, mode: "push" | "replace") {
	const url = new URL(window.location.href);
	if (url.searchParams.get(STEP_PARAM) === view) return;
	url.searchParams.set(STEP_PARAM, view);
	window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
}

export function OnboardingProvider({
	port,
	entry,
	step,
	signIn,
	children,
}: {
	port: OnboardingPort;
	entry: Entry;
	step: StepKey | null;
	/** Where a reload that finds no session goes. */
	signIn: () => void;
	children: ReactNode;
}) {
	// One store per mount: the entry and step only seed it. A new account or persona remounts the provider.
	const [store] = useState(() => createStore(initialState(entry, step)));

	const actions = useMemo<Actions>(() => {
		async function fresh(): Promise<Entry | null> {
			const load = await port.entry();
			if (load.kind === "signed_out") {
				signIn();
				return null;
			}
			return load.entry;
		}
		return {
			go(view) {
				store.set(setView(store.get(), view));
				writeStep(store.get().view, "push");
			},
			edit(patch) {
				store.set(editDrafts(store.get(), patch));
			},
			async run(op, input) {
				const started = begin(store.get(), op, input, () => crypto.randomUUID());
				if ("hold" in started) return started.hold;
				store.set(started.state);
				const reply = await port.command(op, started.send);
				const settled = { op, reply } as Settled;
				const entry = needsReload(settled) ? await fresh() : null;
				store.set(settle(store.get(), settled, entry));
				writeStep(store.get().view, "replace");
				return reply.status;
			},
			async refresh() {
				const entry = await fresh();
				if (entry) store.set(reload(store.get(), entry));
			},
		};
	}, [port, signIn, store]);

	useEffect(() => {
		writeStep(store.get().view, "replace");
		const back = () =>
			store.set(
				setView(store.get(), parseStep(new URL(window.location.href).searchParams.get(STEP_PARAM)) ?? "church"),
			);
		window.addEventListener("popstate", back);
		return () => window.removeEventListener("popstate", back);
	}, [store]);

	const value = useMemo(() => ({ store, actions }), [store, actions]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useOnboarding(): { state: State; actions: Actions } {
	const context = useContext(Context);
	if (!context) throw new Error("useOnboarding needs an OnboardingProvider");
	const state = useSyncExternalStore(context.store.subscribe, context.store.get, context.store.get);
	return { state, actions: context.actions };
}
