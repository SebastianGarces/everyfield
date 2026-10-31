import { parentPort, workerData } from "node:worker_threads";
import { drive } from "./drive.ts";
import { EvfError, parseTask } from "./lib.ts";

/** The drive loop runs here so that the main thread keeps a free event loop and can handle SIGTERM and SIGINT. */
const { root, task, once } = workerData as { root: string; task: string; once: boolean };
try {
	parentPort!.postMessage({ code: drive(root, parseTask(task), { once }) });
} catch (e) {
	if (!(e instanceof EvfError)) throw e;
	parentPort!.postMessage({ refusal: e.message });
}
