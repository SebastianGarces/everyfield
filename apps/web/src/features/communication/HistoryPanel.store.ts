import { createDebouncer } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";

export type Scope = { kind: "hub" } | { kind: "person"; personId: string } | { kind: "meeting"; meetingId: string };
export type Filters = { query: string; state: string; channel: string };

export const emptyFilters: Filters = { query: "", state: "any", channel: "any" };

const QUERY_PAUSE_MS = 300;

export type HistoryState = {
	scope: Scope;
	filters: Filters;
	query: string;
	ownSelected: string | null;
	actions: {
		type: (query: string) => void;
		filter: (change: Pick<Filters, "state"> | Pick<Filters, "channel">) => void;
		clear: () => void;
		show: (scope: Scope) => void;
		choose: (id: string | null) => void;
	};
};

export function createHistoryStore(init: { scope: Scope }): StoreApi<HistoryState> {
	const pause = createDebouncer(QUERY_PAUSE_MS);
	return createStore<HistoryState>()((set) => ({
		scope: init.scope,
		filters: emptyFilters,
		query: "",
		ownSelected: null,
		actions: {
			type: (query) => {
				set({ query });
				pause.run(() => set((state) => ({ filters: { ...state.filters, query } })));
			},
			filter: (change) => set((state) => ({ filters: { ...state.filters, ...change } })),
			clear: () => {
				pause.cancel();
				set({ query: "", filters: emptyFilters });
			},
			show: (scope) => set({ scope }),
			choose: (ownSelected) => set({ ownSelected }),
		},
	}));
}
