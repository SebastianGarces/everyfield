import { parentPort, workerData } from "node:worker_threads";
import { drive } from "./drive.ts";
import { EvfError, parseTask } from "./lib.ts";
import { ensureSampler } from "./sampler.ts";

/** The drive loop runs here so that the main thread keeps a free event loop for signals and the heartbeat. */
const { root, task, once } = workerData as { root: string; task: string; once: boolean };
try {
	let end: { stage: string; reason: string } | undefined;
	const code = drive(root, parseTask(task), {
		once,
		startSampler: ensureSampler,
		onPinned: (pin) => parentPort!.postMessage({ pin }),
		onEnd: (n) => {
			end = { stage: n.stage, reason: n.reason };
		},
	});
	parentPort!.postMessage({ code, end });
} catch (e) {
	if (!(e instanceof EvfError)) throw e;
	parentPort!.postMessage({ refusal: e.message });
}
