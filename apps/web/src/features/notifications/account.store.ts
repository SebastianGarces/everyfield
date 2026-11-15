import { createStore, type StoreApi } from "zustand/vanilla";

export type StandingMark = { token: object; ids: ReadonlySet<string>; cutoff: string | null };

export type AccountState = {
	account: string;
	marks: readonly StandingMark[];
	actions: {
		stand: (mark: StandingMark) => void;
		withdraw: (token: object) => void;
		confirm: (token: object) => void;
	};
};

export type AccountStore = StoreApi<AccountState>;

const confirmed = {};

const laterCutoff = (a: string | null, b: string | null) =>
	a === null ? b : b === null || Date.parse(a) >= Date.parse(b) ? a : b;

function merged(kept: StandingMark | undefined, mark: StandingMark): StandingMark {
	if (!kept) return { ...mark, token: confirmed };
	return { token: confirmed, ids: new Set([...kept.ids, ...mark.ids]), cutoff: laterCutoff(kept.cutoff, mark.cutoff) };
}

export function createAccountStore(account: string): AccountStore {
	return createStore<AccountState>()((set) => ({
		account,
		marks: [],
		actions: {
			stand: (mark) => set((s) => ({ marks: [...s.marks, mark] })),
			withdraw: (token) => set((s) => ({ marks: s.marks.filter((m) => m.token !== token) })),
			confirm: (token) =>
				set((s) => {
					const mark = s.marks.find((m) => m.token === token);
					if (!mark) return s;
					const kept = s.marks.find((m) => m.token === confirmed);
					return {
						marks: [merged(kept, mark), ...s.marks.filter((m) => m.token !== token && m.token !== confirmed)],
					};
				}),
		},
	}));
}
