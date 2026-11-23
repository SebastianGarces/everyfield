import { createStore, type StoreApi } from "zustand/vanilla";

export type StandingMark = {
	token: object;
	ids: ReadonlySet<string>;
	cutoff: string | null;
	eligible: ReadonlyMap<string, string>;
};

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

const covered = (at: string | undefined, cutoff: string | null) =>
	at !== undefined && cutoff !== null && Date.parse(at) <= Date.parse(cutoff);

function merged(kept: StandingMark | undefined, mark: StandingMark): StandingMark {
	const cutoff = kept ? laterCutoff(kept.cutoff, mark.cutoff) : mark.cutoff;
	const eligible = new Map([...(kept?.eligible ?? []), ...mark.eligible]);
	const ids = [...(kept?.ids ?? []), ...mark.ids].filter((id) => !covered(eligible.get(id), cutoff));
	return {
		token: confirmed,
		ids: new Set(ids),
		cutoff,
		eligible: new Map([...eligible].filter(([, at]) => !covered(at, cutoff))),
	};
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
