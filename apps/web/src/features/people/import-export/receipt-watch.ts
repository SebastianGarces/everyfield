import type { ImportReceipt } from "./model.ts";

export type Polled = { status: "ok"; receipt: ImportReceipt } | { status: "refused" } | { status: "lost" };

export type ReceiptWatch = {
	subscribe: (listener: () => void) => () => void;
	latest: () => Polled | null;
};

const FIRST_WAIT_MS = 1000;
const LONGEST_WAIT_MS = 8000;

const watches = new WeakMap<ImportReceipt, ReceiptWatch>();

export function watchReceipt(from: ImportReceipt, read: () => Promise<Polled>): ReceiptWatch {
	const known = watches.get(from);
	if (known) return known;
	const listeners = new Set<() => void>();
	let latest: Polled | null = null;
	let over = false;
	let stop: (() => void) | null = null;

	const poll = () => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const schedule = (wait: number) => {
			timer = setTimeout(() => void tick(wait), wait);
		};
		const tick = async (waited: number) => {
			const got = await read();
			if (stopped) return;
			latest = got;
			for (const listener of listeners) listener();
			over = got.status === "refused" || (got.status === "ok" && got.receipt.status !== "in_progress");
			if (!over) schedule(got.status === "ok" ? FIRST_WAIT_MS : Math.min(waited * 2, LONGEST_WAIT_MS));
		};
		schedule(FIRST_WAIT_MS);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	};

	const watch: ReceiptWatch = {
		subscribe: (listener) => {
			listeners.add(listener);
			if (!over && stop === null) stop = poll();
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0 || stop === null) return;
				stop();
				stop = null;
			};
		},
		latest: () => latest,
	};
	watches.set(from, watch);
	return watch;
}
