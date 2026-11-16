"use client";

import { createContext, use, useState, type Context } from "react";
import { useStore, type StoreApi } from "zustand";

export { useStore };
export { useShallow } from "zustand/react/shallow";
export type { StoreApi };

export function useLocalStore<S>(create: () => StoreApi<S>): StoreApi<S> {
	const [store] = useState(create);
	return store;
}

export function storeContext<S>(name: string): {
	Provider: Context<StoreApi<S> | null>;
	useSelect: <T>(selector: (state: S) => T) => T;
	useStoreApi: () => StoreApi<S>;
} {
	const Provider = createContext<StoreApi<S> | null>(null);
	const useStoreApi = () => {
		const store = use(Provider);
		if (!store) throw new Error(`${name} needs its store provider above it.`);
		return store;
	};
	const useSelect = <T>(selector: (state: S) => T) => useStore(useStoreApi(), selector);
	return { Provider, useStoreApi, useSelect };
}
