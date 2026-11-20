import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { readsFrom } from "../../../apps/web/src/components/get-reads.ts";

const listen = (status: number) =>
	new Promise<Server>((resolve) => {
		const server = createServer((_, res) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(status === 200 ? { status: "ok", value: 1 } : { status: "failed" }));
		});
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
const portOf = (server: Server) => (server.address() as { port: number }).port;

test("INV-reads: a 500 from a GET read is failed; any other non-ok answer or a network error is lost", async () => {
	const answers: Record<number, unknown> = {};
	for (const status of [200, 500, 503, 404, 401]) {
		const server = await listen(status);
		const get = readsFrom(`http://127.0.0.1:${portOf(server)}/x/read`) as (what: string) => Promise<unknown>;
		answers[status] = await get("one");
		server.close();
	}
	const closed = await listen(200);
	const port = portOf(closed);
	await new Promise((resolve) => closed.close(resolve));
	const get = readsFrom(`http://127.0.0.1:${port}/x/read`) as (what: string) => Promise<unknown>;
	assert.deepEqual(answers, {
		200: { status: "ok", value: 1 },
		500: { status: "failed" },
		503: { status: "lost" },
		404: { status: "lost" },
		401: { status: "lost" },
	});
	assert.deepEqual(await get("one"), { status: "lost" });
});
