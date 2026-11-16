export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { privateStorage, assertPrivateBucket } = await import("@everyfield/db/schema");
	const storage = privateStorage();
	if (storage)
		assertPrivateBucket(storage).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(JSON.stringify({ component: "server", event: "bucket_check_failed", message }));
		});
	try {
		(await import("@everyfield/evry/tracing")).registerTracing();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(JSON.stringify({ component: "server", event: "tracing_failed", message }));
	}
	const started = performance.now();
	const ms = () => Math.round(performance.now() - started);
	try {
		const [{ requestAuth }, { warmPools }] = await Promise.all([
			import("./server/identity"),
			import("./server/database"),
		]);
		const [, pools] = await Promise.all([requestAuth().$context, warmPools()]);
		console.log(JSON.stringify({ component: "server", event: "warm", ms: ms() }));
		pools.rest.then(
			() => console.log(JSON.stringify({ component: "server", event: "warm_rest", ms: ms() })),
			(error) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(JSON.stringify({ component: "server", event: "warm_failed", ms: ms(), message }));
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(JSON.stringify({ component: "server", event: "warm_failed", ms: ms(), message }));
	}
}
