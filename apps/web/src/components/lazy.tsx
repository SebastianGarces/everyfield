"use client";

import { Button, Spinner, StatePanel } from "@everyfield/ui/controls";
import { use, useReducer, useState, type ReactNode } from "react";

type Loaded<M> = { status: "ready"; module: M } | { status: "failed" };

export type LazyModule<M> = { preload: () => void; current: () => Promise<Loaded<M>> };

export function lazyModule<M>(load: () => Promise<M>): LazyModule<M> {
	let loading: Promise<Loaded<M>> | null = null;
	let failed = false;
	const start = () => {
		failed = false;
		loading = load().then(
			(module): Loaded<M> => ({ status: "ready", module }),
			(): Loaded<M> => {
				failed = true;
				return { status: "failed" };
			},
		);
		return loading;
	};
	return {
		preload: () => {
			if (!loading || failed) start();
		},
		current: () => loading ?? start(),
	};
}

export function useLazyModule<M>(lazy: LazyModule<M>): { module: M } | { module: null; retry: () => void } {
	const [, retried] = useReducer((attempt: number) => attempt + 1, 0);
	const loaded = use(lazy.current());
	if (loaded.status === "ready") return { module: loaded.module };
	return {
		module: null,
		retry: () => {
			lazy.preload();
			retried();
		},
	};
}

export function Opened({ open, children }: { open: boolean; children: ReactNode }) {
	const [opened, setOpened] = useState(open);
	if (open && !opened) setOpened(true);
	return opened ? children : null;
}

export function LoadState({ what, retry }: { what: string; retry?: () => void }) {
	if (!retry)
		return (
			<p role="status" className="flex items-center justify-center gap-2 px-6 py-16 text-text-2">
				<Spinner size={16} /> Loading {what.toLowerCase()}
			</p>
		);
	return (
		<StatePanel
			tone="error"
			title={`${what} could not be loaded`}
			headingLevel="h3"
			actions={<Button onClick={retry}>Try again</Button>}
		>
			Check your connection, then try again.
		</StatePanel>
	);
}
