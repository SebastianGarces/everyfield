// Runs once when the Node.js server starts, before it serves requests: `next start`, `next dev` and a Vercel function's
// cold start. The first request after a deploy then finds the identity modules loaded, Better Auth built and one open
// connection in each identity pool, instead of paying the module load, setup and TLS handshakes itself. The edge runtime
// (the proxy) has no pools to warm. A failure is logged and never stops the server.
export async function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
