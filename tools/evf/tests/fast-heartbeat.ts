/**
 * Preloaded into a real drive that a test starts, so that the test sees several heartbeats in a short run. It changes
 * only the main thread's one-minute timer, which is the heartbeat, and it needs no test option in the production code.
 */
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
	const real = globalThis.setInterval;
	globalThis.setInterval = ((fn: () => void, ms?: number) =>
		real(fn, ms === 60_000 ? 100 : ms)) as typeof globalThis.setInterval;
}
