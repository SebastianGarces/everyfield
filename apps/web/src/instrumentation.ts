import { asLogNames, logFailure, logInfo, logLine } from "@everyfield/domain/log";
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const config = await import("./server/config.ts");
	config.refuseMissingServerConfig();
	const problem = config.serverConfigProblem();
	if (problem) logLine({ component: "server", event: "config_missing", missing: asLogNames(problem.names) });
	const { privateStorage, assertPrivateBucket } = await import("@everyfield/db/schema");
	const storage = privateStorage();
	if (storage)
		assertPrivateBucket(storage).catch((error) =>
			logFailure({ component: "server", event: "bucket_check_failed" }, error),
		);
	try {
		(await import("@everyfield/evry/tracing")).registerTracing();
	} catch (error) {
		logFailure({ component: "server", event: "tracing_failed" }, error);
	}
	if (problem) return;
	const started = performance.now();
	const ms = () => Math.round(performance.now() - started);
	try {
		const [{ requestAuth }, { warmPools }] = await Promise.all([
			import("./server/identity"),
			import("./server/database"),
		]);
		const [, pools] = await Promise.all([requestAuth().$context, warmPools()]);
		logInfo({ component: "server", event: "warm", ms: ms() });
		pools.rest.then(
			() => logInfo({ component: "server", event: "warm_rest", ms: ms() }),
			(error) => logFailure({ component: "server", event: "warm_failed", ms: ms() }, error),
		);
	} catch (error) {
		logFailure({ component: "server", event: "warm_failed", ms: ms() }, error);
	}
}
