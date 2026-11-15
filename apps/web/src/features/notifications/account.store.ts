import { createStore, type StoreApi } from "zustand/vanilla";

export type StandingMark = { token: object; ids: ReadonlySet<string>; cutoff: string | null };

export type AccountState = {
	marks: readonly StandingMark[];
	actions: {
		stand: (mark: StandingMark) => void;
		withdraw: (token: object) => void;
	};
};

export type AccountStore = StoreApi<AccountState>;

export function createAccountStore(): AccountStore {
	return createStore<AccountState>()((set) => ({
		marks: [],
		actions: {
			stand: (mark) => set((s) => ({ marks: [...s.marks, mark] })),
			withdraw: (token) => set((s) => ({ marks: s.marks.filter((m) => m.token !== token) })),
		},
	}));
}
