const MINUTE = 60_000;

const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | undefined;
let now: number | null = null;

function tick() {
	now = Date.now();
	for (const changed of listeners) changed();
}

export function subscribeMinute(changed: () => void): () => void {
	listeners.add(changed);
	if (ticker === undefined) {
		if (now !== null && Date.now() - now >= MINUTE) now = Date.now();
		ticker = setInterval(tick, MINUTE);
	}
	return () => {
		listeners.delete(changed);
		if (listeners.size > 0) return;
		clearInterval(ticker);
		ticker = undefined;
		now = null;
	};
}

export function minuteSnapshot(): number {
	now ??= Date.now();
	return now;
}
