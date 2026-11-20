"use client";

import { Button, StatePanel } from "@everyfield/ui/controls";
import { use, useReducer, useState, type ReactNode } from "react";

type Loaded<M> = { status: "ready"; module: M } | { status: "failed" };
type Loading<M> = Promise<Loaded<M>> & { status?: "fulfilled"; value?: Loaded<M> };

export type LazyModule<M> = {
	preload: () => void;
	whenLoaded: (then: () => void) => void;
	current: () => Promise<Loaded<M>>;
};

export function lazyModule<M>(load: () => Promise<M>): LazyModule<M> {
	let loading: Loading<M> | null = null;
	const start = () => {
		const attempt: Loading<M> = load().then(
			(module): Loaded<M> => ({ status: "ready", module }),
			(): Loaded<M> => ({ status: "failed" }),
		);
		void attempt.then((value) => {
			attempt.status = "fulfilled";
			attempt.value = value;
		});
		loading = attempt;
		return attempt;
	};
	const live = () => (!loading || loading.value?.status === "failed" ? start() : loading);
	return {
		preload: live,
		whenLoaded: (then) => {
			const attempt = live();
			if (attempt.status === "fulfilled") then();
			else void attempt.then(then);
		},
		current: () => loading ?? start(),
	};
}

export type Failure = { module: null; retry: () => void; keepFocusOnRetry: (event: Event) => void };

export function useLazyModule<M>(lazy: LazyModule<M>): { module: M } | Failure {
	const [, retried] = useReducer((attempt: number) => attempt + 1, 0);
	const attempt = lazy.current();
	const loaded = use(attempt);
	if (loaded.status === "ready") return { module: loaded.module };
	return {
		module: null,
		retry: () => {
			lazy.preload();
			retried();
		},
		keepFocusOnRetry: (event) => {
			if (lazy.current() !== attempt) event.preventDefault();
		},
	};
}

export function Opened({ open, children }: { open: boolean; children: ReactNode }) {
	const [opened, setOpened] = useState(open);
	if (open && !opened) setOpened(true);
	return opened ? children : null;
}

export function LoadFailed({ what, retry }: { what: string; retry: () => void }) {
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
