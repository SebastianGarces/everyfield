import { createStore, type StoreApi } from "zustand/vanilla";
import type { ViewValue } from "./model.ts";
import type { PeopleView } from "./server.ts";

type Kind = "rows" | "pipeline";
const kindOf = (view: ViewValue): Kind => (view === "pipeline" ? "pipeline" : "rows");

type Views = {
	base: PeopleView;
	loaded: Partial<Record<Kind, PeopleView>>;
	view: ViewValue;
	wanted: ViewValue;
};

export type PeopleViewsState = Views & {
	actions: {
		want: (base: PeopleView, next: ViewValue) => PeopleView | null;
		arrived: (base: PeopleView, next: ViewValue, got: PeopleView) => void;
	};
};

const viewsFor = (base: PeopleView): Views => ({
	base,
	loaded: { [kindOf(base.query.view)]: base },
	view: base.query.view,
	wanted: base.query.view,
});

export const viewsOf = (s: Views, base: PeopleView): Views => (s.base === base ? s : viewsFor(base));

export const shownOf = (s: Views): PeopleView | undefined => s.loaded[kindOf(s.view)];

export function createPeopleViewsStore(base: PeopleView): StoreApi<PeopleViewsState> {
	return createStore<PeopleViewsState>()((set, get) => ({
		...viewsFor(base),
		actions: {
			want: (from, next) => {
				const s = viewsOf(get(), from);
				const have = s.loaded[kindOf(next)] ?? null;
				set({ ...s, view: have ? next : s.view, wanted: next });
				return have;
			},
			arrived: (from, next, got) => {
				const s = get();
				if (s.base !== from) return;
				set({ loaded: { ...s.loaded, [kindOf(next)]: got }, view: s.wanted === next ? next : s.view });
			},
		},
	}));
}
