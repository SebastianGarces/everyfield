import { createDebouncer } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Address } from "./HouseholdDialogs.tsx";
import type { HouseholdRole } from "./model.ts";

const SEARCH_PAUSE_MS = 250;

type Mode = "choose" | "create";

export type JoinHouseholdState = {
	mode: Mode;
	switches: number;
	search: string;
	term: string;
	choice: string;
	role: HouseholdRole | "";
	touched: boolean;
	name: string;
	address: Address;
	nameTouched: boolean;
	actions: {
		switchTo: (mode: Mode) => void;
		type: (search: string) => void;
		choose: (householdId: string) => void;
		pickRole: (role: HouseholdRole) => void;
		touch: () => void;
		rename: (name: string) => void;
		readdress: (address: Address) => void;
		touchName: () => void;
	};
};

export function createJoinHouseholdStore(init: {
	mode: Mode;
	choice: string;
	role: HouseholdRole | "";
	name: string;
	address: Address;
}): StoreApi<JoinHouseholdState> {
	const pause = createDebouncer(SEARCH_PAUSE_MS);
	return createStore<JoinHouseholdState>()((set) => ({
		...init,
		switches: 0,
		search: "",
		term: "",
		touched: false,
		nameTouched: false,
		actions: {
			switchTo: (mode) => set((s) => ({ mode, switches: s.switches + 1 })),
			type: (search) => {
				set({ search });
				pause.run(() => set({ term: search.trim() }));
			},
			choose: (choice) => set({ choice }),
			pickRole: (role) => set({ role }),
			touch: () => set({ touched: true }),
			rename: (name) => set({ name }),
			readdress: (address) => set({ address }),
			touchName: () => set({ nameTouched: true }),
		},
	}));
}
