import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { holdPort } from "./held-port.mjs";

const stub = fileURLToPath(new URL("./fixtures/listen-stub.mjs", import.meta.url));

test("INV-census: next start listens on the socket that chose its port, so no socket takes a freed port first (EADDRINUSE race)", async () => {
	const held = await holdPort("127.0.0.1");
	const origin = `http://127.0.0.1:${held.port}`;
	const thief = createServer();
	const taken = await new Promise((resolve) =>
		thief.once("error", () => resolve(false)).listen(held.port, "127.0.0.1", () => resolve(true)),
	);
	const child = held.spawn(process.execPath, [stub, String(held.port)], {
		env: { PATH: process.env.PATH },
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		let log = "";
		const ready = new Promise((resolve, reject) => {
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (chunk) => {
					log += chunk;
					if (/Ready in/.test(log)) resolve();
				});
			child.once("exit", (code) => reject(Error(`stub exited ${code} before it was ready:\n${log}`)));
		});
		await ready;
		assert.equal(await fetch(origin + "/").then((r) => r.text()), "stub");
		assert.equal(
			taken,
			false,
			"another socket bound the port between choosing it and the child's listen: the free-then-reuse race behind " +
				"`listen EADDRINUSE: address already in use 127.0.0.1:40437` in CI run 45068696522",
		);
	} finally {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
		if (taken) thief.close();
	}
});
