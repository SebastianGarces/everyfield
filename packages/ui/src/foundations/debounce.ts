export type Debouncer = {
	run(fn: () => void): void;
	cancel(): void;
	flush(): void;
	cancelOnDetach(node: Element | null): () => void;
};

export function createDebouncer(ms: number): Debouncer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: (() => void) | null = null;
	const cancel = () => {
		clearTimeout(timer);
		timer = undefined;
		pending = null;
	};
	const flush = () => {
		const fn = pending;
		cancel();
		fn?.();
	};
	return {
		run(fn) {
			clearTimeout(timer);
			pending = fn;
			timer = setTimeout(flush, ms);
		},
		cancel,
		flush,
		cancelOnDetach: () => cancel,
	};
}
