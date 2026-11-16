import { createStore, type StoreApi } from "zustand/vanilla";
import type { Outcome } from "../../components/save/model.ts";
import { keyFor, newerRevision, type KeyedPayload } from "./model.ts";

export type Saved = { revision: string };

export type PersonState<P extends Saved, D> = {
	saved: P;
	drafts: Readonly<Record<string, D>>;
	pending: string | null;
	keys: Readonly<Record<string, KeyedPayload>>;
	errors: Readonly<Record<string, "refused" | "lost" | string>>;
	actions: {
		edit: (slot: string, draft: D) => void;
		discard: (slot: string) => void;
		begin: (slot: string, payload: unknown, fresh: () => string, own?: KeyedPayload) => KeyedPayload | null;
		settle: (slot: string, outcome: Outcome<P | null>, keepDraft?: boolean) => void;
		server: (person: P) => void;
	};
};

export type PersonStore<P extends Saved, D> = Pick<StoreApi<PersonState<P, D>>, "getState" | "subscribe">;

const without = <T>(r: Readonly<Record<string, T>>, k: string): Record<string, T> =>
	Object.fromEntries(Object.entries(r).filter(([key]) => key !== k));

export function createPersonStore<P extends Saved, D>(person: P): StoreApi<PersonState<P, D>> {
	return createStore<PersonState<P, D>>()((set, get) => ({
		saved: person,
		drafts: {},
		pending: null,
		keys: {},
		errors: {},
		actions: {
			edit: (slot, draft) =>
				set((s) =>
					s.pending === slot ? s : { drafts: { ...s.drafts, [slot]: draft }, errors: without(s.errors, slot) },
				),
			discard: (slot) =>
				set((s) =>
					s.pending === slot
						? s
						: { drafts: without(s.drafts, slot), keys: without(s.keys, slot), errors: without(s.errors, slot) },
				),
			begin: (slot, payload, fresh, own) => {
				const s = get();
				if (s.pending !== null) return null;
				const key = own ?? keyFor(s.keys[slot] ?? null, payload, fresh);
				set({ pending: slot, keys: { ...s.keys, [slot]: key }, errors: without(s.errors, slot) });
				return key;
			},
			settle: (slot, outcome, keepDraft) =>
				set((s) => {
					if (s.pending !== slot) return s;
					if (outcome.status === "ok")
						return {
							saved:
								outcome.value && !newerRevision(s.saved.revision, outcome.value.revision) ? outcome.value : s.saved,
							pending: null,
							drafts: keepDraft ? s.drafts : without(s.drafts, slot),
							keys: without(s.keys, slot),
							errors: without(s.errors, slot),
						};
					return {
						pending: null,
						keys: outcome.status === "lost" ? s.keys : without(s.keys, slot),
						errors: { ...s.errors, [slot]: outcome.status === "lost" ? "lost" : outcome.code },
					};
				}),
			server: (next) => set((s) => (newerRevision(s.saved.revision, next.revision) ? s : { saved: next })),
		},
	}));
}

export function withServer<P extends Saved, D>(store: PersonStore<P, D>, server: P): PersonStore<P, D> {
	let seen: PersonState<P, D> | null = null;
	let shown: PersonState<P, D> | null = null;
	return {
		subscribe: store.subscribe,
		getState: () => {
			const s = store.getState();
			if (s !== seen || shown === null) {
				seen = s;
				shown = server === s.saved || newerRevision(s.saved.revision, server.revision) ? s : { ...s, saved: server };
			}
			return shown;
		},
	};
}

export async function runSave<P extends Saved, D, T>(
	store: PersonStore<P, D>,
	slot: string,
	payload: unknown,
	call: (requestKey: string) => Promise<Outcome<T>>,
	options: { fresh: () => string; toPerson?: (value: T) => P | null; keepDraft?: boolean; key?: KeyedPayload },
): Promise<Outcome<T> | null> {
	const { begin, settle } = store.getState().actions;
	const key = begin(slot, payload, options.fresh, options.key);
	if (!key) return null;
	let result: Outcome<T>;
	try {
		result = await call(key.key);
	} catch {
		result = { status: "lost" };
	}
	settle(
		slot,
		result.status === "ok" ? { status: "ok", value: options.toPerson?.(result.value) ?? null } : result,
		options.keepDraft,
	);
	return result;
}

export const throughStore =
	<P extends Saved, D, V>(store: PersonStore<P, D>, slot: string, toPerson?: (value: V) => P | null) =>
	<T extends V>(key: string, send: () => Promise<Outcome<T>>): Promise<Outcome<T> | null> =>
		runSave(store, slot, null, send, { fresh: () => key, key: { key, body: "" }, toPerson });
