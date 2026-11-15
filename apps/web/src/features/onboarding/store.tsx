"use client";

import { createContext, use, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAddress, writeAddress } from "../../components/location.ts";
import {
	addressStep,
	editDrafts,
	initialState,
	parseStep,
	setView,
	type Drafts,
	type Entry,
	type Hold,
	type Op,
	type State,
	type StepKey,
} from "./model";
import { refreshEntry, runCommand, type OnboardingPort } from "./port";

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

function stepHref(state: State): string | null {
	const url = new URL(window.location.href);
	const step = addressStep(state);
	if (url.searchParams.get(STEP_PARAM) === step) return null;
	if (step) url.searchParams.set(STEP_PARAM, step);
	else url.searchParams.delete(STEP_PARAM);
	return url.pathname + url.search + url.hash;
}

function atStep(state: State, requested: StepKey | null): State {
	if (requested === null) return state;
	const moved = setView(state, requested);
	return moved.view === state.view ? state : moved;
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
		const cell = {
			get: () => {
				const shown = atStep(store.get(), parseStep(new URL(window.location.href).searchParams.get(STEP_PARAM)));
				if (shown !== store.get()) store.set(shown);
				return shown;
			},
			set: store.set,
		};
		const write = (replace: boolean) => {
			const href = stepHref(store.get());
			if (href) writeAddress(href, { replace });
		};
		return {
			go(view) {
				store.set(setView(cell.get(), view));
				write(false);
			},
			edit(patch) {
				store.set(editDrafts(cell.get(), patch));
			},
			async run(op, input) {
				const result = await runCommand(port, cell, op, input, () => crypto.randomUUID(), signIn);
				if (result === "ok" || result === "refused") write(true);
				return result;
			},
			refresh: () => refreshEntry(port, cell, signIn),
		};
	}, [port, signIn, store]);

	const value = useMemo(() => ({ store, actions }), [store, actions]);
	return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useOnboarding(): { state: State; actions: Actions } {
	const context = use(Context);
	if (!context) throw new Error("useOnboarding needs an OnboardingProvider");
	const stored = useSyncExternalStore(context.store.subscribe, context.store.get, context.store.get);
	const requested = parseStep(useAddress().params.get(STEP_PARAM));
	const state = useMemo(() => atStep(stored, requested), [stored, requested]);
	return { state, actions: context.actions };
}
