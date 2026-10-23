// Runs once when the Node.js server starts, before it serves requests: `next start`, `next dev` and a Vercel function's
// cold start. The first request after a deploy then finds the identity modules loaded, Better Auth built, the connections
// one request uses open and the bucket's privacy checked, instead of paying the module load, setup, TLS handshakes and
// bucket call itself. The edge runtime (the proxy) has no pools to warm. A warm failure is logged and never stops the
// server. The production bucket check does stop it: outside production, the production bucket is refused before any
// request can write to it. Evry tracing to Langfuse registers first, so every turn is traced; a tracing setup failure is
// logged and never stops the server.
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
	const { privateStorage, assertPrivateBucket } = await import("@everyfield/db/schema");
	const storage = privateStorage();
	// Not awaited: a slow bucket must not hold every request. An upload that arrives first shares the check in flight; after
	// a failure the next upload checks again.
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
		await Promise.all([requestAuth().$context, warmPools()]);
		console.log(JSON.stringify({ component: "server", event: "warm", ms: ms() }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(JSON.stringify({ component: "server", event: "warm_failed", ms: ms(), message }));
	}
}
